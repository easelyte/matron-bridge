// Pure helpers for assembling per-session MCP configuration. Kept separate
// from index.js so they're side-effect-free and testable.
//
// Two-section layout on disk (`mcp-config.json`):
//   `mcpServers` — always-on servers (e.g. ask-user)
//   `mcpExtras`  — opt-in groups keyed by name (e.g. `browser`)
//
// `buildMcpServers` merges the base set with whichever extras were requested
// for a session, optionally applying the macOS xvfb-run unwrapper.
// `extractMcpExtraFlags` strips recognised `--<name>` flags from a tokenised
// command line and returns both the extras and the remaining positional
// tokens, so callers can keep their existing positional-arg handling.

import { macifyMcpServers } from './mcp-config-mac.js';

// The set of valid extra names is derived from the merged config's
// `mcpExtras` keys (committed mcp-config.json + the gitignored
// mcp-config.local.json overlay), so adding an extra block automatically
// enables its `--<name>` flag. Callers pass the result to
// extractMcpExtraFlags.
export function knownMcpExtras(baseConfig) {
  return Object.keys(baseConfig?.mcpExtras || {});
}

// Shallow-merge a gitignored machine-local overlay into the committed config.
// Always returns a fresh object (overlay may be null) so callers can never
// mutate the input. Overlay `mcpServers`/`mcpExtras` entries win key-by-key.
export function mergeMcpConfigs(base, overlay) {
  return {
    ...base,
    mcpServers: { ...(base?.mcpServers || {}), ...(overlay?.mcpServers || {}) },
    mcpExtras: { ...(base?.mcpExtras || {}), ...(overlay?.mcpExtras || {}) },
  };
}

// Parse the comma-separated MCP_DEFAULT_EXTRAS env value into a clean list.
// Validation against the known names happens in index.js, where the merged
// config is available, so a typo is warned about once at boot.
export function parseDefaultExtras(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// `share` is opt-in: OFF by default, ON only when SHOW_FILE_DEFAULT_ON=1 is
// set in the session's environment. The per-session `--share` flag
// (EXTRA_FLAG_TO_NAME above) still forces it on regardless of this default.
export function resolveDefaultExtras(envVal) {
  return envVal === '1' ? ['share'] : [];
}

export function effectiveExtras(resolvedExtras, defaultExtras) {
  return Array.from(new Set([...resolvedExtras, ...defaultExtras]));
}

// Matrix / mobile clients frequently auto-correct a leading `--` into a single
// em-dash (—) or en-dash (–), so a user typing `--browser` actually sends
// `—browser`. Normalise any run of leading unicode dashes back to `--` before
// matching, so the auto-corrected forms are still recognised. The ORIGINAL
// token is preserved in `rest` when it isn't a flag, so positional args are
// untouched.
const LEADING_UNICODE_DASHES = /^[‐‑‒–—―]+/;

// Strip recognised `--<name>` flags from a tokenised command line. `knownNames`
// is the list from knownMcpExtras(). A Set membership test (not object lookup)
// keeps prototype names like `__proto__`/`constructor` from matching. The
// ORIGINAL token is preserved in `rest` when it isn't a flag.
export function extractMcpExtraFlags(tokens, knownNames = []) {
  const known = new Set(knownNames);
  const extras = [];
  const rest = [];
  for (const tok of tokens) {
    const m = /^--(.+)$/.exec(tok.replace(LEADING_UNICODE_DASHES, '--'));
    if (m && known.has(m[1])) extras.push(m[1]);
    else rest.push(tok);
  }
  return { extras, rest };
}

// Per-session permission-mode flag (spec 2026-08-10-auto-permission-mode):
// `--bypass` restores the old --dangerously-skip-permissions spawn for this
// session; `--auto` explicitly returns to the default auto-permission spawn
// (needed so /restart can undo a persisted bypass). Neither present → null,
// so callers can fall back to the carried/persisted bypassMode. A Map is not
// needed here (two fixed flags), but unicode-dash normalization is — same
// mobile-autocorrect problem as --browser.
export function extractBypassFlag(tokens) {
  let bypass = null;
  const rest = [];
  for (const tok of tokens) {
    const normalised = tok.replace(LEADING_UNICODE_DASHES, '--');
    if (normalised === '--bypass') bypass = true;
    else if (normalised === '--auto') bypass = false;
    else rest.push(tok);
  }
  return { bypass, rest };
}

// Resolve the `ask-user` server's relative arg against the supplied directory
// so the generated config is portable; callers pass the bridge install dir.
function resolveAskUser(servers, askUserBaseDir) {
  // servers is always the caller's `{ ...base }` spread, never null.
  if (!servers['ask-user'] || !askUserBaseDir) return servers;
  const out = { ...servers };
  const src = out['ask-user'];
  out['ask-user'] = {
    ...src,
    args: (src.args || []).map((a, i) =>
      i === 0 && a === './ask-user.js' ? `${askUserBaseDir}/ask-user.js` : a,
    ),
  };
  return out;
}

function resolveShowFile(servers, askUserBaseDir) {
  if (!servers['show-file'] || !askUserBaseDir) return servers;
  const out = { ...servers };
  const src = out['show-file'];
  out['show-file'] = {
    ...src,
    args: (src.args || []).map((a, i) =>
      i === 0 && a === './show-file-mcp.js' ? `${askUserBaseDir}/show-file-mcp.js` : a,
    ),
  };
  return out;
}

// Resolve `./`-relative server commands (e.g. ./hooks/xvfb-wrap.sh) against
// the bridge install dir. claude is spawned with the SESSION workdir as its
// cwd, so a relative command left in the generated config would ENOENT for
// every session outside the repo.
function resolveRelativeCommands(servers, baseDir) {
  if (!baseDir) return servers;
  const out = {};
  for (const [name, srv] of Object.entries(servers)) {
    out[name] = (srv && typeof srv.command === 'string' && srv.command.startsWith('./'))
      ? { ...srv, command: `${baseDir}/${srv.command.slice(2)}` }
      : srv;
  }
  return out;
}

export function buildMcpServers({
  baseConfig,
  extras = [],
  platform = process.platform,
  askUserBaseDir = null,
} = {}) {
  const base = baseConfig?.mcpServers || {};
  const extrasMap = baseConfig?.mcpExtras || {};
  let servers = { ...base };
  const sorted = [...new Set(extras)].filter(e => Object.prototype.hasOwnProperty.call(extrasMap, e)).sort();
  for (const ex of sorted) {
    Object.assign(servers, extrasMap[ex]);
  }
  servers = resolveAskUser(servers, askUserBaseDir);
  servers = resolveShowFile(servers, askUserBaseDir);
  servers = resolveRelativeCommands(servers, askUserBaseDir);
  let out = { mcpServers: servers };
  if (platform === 'darwin') out = macifyMcpServers(out);
  return { config: out, extras: sorted };
}

// !start --prompt "<text>" injects the session's first message (feat/iv,
// fork-local). Quote-aware: honours backslash escapes inside a double-quoted
// value so `\"` is a literal quote, `\\` a literal backslash. Returns
// { prompt, rest, error } — prompt null (with rest = original) when absent,
// error set on a missing closing quote or empty value.
export function extractPromptFlag(rawText) {
  const m0 = rawText.match(/(^|\s)--prompt(\s|$)/);
  if (!m0) return { prompt: null, rest: rawText, error: null };
  const idx = m0.index + m0[1].length;            // start of the literal "--prompt"
  const after = rawText.slice(idx + '--prompt'.length).replace(/^\s+/, '');
  const before = rawText.slice(0, idx).replace(/\s+$/, '');

  if (after.startsWith('"')) {
    // Scan for the closing quote, honoring backslash escapes so `\"` is a literal
    // quote inside the prompt (and `\\` a literal backslash) rather than a closer.
    let prompt = '';
    let i = 1;
    let closed = false;
    for (; i < after.length; i++) {
      const c = after[i];
      if (c === '\\' && i + 1 < after.length && (after[i + 1] === '"' || after[i + 1] === '\\')) {
        prompt += after[i + 1];
        i++;
        continue;
      }
      if (c === '"') { closed = true; break; }
      prompt += c;
    }
    if (!closed) return { prompt: null, rest: rawText, error: '--prompt: missing closing quote.' };
    if (prompt.trim() === '') return { prompt: null, rest: rawText, error: '--prompt requires non-empty text.' };
    const tail = after.slice(i + 1).replace(/^\s+/, '');
    return { prompt, rest: [before, tail].filter(Boolean).join(' '), error: null };
  }
  const m = after.match(/^(\S+)\s*(.*)$/s);
  if (!m) return { prompt: null, rest: rawText, error: '--prompt requires non-empty text.' };
  return { prompt: m[1], rest: [before, m[2]].filter(Boolean).join(' '), error: null };
}
