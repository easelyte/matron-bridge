import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Random per-process key for redaction markers. A marker embeds a short digest
// so identical secrets correlate WITHIN a run (the useful property — you can see
// the same credential recurring). A bare sha256 prefix of the plaintext also has
// that property, but it is a 32-bit fingerprint of the secret itself: for the
// low-entropy secrets people actually type — a PIN, a short password, a
// passphrase from a small space — an attacker who reads the journal can
// enumerate candidates, hash each, and confirm a guess offline with certainty,
// making the redactor do the opposite of its job for exactly the weakest
// secrets. HMAC-ing under a key minted at process start keeps the within-run
// correlation while making the marker meaningless to anyone without the key.
const MARKER_KEY = randomBytes(32);

// Operator-supplied extra patterns run over every published string on the
// bridge's event loop. A pattern with catastrophic backtracking is easy to write
// by accident (`(\s+)+$`-style) and would stall the whole bridge — every Claude
// session, not just the Codex view — on a large input. The policy file is
// operator-supplied so this is a footgun rather than an attack surface, but the
// failure mode is bad enough to bound: run the extra patterns only below this
// size. The vetted built-in baseline (key-name / PEM / env-dump) always runs.
const DEFAULT_MAX_OPERATOR_PATTERN_BYTES = 256 * 1024;

// What to do with a payload that exceeds the operator-pattern size bound. The
// previous behavior was 'skip' — publish the whole payload with only the baseline
// applied — which turns the liveness guard above into a CONFIDENTIALITY hole:
// operator patterns exist precisely because the baseline is insufficient for that
// host, and a >256 KiB payload (a `cat` of a config dump, a verbose deploy log) is
// exactly the shape most likely to carry the thing those rules guard. On a publish
// path the safe failure direction is not-publish, so the default is now fail-closed:
//   - 'truncate' (default): redact the bounded head (cut on a line boundary so a
//       secret isn't split), drop the rest, and annotate the drop. Bounds regex
//       work to the head while never publishing un-redacted tail bytes.
//   - 'drop': withhold the payload entirely, publishing only an annotation.
//   - 'skip': legacy fail-open — full payload, operator patterns skipped. Opt-in.
const OVERSIZE_POLICIES = new Set(['truncate', 'drop', 'skip']);
const DEFAULT_OVERSIZE_POLICY = 'truncate';

function resolveOversizePolicy(explicit, env) {
  if (typeof explicit === 'string' && OVERSIZE_POLICIES.has(explicit)) return explicit;
  const fromEnv = typeof env?.MATRON_REDACT_OVERSIZE_POLICY === 'string'
    ? env.MATRON_REDACT_OVERSIZE_POLICY.trim()
    : '';
  if (OVERSIZE_POLICIES.has(fromEnv)) return fromEnv;
  return DEFAULT_OVERSIZE_POLICY;
}

// Relative location of an OPTIONAL extra-pattern policy under an explicitly
// supplied workspaceRoot. There is no built-in absolute default path — when no
// policy is configured the redactor falls back to the built-in secret-key /
// PEM / env-dump baseline (see createPublishRedactor).
const REDACTOR_CONFIG_PARTS = ['config', 'redactor.yaml'];

function secretMarker(value) {
  return createHmac('sha256', MARKER_KEY).update(value, 'utf8').digest('hex').slice(0, 8);
}

function compilePythonPattern(source) {
  let flags = 'g';
  let caseInsensitive = false;
  const javascriptSource = source.replaceAll('(?i)', () => {
    caseInsensitive = true;
    return '';
  });
  if (caseInsensitive) flags += 'i';

  // A policy's \s, \b, \d, \w and lookaheads translate directly.
  // Both engines intentionally use ASCII-oriented token
  // syntax; Unicode case-folding/class behavior remains an edge if future
  // patterns add non-ASCII text. Reject only Python constructs that JavaScript
  // would otherwise miscompile instead of rejecting supported syntax.
  if (/\\[AZ]|\(\?P[<=]|\(\?#|\(\?\(/.test(javascriptSource) ||
      /\(\?[aiLmsux-]+:/.test(javascriptSource)) {
    throw new Error('redactor regex uses unsupported Python semantics');
  }
  try {
    return new RegExp(javascriptSource, flags);
  } catch (error) {
    throw new Error('redactor regex cannot be translated to JavaScript', { cause: error });
  }
}

const SECRET_KEY_SEGMENT = /^(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|CREDENTIAL|BEARER)$/i;
const SECRET_KEY_EXACT = /^(?:AUTH|SESSION|COOKIE)$/i;
const QUOTED_KEY_VALUE = /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)(?:"((?:\\[\s\S]|[^"\\\0])*)"|'((?:\\[\s\S]|[^'\\\0])*)')/gm;
const BARE_KEY_VALUE = /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2([^\S\r\n]*[:=][^\S\r\n]*)([^\r\n,;}\0]*)/gm;
const YAML_BLOCK_HEADER = /^([ \t]*)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2([^\S\r\n]*:[^\S\r\n]*)([|>](?:[1-9][+-]?|[+-][1-9]?)?[^\r\n]*)(\r?\n|$)/gm;
const PRIVATE_KEY_PEM = /-----BEGIN ([A-Z0-9 -]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
// A secret-named CLI flag whose value is separated by whitespace or `=`, e.g.
// `curl --password hunter2` or `--api-key=abc`. The leading dashes keep these
// out of the QUOTED/BARE_KEY_VALUE assignment rules (whose key must be preceded
// by start-of-string or a non-[alnum._-] char that a `-` is not), so a raw
// credential would otherwise reach the journal untouched. The value is the next
// quoted string or whitespace-delimited token, never spanning a newline. A flag
// preceded by a path separator (`/--x`) is intentionally excluded via the
// horizontal-whitespace-or-start boundary.
const SECRET_CLI_FLAG =
  /(^|[^\S\r\n])(-{1,2}[A-Za-z][A-Za-z0-9-]*)(=|[^\S\r\n]+)("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s]+)/g;

function isSecretKey(key) {
  const segments = key.split(/[_.-]+/).filter(Boolean);
  const hasKeySuffix = segments.length > 1 && /^KEY$/i.test(segments.at(-1));
  return SECRET_KEY_EXACT.test(key) || hasKeySuffix ||
    segments.some(keySegment => SECRET_KEY_SEGMENT.test(keySegment));
}

function indentationWidth(line) {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function redactYamlBlockSecretValues(value) {
  let output = '';
  let copiedThrough = 0;
  YAML_BLOCK_HEADER.lastIndex = 0;
  for (let header = YAML_BLOCK_HEADER.exec(value); header;
    header = YAML_BLOCK_HEADER.exec(value)) {
    const [match, indent, keyQuote, key, separator, , newline] = header;
    if (!isSecretKey(key) || !newline) continue;

    const contentStart = header.index + match.length;
    const lines = value.slice(contentStart).match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
    let contentLength = 0;
    let contentIndent = null;
    for (const lineWithEnding of lines) {
      if (!lineWithEnding) break;
      const line = lineWithEnding.replace(/\r?\n$/, '');
      if (line.trim() === '') {
        contentLength += lineWithEnding.length;
        continue;
      }
      const width = indentationWidth(line);
      if (contentIndent === null) contentIndent = width;
      if (width <= indent.length || width < contentIndent) break;
      contentLength += lineWithEnding.length;
    }
    if (contentLength === 0) continue;

    const contentEnd = contentStart + contentLength;
    const secret = value.slice(contentStart, contentEnd);
    output += value.slice(copiedThrough, header.index);
    output += `${indent}${keyQuote}${key}${keyQuote}${separator}` +
      `[REDACTED:secret-key:${secretMarker(secret)}]${newline}`;
    copiedThrough = contentEnd;
    YAML_BLOCK_HEADER.lastIndex = contentEnd;
  }
  return output + value.slice(copiedThrough);
}

function redactSecretKeyValues(value) {
  let output = value.replace(PRIVATE_KEY_PEM, secret => (
    `[REDACTED:private-key-pem:${secretMarker(secret)}]`
  ));
  output = redactYamlBlockSecretValues(output);
  output = output.replace(
    QUOTED_KEY_VALUE,
    (match, prefix, keyQuote, key, separator, doubleQuoted, singleQuoted, bare) => {
      if (!isSecretKey(key)) return match;
      const secret = doubleQuoted ?? singleQuoted ?? bare;
      const valueQuote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}${valueQuote}` +
        `[REDACTED:secret-key:${secretMarker(secret)}]${valueQuote}`;
    },
  );
  output = output.split(/(\0|\r?\n)/).map(segment => segment.replace(
    BARE_KEY_VALUE,
    (match, prefix, keyQuote, key, separator, bare) => {
      if (!isSecretKey(key)) return match;
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}` +
        `[REDACTED:secret-key:${secretMarker(bare)}]`;
    },
  )).join('');
  return output.replace(
    SECRET_CLI_FLAG,
    (match, boundary, flag, separator, secret) => {
      if (!isSecretKey(flag.replace(/^-+/, ''))) return match;
      const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : '';
      const inner = quote ? secret.slice(1, -1) : secret;
      return `${boundary}${flag}${separator}${quote}` +
        `[REDACTED:secret-key:${secretMarker(inner)}]${quote}`;
    },
  );
}

function parseScalar(source) {
  const value = source.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  throw new Error('redactor config contains an unsupported scalar');
}

// A strict structural parser for the deliberately small canonical schema.
// Rejecting every unknown/malformed node is safer than accepting a partial
// policy when a full YAML dependency is not available in this bridge.
export function parseRedactorConfig(source) {
  if (typeof source !== 'string') throw new TypeError('redactor config must be text');
  const lines = source.split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() && !/^\s*#/.test(text));
  if (lines[0]?.text.trim() === '---') lines.shift();
  if (lines.at(-1)?.text.trim() === '...') lines.pop();
  if (lines.shift()?.text !== 'patterns:') throw new Error('redactor config must contain patterns');

  const entries = [];
  let current = null;
  for (const { text, line } of lines) {
    const item = /^ {2}- (name|regex):\s*(.+)$/.exec(text);
    const property = /^ {4}(name|regex):\s*(.+)$/.exec(text);
    if (item) {
      if (current) entries.push(current);
      current = {};
      current[item[1]] = parseScalar(item[2]);
    } else if (property && current) {
      if (Object.hasOwn(current, property[1])) {
        throw new Error(`duplicate redactor property at line ${line}`);
      }
      current[property[1]] = parseScalar(property[2]);
    } else {
      throw new Error(`unsupported redactor YAML at line ${line}`);
    }
  }
  if (current) entries.push(current);
  if (entries.length === 0) throw new Error('redactor config has no patterns');
  return entries.map((entry, index) => {
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.name) ||
        typeof entry.regex !== 'string' || entry.regex.length === 0 ||
        Object.keys(entry).length !== 2) {
      throw new Error(`invalid redactor pattern at index ${index}`);
    }
    return { name: entry.name, compiled: compilePythonPattern(entry.regex) };
  });
}

function expandHome(value, homedir = os.homedir()) {
  if (value === '~') return homedir;
  if (value.startsWith(`~${path.sep}`)) return path.join(homedir, value.slice(2));
  return value;
}

// Resolve the OPTIONAL extra-pattern policy file. Precedence: explicit
// configPath, then the MATRON_REDACTOR_CONFIG env var, then a conventional
// location under an explicitly supplied workspaceRoot. When none is given this
// returns null and the redactor uses its built-in baseline only.
export function resolveRedactorConfigPath({
  workspaceRoot,
  configPath,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const selected = configPath ?? env.MATRON_REDACTOR_CONFIG ?? (
    typeof workspaceRoot === 'string'
      ? path.join(workspaceRoot, ...REDACTOR_CONFIG_PARTS)
      : null
  );
  if (typeof selected !== 'string' || selected.length === 0) return null;
  return path.resolve(expandHome(selected, homedir));
}

/**
 * Build the shared publish-side secret redactor. The built-in secret-key /
 * private-key-PEM / env-dump patterns are always applied as the baseline. An
 * optional YAML policy (resolved via configPath / MATRON_REDACTOR_CONFIG /
 * workspaceRoot) adds extra value-format rules on top; it is loaded once,
 * lazily. When no policy is configured the baseline is used on its own. If a
 * policy IS configured but fails to load/compile, the adapter latches closed
 * so callers drop the event or omit the optional field rather than publishing
 * under a partial policy.
 */
export function createPublishRedactor({
  workspaceRoot,
  configPath,
  env = process.env,
  homedir = os.homedir(),
  readFileSyncFn = readFileSync,
  log = console,
  maxOperatorPatternBytes = DEFAULT_MAX_OPERATOR_PATTERN_BYTES,
  oversizePolicy,
} = {}) {
  const resolvedOversizePolicy = resolveOversizePolicy(oversizePolicy, env);
  const resolvedConfigPath = resolveRedactorConfigPath({
    workspaceRoot, configPath, env, homedir,
  });
  let patterns;
  let loadFailed = false;
  let oversizeWarned = false;
  return value => {
    if (typeof value !== 'string') throw new TypeError('publish redactor requires a string');
    if (loadFailed) throw new Error('publish redactor is unavailable');
    if (!patterns) {
      if (typeof resolvedConfigPath !== 'string' || resolvedConfigPath.length === 0) {
        // No policy file configured: use the built-in baseline only. The
        // secret-key / PEM / env-dump belt below still runs unconditionally.
        patterns = [];
      } else {
        try {
          patterns = parseRedactorConfig(readFileSyncFn(resolvedConfigPath, 'utf8'));
        } catch (error) {
          loadFailed = true;
          try {
            const kind = error instanceof Error ? error.name : typeof error;
            log?.error?.(`[publish-redactor] config load failed (${kind}); publication disabled`);
          } catch { /* logging cannot weaken fail-closed behavior */ }
          throw new Error('publish redactor config failed', { cause: error });
        }
      }
    }
    // Key-name redaction covers every free-text publication route, including
    // environment output produced by commands the supplemental dump detector
    // cannot decide is an env dump. An unremarkable key whose value matches no
    // configured value pattern remains fundamentally undecidable and may pass.
    const output = redactSecretKeyValues(value);
    const applyOperatorPatterns = text => {
      let redacted = text;
      for (const pattern of patterns) {
        redacted = redacted.replace(pattern.compiled, match => (
          `[REDACTED:${pattern.name}:${secretMarker(match)}]`
        ));
      }
      return redacted;
    };
    // Operator patterns run on the bridge's event loop, so a catastrophic-
    // backtracking rule on a huge input would stall every session — bound the work
    // by size. The bound is in UTF-8 BYTES, so measure bytes (not `.length`, which
    // is UTF-16 code units and undercounts multibyte text). Under the bound (or
    // with no operator patterns) apply them normally.
    const outputBytes = Buffer.byteLength(output, 'utf8');
    if (!patterns.length || outputBytes <= maxOperatorPatternBytes) {
      return applyOperatorPatterns(output);
    }
    // Over the bound the baseline above already ran; the oversize policy decides
    // what happens to the un-vetted remainder (default fail-closed). Warn once so
    // the decision is visible in the logs.
    if (!oversizeWarned) {
      oversizeWarned = true;
      try {
        log?.warn?.(
          `[publish-redactor] input ${outputBytes}B exceeds ` +
          `${maxOperatorPatternBytes}B; applying oversize policy '${resolvedOversizePolicy}' ` +
          `to ${patterns.length} operator pattern(s) for this and larger inputs`,
        );
      } catch { /* logging must not weaken redaction */ }
    }
    if (resolvedOversizePolicy === 'skip') {
      // Legacy fail-open: full baseline-redacted payload, operator patterns skipped.
      return output;
    }
    if (resolvedOversizePolicy === 'drop') {
      return `[REDACTED-OVERSIZE: ${outputBytes}B payload withheld ` +
        `(exceeds ${maxOperatorPatternBytes}B operator-pattern limit)]`;
    }
    // 'truncate' (default): fully redact a bounded head, drop the un-vetted tail so
    // no operator-pattern-eligible bytes publish unredacted. Work on the UTF-8 byte
    // buffer and cut at the LAST newline whose byte index is within the bound: `\n`
    // is a single-byte char, so the cut never splits a multibyte character, and a
    // secret straddling the boundary lands entirely in the dropped tail (never a
    // publishable prefix). If no newline fits in the bound, drop the whole payload
    // (empty head) rather than hard-slicing a partial line — fully fail-closed.
    const buf = Buffer.from(output, 'utf8');
    const scanEnd = Math.min(maxOperatorPatternBytes, buf.length);
    let cut = -1;
    for (let i = scanEnd - 1; i >= 0; i--) {
      if (buf[i] === 0x0A) { cut = i; break; }
    }
    const head = cut >= 0 ? buf.toString('utf8', 0, cut) : '';
    const droppedBytes = outputBytes - (cut >= 0 ? cut : 0);
    const annotation = `[REDACTED-OVERSIZE: ${droppedBytes}B dropped beyond the ` +
      `${maxOperatorPatternBytes}B operator-pattern limit; head fully redacted]`;
    return head ? `${applyOperatorPatterns(head)}\n${annotation}` : annotation;
  };
}
