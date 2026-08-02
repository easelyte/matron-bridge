import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REDACTOR_CONFIG_PARTS = ['memory', 'config', 'lesson_redactor.yaml'];

function sha256Prefix(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

function compilePythonPattern(source) {
  let flags = 'g';
  let javascriptSource = source;
  const leadingFlags = /^\(\?([ms]+)\)/.exec(javascriptSource);
  if (leadingFlags) {
    javascriptSource = javascriptSource.slice(leadingFlags[0].length);
    flags += [...new Set(leadingFlags[1])].join('');
  }
  // This is deliberately an ASCII-oriented intersection of the Python and
  // JavaScript dialects used by the canonical policy: literals, positive
  // character classes/ranges, grouping/alternation, anchors and quantifiers.
  // Shorthand classes/boundaries and case-insensitive matching have different
  // Unicode semantics in the two engines. Wildcards, negated classes, special
  // groups and non-ASCII pattern text can likewise produce a weaker JS match.
  // Refuse the whole policy instead of silently enabling only part of it.
  const unsupportedEscape = /\\(?:[AbBdDsSwWZz]|[0-9]|[pPuUN]|x|c)/;
  const unsupportedGroup = /\(\?(?!:)/;
  if (/[\u0080-\uFFFF]/.test(javascriptSource) ||
      unsupportedEscape.test(javascriptSource) ||
      unsupportedGroup.test(javascriptSource) ||
      /(^|[^\\])\./.test(javascriptSource) ||
      /\[\^/.test(javascriptSource)) {
    throw new Error('redactor regex uses unsupported Python semantics');
  }
  // Only escapes for ASCII regex punctuation are in the shared subset.
  if (/\\(?![\\.^$|?*+(){}[\]/-])/u.test(javascriptSource)) {
    throw new Error('redactor regex uses unsupported Python semantics');
  }
  return new RegExp(javascriptSource, flags);
}

const SECRET_KEY_NAME = /(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH|SESSION|COOKIE|BEARER)|_(?:KEY|TOKEN|SECRET)$/i;
const KEY_VALUE_SEGMENT = /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\r\n,;}]*))/gm;

function redactSecretKeyValues(value) {
  return value.replace(
    KEY_VALUE_SEGMENT,
    (match, prefix, keyQuote, key, separator, doubleQuoted, singleQuoted, bare) => {
      if (!SECRET_KEY_NAME.test(key)) return match;
      const secret = doubleQuoted ?? singleQuoted ?? bare;
      const valueQuote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}${valueQuote}` +
        `[REDACTED:secret-key:${sha256Prefix(secret)}]${valueQuote}`;
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

export function resolveRedactorConfigPath({
  workspaceRoot,
  configPath,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const selected = configPath ?? env.CLAUDE_REDACTOR_CONFIG ?? (
    typeof workspaceRoot === 'string'
      ? path.join(workspaceRoot, ...REDACTOR_CONFIG_PARTS)
      : null
  );
  if (typeof selected !== 'string' || selected.length === 0) return null;
  return path.resolve(expandHome(selected, homedir));
}

/**
 * Build the shared bridge-side adapter for the canonical lesson-redactor
 * policy. Config is loaded once, lazily; any load/compile failure latches the
 * adapter closed so callers drop the event or omit the optional field.
 */
export function createPublishRedactor({
  workspaceRoot,
  configPath,
  env = process.env,
  homedir = os.homedir(),
  readFileSyncFn = readFileSync,
  log = console,
} = {}) {
  const resolvedConfigPath = resolveRedactorConfigPath({
    workspaceRoot, configPath, env, homedir,
  });
  let patterns;
  let loadFailed = false;
  return value => {
    if (typeof value !== 'string') throw new TypeError('publish redactor requires a string');
    if (loadFailed) throw new Error('publish redactor is unavailable');
    if (!patterns) {
      try {
        if (typeof resolvedConfigPath !== 'string' || resolvedConfigPath.length === 0) {
          throw new Error('publish redactor config is unavailable');
        }
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
    // Key-name redaction covers every free-text publication route, including
    // environment output produced by commands the supplemental dump detector
    // cannot decide is an env dump. An unremarkable key whose value matches no
    // canonical value pattern remains fundamentally undecidable and may pass.
    let output = redactSecretKeyValues(value);
    for (const pattern of patterns) {
      output = output.replace(pattern.compiled, match => (
        `[REDACTED:${pattern.name}:${sha256Prefix(match)}]`
      ));
    }
    return output;
  };
}
