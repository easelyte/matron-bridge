// Child-process environments for bridge-spawned agent sessions.
//
// These used to be object literals inline in index.js, which is an entrypoint
// with no exports, so "what does the child actually get" could only be tested
// by pinning how the literal was spelled. The builders return the env as data
// so tests can assert on the result instead.
//
// Credential scoping lives in lib/journal-cred-scope.js. Sessions reach
// journal search through the bridge-local read proxy
// (lib/journal-read-proxy.js), authenticated by a header file named in
// MATRON_JOURNAL_PROXY_HEADER_FILE, so:
//   - Claude sessions (print + interactive): stripJournalCreds, no journal
//     token, no bridge-only secrets; the user's provider keys are kept.
//   - Codex sessions: stripJournalCreds on the app-server transport;
//     stripBridgeOnlySecrets only on the legacy exec transport, whose /items
//     HTTP fallback still authenticates with the token.
// A session's subagents and tools inherit its env, so this is what keeps the
// token away from them too. It reduces ambient exposure; it is not an OS
// boundary (a same-uid child that knows where the token file lives can still
// read it).

import path from 'node:path';
import { stripBridgeOnlySecrets, stripJournalCreds } from './journal-cred-scope.js';
import { bashTimeoutEnv } from './bash-timeout-env.js';

// Prepend the directory of the node binary running the bridge to PATH (once).
// The ask-user MCP server and the matron-tee Bash hook both resolve `node` via
// PATH; when the bridge is launched non-interactively (e.g. launchd) nvm hasn't
// loaded and PATH lacks the node bin dir.
export function pathWithNodeBin(existingPath, execPath = process.execPath) {
  const nodeBinDir = path.dirname(execPath);
  const current = existingPath || '';
  return current.split(':').includes(nodeBinDir) ? current : `${nodeBinDir}:${current}`;
}

// Env for a Claude session child. `mode` is 'print' (stream-json --print
// session) or 'iv' (interactive TUI session); both get the same shape except
// for the permission-card keys below.
//
// easelyte fork delta (permission cards): print-only keys
// MATRON_PERMISSION_CARDS (snapshotted at spawn; toggling the flag needs
// !restart) and MATRON_PERMISSION_TOKEN (the per-session token the
// permission-decision hook authenticates with). CC hooks cannot receive an
// isolated env, so the whole claude process inherits that token; it
// authenticates "a process in this print session", and the identifiers the
// hook emits are parser-bounded. Interactive sessions get neither.
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
    ...stripJournalCreds(baseEnv, { keepProviderKeys: true }),
    PATH: pathWithNodeBin(baseEnv.PATH, execPath),
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    // Raise the Bash-tool timeout floor above the 2-min built-in default so long
    // Codex reviews / test suites in bridge sessions aren't SIGTERM'd mid-run.
    // Operator-overridable via BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS in
    // the bridge env (read from baseEnv inside the helper; explicit wins).
    ...bashTimeoutEnv(baseEnv, warn ? { warn } : undefined),
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
    // Path of the 0600 file holding the read-proxy capability header. The
    // capability value itself never goes into the env or argv.
    MATRON_JOURNAL_PROXY_HEADER_FILE: journalProxyHeaderFile || '',
    ...(mode === 'print' ? { MATRON_PERMISSION_CARDS: baseEnv.MATRON_PERMISSION_CARDS || '' } : {}),
    // Env is fixed at spawn time; toggling the flag later requires
    // !restart to take effect.
    MATRON_BASH_TEE_ENABLED: showBashOutput ? '1' : '0',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir,
    // Load every MCP tool up front instead of letting Claude Code defer
    // them behind ToolSearch. With deferral on, the item_* tools (and the
    // rest of ask-user) reach the model only as names in a reminder, and a
    // tool that needs a schema lookup before its first call is a tool the
    // model reaches for last: a fleet survey on 2026-09-09 found not one
    // item_* call on any box other than the one whose sessions were
    // steered to them by hand, while questions went out as prose. The
    // cost is a larger (cached) tool prefix per request. Values: `false`
    // loads everything; `auto:N` defers past N% of context. Operators can
    // set it in the bridge's `.env` like any other setting (dotenv loads
    // that with `override: true` at startup, so `.env` beats the service
    // environment — the same rule as for every other bridge setting), and
    // whatever `process.env` holds by now wins over the default.
    ENABLE_TOOL_SEARCH: baseEnv.ENABLE_TOOL_SEARCH ?? 'false',
    // No MCP_TOOL_TIMEOUT default here. #254 briefly injected a 10-minute
    // backstop so a wedged MCP server couldn't hang a turn forever, but a
    // hard kill also cut off legitimately long calls (long builds, big test
    // runs, patient subagents). The slow-tool notices in index.js make a hung
    // call visible instead and leave the cancel decision with the user. An
    // operator who wants the hard cap can still set MCP_TOOL_TIMEOUT in the
    // bridge's own env; it passes through.
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
// App-server sessions have the ask-user MCP tools (item_*, mission_*) for
// tracker writes and the read proxy for search, so they get no journal token.
// The legacy exec transport has no Matron MCP tools and BRIDGE_CODEX.md's
// /items HTTP fallback authenticates with the token, so it keeps it.
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
    ...(appServer === false ? stripBridgeOnlySecrets(baseEnv) : stripJournalCreds(baseEnv, { keepProviderKeys: true })),
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
    MATRON_JOURNAL_PROXY_HEADER_FILE: journalProxyHeaderFile || '',
  };
}
