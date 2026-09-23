// Child-process environments for bridge-spawned agent sessions.
//
// Every agent spawn used to build its env inline in index.js, which is an ESM
// entrypoint with no exports, so the only way to test "what does the child
// actually get" was to pin the spelling of the object literal. Those pins broke
// on every edit here (loop #784). The builders below return the env as data so
// the tests can assert on the result instead.
//
// Credential scoping lives in lib/journal-cred-scope.js; this module only
// decides which helper each spawn kind goes through:
//   - Claude print + interactive sessions: stripJournalCreds (no JOURNAL_TOKEN /
//     JOURNAL_TOKEN_FILE, no bridge-only secrets). They reach journal search via
//     the bridge-local read proxy (loop #765).
//   - Codex sessions: stripJournalCreds on the app-server transport,
//     stripBridgeOnlySecrets only on legacy exec (see buildCodexSpawnEnv).
//
// MCP extras reach the env only through SHOW_FILE_TOKEN: the caller mints it
// when the effective extras include 'share' and passes it in. The extras
// themselves go to the child as argv (--mcp-config) or Codex config, not env.

import path from 'node:path';
import { bashTimeoutEnv } from './bash-timeout-env.js';
import { stripBridgeOnlySecrets, stripJournalCreds } from './journal-cred-scope.js';

// Prepend the directory of the node binary running the bridge to PATH (once),
// so the spawned claude process can reach `node` for the ask-user MCP server and
// the matron-tee Bash hook when the bridge was launched without nvm loaded
// (e.g. launchd).
export function pathWithNodeBin(existingPath, execPath = process.execPath) {
  const nodeBinDir = path.dirname(execPath);
  const current = existingPath || '';
  return current.split(':').includes(nodeBinDir) ? current : `${nodeBinDir}:${current}`;
}

// Env for a Claude session child. `mode` is 'print' (stream-json --print
// session) or 'iv' (interactive TUI session).
//
// print-only keys: MATRON_PERMISSION_CARDS (snapshotted at spawn; toggling the
// flag needs !restart) and MATRON_PERMISSION_TOKEN (the per-session token the
// permission-decision hook authenticates with). CC hooks cannot receive an
// isolated env, so the whole claude process inherits that token; it
// authenticates "a process in this print session", and the identifiers the hook
// emits are parser-bounded. Interactive sessions get neither.
export function buildClaudeSpawnEnv({
  mode,
  baseEnv = process.env,
  execPath = process.execPath,
  roomId,
  apiPort,
  journalProxyHeaderFile,
  pluginCacheDir,
  showBashOutput,
  showFileToken,
  permissionToken,
  warn,
} = {}) {
  if (mode !== 'print' && mode !== 'iv') {
    throw new RangeError(`buildClaudeSpawnEnv: unknown mode ${mode}`);
  }
  if (baseEnv === null || typeof baseEnv !== 'object') {
    throw new TypeError('buildClaudeSpawnEnv: baseEnv must be an object');
  }
  const env = {
    // Strip the full-journal read credential (loop #765): sessions reach the
    // journal search routes through the bridge-local read proxy (see
    // journalReadProxy / BRIDGE_CLAUDE.md "Searching the journal"), so no child,
    // session or its subagents, needs the raw JOURNAL_TOKEN that can pull every
    // transcript. JOURNAL_WS_URL etc. (non-credentials) are kept.
    ...stripJournalCreds(baseEnv),
    PATH: pathWithNodeBin(baseEnv.PATH, execPath),
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    // Raise the Bash-tool timeout floor above the 2-min built-in default so long
    // Codex reviews / test suites in bridge sessions aren't SIGTERM'd mid-run.
    // Operator-overridable via BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS in
    // the bridge env (explicit wins).
    ...bashTimeoutEnv(baseEnv, warn ? { warn } : undefined),
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
    // Path to the 0600 header file carrying the journal read-proxy capability
    // (loop #765). The token value is never placed in the child env or argv.
    MATRON_JOURNAL_PROXY_HEADER_FILE: journalProxyHeaderFile,
    ...(mode === 'print' ? { MATRON_PERMISSION_CARDS: baseEnv.MATRON_PERMISSION_CARDS || '' } : {}),
    MATRON_BASH_TEE_ENABLED: showBashOutput ? '1' : '0',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir,
    // Load every MCP tool up front instead of letting Claude Code defer them
    // behind ToolSearch. With deferral on, the item_* tools (and the rest of
    // ask-user) reach the model only as names in a reminder, and a tool that
    // needs a schema lookup before its first call is a tool the model reaches
    // for last: a fleet survey on 2026-09-09 found not one item_* call on any
    // box other than the one whose sessions were steered to them by hand. The
    // cost is a larger (cached) tool prefix per request. Values: `false` loads
    // everything; `auto:N` defers past N% of context. Whatever the bridge env
    // holds (its `.env` is loaded with override at startup) wins.
    ENABLE_TOOL_SEARCH: baseEnv.ENABLE_TOOL_SEARCH ?? 'false',
    // No MCP_TOOL_TIMEOUT default. #254 briefly injected a 10-minute backstop,
    // but a hard kill also cut off legitimately long calls. The slow-tool
    // notices make a hung call visible instead and leave the cancel decision
    // with the user. An operator who wants the hard cap can still set
    // MCP_TOOL_TIMEOUT in the bridge's own env; it passes through.
  };
  // The show-file token is per session: never inherit one from the bridge env.
  delete env.SHOW_FILE_TOKEN;
  if (showFileToken) env.SHOW_FILE_TOKEN = showFileToken;
  // Permission-card keys are print-only: an interactive child never inherits
  // the bridge's MATRON_PERMISSION_CARDS / MATRON_PERMISSION_TOKEN (nothing in an
  // iv session reads them; the permission-decision hook is wired for print only).
  if (mode === 'print') {
    delete env.MATRON_PERMISSION_TOKEN;
    env.MATRON_PERMISSION_TOKEN = permissionToken;
  } else {
    delete env.MATRON_PERMISSION_CARDS;
    delete env.MATRON_PERMISSION_TOKEN;
  }
  return env;
}

// Env for a Codex session child (app-server or legacy exec transport).
//
// Bridge-only secrets (HMAC_SECRET) are always stripped: no Codex path uses them.
// The journal read-proxy capability reaches the child as a 0600 header FILE
// path (MATRON_JOURNAL_PROXY_HEADER_FILE), the same as Claude sessions, so
// BRIDGE_CODEX.md can point journal search at the bridge-local proxy.
//
// The full-journal read token (JOURNAL_TOKEN / JOURNAL_TOKEN_FILE), loop #781:
//   - app-server transport (the default): stripped. These sessions have the
//     ask-user MCP tools (item_*, mission_*, milestone_*) for tracker writes and
//     the read proxy for search, so nothing needs the token.
//   - legacy exec transport (MATRON_CODEX_TRANSPORT=exec): kept. It has no
//     Matron MCP tools, and BRIDGE_CODEX.md's /items HTTP fallback
//     authenticates with the token.
// `appServer` defaults to true so a caller that forgets it fails safe (token
// stripped) rather than open.
export function buildCodexSpawnEnv({
  baseEnv = process.env,
  roomId,
  apiPort,
  appServer = true,
  journalProxyHeaderFile,
} = {}) {
  if (baseEnv === null || typeof baseEnv !== 'object') {
    throw new TypeError('buildCodexSpawnEnv: baseEnv must be an object');
  }
  return {
    ...(appServer === false ? stripBridgeOnlySecrets(baseEnv) : stripJournalCreds(baseEnv)),
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
    MATRON_JOURNAL_PROXY_HEADER_FILE: journalProxyHeaderFile,
  };
}
