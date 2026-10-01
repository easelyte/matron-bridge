# Session control path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Coordinator can switch another session's model or backend, compact it, or tell it to carry on, through a journal-relayed RPC that never acts mid-turn; and every Claude session carries itself on automatically when a usage limit resets or its model turns out to be unavailable.

**Architecture:** A Coordinator-only journal WS op `session_control` is validated (owner + Coordinator role + target visibility), acked, and turned into a journal-originated RPC to the target bridge, whose reply is relayed back as a `result` frame. The target bridge resumes the session on demand, parks the action while the session is occupied (one slot per kind, drained from the shared "session is free" gate), applies it through the existing `/model`, `/switch`, `/compact` and turn-injection paths, and posts a notice in the target chat. Separately, the stall detector's `resets_at` arms an automatic carry-on, a bad-model record triggers one default-model recovery, and the journal wakes a sleeping box when a stall's reset time passes.

**Tech Stack:** matron-journal: Node 20+, better-sqlite3, `node --test`. matron-bridge: Node 22+, vitest, eslint.

**Spec:** `docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md` — "Decisions (Dan, 29 Sep 2026)" section and §4 are normative; §2 where they do not differ.

## Global Constraints

- Journal op names and error codes: `session_control`; codes `forbidden` (detail `not_coordinator` for a non-Coordinator caller), `not_ready`, `bad_request`, `not_found`, `agent_unreachable`, `internal`. RPC method name `session_control`. Frames `{kind:'session_control', event:'sent'|'result', request_id, …}`.
- Bridge RPC reply shapes: `{ok:true, result:{applied:'now'|'deferred'|'scheduled', box, detail?}}`; errors `not_found`, `gone`, `bad_request`, `bad_model`, `bad_agent`, `not_stalled`, `no_reset_time`, `unsupported`, `internal`.
- Never type into a busy session; never call `switchAgentSession` unless `canSwitchAgent` agrees; parked slots persist across a restart.
- `~/matron-bridge` is the live bridge: work in `~/matron-bridge-session-control` (branch `feat/coordinator-session-control`, PR #324 — a second PR is fine if #324 merges first: branch from master then). Journal work in `~/matron-journal-cs` — open a **new** branch `feat/session-control` from `origin/master` once PR #96 has merged, or stack on `feat/conversation-status` if not (the stall wake sweep needs `conversation_status`).
- Pure lib modules + source-inspection wiring tests; new libs added to `package.json` `check`; attribution lines on commits and PR bodies; no tracker numbers in anything that leaves Matron.

## Review Focus

1. A Coordinator on a private box targeting an ordinary box, and an ordinary Coordinator targeting a private box's session: the second must be `not_found`; the first must work. — Task 1 tests.
2. A `carry_on` or `compact` that arrives while the target is in a resume hold (`_awaitingInputReady`) must be applied when the hold lifts, not wait a whole turn. — Task 4 wiring test pins the drain call inside `maybeFlushRoomDelivery`, and a planner test pins `_awaitingInputReady` as "occupied".
3. A `set_model` with `agent` for a session that already runs that agent is just a model switch (no `/switch`). — Task 3 tests.
4. The automatic carry-on must not fire twice for the same stall, nor after a real answer already cleared it; a restart between arming and firing must still fire it. — Task 6 tests (persisted slot, `since` guard).
5. Bad-model recovery must never loop: one `default` switch per stall; a second bad-model record leaves the flag and posts the "needs a human" notice. — Task 6 tests.

---

## Part A — matron-journal

### Task 1: `session_control` op

**Files:**
- Create: `src/session-control.js` (validation + orchestration, pure where possible: `validateSessionControl(msg) -> {ok, params} | {code, detail}`, `runSessionControl(ctx, conn, params)`)
- Modify: `src/ws.js` — new `case 'session_control'`; thread `spawnWakeWaitMs` and a `sessionControlTimeoutMs` (default 30000) into `handleOp` from `attachWs` (both places, ws.js ~544 and ~600)
- Modify: `docs/protocol.md` — new subsection after "## Coordinator" (~line 1609–1630): the op, checks, frames; add `session_control` to the journal-originated method list in "## Agent RPC"
- Test: `test/session-control.test.js`

**Interfaces:**
- Consumes: `getCoordinatorConvoId(db, userId)` (`src/coordinator.js`), `isPrivateDevice`, `sanitizePeerText`, `wakeIfOffline` closure, `hub.waitForDevice`, `broker.issue(hub, userId, deviceId, method, params, {timeoutMs})`, `hub.sendToDevice`.
- Produces: frames per Global Constraints.

- [ ] **Step 1: Write the failing tests** (copy the `spawnFleet` fixture from `test/agent-spawn.test.js:8–32`; `setCoordinatorConvoId(s.db, dan.id, 'parent-convo')` to make the parent the Coordinator)

```js
test('session_control: Coordinator → journal → target bridge → result frame', async (t) => {
  const { s, dan, parent, target, targetDev } = await fleet(t)
  target.send({ op: 'convo_upsert', convo_id: 'tgt', title: 't', session_state: 'waiting' })
  await target.waitFor((f) => f.kind === 'journal' && f.convo_id === 'tgt')
  setCoordinatorConvoId(s.db, dan.id, 'parent-convo')
  parent.send({ op: 'session_control', request_id: 'r1', from_convo_id: 'parent-convo', target_convo_id: 'tgt', action: 'compact', reason: 'context at 92%' })
  const sent = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'sent')
  assert.equal(sent.request_id, 'r1'); assert.equal('target_waking' in sent, false)
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.from_device_id, 0)
  assert.deepEqual(req.request.params, { convo_id: 'tgt', action: 'compact', reason: 'context at 92%', from_convo_id: 'parent-convo', from_name: 'dev-6' })
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'deferred', box: 'eric' } })
  const res = await parent.waitFor((f) => f.kind === 'session_control' && f.event === 'result')
  assert.deepEqual(res, { kind: 'session_control', event: 'result', request_id: 'r1', ok: true, result: { applied: 'deferred', box: 'eric' } })
})

test('session_control: refused for a non-Coordinator caller, a client, a foreign or private target, self, bad params', async (t) => {
  // not_coordinator: same fleet, no setCoordinatorConvoId → control error forbidden with detail 'not_coordinator' and request_id 'r2'
  // client socket → forbidden
  // target owned by another user / private box seen by ordinary caller → not_found
  // target_convo_id === from_convo_id → bad_request
  // action 'reboot', agent 'gemini', when 'later', model 65 chars, carry_on without message, reason 201 chars → bad_request
})

test('session_control: set_model passes model and agent; carry_on passes message and when; strings are sanitised', …)
test('session_control: an offline wakeable target is acked with target_waking and the RPC goes out when it connects', …) // fakeWaker + spawnWakeWaitMs: 5000, connect target after the ack
test('session_control: an offline unwakeable target is agent_unreachable; a target that never answers relays error timeout', …)
```

- [ ] **Step 2: Run** `node --test test/session-control.test.js` → FAIL (unknown op).

- [ ] **Step 3: Implement** — `src/session-control.js`:

```js
import { sanitizePeerText } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { isPrivateDevice } from './db.js'

export const SESSION_CONTROL_ACTIONS = new Set(['set_model', 'compact', 'carry_on'])
const AGENTS = new Set(['claude', 'codex']); const WHEN = new Set(['now', 'after_limit_reset'])
const MODEL_MAX = 64, MESSAGE_MAX = 2000, REASON_MAX = 200, ID_MAX = 128

export function validateSessionControl(msg) {
  const rid = msg.request_id
  if (typeof rid !== 'string' || !rid || rid.length > ID_MAX) return { code: 'bad_request', detail: 'bad request_id' }
  const str = (v, max, name) => { if (v == null) return undefined; if (typeof v !== 'string' || v.length > max) throw Object.assign(new Error(name), { code: 'bad_request', detail: `bad ${name}` }); return sanitizePeerText(v, max) }
  try {
    if (!SESSION_CONTROL_ACTIONS.has(msg.action)) return { code: 'bad_request', detail: 'bad action' }
    if (typeof msg.from_convo_id !== 'string' || !msg.from_convo_id || typeof msg.target_convo_id !== 'string' || !msg.target_convo_id) return { code: 'bad_request', detail: 'bad convo id' }
    if (msg.target_convo_id === msg.from_convo_id) return { code: 'bad_request', detail: 'target is the coordinator itself' }
    const params = { convo_id: msg.target_convo_id, action: msg.action }
    if (msg.action === 'set_model') {
      const model = str(msg.model, MODEL_MAX, 'model'); if (model) params.model = model
      if (msg.agent != null) { if (!AGENTS.has(msg.agent)) return { code: 'bad_request', detail: 'bad agent' }; params.agent = msg.agent }
      if (!params.model && !params.agent) return { code: 'bad_request', detail: 'set_model needs model or agent' }
    }
    if (msg.action === 'carry_on') {
      const message = str(msg.message, MESSAGE_MAX, 'message'); if (!message) return { code: 'bad_request', detail: 'carry_on needs message' }
      params.message = message
      if (msg.when != null) { if (!WHEN.has(msg.when)) return { code: 'bad_request', detail: 'bad when' }; params.when = msg.when }
    }
    const reason = str(msg.reason, REASON_MAX, 'reason'); if (reason) params.reason = reason
    return { ok: true, rid, params }
  } catch (e) { return { code: e.code || 'bad_request', detail: e.detail || 'bad params' } }
}

// Ownership, role and target checks. Returns {code, detail} or {target: {device_id, name}}.
export function authorizeSessionControl(db, conn, msg) {
  const from = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.from_convo_id)
  if (!from || from.owner_user_id !== conn.userId || from.agent_device_id !== conn.deviceId || from.parent_convo_id != null) return { code: 'not_found' }
  if (getCoordinatorConvoId(db, conn.userId) !== msg.from_convo_id) return { code: 'forbidden', detail: 'not_coordinator' }
  const tgt = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(msg.target_convo_id)
  if (!tgt || tgt.owner_user_id !== conn.userId || tgt.parent_convo_id != null || tgt.agent_device_id == null) return { code: 'not_found' }
  if (isPrivateDevice(db, tgt.agent_device_id) && !isPrivateDevice(db, conn.deviceId)) return { code: 'not_found' }
  const dev = db.prepare('SELECT id AS device_id, name FROM devices WHERE id=? AND user_id=? AND kind=\'agent\'').get(tgt.agent_device_id, conn.userId)
  if (!dev) return { code: 'not_found' }
  return { target: dev }
}
```

and in `ws.js`:

```js
      case 'session_control': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const v = validateSessionControl(msg)
        const failRpc = (code, detail) => conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code, ref: msg.op, ...(v.rid ? { request_id: v.rid } : {}), ...(detail ? { detail } : {}) }))
        if (!v.ok) return failRpc(v.code, v.detail)
        const auth = authorizeSessionControl(db, conn, msg)
        if (auth.code) return failRpc(auth.code, auth.detail)
        const { target } = auth
        const online = hub.connsOf(conn.userId).some((c) => c.deviceId === target.device_id && c.ws.readyState === 1)
        const waking = !online && wakeIfOffline(target.device_id)
        if (!online && !waking) return failRpc('agent_unreachable')
        conn.ws.send(JSON.stringify({ kind: 'session_control', event: 'sent', request_id: v.rid, ...(waking ? { target_waking: true } : {}) }))
        const fromName = db.prepare('SELECT name FROM devices WHERE id=?').get(conn.deviceId)?.name || 'coordinator'
        const params = { ...v.params, from_convo_id: msg.from_convo_id, from_name: fromName }
        // Async from here: waiting for a wake must not block this socket's other ops.
        void (async () => {
          try {
            if (waking && spawnWakeWaitMs > 0) await hub.waitForDevice(conn.userId, target.device_id, spawnWakeWaitMs)
            const r = await broker.issue(hub, conn.userId, target.device_id, 'session_control', params, { timeoutMs: sessionControlTimeoutMs })
            hub.sendToDevice(conn.userId, conn.deviceId, { kind: 'session_control', event: 'result', request_id: v.rid, ok: r.ok, ...(r.ok ? { result: r.result } : { error: { code: sanitizePeerText(String(r.error?.code || 'unknown'), 64) || 'unknown', ...(r.error?.detail ? { detail: sanitizePeerText(String(r.error.detail), 300) } : {}) } }) })
          } catch (e) {
            hub.sendToDevice(conn.userId, conn.deviceId, { kind: 'session_control', event: 'result', request_id: v.rid, ok: false, error: { code: 'internal' } })
          }
        })()
        break
      }
```

- [ ] **Step 4: Run tests, whole suite; Step 5: commit** `journal: session_control — Coordinator-only relay to a target bridge`.

### Task 2: Stall wake sweep

**Files:** Create `src/stall-wake.js` (`dueStalledBoxes(db, now) -> [{user_id, device_id}]` from `conversation_status` rows whose `json_extract(status,'$.stall.resets_at')` parses ≤ now, joined to `conversations.agent_device_id`, deduped); `src/server.js` a 60 s interval calling `wakeIfOffline` per box (skip when no waker); `docs/protocol.md` a paragraph under the `status` op persistence text; `test/stall-wake.test.js` (due vs not due vs no stall, dedupe, ISO parse failure ignored).

Commit: `journal: wake a sleeping box when a stalled session's limit has reset`.

Open PR: "session_control op and stall wake sweep" — body per conventions; ask Dan before merging.

---

## Part B — matron-bridge

### Task 3: `lib/session-control.js` — planner

**Files:** Create `lib/session-control.js`; test `test/session-control.test.js`; add to `check`.

**Interfaces (produces):**
```js
export function planSessionControl({ params, session, canSwitch }) // -> { kind:'error', code, detail? } | { kind:'park', slot, notice } | { kind:'apply', steps:[…], notice }
// steps: {op:'switch_agent', agent} | {op:'set_model', model} | {op:'compact'} | {op:'carry_on', text} | {op:'schedule_carry_on', at, text}
export function occupied(session)             // busy || _awaitingInputReady || waitingForAnswer || pendingInteractivePrompt
export function controlNotice(params, { when: 'received'|'applied'|'deferred', box })  // '🛠 Coordinator: …'
export function coordinatorTurnText(message)  // '[from the Coordinator] carry on: …'
export const CONTROL_KINDS = ['carry_on', 'compact', 'set_model'] // drain order
```
Rules: `set_model` with `agent === session.agent` → model step only; `agent` differs and `!canSwitch(session).ok` → park; `carry_on when:'after_limit_reset'` → `not_stalled` / `no_reset_time` / `schedule_carry_on`; occupied → park for everything else; Codex + `set_model` with a Claude alias is passed through (applyModelSwitch's Codex branch validates ids). Tests per rule, plus Review Focus 2 and 3.

### Task 4: Wire the RPC, the slots and the drain in `index.js`

**Files:** `lib/journal-rpc.js` (new `session_control` handler using injected `controlSession(params)`), `index.js`:
- `journalControlSession(params)` async: resolve (`findSessionByClaudeSessionId` → `journalResumeConvo`), `planSessionControl`, then either park (`session._deferredControls[slot.kind] = slot`, persist, notice) or `applyControlSteps(session, steps)`; returns the RPC result/error.
- `applyControlSteps`: `switch_agent` → `await switchAgentSession(roomId, agent, {sendReply: noticeSink})` and continue on the returned session; `set_model` → `applyModelSwitch(roomId, session, model, {sendReply, sendHtml, explicit:true})` (capture a `bad_model` reply: `planPrintModelSwitch`/`isValidModelArg` first for Claude); `compact` → `journalRouteTextToSession(session, '/compact')`; `carry_on` → notice + `sendTextToSession(session, text, {skipJournalMirror:true})`; `schedule_carry_on` → `session._autoResume = {at, text, kind:'usage_limit'}` + persist.
- `drainDeferredControls(session)`: called at the top of `maybeFlushRoomDelivery(session)` when `!occupied(session)`; applies slots in `CONTROL_KINDS` order, clears them, persists, posts the "applied" notice.
- `persistSession`: `derived._deferredControls`, `derived._autoResume`; restored on resume in both Claude builders (and Codex for `_deferredControls`).
- Wiring test `test/session-control-wiring.test.js` (source inspection): RPC method registered, drain inside `maybeFlushRoomDelivery`, persistence lines, restore lines.

### Task 5: Coordinator's tools

**Files:** `lib/session-control-client.js` (`createSessionControlHandlers({publisher, sessions, callerSession, journalConvoIdFor, notify})` with `setModel/compact/carryOn(data)` → refuse non-Coordinator (`session.coordinator !== true` → 403 "only the Coordinator may control other sessions"), build the op, `publisher.sendRoomOp`, await the `sent` ack (5 s) via a pending map keyed by request_id, return `{status:200, body:{sent:true, target_waking}}`; `onSessionControlFrame(frame)` → on `result`, `notify(convoId, text)` into the Coordinator chat: `✅ <box>: compact applied at idle` / `⏳ deferred…` / `⚠️ … failed: bad_model`); `journal-publisher.js`: dispatch `msg.kind === 'session_control'` to `onSessionControlFrame` like `onSpawnFrame`; `index.js`: routes `/session-set-model`, `/session-compact`, `/session-carry-on`; `ask-user.js`: three tools with descriptions written for the Coordinator (when to compact, when to switch, never expect an immediate effect on a running session). Tests: `test/session-control-client.test.js` (refusal, frame shapes, ack timeout → 504, result → notice text).

### Task 6: Automatic carry-on and bad-model recovery

**Files:** `lib/stall-detector.js` (add `bad_model` detection: `isApiErrorMessage && (error === 'model_not_found' || apiErrorStatus === 404)` or sole text matching `/is not available on your .* deployment|There's an issue with the selected model/i` → `{kind:'bad_model', model?}`), `lib/auto-resume.js` (pure: `armFromStall(stall, now) -> {at, kind, text} | null`, `dueAutoResumes(entries, now)`, `AUTO_RESUME_TEXT`, `BAD_MODEL_RECOVERY_TEXT`, `shouldCompactBefore(pct)` ≥ 80), `index.js`: on `usage_limit` stall with `resets_at` set `session._autoResume` (unless already set for this `since`); a 60 s sweep over live sessions and `loadPersistedSessions()` for due `_autoResume` → `carryOnConvo`-style delivery (resume if needed, `/compact` first when due, then text), clear + persist; on `bad_model` stall: if `!session._badModelRecovered` → `applyModelSwitch(roomId, session, 'default', {explicit:false})`, mark, notice, then carry on; else notice "needs a human". A real answer (Task 8 of the read-path plan already clears `_stall`) also clears `_autoResume` and `_badModelRecovered`. Tests: detector cases from the bundle texts; auto-resume pure functions; wiring test.

### Task 7: Docs and PR

`BRIDGE_COORDINATOR.md`: replace the "Until the session-control tools land, tell the user rather than acting" sentence with a "Keep sessions healthy" section: compact at ≥ 80 %, switch a stalled session's model or wait for the automatic carry-on (the bridge does it), use `session_carry_on` only when the automatic path did not (no reset time, a session the sweep missed), and that every action is parked until the session is idle. Spec status line. Update PR #324's body (or open PR #2 if #324 has merged). Get CI, Bugbot and CodeRabbit green; ask Dan before merging.
