# Session context read path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Coordinator sees every session's model, context gauge and usage-limit stall on `agent_roster` and `mission_get`, from a status header the journal now persists per conversation.

**Architecture:** The bridge already sends `status {convo_id, status:{model, context:{tokens,window,pct}, limits[], …}}` to the journal at every turn end. The journal sanitises a subset of that frame into a new `conversation_status` table (JSON per conversation, like `device_status`), and serves it as `status` on `GET /roster` conversation rows and on mission-detail conversation rows. The bridge renders that block in the two tools, and adds a `stall` field to the frame when a turn ends on a usage-limit message. No new op, no new tool, no bridge protocol change beyond the optional `stall` key.

**Tech Stack:** matron-journal: Node 20+, better-sqlite3, `node --test`. matron-bridge: Node 22+, vitest, eslint.

**Spec:** `docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md` §1 (read path) and §3 (stall). Decided by Dan on tracker item "Session control F" (29 Sep 2026): persist in the journal, no live RPC.

## Global Constraints

- Journal: the `status` op stays opaque and ≤ 4096 bytes (`STATUS_MAX_BYTES`); the persisted subset is validated all-or-nothing per block, unknown keys dropped, and a frame with nothing persistable writes nothing.
- Journal: privacy predicates unchanged — the roster and mission-detail rows already hide private-owned conversations from ordinary agents; `status` rides those rows only. Shared (GitHub-verified) mission views do **not** get `status`.
- Journal: `conversation_status` cascades on conversation delete (`ON DELETE CASCADE`, `foreign_keys = ON` is already set in `src/db.js`).
- Bridge: `~/matron-bridge` is the live bridge — all edits in the worktree `~/matron-bridge-session-control` (branch `feat/coordinator-session-control`). Journal edits in a worktree of `~/matron-journal` on branch `feat/conversation-status`.
- Bridge: `lib/*` modules stay pure and unit-tested; `index.js` wiring is pinned by source-inspection tests (`test/coordinator-wiring.test.js` style). New lib files are added to the `check` script in `package.json`.
- Both: commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never write tracker item numbers into commits or PRs.

## Review Focus

1. A bridge that predates `stall` (or a Codex session) sends no `stall` key: the roster must show `context unknown` for a missing context and no stall text, never `undefined`. — pinned in Task 6 tests.
2. A status frame arriving for a conversation the caller may write to but that has since been deleted must not crash the op (FK violation): the write is wrapped and logged, the ephemeral fan-out still happens. — pinned in Task 2 tests.
3. `context.pct` or `tokens` as strings, negative, or `Infinity` from a buggy bridge must be dropped (block invalid), not persisted. — pinned in Task 1 tests.
4. A journal restart must not lose the gauge: `/roster` reads the table, not the in-memory cache. — pinned in Task 3 test (new server on the same DB file is heavy; instead the test reads via `convoStatuses(db)` after clearing the cache, and the roster route is checked to use the DB helper by test).
5. The stall detector must not fire on an assistant message that merely *quotes* the limit text (e.g. this spec being read aloud): only an assistant record flagged `isApiErrorMessage`, or whose sole text block matches the pattern, counts. — pinned in Task 7 tests.

---

## Part A — matron-journal (branch `feat/conversation-status`)

### Task 1: `src/convo-status.js` — sanitiser and persistence helpers

**Files:**
- Create: `src/convo-status.js`
- Modify: `src/db.js` (schema block after `device_status`, ~line 251)
- Test: `test/convo-status.test.js`

**Interfaces:**
- Produces: `sanitizeConvoStatus(raw) -> {model?, context?:{tokens,window,pct}, stall?:{kind,model?,resets_at?,since?}, limits?:{as_of,lines[]}} | null`; `upsertConvoStatus(db, {userId, convoId, status, reportedAt})`; `convoStatuses(db, userId) -> Map<convoId, {reported_at, ...status}>`; `convoStatus(db, convoId) -> {reported_at, ...status} | null`.

- [ ] **Step 1: Write the failing tests**

```js
// test/convo-status.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { sanitizeConvoStatus, upsertConvoStatus, convoStatuses, convoStatus } from '../src/convo-status.js'

const FRAME = {
  model: 'claude-opus-5-5', effort: 'high', workdir: '/home/dan/app', email: 'dan@example.com',
  context: { tokens: 87000, window: 1000000, pct: 9 },
  limits: { as_of: 1758460000000, lines: [{ id: '5h', label: 'Current session', percent: 42, resets_at: '2026-09-29T15:00:00.000Z' }] },
  stall: { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1758460000000 },
  vitals: { cpu: 12 }, model_options: [{ value: 'opus', label: 'Opus' }],
}

test('sanitizeConvoStatus keeps model, context, stall and limits; drops everything else', () => {
  const s = sanitizeConvoStatus(FRAME)
  assert.deepEqual(Object.keys(s).sort(), ['context', 'limits', 'model', 'stall'])
  assert.deepEqual(s.context, { tokens: 87000, window: 1000000, pct: 9 })
  assert.deepEqual(s.stall, FRAME.stall)
  assert.equal(s.limits.lines[0].resets_at, '2026-09-29T15:00:00.000Z')
})

test('sanitizeConvoStatus drops an invalid block but keeps the rest; all invalid -> null', () => {
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: '87000', window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: -1, window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: 1, window: Infinity, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ context: { tokens: 1, window: 2, pct: 50 }, stall: { kind: 'other' } }), { context: { tokens: 1, window: 2, pct: 50 } })
  assert.equal(sanitizeConvoStatus({ effort: 'high', vitals: {} }), null)
  assert.equal(sanitizeConvoStatus(null), null)
  assert.equal(sanitizeConvoStatus({ model: 'x'.repeat(65) }), null)
})

test('upsertConvoStatus is latest-wins per conversation and cascades with the conversation', () => {
  const db = openDb(':memory:')
  const dan = createUserSync(db)
  const dev = createAgent(db, dan.id, 'gene')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'A', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'B', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'a' }, reportedAt: 10 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'b', context: { tokens: 1, window: 2, pct: 50 } }, reportedAt: 20 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c2', status: { model: 'c' }, reportedAt: 30 })
  assert.deepEqual(convoStatus(db, 'c1'), { reported_at: 20, model: 'b', context: { tokens: 1, window: 2, pct: 50 } })
  const all = convoStatuses(db, dan.id)
  assert.deepEqual([...all.keys()].sort(), ['c1', 'c2'])
  db.prepare('DELETE FROM conversations WHERE id=?').run('c1')
  assert.equal(convoStatus(db, 'c1'), null)
  assert.equal(convoStatuses(db, dan.id).size, 1)
})

// createUser is async (argon2); the test only needs a row.
function createUserSync(db) {
  db.prepare("INSERT INTO users(username, password_hash, created_at) VALUES('dan','x',0)").run()
  return { id: db.prepare("SELECT id FROM users WHERE username='dan'").get().id }
}
```

Check `openDb`'s exported name and `upsertConversation`'s signature before running (`grep -n "export function openDb\|export function upsertConversation" src/db.js src/journal.js`); adjust the imports to match, never the assertions. If `users` has other NOT NULL columns, fill them in `createUserSync`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/matron-journal-cs && node --test test/convo-status.test.js`
Expected: FAIL — `Cannot find module '../src/convo-status.js'`.

- [ ] **Step 3: Add the table and write the module**

In `src/db.js`, after the `idx_device_status_user` index line inside the schema string:

```sql
-- Per-conversation session header (spec 2026-09-29 coordinator session
-- control §1): the persisted subset of the bridge's `status` op — model,
-- context gauge, usage-limit stall, account meters — so the roster and a
-- mission's conversations can answer "how full is that session" for a box
-- that is asleep or a journal that has restarted. Same shape as
-- device_status: JSON per row, latest wins, goes with the conversation.
CREATE TABLE IF NOT EXISTS conversation_status(
  convo_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_status_user ON conversation_status(user_id);
```

`src/convo-status.js`:

```js
// The persisted subset of a bridge's `status` op (spec 2026-09-29
// coordinator session control §1). The op itself stays opaque and
// in-memory for header replay (ws.js statusCache); this module keeps only
// what the roster and mission views need — model, context gauge, stall,
// account meters — validated block by block so one malformed block never
// costs the others, and unknown keys (effort, workdir, email, vitals,
// model_options…) are never written.
import { sanitizeSpawnLimits } from './spawns.js'

const MODEL_CAP = 64
const STALL_KINDS = new Set(['usage_limit'])
const ISO_CAP = 40
const MS_MAX = 4102444800000 // 2100-01-01

const nonNegInt = (n) => Number.isInteger(n) && n >= 0
const shortStr = (s, cap) => typeof s === 'string' && s.length > 0 && s.length <= cap

function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { tokens, window, pct } = raw
  if (!nonNegInt(tokens) || !Number.isInteger(window) || window <= 0) return null
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) return null
  return { tokens, window, pct }
}

function sanitizeStall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!STALL_KINDS.has(raw.kind)) return null
  const out = { kind: raw.kind }
  if (raw.model !== undefined) { if (!shortStr(raw.model, MODEL_CAP)) return null; out.model = raw.model }
  if (raw.resets_at !== undefined) { if (!shortStr(raw.resets_at, ISO_CAP)) return null; out.resets_at = raw.resets_at }
  if (raw.since !== undefined) { if (!nonNegInt(raw.since) || raw.since > MS_MAX) return null; out.since = raw.since }
  return out
}

export function sanitizeConvoStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  if (shortStr(raw.model, MODEL_CAP)) out.model = raw.model
  const context = sanitizeContext(raw.context)
  if (context) out.context = context
  const stall = sanitizeStall(raw.stall)
  if (stall) out.stall = stall
  const limits = sanitizeSpawnLimits(raw.limits)
  if (limits) out.limits = limits
  return Object.keys(out).length ? out : null
}

export function upsertConvoStatus(db, { userId, convoId, status, reportedAt = Date.now() }) {
  db.prepare(
    `INSERT INTO conversation_status(convo_id, user_id, reported_at, status) VALUES (?,?,?,?)
     ON CONFLICT(convo_id) DO UPDATE SET user_id=excluded.user_id, reported_at=excluded.reported_at, status=excluded.status`
  ).run(convoId, userId, reportedAt, JSON.stringify(status))
}

function parseRow(r) {
  try { return { reported_at: r.reported_at, ...JSON.parse(r.status) } } catch { return null }
}

export function convoStatuses(db, userId) {
  const out = new Map()
  for (const r of db.prepare('SELECT convo_id, reported_at, status FROM conversation_status WHERE user_id=?').all(userId)) {
    const parsed = parseRow(r)
    if (parsed) out.set(r.convo_id, parsed)
  }
  return out
}

export function convoStatus(db, convoId) {
  const r = db.prepare('SELECT reported_at, status FROM conversation_status WHERE convo_id=?').get(convoId)
  return r ? parseRow(r) : null
}
```

`sanitizeSpawnLimits` requires `as_of`; a bridge frame's `limits` is an **array of lines** (`buildSessionStatus` sets `status.limits = limits` where `limits` is `usageLimitsCache.lines`). Check with `grep -n "status.limits" ~/matron-bridge/lib/session-status.js`. If it is a bare array, wrap it before sanitising: `sanitizeSpawnLimits({ as_of: reportedAt, lines: raw.limits })` — then `sanitizeConvoStatus(raw, reportedAt)` takes the timestamp as a second argument, and the FRAME fixture in Step 1 uses `limits: [ {…} ]`. Update the test to whichever shape the bridge really sends.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/convo-status.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/db.js src/convo-status.js test/convo-status.test.js
git commit -m "convo-status: persist the roster subset of a session's status header

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Write it from the `status` op

**Files:**
- Modify: `src/ws.js` `case 'status'` (~line 1789–1808)
- Test: `test/convo-status.test.js` (append)

**Interfaces:**
- Consumes: `sanitizeConvoStatus`, `upsertConvoStatus` (Task 1).

- [ ] **Step 1: Write the failing test**

```js
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser } from '../src/auth.js'

test('the status op persists its roster subset; a frame with nothing persistable writes nothing', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan2', 'pw')
  const dev = createAgent(s.db, dan.id, 'gene')
  const agent = await makeWsClient(s.base, { token: dev.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  t.after(() => agent.close())
  agent.send({ op: 'convo_upsert', convo_id: 'w1', title: 'Work', session_state: 'running' })
  await agent.waitFor((f) => f.op === 'ok' || f.kind === 'journal' || f.op === 'ack')
  agent.send({ op: 'status', convo_id: 'w1', status: FRAME })
  await new Promise((r) => setTimeout(r, 80))
  const stored = convoStatus(s.db, 'w1')
  assert.equal(stored.model, 'claude-opus-5-5')
  assert.deepEqual(stored.context, { tokens: 87000, window: 1000000, pct: 9 })
  assert.equal('effort' in stored, false)
  agent.send({ op: 'status', convo_id: 'w1', status: { effort: 'high' } })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(convoStatus(s.db, 'w1').model, 'claude-opus-5-5', 'an all-unpersistable frame leaves the row alone')
})
```

Check how `convo_upsert` is acknowledged in `test/agent.test.js` (`grep -n "convo_upsert" test/agent.test.js | head`) and use the same wait; the row must exist before `status` is sent, because `authorizeAgentWrite` refuses unknown conversations.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/convo-status.test.js`
Expected: FAIL — `stored` is null.

- [ ] **Step 3: Wire the write**

In `src/ws.js` `case 'status'`, after `statusCache.set(...)`:

```js
        // Persist the roster subset (spec 2026-09-29 §1). Best effort and
        // never fatal to the op: the conversation can vanish between the
        // ownership check and this write (FK), and a failed persist must not
        // cost the live header fan-out below.
        const persisted = sanitizeConvoStatus(msg.status, Date.now())
        if (persisted) {
          try { upsertConvoStatus(db, { userId: conn.userId, convoId: msg.convo_id, status: persisted }) }
          catch (e) { console.warn(`status: persist failed for ${msg.convo_id}: ${e.message}`) }
        }
```

Add `import { sanitizeConvoStatus, upsertConvoStatus } from './convo-status.js'` at the top of `ws.js`. Drop the second argument if Task 1 settled on the object-shaped `limits`.

- [ ] **Step 4: Run to verify it passes, then the whole suite**

Run: `node --test test/convo-status.test.js && npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/ws.js test/convo-status.test.js
git commit -m "ws: persist the roster subset of every accepted status op

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Serve it on `GET /roster` and mission detail

**Files:**
- Modify: `src/http.js` `/roster` handler (~line 359–395)
- Modify: `src/missions.js` `missionDetail` conversations query (~line 199–201)
- Test: `test/convo-status.test.js` (append)

**Interfaces:**
- Consumes: `convoStatuses(db, userId)` (Task 1).
- Produces: roster conversation rows gain `status: {model?, context?, stall?, limits?, reported_at}` (omitted until first report); `GET /missions/:id` conversation rows gain the same `status` key. `sharedMissionDetail` unchanged.

- [ ] **Step 1: Write the failing test**

```js
import { createMission, joinMission } from '../src/missions.js'

test('roster and mission-detail conversation rows carry the persisted status; unreported rows have no key', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan3', 'pw')
  const dev = createAgent(s.db, dan.id, 'gene')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan3', password: 'pw', device_name: 'mac' } })
  upsertConversation(s.db, { id: 'r1', ownerUserId: dan.id, title: 'A', sessionState: 'waiting', agentDeviceId: dev.deviceId })
  upsertConversation(s.db, { id: 'r2', ownerUserId: dan.id, title: 'B', sessionState: 'waiting', agentDeviceId: dev.deviceId })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'r1', status: { model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 } }, reportedAt: 123 })
  const roster = await s.http('/roster', { token: login.json.token })
  const r1 = roster.json.conversations.find((c) => c.id === 'r1')
  const r2 = roster.json.conversations.find((c) => c.id === 'r2')
  assert.deepEqual(r1.status, { reported_at: 123, model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 } })
  assert.equal('status' in r2, false)
  // Mission detail: same block on its conversation rows.
  const m = createMission(s.db, { userId: dan.id, title: 'M', body: '' })
  joinMission(s.db, { userId: dan.id, missionId: m.id, convoId: 'r1' })
  const detail = await s.http(`/missions/${m.id}`, { token: login.json.token })
  const row = detail.json.conversations.find((c) => c.id === 'r1')
  assert.equal(row.status.model, 'claude-opus-5-5')
  assert.equal(row.status.context.pct, 9)
})
```

Check `createMission` / `joinMission` names and argument shapes in `src/missions.js` (`grep -n "^export function" src/missions.js`) and the detail route path in `test/missions-http.test.js`; adjust the calls, not the assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/convo-status.test.js`
Expected: FAIL — `r1.status` undefined.

- [ ] **Step 3: Implement**

`src/http.js` `/roster`: after the `conversations` query,

```js
        // Persisted session header (spec 2026-09-29 §1): model, context
        // gauge, stall and meters, from the bridge's last status op. Omitted
        // (never null) for a conversation that has not reported. Rides the
        // already-filtered rows, so privacy needs no second check.
        const convoStatus = convoStatuses(db, who.userId)
        const conversations = rows.map((c) => (convoStatus.has(c.id) ? { ...c, status: convoStatus.get(c.id) } : c))
```

(rename the existing `.all(who.userId)` result to `rows`). Import `convoStatuses` from `./convo-status.js`.

`src/missions.js` `missionDetail`: change the conversations query to

```js
  const conversations = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box,
      s.reported_at AS status_reported_at, s.status AS status_json
    FROM conversations c LEFT JOIN devices d ON d.id = c.agent_device_id
    LEFT JOIN conversation_status s ON s.convo_id = c.id
    WHERE c.mission_id=? ${sieve} ORDER BY c.created_at`).all(mission.id).map(withConvoStatus)
```

and add, near `PRIVATE_CONVO`:

```js
// Fold the LEFT JOINed conversation_status columns into one `status` block
// (omitted when the session never reported), same shape as GET /roster.
function withConvoStatus({ status_reported_at, status_json, ...row }) {
  if (status_json == null) return row
  try { return { ...row, status: { reported_at: status_reported_at, ...JSON.parse(status_json) } } } catch { return row }
}
```

`sharedMissionDetail` is left as is (no status for other viewers).

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `node --test test/convo-status.test.js && npm test`
Expected: all passing (the existing missions tests compare specific fields, not whole rows — if one does a `deepEqual` on a conversation row, it still passes because `status` is omitted for unreported rows).

- [ ] **Step 5: Commit**

```bash
git add src/http.js src/missions.js test/convo-status.test.js
git commit -m "roster, missions: carry each conversation's persisted status header

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Protocol docs and PR

**Files:**
- Modify: `docs/protocol.md` — `GET /roster` bullet (~line 184–207), the agent `status` op bullet (~line 642–650), and the missions detail route table (search `GET /missions/:id`).

- [ ] **Step 1: Document**

Under the `status` op bullet append: "The server also persists a sanitised subset of each accepted frame — `model` (≤ 64 chars), `context {tokens, window, pct}`, `stall {kind:'usage_limit', model?, resets_at?, since?}` and `limits` (validated as `spawn_targets`'s `limits` block) — per conversation (`conversation_status`, latest wins, cascades with the conversation; `src/convo-status.js`). Each block is validated all-or-nothing and unknown keys are dropped; a frame with nothing persistable leaves the row unchanged. This is what `GET /roster` and `GET /missions/:id` serve as a conversation's `status`."

Under `GET /roster` conversations: "…each row also carries `status: {reported_at, model?, context?, stall?, limits?}` when the session has reported one (omitted otherwise) — see the agent `status` op." Same sentence on the `GET /missions/:id` row (own-user detail only; the shared view does not carry it).

- [ ] **Step 2: Run the suite and push**

```bash
npm test
git add docs/protocol.md
git commit -m "docs: persisted conversation status on /roster and mission detail

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/conversation-status
gh pr create --title "Persist each conversation's status header for the roster and mission detail" --body "…(what/why, spec pointer to the matron-bridge spec path, decided by Dan 29 Sep; ends with the attribution line)"
```

Then watch CI, CodeRabbit and Bugbot; fix findings in follow-up commits. Do **not** merge — ask Dan (tracker question).

---

## Part B — matron-bridge (branch `feat/coordinator-session-control`, worktree `~/matron-bridge-session-control`)

### Task 5: `lib/convo-status-format.js` — render a status block

**Files:**
- Create: `lib/convo-status-format.js`
- Modify: `package.json` `check` script (append `&& node --check lib/convo-status-format.js`)
- Test: `test/convo-status-format.test.js`

**Interfaces:**
- Produces: `formatConvoStatus(status, now = Date.now()) -> string` — `''` for no status; otherwise a ` · `-joined fragment **without** a leading separator: `opus[1m] · 87k/1M 9%`, `context unknown`, `stalled: Fable limit, resets 15:00`, `reported 2 min ago`. Reuses `contextGaugeText(tokens, model)` from `lib/session-status.js` for the `87k/1M` text.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { formatConvoStatus, shortModel, agoText } from '../lib/convo-status-format.js';

const NOW = Date.parse('2026-09-29T14:00:00Z');

describe('formatConvoStatus', () => {
  it('renders model, gauge and age', () => {
    expect(formatConvoStatus({ model: 'claude-opus-5-5[1m]', context: { tokens: 87000, window: 1000000, pct: 9 }, reported_at: NOW - 120000 }, NOW))
      .toBe('opus-5-5[1m] · 87k/1m 9% · reported 2 min ago');
  });
  it('says context unknown when there is no gauge (old bridge, Codex before its first turn)', () => {
    expect(formatConvoStatus({ model: 'gpt-5-codex', reported_at: NOW - 5000 }, NOW)).toBe('gpt-5-codex · context unknown · reported just now');
  });
  it('renders a usage-limit stall with its reset time, and without one', () => {
    expect(formatConvoStatus({ model: 'claude-fable-5-1', context: { tokens: 400000, window: 1000000, pct: 40 }, stall: { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00Z' }, reported_at: NOW }, NOW))
      .toBe('fable-5-1 · 400k/1m 40% · stalled: usage limit, resets 15:00 UTC · reported just now');
    expect(formatConvoStatus({ stall: { kind: 'usage_limit' }, reported_at: NOW }, NOW)).toBe('context unknown · stalled: usage limit · reported just now');
  });
  it('returns an empty string for a missing or malformed status', () => {
    expect(formatConvoStatus(undefined)).toBe('');
    expect(formatConvoStatus(null)).toBe('');
    expect(formatConvoStatus({})).toBe('');
    expect(formatConvoStatus({ context: { tokens: 'x' } })).toBe('');
  });
});

describe('helpers', () => {
  it('shortModel strips the claude- prefix only', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5');
    expect(shortModel('opus[1m]')).toBe('opus[1m]');
    expect(shortModel(undefined)).toBe('');
  });
  it('agoText buckets', () => {
    expect(agoText(NOW - 5000, NOW)).toBe('just now');
    expect(agoText(NOW - 90000, NOW)).toBe('1 min ago');
    expect(agoText(NOW - 3 * 3600000, NOW)).toBe('3 h ago');
    expect(agoText(NOW - 2 * 86400000, NOW)).toBe('2 d ago');
    expect(agoText(undefined, NOW)).toBe('');
  });
});
```

Confirm what `contextGaugeText(400000, 'claude-fable-5-1')` returns (`1m` vs `1M`) by reading `lib/session-status.js:92-110` and match the expectations to it.

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/matron-bridge-session-control && npx vitest run test/convo-status-format.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// One-line rendering of a conversation's persisted status header (journal
// GET /roster `status`, spec 2026-09-29 coordinator session control §1) for
// agent_roster and mission_get: model, context gauge, usage-limit stall and
// report age, joined with " · ". Pure; the callers place it.
import { contextGaugeText } from './session-status.js';

export function shortModel(model) {
  return typeof model === 'string' ? model.replace(/^claude-/, '') : '';
}

export function agoText(reportedAt, now = Date.now()) {
  if (!Number.isFinite(reportedAt)) return '';
  const s = Math.max(0, Math.round((now - reportedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function hhmmUtc(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function formatConvoStatus(status, now = Date.now()) {
  if (!status || typeof status !== 'object') return '';
  const parts = [];
  const model = shortModel(status.model);
  if (model) parts.push(model);
  const ctx = status.context;
  const gauge = ctx && Number.isFinite(ctx.tokens) && Number.isFinite(ctx.window) && ctx.window > 0
    ? contextGaugeText(ctx.tokens, status.model, ctx.window) : null;
  if (gauge) parts.push(`${gauge}${Number.isFinite(ctx.pct) ? ` ${ctx.pct}%` : ''}`);
  else parts.push('context unknown');
  if (status.stall?.kind === 'usage_limit') {
    const at = status.stall.resets_at ? hhmmUtc(status.stall.resets_at) : null;
    parts.push(`stalled: usage limit${at ? `, resets ${at}` : ''}`);
  }
  const ago = agoText(status.reported_at, now);
  if (ago) parts.push(`reported ${ago}`);
  // Nothing but "context unknown" for an empty object is noise, not a status.
  if (parts.length === 1 && parts[0] === 'context unknown') return '';
  return parts.join(' · ');
}
```

`contextGaugeText(tokens, model)` derives the window from the model; the persisted `window` is authoritative (Codex reports its own). Extend it in `lib/session-status.js` with an optional third argument `window` that overrides `contextWindowFor(model)` when a positive finite number — a one-line change, covered by a new test in `test/session-status.test.js`: `expect(contextGaugeText(87000, 'claude-opus-5-5', 1000000)).toBe('87k/1m')` (adjust to its casing).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/convo-status-format.test.js test/session-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/convo-status-format.js lib/session-status.js test/convo-status-format.test.js test/session-status.test.js package.json
git commit -m "convo-status-format: render a session's model, context gauge and stall

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Show it on `agent_roster` and `mission_get`

**Files:**
- Modify: `lib/agent-chat.js` `roster` handler (~line 210–228): pass `status` through.
- Modify: `ask-user.js` `agent_roster` rendering (~line 267–300) and tool description.
- Modify: `lib/missions-format.js:73` conversation line.
- Test: `test/agent-chat.test.js` roster cases; `test/missions-format.test.js` detail case; new `test/ask-user-roster-render.test.js` is **not** possible (ask-user.js starts an MCP server on import) — instead move the row renderer into `lib/roster-format.js` (`rosterLine(c, mine, now)`) and test that.

**Interfaces:**
- Consumes: `formatConvoStatus` (Task 5).
- Produces: `lib/roster-format.js` `rosterLine(c, mine, now) -> string`.

- [ ] **Step 1: Write the failing tests**

In `test/agent-chat.test.js`, extend the fixture's remote conversation with `status: { model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 }, reported_at: 111 }` (find `convo-remote` in `makeFixture`) and change the roster expectation's first row to include that `status` object; the other two rows stay without a `status` key (`expect(res.body.conversations[1]).not.toHaveProperty('status')`).

In `test/missions-format.test.js` detail case, add a second conversation `{ id: 'c2', title: 'Full', box: 'ang', state: 'waiting', status: { model: 'claude-opus-5-5', context: { tokens: 870000, window: 1000000, pct: 87 }, reported_at: 1700000000000 } }` and expect its line `'- c2 Full (ang, waiting · opus-5-5 · 870k/1m 87% · reported <ago>)'` — pass a fixed `now` into `formatMissionDetail(data, { now })` so the age is deterministic (`reported 2 min ago` with `now = 1700000120000`). The existing `c1` line stays exactly `'- c1 Session (dev-2, running)'`.

New `test/roster-format.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { rosterLine } from '../lib/roster-format.js';

const NOW = 1700000120000;
describe('rosterLine', () => {
  it('renders the status block after the state when present', () => {
    expect(rosterLine({ id: 'c1', title: 'Work', session_state: 'waiting', agent_device_id: 7, summary: 'porting',
      status: { model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 }, reported_at: NOW - 120000 } }, 1, NOW))
      .toBe('- c1 — "Work" [waiting · opus-5-5 · 87k/1m 9% · reported 2 min ago] (agent 7): porting');
  });
  it('keeps the old shape without a status, and marks this bridge / no agent', () => {
    expect(rosterLine({ id: 'c2', title: '', session_state: 'running', agent_device_id: 1, summary: '' }, 1, NOW)).toBe('- c2 — "untitled" [running] (this bridge)');
    expect(rosterLine({ id: 'c3', title: 'X', agent_device_id: null, summary: 'y'.repeat(300) }, 1, NOW)).toMatch(/^- c3 — "X" \[unknown\] \(no agent\): y{200}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agent-chat.test.js test/missions-format.test.js test/roster-format.test.js`
Expected: FAIL (missing module, missing `status`, missing block).

- [ ] **Step 3: Implement**

`lib/agent-chat.js` roster map: add `...(c.status ? { status: c.status } : {})` to each conversation object.

`lib/roster-format.js`:

```js
// The agent_roster picker's one line per conversation. Extracted from
// ask-user.js so it is unit-testable (ask-user.js starts an MCP server on
// import). `mine` is this bridge's device id (null when unknown).
import { formatConvoStatus } from './convo-status-format.js';

export function rosterLine(c, mine, now = Date.now()) {
  const agent = c.agent_device_id == null ? ' (no agent)'
    : (mine != null && c.agent_device_id === mine) ? ' (this bridge)'
      : ` (agent ${c.agent_device_id})`;
  const summary = c.summary ? `: ${String(c.summary).slice(0, 200)}` : '';
  const status = formatConvoStatus(c.status, now);
  const state = `${c.session_state || 'unknown'}${status ? ` · ${status}` : ''}`;
  return `- ${c.id} — "${c.title || 'untitled'}" [${state}]${agent}${summary}`;
}
```

`ask-user.js`: import `rosterLine`, replace the `.map((c) => {...})` body with `.map((c) => rosterLine(c, mine))`; extend the tool description: "…states, rolling summaries, and each session's model, context gauge (tokens used of its window) and any usage-limit stall, so you can pick a target for agent_chat_start or see which sessions need compacting or a model switch. Excludes yourself."

`lib/missions-format.js`: `formatMissionDetail(data, { now = Date.now() } = {})`; conversation line:

```js
  for (const c of convos) {
    const status = formatConvoStatus(c.status, now);
    lines.push(`- ${str(c.id)} ${str(c.title)} (${str(c.box) || 'unknown box'}, ${str(c.state) || 'unknown'}${status ? ` · ${status}` : ''})`);
  }
```

Add `&& node --check lib/roster-format.js` to the `check` script.

- [ ] **Step 4: Run the tests, lint and check**

Run: `npx vitest run test/agent-chat.test.js test/missions-format.test.js test/roster-format.test.js && npm run lint && npm run check`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-chat.js lib/roster-format.js lib/missions-format.js ask-user.js package.json test/
git commit -m "agent_roster, mission_get: show each session's model, context gauge and stall

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: `lib/stall-detector.js` — recognise a usage-limit stall

**Files:**
- Create: `lib/stall-detector.js`
- Modify: `lib/session-status.js` `buildSessionStatus` — new `stall` argument, passed through verbatim when it is an object.
- Modify: `package.json` `check` script.
- Test: `test/stall-detector.test.js`, `test/session-status.test.js`

**Interfaces:**
- Produces: `stallFromAssistantEvent(event) -> {kind:'usage_limit', model?} | null`; `stallResetsAt(limitLines) -> iso string | undefined`; `USAGE_LIMIT_RE`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { stallFromAssistantEvent, stallResetsAt } from '../lib/stall-detector.js';
import { buildSessionStatus } from '../lib/session-status.js';

const LIMIT_TEXT = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
const ev = (text, extra = {}) => ({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text }] }, ...extra });

describe('stallFromAssistantEvent', () => {
  it('recognises the limit message as the sole text block', () => {
    expect(stallFromAssistantEvent(ev(LIMIT_TEXT))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent(ev(`Error during compaction: ${LIMIT_TEXT}`))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
  });
  it('recognises an API-error record whatever its text', () => {
    expect(stallFromAssistantEvent(ev('Claude AI usage limit reached|1790700000', { isApiErrorMessage: true }))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
  });
  it('does not fire on a message that merely quotes the text, on tool_use, on subagents or on other errors', () => {
    expect(stallFromAssistantEvent(ev(`The spec says the bridge sees "${LIMIT_TEXT}" and reports it.`))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'assistant', message: { content: [{ type: 'text', text: LIMIT_TEXT }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })).toBeNull();
    expect(stallFromAssistantEvent({ ...ev(LIMIT_TEXT), isSidechain: true })).toBeNull();
    expect(stallFromAssistantEvent(ev('API Error: 500 overloaded', { isApiErrorMessage: true }))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'user' })).toBeNull();
    expect(stallFromAssistantEvent(null)).toBeNull();
  });
});

describe('stallResetsAt', () => {
  it('prefers the session meter, then the first line with a reset time', () => {
    expect(stallResetsAt([{ id: 'week_all', label: 'Weekly', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }, { id: 'session', label: 'Current session', percent: 100, resets_at: '2026-09-29T15:00:00.000Z' }])).toBe('2026-09-29T15:00:00.000Z');
    expect(stallResetsAt([{ id: 'week_all', label: 'Weekly', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }])).toBe('2026-10-02T00:00:00.000Z');
    expect(stallResetsAt([{ id: 'session', label: 'Current session', percent: 100 }])).toBeUndefined();
    expect(stallResetsAt(undefined)).toBeUndefined();
  });
});

describe('buildSessionStatus stall', () => {
  it('passes a stall object through and omits the key otherwise', () => {
    const stall = { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1 };
    expect(buildSessionStatus({ model: 'claude-fable-5-1', stall }).stall).toEqual(stall);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1' })).toBe(false);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1', stall: null })).toBe(false);
  });
});
```

The 5-hour meter's id is `session` (`deriveLimitId` in `lib/usage-limits.js`); weekly meters are `week_all` / `week_<model>`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/stall-detector.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// Recognise a usage-limit stall from the assistant record Claude Code
// writes when the account meter is exhausted (spec 2026-09-29 coordinator
// session control §3). Observed texts (journal search, Sept 2026):
//   "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
//   "Error during compaction: You've reached your Fable 5 limit. …"
// and the raw API form "Claude AI usage limit reached|<epoch>" on records
// flagged isApiErrorMessage. Only a record whose ONLY content is that text
// counts — a model that quotes the sentence mid-answer is not stalled.
import { isSidechainEvent } from './session-status.js';

export const USAGE_LIMIT_RE = /^(?:error during compaction:\s*)?(?:you'?ve reached your .{1,40} limit\b|claude ai usage limit reached\b)/i;

export function stallFromAssistantEvent(event) {
  if (!event || event.type !== 'assistant' || isSidechainEvent(event)) return null;
  const content = event.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') return null;
  const text = blocks[0].text.trim();
  if (!USAGE_LIMIT_RE.test(text)) return null;
  const model = typeof event.message?.model === 'string' && event.message.model ? event.message.model : undefined;
  return { kind: 'usage_limit', ...(model ? { model } : {}) };
}

// The moment the stall lifts: the session (5-hour) meter's reset when it has
// one, else the first line carrying a reset. Undefined when nothing says.
export function stallResetsAt(lines) {
  if (!Array.isArray(lines)) return undefined;
  const session = lines.find((l) => l && l.id === 'session' && typeof l.resets_at === 'string');
  if (session) return session.resets_at;
  const any = lines.find((l) => l && typeof l.resets_at === 'string');
  return any ? any.resets_at : undefined;
}
```

Note the `isApiErrorMessage` case: the regex already matches the raw API text, so no separate flag check is needed; the test's "API Error: 500 overloaded" stays null because it does not match. Keep the implementation that simple.

`lib/session-status.js` `buildSessionStatus({ …, stall })`: after the `limits` line, `if (stall && typeof stall === 'object') status.stall = stall;` and document it in the header comment: "`stall`, when present, is the usage-limit stall detected by lib/stall-detector.js; omitted (not nulled) when the session is not stalled — the journal persists it for the roster."

Add `&& node --check lib/stall-detector.js` to `check`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/stall-detector.test.js test/session-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/stall-detector.js lib/session-status.js test/stall-detector.test.js test/session-status.test.js package.json
git commit -m "stall-detector: recognise a usage-limit stall from the assistant record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Wire the stall into `index.js` and the status frame

**Files:**
- Modify: `index.js` — imports; `case 'assistant'` (~line 4141); `journalStatus` (~line 1620); `applyModelSwitch` (~line 11581); the three session object literals that initialise `currentModel` (~2095, ~2400, ~2929) gain `_stall: null`.
- Modify: `BRIDGE_COORDINATOR.md` — one paragraph under "Read the state of the world from the journal".
- Test: `test/stall-wiring.test.js` (source inspection)

**Interfaces:**
- Consumes: `stallFromAssistantEvent`, `stallResetsAt` (Task 7); `buildSessionStatus({stall})`.

- [ ] **Step 1: Write the failing wiring test**

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('usage-limit stall wiring (source inspection)', () => {
  it('imports the detector', () => {
    expect(index).toContain("import { stallFromAssistantEvent, stallResetsAt } from './lib/stall-detector.js';");
  });
  it('the assistant case sets or clears session._stall from every parent assistant record', () => {
    const c = body("case 'assistant': {", "case 'result': {");
    expect(c).toContain('const stall = stallFromAssistantEvent(event);');
    expect(c).toMatch(/session\._stall = stall\s*\?\s*\{ \.\.\.stall, since: Date\.now\(\), resets_at: stallResetsAt\(usageLimitsCache\.lines\) \}\s*:\s*null;/);
    expect(c).toContain('if (stall) journalStatus(session);');
  });
  it('journalStatus publishes the stall and applyModelSwitch clears it', () => {
    const js = body('function journalStatus(session) {', '\nfunction ');
    expect(js).toContain('stall: session._stall || undefined,');
    const ams = body('function applyModelSwitch(', '\nfunction ');
    expect(ams).toContain('session._stall = null;');
  });
});
```

Check the exact function signature strings with `grep -n "^function journalStatus\|^async function applyModelSwitch\|^function applyModelSwitch" index.js` and correct the markers.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/stall-wiring.test.js`
Expected: FAIL.

- [ ] **Step 3: Wire**

In the `case 'assistant'` block, right after the `assistantCtxTokens` handling:

```js
      // Usage-limit stall (spec 2026-09-29 §3): the record Claude writes when
      // the account meter is exhausted ends the turn with nothing else, so
      // every parent assistant record either sets or clears the flag. The
      // reset time is read from the shared limits cache at the moment of the
      // stall (the meter that just filled); published at once so the roster
      // shows the stall without waiting for a turn end that may not come.
      const stall = stallFromAssistantEvent(event);
      session._stall = stall ? { ...stall, since: Date.now(), resets_at: stallResetsAt(usageLimitsCache.lines) } : null;
      if (stall) journalStatus(session);
```

If `stallResetsAt` returns `undefined`, the spread leaves `resets_at: undefined`, which `JSON.stringify` drops — fine.

In `journalStatus`'s `buildSessionStatus({...})` call add `stall: session._stall || undefined,`.

In `applyModelSwitch`, at the point the switch is accepted (before the per-agent branches), add `session._stall = null;` — a switch away from the exhausted model lifts the stall; if the new model is also exhausted the next record re-flags it.

Add `_stall: null,` beside each `currentModel: null,` session-literal initialiser.

`BRIDGE_COORDINATOR.md`, in "Read the state of the world from the journal", add a bullet: "- `agent_roster` and `mission_get` show each session's model and context gauge (`opus-5-5 · 870k/1m 87%`) and, when a session has run out of account allowance, `stalled: usage limit, resets HH:MM UTC`. A session above about 80% of its window is a candidate for compaction; a stalled one either waits for the reset or needs another model. Until the session-control tools land, tell the user rather than acting."

- [ ] **Step 4: Run everything**

Run: `npx vitest run && npm run lint && npm run check`
Expected: all green.

- [ ] **Step 5: Commit and push, update the PR**

```bash
git add index.js BRIDGE_COORDINATOR.md test/stall-wiring.test.js
git commit -m "status: publish a usage-limit stall so the roster shows it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
gh pr ready 324   # then edit the PR body: read path implemented, control path pending answers
```

Watch CI, CodeRabbit and Bugbot; answer every finding. Do not merge — ask Dan.

---

## Self-review notes

- Spec §1 covered by Tasks 1–6; §3 (detection + roster rendering) by Tasks 5, 7, 8. §2 (control path) is deliberately **not** in this plan — it waits for the answers to questions A–E.
- Names used consistently: `sanitizeConvoStatus`, `upsertConvoStatus`, `convoStatuses`, `convoStatus` (journal); `formatConvoStatus`, `rosterLine`, `stallFromAssistantEvent`, `stallResetsAt`, `session._stall` (bridge).
- Open detail settled at execution time (Task 1 Step 3): whether the bridge's `limits` is a bare array or `{as_of, lines}`; the sanitizer wraps accordingly.
