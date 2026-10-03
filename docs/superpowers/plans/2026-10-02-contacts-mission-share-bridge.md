# Contacts and read-only mission share — bridge plan (phase 1)

**Date:** 2026-10-02 · **Spec:** matron-journal
`docs/superpowers/specs/2026-10-02-matron-to-matron-sharing-design.md`
(build plan step 1) · **Companion:** matron-journal
`docs/superpowers/plans/2026-10-02-contacts-grants-phase1-journal.md`,
which owns the routes this calls (journal `docs/protocol.md`, "Contacts and
grants").

## Goal

An agent can, when its user asks, request a contact and offer a mission to
read; see where both stand; end either; and read a mission another person
shares with its user, rendered as that person's words.

## Rules the bridge keeps

1. **No tool answers a card.** `contact_add` and `mission_share` park an
   ask with the journal, which puts a card in front of the session's own
   user. The other person's accept is theirs. The journal refuses every
   agent on the answer routes; the bridge has no handler that calls them,
   and the Coordinator's `consent_list` / `consent_decide` are unchanged
   (two kinds, neither of them these).
2. **Agents may reduce access** (`mission_unshare`, `contact_remove`,
   `contact_block`), because the journal lets them. Unblock is not a tool.
3. **A shared mission is peer text.** Names and titles go through
   `peerField`; multi-line bodies are rendered as a block with a marker on
   every line (`quoteBlock`); the header says whose words they are and that
   they are not instructions.

## Files

| File | What |
|---|---|
| `lib/sharing-client.js` | HTTP client (reuses `createJournalRequester`) |
| `lib/sharing-tools.js` | Loopback handlers, mounted at `/sharing/<op>` |
| `lib/sharing-format.js` | Renderers and the journal-refusal sentences |
| `ask-user.js` | `contact_list`, `contact_add`, `contact_remove`, `contact_block`, `mission_share`, `mission_unshare`, `mission_shares`; `mission_list {shared}`, `mission_get {shared_by, num}` |
| `index.js` | Client, handlers, route matcher |
| `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`, `coordinator/procedures/20-…` | What agents are told |
| `test/sharing-tools.test.js` | Handlers, client paths, renderers |

## Tools

| Tool | Journal call |
|---|---|
| `contact_list {users?}` | `GET /contacts` (+ `GET /contacts/users`) |
| `contact_add {user}` | `POST /contacts {user, convo_id}` → 202 parked |
| `contact_remove {contact}` / `contact_block {contact}` | `DELETE /contacts/:id` / `POST /contacts/:id/block` |
| `mission_share {contact, mission?, level?}` | `POST /missions/:id/shares {contact, level:'read', convo_id}` → 202 parked |
| `mission_unshare {grant? \| contact, mission?}` | `DELETE /grants/:id` (looked up through `GET /missions/:id/shares` for a contact) |
| `mission_shares` | `GET /grants` |
| `mission_list {shared: true}` | `GET /missions?scope=shared` |
| `mission_get {shared_by, num}` | `GET /lookup?user=&num=` then `GET /missions/:id` |

`mission` defaults to the conversation's current mission (the missions
handlers' `resolveMission`). The owner's number of a shared mission is
theirs, not this user's, so it is only ever used together with `shared_by`.

## Not in this phase

Foreign turns and the restricted tool set (phase 2), contribute and
hand-over (phase 3), answering cards in the apps (phase 4).
