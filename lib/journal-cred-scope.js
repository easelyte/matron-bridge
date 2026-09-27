// Credential scoping for bridge-spawned child processes.
//
// Three kinds of bridge secret reach children through `...process.env` today:
//
//   - HMAC_SECRET signs the viewer's file / secret / sensitive-data links. Only
//     the bridge process (index.js, lib/viewer-tokens.js) and the viewer (which
//     loads the same .env itself) use it. No child needs it: the show-file MCP
//     server carries its own per-session SHOW_FILE_TOKEN. Yet every Claude and
//     Codex session inherited it, and anything those sessions start inherits it
//     in turn; a dev server run inside a session can persist its environment to
//     disk (e.g. a bundler's on-disk cache). Anyone holding it can mint viewer
//     links for any path the viewer serves. Stripped from EVERY child.
//
//   - JOURNAL_TOKEN / JOURNAL_TOKEN_FILE is the bridge's agent credential for
//     the journal. It reads every conversation the user has (search, transcript
//     reads, roster), not just this box's. Sessions reach journal search
//     through the bridge-local read proxy (lib/journal-read-proxy.js), so
//     Claude sessions and app-server Codex sessions do not get it (see
//     lib/spawn-env.js). Only the legacy exec Codex transport keeps it, for
//     BRIDGE_CODEX.md's /items HTTP fallback. Children that run a fixed,
//     journal-free job (the `claude -p /usage` one-shot, the codex app-server
//     account reader, ffmpeg/ffprobe, whisper-cli, the sleep command, `ps`)
//     never get it.
//
//   - OPENAI_API_KEY / GEMINI_API_KEY are the summary-model keys (conversation
//     titles and TOC summaries run in the bridge process). Fixed-job children
//     never use them, so stripJournalCreds removes them too. Agent sessions
//     keep them: they are the user's own provider keys, and Codex can
//     authenticate with OPENAI_API_KEY (docs/codex.md), so the codex account
//     reader keeps them as well (keepProviderKeys).
//
// This stops accidental spread. It is not an OS boundary: a same-uid child
// that goes looking can still read the bridge's .env or token file.
//
// Non-credential journal settings (JOURNAL_WS_URL, JOURNAL_CONTROL_CONVO_ID,
// JOURNAL_CURSOR_FILE) are left alone.
//
// Both helpers fail SAFE, never open:
//   - they own the copy, so they never mutate the caller's object; in
//     particular they can be handed `process.env` directly without clobbering
//     the bridge's own credentials;
//   - a missing argument defaults to a sanitized copy of `process.env`, never
//     an inherited full environment (Node treats `env: undefined` as "inherit
//     everything", so a helper that passed undefined through would silently
//     restore the secrets);
//   - an explicitly invalid (non-object, non-nullish) argument throws.

export const BRIDGE_ONLY_SECRET_KEYS = ['HMAC_SECRET'];

export const JOURNAL_CHILD_STRIPPED_KEYS = ['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE'];

export const PROVIDER_API_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY'];

// A COPY of `env` without the bridge-only secrets. For the legacy exec Codex
// transport, which keeps the journal token its /items fallback relies on.
export function stripBridgeOnlySecrets(env = process.env) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripBridgeOnlySecrets: env must be an object');
  }
  const out = { ...env };
  for (const key of BRIDGE_ONLY_SECRET_KEYS) delete out[key];
  return out;
}

// A COPY of `env` without the journal credential, the bridge-only secrets and
// (unless keepProviderKeys) the summary-model provider keys. For every other
// child spawn; agent sessions and the codex account reader pass
// keepProviderKeys.
export function stripJournalCreds(env = process.env, { keepProviderKeys = false } = {}) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripJournalCreds: env must be an object');
  }
  const out = stripBridgeOnlySecrets(env ?? {});
  for (const key of JOURNAL_CHILD_STRIPPED_KEYS) delete out[key];
  if (!keepProviderKeys) for (const key of PROVIDER_API_KEYS) delete out[key];
  return out;
}
