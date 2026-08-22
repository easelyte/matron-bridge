# Auto permission mode by default + Matron permission prompt tool

**Date:** 2026-08-10
**Status:** Approved (design) — pending implementation plan

## Problem

The bridge launches every Claude session with `--dangerously-skip-permissions`
(index.js print-mode and iv-mode spawn args; `lib/pre-trust.js` even primes
`bypassPermissionsModeAccepted` so the warning modal never shows). The bridge
runs on the user's Mac with their full account, drives sessions that read the
web and external MCP content, and is steered remotely over chat — a
prompt-injection blast-radius setup with no gate at all.

Claude Code's `auto` permission mode
(https://code.claude.com/docs/en/auto-mode-config) provides a background
classifier that auto-approves routine work and blocks irreversible/destructive/
exfiltration actions without prompting. `--permission-mode auto` is supported
with `-p` (print mode). The remaining user-prompt cases (explicit
`permissions.ask` rules, MCP tools marked as requiring interaction, and the
fallback after repeated classifier blocks) need `--permission-prompt-tool` in
print mode — without one, repeated blocks abort the session.

## Decisions (approved in chat)

- Base mode is **`auto`**, not `acceptEdits`.
- **Zero prompts by default**: the bridge injects no `permissions.ask` rules.
  Users add their own in `~/.claude/settings.json` if they want checkpoints
  (e.g. `Bash(git push *)`).
- **Auto mode is the default** for print-mode sessions — it replaces
  `--dangerously-skip-permissions` outright. A per-session `--bypass` flag is
  the escape hatch (and the rollback lever): it restores the old
  skip-permissions spawn for that session. Its counterpart `--auto` explicitly
  returns a bypassed session to auto mode (needed so `/restart --auto` can
  undo a persisted `--bypass`); with neither flag, restart/resume preserve the
  session's current mode.
- Permission cards offer **Allow once / Always allow this tool (session) /
  Deny**; unanswered cards **deny after 5 minutes**.
- **Print-mode only** in this iteration. iv-mode sessions keep bypass
  unchanged for now (TUI permission dialogs via prompt-detector are the
  follow-up phase). `/mode interactive` on an auto-mode session warns that
  interactive mode currently runs with permissions bypassed.
- Known trade-offs accepted: Haiku-class models don't support auto mode (such
  sessions fall back to `default` mode and prompt through the card — warned at
  start); early classifier false positives are fixed via the user's
  `~/.claude/settings.json` `autoMode.environment`, per-denial retry intent,
  or `--bypass`.

## Architecture

```
claude -p --permission-mode auto --permission-prompt-tool mcp__ask-user__permission_request
   │  (permission needed: ask rule match, requires-interaction MCP tool,
   │   or classifier fallback)
   ▼
ask-user.js permission_request tool
   │  POST /permission-request {roomId, toolName, input, toolUseId}
   ▼
bridge (index.js)                       ──► Matron button card via
   pendingPermissionRequests map            sendButtonMessage/publishPrompt
   │  ◄── tap arrives as journal prompt_reply, choice = perm:<id>:<verdict>
   ▼
GET /permission-request/:id  (tool polls every 500ms)
   │
   ▼
tool returns JSON string Claude Code expects:
   {"behavior":"allow","updatedInput":<input>} | {"behavior":"deny","message":"…"}
```

This mirrors two existing patterns exactly: the `request_secret` POST+poll
shape in `ask-user.js` (`/secret`, `GET /secret/:id`), and the value-namespaced
button cards (`timer:cancel:<id>`, `model:<alias>`) that ride the journal
`prompt_reply` path (`lib/picker-dispatch.js`, `lib/journal-input-router.js`).

## Components

### 1. `ask-user.js` — new `permission_request` tool

- Input schema: `tool_name` (string), `input` (any), `tool_use_id` (string,
  optional), `permission_suggestions` (any, optional — accepted and ignored so
  newer CLI payloads don't fail validation).
- POSTs `/permission-request`. Response is either `{behavior:'allow'}`
  (session-allowlisted tool — short-circuit, no card) or `{requestId}`.
- Polls `GET /permission-request/:id` every 500ms up to
  `PERMISSION_PROMPT_TIMEOUT_MS` (default 300 000).
- Returns text content that is exactly the JSON string Claude Code parses:
  - allow: `{"behavior":"allow","updatedInput":<original input>}`
  - deny: `{"behavior":"deny","message":"<reason>"}`
- **Fail closed**: bridge unreachable, non-OK response, or timeout ⇒ deny with
  an explanatory message (timeout message tells Claude the user didn't answer
  within 5 minutes and it may continue other work).

### 2. `lib/permission-prompt.js` — new pure module (unit-tested)

- `renderPermissionCard({toolName, input})` → `{plain, html}`. Shows the tool
  name and an input preview: for `Bash`, the `command` (and `description` when
  present); otherwise compact JSON. Preview truncated to ~500 chars.
- `permissionButtons(requestId, toolName)` → buttons with values
  `perm:<id>:allow`, `perm:<id>:always`, `perm:<id>:deny` and labels
  `Allow once`, `Always allow <tool> (session)`, `Deny`.
- `parsePermTap(value)` → `{requestId, verdict}` or `null` (defense-in-depth
  validation like `parsePickerValue`).
- `createPermissionRegistry({setTimeout, clearTimeout})` — pending-request
  store: `create({roomId, toolName})` → `{id}`; `answer(id, verdict)` →
  `{toolName, behavior}` or null (unknown/expired/already answered);
  `read(id)` → `{answered, behavior, message}` and deletes on answered read
  (the `/secret/:id` shape); entries expire (deny) after 360 s so the map
  never leaks. Injectable timers per `room-reply-waiters.js` convention.

### 3. `index.js` wiring

- Routes: `POST /permission-request` (session lookup by `roomId`; auto-allow
  check against `session.permAllowedTools`; create registry entry; post card)
  and `GET /permission-request/:id` (poll endpoint).
- Tap dispatch: in the journal `prompt_reply` path where `timer:` values are
  recognized, add `perm:` handling — resolve the registry entry, on `always`
  add the tool name to `session.permAllowedTools` (in-memory `Set`, per
  session, not persisted) then allow, and mirror the outcome into chat like
  other answered prompts. Tap on an expired/answered card → short informative
  reply, no crash.
- Print-mode spawn args (default): replace
  `--dangerously-skip-permissions` with `--permission-mode auto` and
  `--permission-prompt-tool mcp__ask-user__permission_request`. Keep
  `--disallowed-tools AskUserQuestion` and all other args unchanged. Add
  `permissions.allow` entries for the bridge's own MCP servers
  (`mcp__ask-user`, `mcp__show-file`) to the existing `--settings` JSON so the
  plumbing never generates cards about itself. With `--bypass`, spawn args are
  exactly what they are today.

### 4. `--bypass` session flag

- Parsed wherever `extractMcpExtraFlags` runs today (`/start`, `/restart`,
  `/resume`, `/workdir`), with the same unicode-dash normalization; new pure
  helper in `lib/mcp-config.js` (`extractBypassFlag(tokens)` →
  `{bypass: true|false|null, rest}` — `--bypass` → true, `--auto` → false,
  neither → null so callers fall back to the persisted/carried value).
- Persisted (`bypassMode`) via `persistSession` so `/restart` and resume keep
  it. Existing persisted sessions have no flag and therefore resume in auto
  mode — the new default — which is the intended migration.
- `/mode interactive` on an auto-mode session warns: "heads-up — interactive
  mode currently runs with permissions bypassed (auto mode support is coming)."
  iv-mode spawns are unchanged.
- Session-start confirmation mentions the mode (e.g. "🛡 auto permissions" /
  "⚠️ permissions bypassed"). If the resolved model is one auto mode doesn't
  support (Haiku-class), post a warning that the session may fall back to
  `default` mode and prompt frequently.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Bridge API down / non-OK | Tool denies (fail closed) with reason |
| No tap within 5 min | Tool denies; card expires bridge-side at 6 min |
| Tap after expiry/answer | Informative no-op reply in chat |
| Unknown session roomId | 404 → tool denies |
| Repeated classifier blocks | Fallback prompt routes through the tool (card in Matron) instead of aborting the `-p` session |
| Unsupported model | Warning at session start; prompts route through the card either way |

## Testing (vitest)

- `test/permission-prompt.test.js`: button building/labels/values, tap-value
  parse round-trip (incl. malformed/foreign values → null), card rendering for
  Bash vs generic tools + truncation, registry lifecycle (create → answer →
  consumed read; always-verdict reports toolName; expiry denies; double-answer
  null).
- `lib/mcp-config.js` tests extended: `--bypass` extraction, unicode-dash
  form, positional preservation, composition with `--browser`/`--share`.
- Spawn-arg assembly extracted pure (e.g. `permissionSpawnArgs(bypass)`) and
  unit-tested: default → auto-mode pair + prompt tool, bypass → the
  skip-permissions flag.
- `ask-user.js` handler kept thin (existing convention: not unit-tested).

## Out of scope

- iv-mode auto-mode support (TUI permission dialogs via prompt-detector) —
  later phase; iv-mode spawns keep bypass until then.
- Persisting the "always allow" set across restarts.
- Bridge-injected `autoMode.environment` / `ask` rules — user's own
  `~/.claude/settings.json` governs.
- **Deny-with-message via free text** (follow-up): a plain text reply to a
  pending permission card becomes `{"behavior":"deny","message":"<text>"}`,
  so the user can deny *and* steer Claude ("no — use rg instead of grep") in
  one message. Safe to route because cards only appear while Claude is blocked
  mid-turn, so any inbound text while a card is pending is almost certainly
  about the card. v1 is buttons-only; needs an inbound-text waiter check in
  the room message handler (same shape as `room-reply-waiters`).
