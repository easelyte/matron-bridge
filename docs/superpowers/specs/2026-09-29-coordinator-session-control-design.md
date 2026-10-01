# Coordinator session control: context size, /model, /compact, carry on

**Date:** 2026-09-29
**Status:** §1 read path and §3 stall reporting implemented (this PR + matron-journal PR #96). §2 control path and §4 automatic carry-on: all six design questions answered by Dan on 29 Sep (see "Decisions" at the end, which supersede §2 where they differ); being built
**Depends on:** 2026-07-15 agent RPC design (journal-originated requests), 2026-08-09 agent spawns design (the `spawn_request` relay shape), 2026-09-23 Coordinator redesign, 2026-06-10 `/model` design, 2026-08-06 compact/queue design

## Problem

Dan (voice notes, 29 Sep): the Coordinator should be able to manage the
health of the user's other agent sessions —

1. **see each session's context size**: tokens in use against the window,
   and the model;
2. **switch a session's model**, the way `/model <alias>` does in that chat;
3. **compact a session** (`/compact`), at its next idle point, never mid-turn;
4. **tell a session to carry on** when it has stalled on a usage limit, and
   again once that limit has reset.

Today the Coordinator can only see `session_state` (running / waiting / done)
per conversation and a box's account limits, and its only lever on another
session is an agent chat room, which costs the target's context and does
nothing for a stalled session.

## What already exists (verified 2026-09-29)

**Context and model are already measured, per conversation.** Every Claude
session tracks `session.currentModel` (from each assistant record's
`message.model`) and `session._lastContextTokens` (input + cache-read +
cache-create tokens of the last request, `lib/session-status.js`
`contextTokensFromAssistantEvent`). Codex sessions get `_lastContextTokens`
and the real `_codexContextWindow` from `thread/tokenUsage/updated`.
`journalStatus(session)` (`index.js` ~1620) builds
`{model, context:{tokens, window, pct}, limits[], effort, workdir, …}` with
`buildSessionStatus` and publishes it as the **ephemeral `status` op**
(`journal-publisher.js publishStatus`) — at turn end, every 5 s mid-turn,
and right after `compact_boundary`. Claude's window is guessed from the
model name (1M for fable/mythos/`[1m]`, else 200k); Codex omits `context`
when its window is unknown.

**The journal keeps that status, but only in memory.** `makeStatusCache`
(journal `src/ws.js`) is a 2048-entry LRU replayed to a client that opens
the conversation. Nothing persists it; `GET /roster` and `mission_get`'s
conversation rows carry no model or context. A journal restart forgets every
gauge until the next turn end.

**The three actions already have local handlers.**

| Action | Claude iv-mode | Claude print mode | Codex |
|---|---|---|---|
| `/model X` | in-process: types `/model X` into the PTY (`lib/model-command.js`), applies on the next message | idle: `recreateSession` with `--model` + `--resume` (history kept); busy: parked in `session._deferredCommandText` and replayed at turn end | in-process (`applyModelSwitch`, refuses while busy) |
| `/compact` | typed straight into the PTY, even mid-turn (`isIvSlashPassthrough`) | queued at the **front** of `session.queuedMessages`, sent alone at the next idle point (`lib/compact-priority.js`, `compactBatchSize`) | native `thread/compact/start` |
| a text turn | `session.iv.sendText` or queued if busy | queued if busy, flushed at turn end | `turn/start` |

Busy/idle is `session.busy`, cleared at exactly three turn-end points
(`result` event, the Stop-hook `/turn-end` route, `finishCodexTurn`), each
of which runs `dispatchDeferredCommand(session)` and then
`flushPendingSessionQueue`. So "at the next idle point" is an existing
primitive for print mode, but iv-mode `/compact` and `/model` are typed
live today — a Coordinator-driven action must not do that.

**A limit stall is visible, but not recognised.** When the account's
5-hour / weekly meter is exhausted, Claude Code ends the turn with an
assistant text such as
`You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.`
(also `Error during compaction: You've reached …`). The bridge posts it as
ordinary assistant text and marks the session `waiting`; nothing flags the
stall or reads the reset time, although `limits[]` in the status frame
carries `resets_at` per meter (`lib/usage-limits.js`).

**Cross-box calls only go through the journal.** A bridge cannot send
`agent_request` (client connections only). The journal itself is an RPC
caller (`src/rpc-broker.js issue()`, `from_device_id: 0`) for `recent_folders`
and spawn's `start`; the bridge answers in `lib/journal-rpc.js`
(`recent_folders`, `local_memories`, `local_memory_get`, `start`). Spawn and
invites are the two existing "agent → journal → other agent" relays: a WS
op from the asking bridge, journal-side checks (same user, own
conversation, privacy, pending-ask cap), optional consent card, wake of a
sleeping box, then a journal-originated RPC and an outcome frame back.

**The Coordinator is a journal fact.** `user_settings.coordinator_convo_id`,
readable by any of the user's devices via `GET /coordinator`; the bridge
caches it (`lib/coordinator.js`) and flags `session.coordinator`. No route or
tool today is gated on it — the Coordinator's difference is its prompt,
its disabled edit tools and its default model.

## Design

Two independent halves: a **read path** (context stats on the roster) and a
**control path** (a Coordinator-only relay for the three actions). Each is
its own PR pair (journal, bridge); the read path has no bridge protocol
change at all.

### 1. Read path: persist the status header, show it on the roster

**Journal.** Persist a subset of every accepted `status` op alongside the
in-memory replay cache: a new table

```sql
CREATE TABLE conversation_status (
  convo_id     TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  model        TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  context_pct  INTEGER,
  stall_json   TEXT,          -- see §3; null when not stalled
  limits_json  TEXT,          -- the frame's limits[] (id,label,percent,resets_at), ≤ 2 KiB
  reported_at  INTEGER NOT NULL
)
```

written from the same `status` handler (`ws.js` ~1803) with the same
ownership check, latest-wins, one write per accepted frame (no journal-side
throttle: the bridge's own 5 s mid-turn repaint throttle bounds the rate,
and the write is one SQLite upsert). Implemented as a JSON-per-row table
(`convo_id, user_id, reported_at, status`) like `device_status`, not the
column layout sketched above. `GET /roster`
conversations gain `status: {model, context:{tokens,window,pct}, stall?,
limits?, reported_at}` (omitted until first report); `mission_get`'s
conversation rows (`src/missions.js` SELECT) gain the same block. Both are
scoped by the existing privacy predicate. `GET /snapshot` is unchanged.

**Bridge.** `agent_roster` and `mission_get` render the block:
`(ang, waiting · opus[1m] · 87k/1M 9% · reported 2 min ago)`. A row whose
status has a model but no gauge (a Codex session before its first turn, a
bridge that has only sent its spawn header) shows `context unknown`; a row
with **no** status at all (an old journal, a session that has never
reported) keeps the unchanged pre-feature line rather than repeating
"context unknown" down a whole roster. The status frame itself gains
`stall` (§3) and, for Codex, nothing new: Codex reports `context` only when
`modelContextWindow` is known, which stays "unknown" otherwise. No new
tool; the Coordinator already calls both.

**Apps.** Out of scope here, but the same roster block is what the apps
would render for a "context" column later.

### 2. Control path: `session_control` relay

One journal WS op, mirroring `spawn_request` without the consent card by
default:

```json
{ "op": "session_control", "request_id": "…", "from_convo_id": "<coordinator convo>",
  "target_convo_id": "<session convo>",
  "action": "set_model" | "compact" | "carry_on",
  "model": "sonnet",              // set_model only, ≤ 64 chars, validated by the target bridge
  "message": "carry on with …",   // carry_on only, ≤ 2000 chars, sanitised like spawn.task
  "when": "now" | "after_limit_reset",   // carry_on only, default now
  "reason": "context at 92%" }     // optional, ≤ 200 chars, shown in the target chat
```

**Journal checks, in order**: agent connection (`forbidden` for clients);
`from_convo_id` is a top-level conversation this device owns **and** equals
`user_settings.coordinator_convo_id` (`forbidden`, detail `not_coordinator`)
— the one place the Coordinator role gates a route; `target_convo_id`
resolves, same user, top-level, has an `agent_device_id`, visible under
the caller's privacy regime (`not_found`, indistinguishable); target is not
the Coordinator itself and not a room (`bad_request`). Then
`wakeIfOffline(target device)`: an asleep box is woken and the request is
parked up to `MATRON_SPAWN_WAKE_WAIT_MS` like spawn approval;
`agent_unreachable` only when no wake is possible. Then a journal-originated
RPC `session_control {convo_id, action, model?, message?, when?, reason?,
from_convo_id, from_name}` to the target device, 30 s timeout, and the
reply relayed to the asking bridge as
`{kind:'session_control', event:'result', request_id, ok, result?|error?}`.
Nothing is journaled by the journal; the target bridge writes the visible
record (below). A `session_control` row is **not** counted against the
pending-ask cap (nothing awaits the user) — unless Dan chooses per-action
consent (question A), in which case it is parked `awaiting_user` exactly
like spawn, with a card and a tracker item, and counted.

**Target bridge** (`lib/journal-rpc.js` → new `lib/session-control.js`,
pure planner + thin wiring):

- resolve the session by conversation id. The sessions this feature is for
  are mostly **not live**: the idle reaper ends a session's process after
  about an hour of silence and a box that was woken has no sessions running
  at all, only persisted ones. So a conversation that this bridge owns but
  does not currently run is **resumed on demand** (the same path a user's
  message into an idle conversation takes — `journalRouteTextToSession`
  respawns from the persisted session), and the action is then parked for
  its first idle point. `not_found` only when the conversation is not this
  bridge's; `gone` when its persisted state is absent or the session ended
  (`session_state: done`);
- **never act mid-turn**: if `session.busy` or otherwise occupied
  (`_awaitingInputReady`, `waitingForAnswer`, `pendingInteractivePrompt`),
  park the action and answer `{ok:true, applied:'deferred'}`; otherwise
  apply now and answer `{ok:true, applied:'now'}`. Parking is one slot per
  action kind on the session (`deferredControls: {set_model?, compact?,
  carry_on?}`, a later request of the same kind replaces the earlier one),
  drained by one `drainDeferredControls(session)` call at **every** point
  where the session becomes free: the three turn-end hooks (before
  `dispatchDeferredCommand`), and the moments the occupied flags clear
  (`_awaitingInputReady` on terminal ready, `waitingForAnswer` /
  `pendingInteractivePrompt` when the prompt is answered) — an occupied
  session is already past its turn end, so a turn-end-only drain would wait
  a whole extra turn. Drain order: `set_model` last, because a print-mode
  switch recreates the process: `compact` and `carry_on` are applied (or
  queued into `queuedMessages`, which `recreateSession` carries across)
  first, and the slot object itself is carried to the replacement session
  the way `queuedMessages` is, so nothing parked is lost to a recreate;
- `set_model`: validate with `isValidModelArg` (Claude) or against the
  Codex model catalogue; apply through the existing `applyModelSwitch`
  path (iv: typed switch; print: recreate with `--model`; Codex: in-process).
  Errors: `bad_model`, `busy_codex` (Codex refuses a switch mid-turn; parked
  instead), `unsupported` (print-mode session in a state that cannot
  recreate);
- `compact`: Claude print → existing queue-front path; Claude iv → typed
  `/compact` **only at idle** (never the live passthrough); Codex → native
  compact. Second compact while one is queued → `already_queued`;
- `carry_on`: `when: now` → the message enters the session's queue as a
  turn attributed to the Coordinator (`[from the Coordinator] carry on: …`),
  the same shape as a spawn's opening turn. `when: after_limit_reset` →
  parked until the session's `stall.resets_at` (§3) has passed (timer,
  persisted in the session's state file so a bridge restart re-arms it; a
  box that sleeps fires it on the next boot's resume). If the session is
  not stalled, `after_limit_reset` is answered `not_stalled`; if it is
  stalled but no meter gave a reset time (`stall.resets_at` absent), it is
  answered `no_reset_time` with the stall block, so the Coordinator can
  choose `when: now` later or switch the model instead of a timer that can
  never fire. A `carry_on` never resets the self-restart budget (it is not
  user input).
- **Visible record** in the target chat, whatever the outcome: a notice
  `🛠 Coordinator: compacting this session once this turn finishes — context at 92%`
  / `… switched model to Sonnet` / `… carry on (after the Fable limit resets at 15:00)`,
  posted with the existing `notice()` helper, so Dan sees who did what and
  why in the session itself. The Coordinator's tool result says the same
  in one line; the `result` frame arrives as a later turn when the action
  was deferred or the box had to wake (like spawn outcomes).

**Coordinator's bridge** (`ask-user.js` + `lib/agent-spawn.js`-style
sender): three MCP tools, all refused locally with a clear message when
this session is not the Coordinator (the journal enforces it anyway).
Context is read from `agent_roster` / `mission_get` (§1); there is no
separate read tool unless Dan wants one:

- `session_set_model(convo_id, model, reason?)`
- `session_compact(convo_id, reason?)`
- `session_carry_on(convo_id, message, when?, reason?)`

Each returns immediately ("sent to <box>; applies at its next idle point")
and the outcome arrives as a turn. `BRIDGE_COORDINATOR.md` gains a
"Keep sessions healthy" section: when to compact (context ≥ ~80%), when to
switch a stalled session to another model versus waiting for the reset,
and never to act on a `running` session expecting an immediate effect.

### 3. Recognising a limit stall

The bridge sets `stall` in the status frame when a parent assistant record
whose only content is one text block is a usage-limit error: structurally,
`isApiErrorMessage: true` together with `error: 'rate_limit'` or
`apiErrorStatus: 429` (the record observed on this box; its `message.model`
is the placeholder `<synthetic>`, which is never adopted), or, for stream
shapes that strip those fields, a sole text matching
`/^(error during compaction: )?(you've reached your … limit|claude ai usage limit reached)/i`.
An `isApiErrorMessage` record for any other error (a 500, an overload) is
not a stall. The frame carries:

```json
"stall": { "kind": "usage_limit", "model": "claude-fable-5-1",
           "resets_at": "2026-09-29T15:00:00Z", "since": 1790690000000 }
```

`resets_at` comes from the `limits[]` line that filled: the fullest meter
(100% first) that carries a reset time — the message names a model
("Fable limit"), which is often the weekly per-model meter, not the 5-hour
session one — else the session meter, else any line with a reset; omitted
when no meter can say. The bridge refreshes the meters at the moment of the
stall and republishes once the reset time is known, since the shared cache
can be minutes old. Cleared on the
next successful assistant record or model switch. Codex: its rate-limit
text differs and is not matched in v1 — reported as unknown. The journal
persists it (§1) so the roster shows `stalled: Fable limit, resets 15:00`
and the Coordinator can decide between `session_set_model` (switch away)
and `session_carry_on … after_limit_reset`.

Optional (question D): the bridge itself auto-sends "carry on" at
`resets_at` for a stalled session, without the Coordinator, and only
announces it.

## Questions filed for Dan (tracker, mission #4644)

- **A. Permissions and consent.** Journal-enforced: only the Coordinator's
  conversation, only the same user's sessions, never itself. Standing
  permission (no card) for all three actions, with the record in the
  target chat — or a consent card per action like spawn? Recommendation:
  standing for `compact` and `carry_on`, standing for `set_model` too (it
  is reversible and visible), no cards.
- **B. How each action appears in the target chat.** A one-line notice
  (`🛠 Coordinator: …reason`) from the bridge, plus the queued carry-on
  text shown as a Coordinator-attributed turn. Or also a milestone on the
  session's mission? Recommendation: notice only; the Coordinator posts a
  milestone itself if it matters.
- **C. Codex sessions.** Model switch and compact work natively; context is
  shown when Codex reports a window, else "unknown"; limit stalls are not
  recognised in v1. OK to ship Codex at that level?
- **D. Carry-on after the limit reset.** Who waits: the target bridge
  (parks until `resets_at`, survives restart), the Coordinator (sets a
  reminder and calls the tool again), or the bridge automatically without
  the Coordinator? Recommendation: the bridge parks it on the Coordinator's
  instruction (`when: after_limit_reset`); no fully automatic carry-on.
- **E. Never mid-turn.** Actions on a `running` session are parked and
  applied at its next idle point (the three turn-end hooks); the tool
  result says `deferred`. Is a hard refuse (`busy`, try later) preferable
  for `set_model`, since a parked model switch may land after the turn the
  Coordinator was worried about? Recommendation: park everything.
- **F. Read path.** Persist the status header in the journal and show it
  on `agent_roster` / `mission_get` rows (no new tool), rather than a
  live RPC (which cannot see asleep boxes). OK?

## Testing

- Journal: `session_control` op unit tests (every check above, wake path,
  relay of ok/error, non-Coordinator caller `forbidden`); `conversation_status`
  write throttle and roster/mission exposure; privacy predicate.
- Bridge: `lib/session-control.js` planner (pure: busy → deferred, model
  validation, Codex vs Claude paths, `after_limit_reset` with and without
  a stall); stall detector against the observed texts; roster formatting;
  tool handlers refusing a non-Coordinator caller; wiring pinned by source
  inspection like `test/coordinator-wiring.test.js`.
- Manual: two boxes, Coordinator on one, target on the other, all three
  actions while the target is idle, busy, and asleep.

## Rollout

Journal first (the new op answers `unknown_op` on an old journal, which the
bridge tools report verbatim), then bridges via the usual fleet pass. Old
bridges ignore the roster's `status` block and answer `unknown_method` to
the RPC, which the Coordinator sees as "that box's bridge predates session
control".

## Decisions (Dan, 29 Sep 2026) and the final control-path design

Dan's answers to the six questions: **A** standing permission, no consent
card. **B** a one-line notice in the target session's chat. **C** Codex
sessions get all three actions, and the Coordinator must also be able to
switch a session **between Codex and Claude**. **D** automatic: the bridge
itself carries on when the limit resets, and when a resumed session comes
back on an unknown or unavailable model the bridge switches it to a known
model, then carries on, compacting when the context is high. **E** park
everything that lands mid-turn. **F** persist the status header in the
journal (built, §1).

### Journal: `session_control` op

```json
{ "op": "session_control", "request_id": "…",
  "from_convo_id": "<the Coordinator conversation>", "target_convo_id": "<session>",
  "action": "set_model" | "compact" | "carry_on",
  "model": "sonnet",                 // set_model: Claude alias / claude-* name, or a Codex model id; optional when `agent` is given
  "agent": "claude" | "codex",       // set_model: switch the session's backend first (bridge /switch), optional
  "message": "carry on with …",      // carry_on: ≤ 2000 chars, peer-text sanitised
  "when": "now" | "after_limit_reset", // carry_on, default now
  "reason": "context at 92%" }       // optional, ≤ 200 chars, shown in the target chat
```

Checks, in order, every failure a `{kind:'control', op:'error', code, ref, request_id}`
frame: agent connection (`forbidden`); registered (`not_ready`); `request_id`
(`bad_request`); `from_convo_id` is a top-level conversation this device owns
(`not_found`) **and** equals `user_settings.coordinator_convo_id`
(`forbidden`, detail `not_coordinator`) — the one route the Coordinator role
gates; `action`/`agent`/`when` in their vocabularies, `model` ≤ 64,
`message` ≤ 2000 after sanitising (required for `carry_on`), `reason` ≤ 200
(`bad_request`); `target_convo_id` exists, same user, top-level, has an
`agent_device_id`, and its box is not a private device hidden from this
caller (`not_found`, indistinguishable); target is not `from_convo_id`
(`bad_request`). Then: if the box is offline and cannot be woken →
`agent_unreachable`; otherwise ack at once with
`{kind:'session_control', event:'sent', request_id, target_waking?}`, wake
the box if needed and wait up to `MATRON_SPAWN_WAKE_WAIT_MS` for it
(`hub.waitForDevice`), issue a journal-originated RPC `session_control
{convo_id, action, model?, agent?, message?, when?, reason?, from_convo_id,
from_name}` (30 s), and deliver the reply to every socket of the caller's
device as `{kind:'session_control', event:'result', request_id, ok,
result?|error?}`. Nothing is journaled by the journal; not counted against
the pending-ask cap (nothing awaits the user).

**Stall wake sweep.** Once a minute the journal scans `conversation_status`
for rows whose `stall.resets_at` has passed and whose box has no live
socket, and calls `wakeIfOffline` on that box (debounced by the waker), so
the bridge below can perform its automatic carry-on even when the box went
to sleep while stalled. The bridge's next status frame drops the stall and
ends the loop.

### Target bridge

`lib/session-control.js` is the pure planner (validate params, decide
`apply` vs `park`, name the notice and the reply); `lib/journal-rpc.js`
gains the `session_control` method; `index.js` wires it.

- **Resolve or resume.** `findSessionByClaudeSessionId(convo_id)`; when
  there is no live session, `journalResumeConvo(convo_id)` respawns it from
  the persisted record exactly as a user's message would (the sessions this
  feature manages are mostly idle-reaped or on a just-woken box). Neither
  → `not_found` (not this bridge's) or `gone` (persisted state absent).
- **Park or apply.** Occupied is `sessionOccupiedForRoomDelivery(session)`
  (busy, resume hold, open question, open prompt); an agent switch
  additionally needs `canSwitchAgent` to agree (no queue, no pending plan).
  When occupied, the action is stored in `session._deferredControls`
  (`{set_model?, compact?, carry_on?}`, one slot per kind, latest wins,
  carried by `persistSession` and restored on resume/recreate so a restart
  does not lose it) and the reply is `{ok:true, applied:'deferred'}`.
  `drainDeferredControls(session)` runs from `maybeFlushRoomDelivery`, the
  shared "session is free" gate every turn-end and every prompt-clear seam
  already passes through, in the order `carry_on` (queued as a turn),
  `compact` (queue front), `set_model` last (a print-mode switch recreates
  the process, which carries `queuedMessages`).
- **set_model.** `agent` given and different → `switchAgentSession(roomId,
  agent, …)` first (idle-only; occupied → parked); then `model` →
  `applyModelSwitch(roomId, session, model, {explicit: true})`, whose own
  validation yields `bad_model` (a refused alias is never typed anywhere).
  Codex model ids go to the same function's Codex branch.
- **compact.** `journalRouteTextToSession(session, '/compact')` — Codex
  native compact, Claude typed/stdin — only ever at idle.
- **carry_on.** `when: now` → notice, then
  `sendTextToSession(session, '[from the Coordinator] ' + message)`.
  `when: after_limit_reset` → `not_stalled` unless `session._stall`, else
  `no_reset_time` unless it has `resets_at`, else the message replaces the
  automatic carry-on's default text (§4) and the reply says when it fires.
- **Notice** (decision B): `🛠 Coordinator: compacting this session once
  this turn finishes — context at 92%`, `🛠 Coordinator: switching this
  session to Sonnet`, `🛠 Coordinator: carry on once the usage limit resets
  at 15:00 UTC`, posted with `notice()` into the target chat when received
  and, for a parked action, again when it applies. Errors are notices too.
- **Coordinator's bridge.** Three tools in ask-user.js — `session_set_model
  (convo_id, model?, agent?, reason?)`, `session_compact(convo_id, reason?)`,
  `session_carry_on(convo_id, message, when?, reason?)` — POST to bridge
  routes that refuse a non-Coordinator caller (`session.coordinator`) with a
  clear message before the journal does, send the op, return on the `sent`
  ack ("sent to <box>; applies at the session's next idle point"), and
  publish the `result` frame into the Coordinator's chat as a notice when
  it lands (as spawn outcomes do).

### §4 Automatic carry-on and bad-model recovery (decision D)

Bridge-only, no Coordinator involved, on every Claude session:

1. **Usage limit.** When a stall (§3) has `resets_at`, the bridge arms
   `session._autoResume = {at, kind:'usage_limit'}` (persisted). A one-minute
   sweep over live and persisted sessions fires due entries: resume the
   session if needed (`journalResumeConvo`), queue `/compact` first when the
   last gauge was ≥ 80 % of the window, then send
   `[auto-continue after usage limit reset] The usage limit that stopped you has reset. Carry on with what you were doing.`
   (or the Coordinator's `carry_on … after_limit_reset` message). The
   journal's stall wake sweep brings a sleeping box back for this.
2. **Unknown / unavailable model.** Claude Code answers with an
   `isApiErrorMessage` record, `error: 'model_not_found'` / HTTP 404, text
   `The model <m> is not available on your <deployment> deployment. Try /model … to switch to <l>, or ask your admin to enable this model.`
   or `There's an issue with the selected model (<m>). It may not exist or you may not have access to it.`
   (verified in the Claude Code 2.1.280 bundle). The detector reports it as
   `stall.kind = 'bad_model'`; the bridge then runs `applyModelSwitch(…,
   'default', {explicit:false})`, posts a notice, and sends the carry-on
   above with a "switched to the default model" preface. At most one
   automatic recovery per stall: if the default model is refused too, the
   session stays flagged and the notice says so, for the Coordinator or Dan.
3. A real answer (non-zero usage) clears the stall and disarms the
   auto-resume, as §3 already does.

## Coordinator mission close (item #4901, 29 Sep 2026)

Dan chose a standing rule (agents close their own missions, memory
`agents-close-finished-missions`) plus a Coordinator tool for the missions
whose sessions have gone. No new tool: `mission_close` gains an optional
`mission: N`, the shape `mission_status` already uses.

- **Bridge** (`lib/missions-tools.js close`): with `mission`, the session
  must be the Coordinator (`session.coordinator`, 403 with a sentence
  otherwise, before any journal call); the close goes by number, is never
  cached as the session's own mission, and its 404 does not clear that
  cache. With or without `mission`, the closing conversation now rides
  along as `convo_id`. A journal 403 `not_coordinator` is rendered as "the
  journal does not list this conversation as the Coordinator".
- **Journal** (`POST /missions/:id/close {summary, convo_id?}`): an agent
  that names its conversation is held to one rule — the conversation is
  this device's own (404), and either on the mission (origin or attached,
  a child included) or the user's Coordinator
  (`user_settings.coordinator_convo_id`); anyone else is 403
  `{error:'forbidden', detail:'not_coordinator'}`. A client's `convo_id`
  is ignored; a bridge that sends none keeps the old contract. Both item
  tiers still block (`user_items`, then `agent_items`, each with the
  list), so the Coordinator resolves or moves items first and a mission
  never closes over one awaiting the user. The row records
  `closed_convo_id` and the `closed` marker carries `by_convo_id`, the
  audit line behind "closed by the Coordinator".
- **Instructions**: BRIDGE_COORDINATOR.md "Close finished missions" —
  close only when the milestones show the work done; items awaiting the
  user mean the mission stays open; never without `mission`.

