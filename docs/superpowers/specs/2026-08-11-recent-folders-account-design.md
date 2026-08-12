# recent_folders: report the logged-in account

**Date:** 2026-08-11
**Status:** Approved
**Depends on:** 2026-08-10 agent-spawn bridge + capacity design (the `activity`/`limits` blocks)

## Problem

The `recent_folders` RPC reply now carries capacity blocks (`activity`,
`limits`) so both agents (via the journal's `spawn_targets`) and humans (via
the app's New Chat chooser, which receives the reply verbatim over the RPC
relay) can judge where to start a session. What neither can see is **which
account the box is logged in to** — the thing that decides whose quota a new
session burns. A user with boxes split across accounts can't tell them apart
in the chooser.

## Design

Add one more optional block to the `recent_folders` reply, alongside
`activity` and `limits`:

```json
"account": { "email": "pat@yearbook.com" }
```

- **Source:** the existing `getAccountEmail()` cache (index.js), which
  already reads `~/.claude.json` → `oauthAccount` on the limits-refresh
  cadence for session-status frames. No new I/O path, no new cache.
- **All-or-nothing:** if the cached email is null/empty (file unreadable,
  not logged in, Codex-only box), the `account` key is **omitted entirely**
  (never null, never an empty object) — same convention as
  `activity`/`limits`.
- No `display_name`: the email is the identity signal the chooser needs;
  the existing cache stores only the email, and widening it is not worth it.

## Non-goals

- The journal's `spawn_targets` sanitiser does **not** pass `account`
  through yet — agents keep choosing on activity/limits alone. A follow-up
  journal change can add it; the client path needs no journal change because
  the RPC relay forwards the reply verbatim.

## Testing

Extend `test/journal-rpc-handlers.test.js`'s `recent_folders` suite: email
present → `account: {email}` in the reply alongside `activity`/`limits`;
email null → key omitted.
