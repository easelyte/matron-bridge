// Scope the journal read credential out of bridge-spawned child environments
// that have no reason to hold it.
//
// The bridge holds JOURNAL_TOKEN (or JOURNAL_TOKEN_FILE, which resolves to the
// same token) — a FULL-journal READ credential: it reads every conversation
// transcript via /snapshot and all roster metadata via GET /roster (see the
// boundary note in lib/agent-chat.js). The bridge process uses it for its own
// journal dual-post / roster fetches (resolveJournalToken() -> Bearer auth in
// lib/journal-rpc.js / journal-publisher.js).
//
// CLAUDE SESSION + INTERACTIVE spawns ARE stripped (loop #765): the bridge now
// runs a loopback journal READ proxy (lib/journal-read-proxy.js, mounted on the
// MATRON_BRIDGE_API_PORT loopback API), and BRIDGE_CLAUDE.md "Searching the
// journal" points sessions at that tokenless proxy for /search,
// /convo/:id/messages and /help. So a Claude session (and its subagents, which
// inherit its env) no longer needs — and must not hold — the full-read token.
//
// CODEX SESSION spawns (loop #781, lib/spawn-env.js buildCodexSpawnEnv): the
// default app-server transport IS stripped — it has the ask-user MCP item/mission
// tools and reaches search through the same read proxy. Only the legacy exec
// transport (MATRON_CODEX_TRANSPORT=exec) keeps the token: it has no Matron MCP
// tools, and BRIDGE_CODEX.md's `/items` HTTP fallback authenticates with it.
// Closing that last case needs the proxy to cover the write-side `/items` routes.
//
// Also use this on bridge-controlled child spawns that run a fixed, journal-free
// job: the `claude -p /usage` limits one-shot and the codex app-server
// account/model/rate-limit reader. Those default to `...process.env` and thus
// carry the full-read token for no reason.
//
// Scope note: this strips ONLY the full-journal read credential. JOURNAL_WS_URL,
// JOURNAL_CONTROL_CONVO_ID and JOURNAL_CURSOR_FILE are a URL / convo id / cursor
// path, not credentials.
export const JOURNAL_CHILD_STRIPPED_KEYS = ['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE'];

// Secrets only the bridge process itself (and the viewer, which loads the same
// .env) ever uses. HMAC_SECRET signs file/secret/sensitive-data viewer links;
// signing happens in-process (index.js, lib/viewer-tokens.js), and no MCP child
// needs it (show-file uses its own SHOW_FILE_TOKEN). Unlike the journal token
// there is no Codex fallback that depends on it, so it is stripped from EVERY
// child, Codex sessions included. It leaked once: a dev server started inside a
// session inherited it and Turbopack persisted the env into .next/dev/cache.
export const BRIDGE_ONLY_SECRET_KEYS = ['HMAC_SECRET'];

// Return a COPY of `env` without the bridge-only secrets. Same fail-safe
// contract as stripJournalCreds below.
export function stripBridgeOnlySecrets(env = process.env) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripBridgeOnlySecrets: env must be an object');
  }
  const out = { ...env };
  for (const key of BRIDGE_ONLY_SECRET_KEYS) delete out[key];
  return out;
}

// Return a COPY of `env` with the full-journal read credential removed. This is
// a credential helper, so it fails SAFE, never open:
//   - it owns the copy, so it never mutates the caller's object — in particular
//     it can be handed `process.env` directly without clobbering the bridge's
//     own journal auth;
//   - a missing argument defaults to a sanitized copy of `process.env` (a child
//     env with the credential removed), never an inherited full environment;
//   - an explicitly invalid (non-object, non-nullish) argument throws rather
//     than silently returning something that might still carry the credential.
// The net guarantee: the returned object never contains JOURNAL_TOKEN /
// JOURNAL_TOKEN_FILE, whatever the caller does. It also drops the bridge-only
// secrets (BRIDGE_ONLY_SECRET_KEYS): every caller is a child spawn.
export function stripJournalCreds(env = process.env) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripJournalCreds: env must be an object');
  }
  const out = stripBridgeOnlySecrets(env ?? {});
  for (const key of JOURNAL_CHILD_STRIPPED_KEYS) delete out[key];
  return out;
}
