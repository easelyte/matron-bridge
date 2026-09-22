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
// IMPORTANT — this does NOT apply to interactive/print SESSION spawns. The
// shipped system prompt (BRIDGE_CLAUDE.md "Searching the journal",
// BRIDGE_CODEX.md "Journal history") instructs every session to authenticate
// the journal's /search, /convo/:id/messages and /help routes — and the /items
// HTTP fallback — with the raw JOURNAL_TOKEN_FILE/JOURNAL_TOKEN. There is no MCP
// search tool and no loopback-API proxy for those routes, so a session
// genuinely needs the token. Stripping it from a session spawn would break
// documented cross-box journal search. (A session's subagents inherit its env,
// so denying the token to bounded-task subagents while keeping it for the
// session's own search cannot be done at the bridge spawn layer — that is the
// "separate, unshipped" server-side per-device capability flagged in
// lib/agent-chat.js. See loop #750's PR body.)
//
// Use this ONLY on bridge-controlled child spawns that run a fixed, journal-free
// job: the `claude -p /usage` limits one-shot and the codex app-server
// account/model/rate-limit reader. Those default to `...process.env` and thus
// carry the full-read token for no reason.
//
// Scope note: this strips ONLY the full-journal read credential. JOURNAL_WS_URL,
// JOURNAL_CONTROL_CONVO_ID and JOURNAL_CURSOR_FILE are a URL / convo id / cursor
// path, not credentials. HMAC_SECRET signs file/secret deep links (a different
// capability) and is out of scope for this change.
export const JOURNAL_CHILD_STRIPPED_KEYS = ['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE'];

// Delete the full-journal read credential from `env` in place and return it.
// Callers MUST pass a copy (e.g. stripJournalCreds({ ...process.env, ... }))
// when the source is process.env — this mutates, and clobbering the bridge's
// own process.env would break its journal auth.
export function stripJournalCreds(env) {
  if (!env || typeof env !== 'object') return env;
  for (const key of JOURNAL_CHILD_STRIPPED_KEYS) delete env[key];
  return env;
}
