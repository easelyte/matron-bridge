# Agent Spawn Bridge Side + Capacity Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge-side agent-spawn (MCP tools `agent_boxes` / `agent_session_start`, `start` RPC gaining `prompt`+`room_id`) plus capacity-aware discovery (per-box session activity + usage limits), consuming matron-journal PR #61's wire surface.

**Architecture:** Injectable-factory modules in the existing bridge style (`lib/agent-chat.js` pattern): pure logic in `lib/`, thin wiring in `index.js`, MCP tools in `ask-user.js` POSTing to the local HTTP loopback. One small journal-side delta lands on the open `feat/agent-spawn-journal` branch (PR #61).

**Tech Stack:** Node 22 ESM, vitest (bridge), node:test + better-sqlite3 (journal). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-agent-spawn-bridge-capacity-design.md` (this repo) + matron-journal `docs/protocol.md` on branch `feat/agent-spawn-journal` (wire ground truth).

## Global Constraints

- **Repos/branches:** Task 1 in `/home/danbarker/matron-journal` on branch `feat/agent-spawn-journal` (append commits; do NOT rebase). Tasks 2–6 in `/home/danbarker/matron-bridge` on branch `feat/agent-spawn-bridge`.
- **Tests:** bridge = `npm test` (vitest run) in matron-bridge; journal = `npm test` (node --test glob) in matron-journal. Journal full suite may flake whole files under heavy host load — re-run the flagged file in isolation to confirm before investigating.
- **Wire caps (journal-enforced, bridge must respect):** `task` ≤ 2000, `topic` ≤ 200, `workdir` ≤ 1024, `request_id` ≤ 128. Pass-through caps: `activity.last_hour` ≤ 20 entries, `limits.lines` ≤ 12.
- **Optional wire fields are OMITTED, never null.**
- **Peer-text discipline:** every agent-/peer-/subprocess-authored string that gets rendered passes sanitization — journal side `sanitizePeerText` (src/peer-text.js), bridge side `oneLine`/`peerField` (lib/peer-text.js).
- **Arm-before-send:** every reply waiter is registered BEFORE the frame is sent (a frame batch can drain in one tick — `lib/agent-invites.js:121-127` documents this).
- **Never block an RPC reply on a subprocess:** `recent_folders` answers from cache; the journal's broker timeout is 4s and a `claude` boot exceeds it.
- **Exactly-once surfacing:** each spawn outcome produces at most one injected turn + one notice; an outcome with no in-memory context still produces the notice (bridge restart case).
- **`from_device_id: 0` / `to_device_id: 0` are valid** (journal-originated RPC); never truthiness-test device ids.
- Style: match surrounding code; injectable factories; comments only for non-obvious constraints.

---

### Task 1: Journal delta — capacity pass-through + `from_name` in start params

**Repo:** `/home/danbarker/matron-journal`, branch `feat/agent-spawn-journal` (open PR #61 — append a commit, never rebase).

**Files:**
- Modify: `src/spawns.js` (add two pure sanitizers; add `from_name` to `broker.issue` start params in `approveSpawn`)
- Modify: `src/ws.js` (spawn_targets: attach sanitized `activity`/`limits` per box)
- Modify: `docs/protocol.md` (spawn_targets reply + start params)
- Test: `test/spawns.test.js` (sanitizer units), `test/agent-spawn.test.js` (from_name + pass-through e2e)

**Interfaces:**
- Produces: `sanitizeSpawnActivity(raw) -> {live_sessions, last_hour} | null`, `sanitizeSpawnLimits(raw) -> {as_of, lines} | null` (exported from src/spawns.js); `start` RPC params gain `from_name` (sanitized parent device name, may be omitted if the device row is gone); `spawn_targets` box entries gain optional `activity`/`limits`.

- [ ] **Step 1: Write failing unit tests** in `test/spawns.test.js` (node:test style already in the file):

```js
test('sanitizeSpawnActivity accepts a valid block and caps last_hour at 20', () => {
  const raw = {
    live_sessions: 2,
    last_hour: Array.from({ length: 25 }, (_, i) => ({ path: `/w/${i}`, sessions: i + 1 })),
  }
  const out = sanitizeSpawnActivity(raw)
  assert.equal(out.live_sessions, 2)
  assert.equal(out.last_hour.length, 20)
  assert.deepEqual(out.last_hour[0], { path: '/w/0', sessions: 1 })
})

test('sanitizeSpawnActivity rejects malformed blocks whole', () => {
  assert.equal(sanitizeSpawnActivity(null), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: -1, last_hour: [] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 1, last_hour: [{ path: '', sessions: 1 }] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 1, last_hour: [{ path: '/ok', sessions: 0 }] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 'x', last_hour: [] }), null)
})

test('sanitizeSpawnActivity flattens newlines in paths', () => {
  const out = sanitizeSpawnActivity({ live_sessions: 0, last_hour: [{ path: '/a\nb', sessions: 1 }] })
  assert.ok(!out.last_hour[0].path.includes('\n'))
})

test('sanitizeSpawnLimits accepts a valid block, caps lines at 12, drops malformed whole', () => {
  const line = { id: 'session', label: 'Session', percent: 39, resets: 'Aug 11, 1:00am (UTC)', resets_at: '2026-08-11T01:00:00.000Z' }
  const out = sanitizeSpawnLimits({ as_of: 123, lines: Array.from({ length: 15 }, () => ({ ...line })) })
  assert.equal(out.as_of, 123)
  assert.equal(out.lines.length, 12)
  assert.deepEqual(out.lines[0], line)
  assert.equal(sanitizeSpawnLimits({ as_of: 0, lines: [line] }), null)
  assert.equal(sanitizeSpawnLimits({ as_of: 1, lines: [{ ...line, percent: 'x' }] }), null)
  assert.equal(sanitizeSpawnLimits({ as_of: 1, lines: 'nope' }), null)
})

test('sanitizeSpawnLimits omits absent resets fields rather than nulling', () => {
  const out = sanitizeSpawnLimits({ as_of: 1, lines: [{ id: 'session', label: 'Session', percent: 5 }] })
  assert.ok(!('resets' in out.lines[0]) && !('resets_at' in out.lines[0]))
})
```

Add `sanitizeSpawnActivity, sanitizeSpawnLimits` to the existing `src/spawns.js` import line in the test file.

- [ ] **Step 2: Run to verify failure** — `cd /home/danbarker/matron-journal && node --test test/spawns.test.js` → FAIL (not exported).

- [ ] **Step 3: Implement the sanitizers** in `src/spawns.js` (import `sanitizePeerText` from `'./peer-text.js'` — check the exact export name used by src/ws.js and import identically):

```js
// Shape-validation for the capacity blocks a bridge may attach to its
// recent_folders reply (spec: 2026-08-10 bridge capacity design). All-or-
// nothing per block: one malformed entry drops the whole optional block —
// but never the box — because a half-validated capacity report is worse
// than none. Strings are flattened through sanitizePeerText: they originate
// from another box's `claude` output and filesystem, and render in an
// agent-facing reply.
const ACTIVITY_MAX_ENTRIES = 20
const LIMITS_MAX_LINES = 12
const LIMIT_STR_CAP = 100
const SESSIONS_SANE_MAX = 10000

export function sanitizeSpawnActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isInteger(raw.live_sessions) || raw.live_sessions < 0 || raw.live_sessions > SESSIONS_SANE_MAX) return null
  if (!Array.isArray(raw.last_hour)) return null
  const last_hour = []
  for (const e of raw.last_hour.slice(0, ACTIVITY_MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') return null
    if (typeof e.path !== 'string' || !e.path || e.path.length > 1024) return null
    if (!Number.isInteger(e.sessions) || e.sessions < 1 || e.sessions > SESSIONS_SANE_MAX) return null
    const path = sanitizePeerText(e.path, 1024)
    if (!path) return null
    last_hour.push({ path, sessions: e.sessions })
  }
  return { live_sessions: raw.live_sessions, last_hour }
}

export function sanitizeSpawnLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isInteger(raw.as_of) || raw.as_of <= 0) return null
  if (!Array.isArray(raw.lines)) return null
  const lines = []
  for (const l of raw.lines.slice(0, LIMITS_MAX_LINES)) {
    if (!l || typeof l !== 'object') return null
    if (typeof l.id !== 'string' || !l.id || l.id.length > LIMIT_STR_CAP) return null
    if (typeof l.label !== 'string' || !l.label || l.label.length > LIMIT_STR_CAP) return null
    if (!Number.isInteger(l.percent) || l.percent < 0 || l.percent > 1000) return null
    const id = sanitizePeerText(l.id, LIMIT_STR_CAP)
    const label = sanitizePeerText(l.label, LIMIT_STR_CAP)
    if (!id || !label) return null
    const out = { id, label, percent: l.percent }
    if (l.resets !== undefined) {
      if (typeof l.resets !== 'string' || l.resets.length > LIMIT_STR_CAP) return null
      const resets = sanitizePeerText(l.resets, LIMIT_STR_CAP)
      if (!resets) return null
      out.resets = resets
    }
    if (l.resets_at !== undefined) {
      if (typeof l.resets_at !== 'string' || !l.resets_at || l.resets_at.length > 40) return null
      out.resets_at = l.resets_at
    }
    lines.push(out)
  }
  return { as_of: raw.as_of, lines }
}
```

NOTE: `src/spawns.js` may not currently import from `'./peer-text.js'` — add the import. Test expectations in Step 1 assume `sanitizePeerText` preserves ordinary strings verbatim and flattens newlines; if a Step-1 expectation contradicts its actual behaviour (e.g. it trims), adjust the *expected literals* to match real sanitizer output, not the sanitizer.

- [ ] **Step 4: Wire into spawn_targets** in `src/ws.js` (~line 878-889, the `Promise.all(boxes.map(...))` callback). Change the online-branch to capture the whole reply and attach optional blocks:

```js
let folders = []
let activity = null
let limits = null
if (online) {
  const r = await broker.issue(hub, conn.userId, d.device_id, 'recent_folders', null, { timeoutMs: spawnFoldersTimeoutMs })
  if (r.ok && Array.isArray(r.result?.folders)) folders = r.result.folders
  if (r.ok) {
    // Optional capacity blocks (2026-08-10 bridge capacity spec): validated
    // all-or-nothing; a bridge that predates them just lists folders.
    activity = sanitizeSpawnActivity(r.result?.activity)
    limits = sanitizeSpawnLimits(r.result?.limits)
  }
}
return {
  device_id: d.device_id, name: sanitizePeerText(d.name, PEER_NAME_CAP), online, folders,
  ...(activity ? { activity } : {}),
  ...(limits ? { limits } : {}),
}
```

Import the two sanitizers from `'./spawns.js'` alongside the existing spawn imports in ws.js.

- [ ] **Step 5: Add `from_name` to start params** in `src/spawns.js` `approveSpawn` (the `broker.issue(..., 'start', {...})` call). Before the try block's `broker.issue`, look up the parent device name and pass it through sanitized:

```js
const fromName = sanitizePeerText(
  db.prepare('SELECT name FROM devices WHERE id=?').get(row.from_device_id)?.name,
  PEER_NAME_CAP,
)
```

and extend the params object: `{ workdir: row.workdir, prompt: row.task, room_id: roomId, ...(fromName ? { from_name: fromName } : {}) }`. Import `PEER_NAME_CAP` from `'./peer-text.js'` (same module as sanitizePeerText; confirm the constant lives there — src/ws.js's import line is ground truth; if it lives elsewhere import from there).

- [ ] **Step 6: e2e tests** in `test/agent-spawn.test.js` (fleet harness). Two additions:
  1. In an existing spawn-approval flow test (or a new one modeled on it), make the mocked target bridge's RPC handler assert `request.params.from_name` equals the parent device's name.
  2. New test: mocked bridge answers `recent_folders` with `{folders: [...], activity: {live_sessions: 1, last_hour: [{path: '/w', sessions: 2}]}, limits: {as_of: 5, lines: [{id: 'session', label: 'Session', percent: 10}]}}` → `spawn_targets` reply box carries both blocks; a second box answering `activity: {live_sessions: -5, last_hour: []}` gets folders but NO `activity` key.

- [ ] **Step 7: Run tests** — `node --test test/spawns.test.js test/agent-spawn.test.js` → PASS, then full `npm test`.

- [ ] **Step 8: Update `docs/protocol.md`**: (a) spawn_targets reply box schema gains the two optional blocks with their shape + "omitted when the bridge doesn't report them or they fail validation"; (b) `start` RPC params list gains `from_name` (optional, sanitized parent device name for the target bridge's opening turn); (c) the recent_folders note gains the optional reply fields.

- [ ] **Step 9: Commit** on `feat/agent-spawn-journal`:

```bash
git add -A && git commit -m "feat(spawn): capacity pass-through on spawn_targets + from_name in start params

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/spawn-capacity.js` — pure capacity builders (bridge)

**Files:**
- Create: `lib/spawn-capacity.js`
- Test: `test/spawn-capacity.test.js`

**Interfaces:**
- Produces: `buildActivity({ sessions, persisted, now }) -> {live_sessions, last_hour: [{path, sessions}]}` (never null; empty shape when nothing to report) and `buildLimits(cache) -> {as_of, lines} | null` (null when the cache is cold). Task 3 injects thunks over these; Task 5 wires the real data sources.

- [ ] **Step 1: Write failing tests** `test/spawn-capacity.test.js` (vitest — `import { describe, it, expect } from 'vitest'`):

```js
import { describe, it, expect } from 'vitest';
import { buildActivity, buildLimits } from '../lib/spawn-capacity.js';

const NOW = 1_754_800_000_000;
const mkSession = (roomId, workdir, extra = {}) => ({ roomId, workdir, alive: true, lastActivityAt: NOW, ...extra });

describe('buildActivity', () => {
  it('counts live sessions and groups the last hour by workdir', () => {
    const sessions = new Map([
      ['r1', mkSession('r1', '/w/app')],
      ['r2', mkSession('r2', '/w/app')],
      ['r3', mkSession('r3', '/w/other')],
    ]);
    const out = buildActivity({ sessions, persisted: {}, now: NOW });
    expect(out.live_sessions).toBe(3);
    expect(out.last_hour).toEqual([
      { path: '/w/app', sessions: 2 },
      { path: '/w/other', sessions: 1 },
    ]);
  });

  it('excludes dead and auto-stopped sessions from the live count', () => {
    const sessions = new Map([
      ['r1', mkSession('r1', '/w/app', { alive: false })],
      ['r2', mkSession('r2', '/w/app', { _autoStopped: true })],
    ]);
    const out = buildActivity({ sessions, persisted: {}, now: NOW });
    expect(out.live_sessions).toBe(0);
  });

  it('includes persisted records used within the hour and dedupes against live sessions by key', () => {
    const sessions = new Map([['r1', mkSession('r1', '/w/app')]]);
    const persisted = {
      r1: { workdir: '/w/app', lastUsed: NOW - 1000 },           // same session as live r1 — once
      r2: { workdir: '/w/app', lastUsed: NOW - 30 * 60_000 },     // in window
      r3: { workdir: '/w/app', lastUsed: NOW - 2 * 3_600_000 },   // stale — out
      r4: { workdir: '/w/other', lastUsed: NOW - 10 * 60_000 },
    };
    const out = buildActivity({ sessions, persisted, now: NOW });
    expect(out.last_hour).toEqual([
      { path: '/w/app', sessions: 2 },
      { path: '/w/other', sessions: 1 },
    ]);
    expect(out.live_sessions).toBe(1);
  });

  it('a live session counts toward its workdir even with a stale persisted record', () => {
    const sessions = new Map([['r1', mkSession('r1', '/w/app', { lastActivityAt: NOW })]]);
    const persisted = { r1: { workdir: '/w/app', lastUsed: NOW - 2 * 3_600_000 } };
    const out = buildActivity({ sessions, persisted, now: NOW });
    expect(out.last_hour).toEqual([{ path: '/w/app', sessions: 1 }]);
  });

  it('caps last_hour at 20 entries, most recently used first', () => {
    const persisted = {};
    for (let i = 0; i < 25; i++) persisted[`r${i}`] = { workdir: `/w/${i}`, lastUsed: NOW - i * 60_000 };
    const out = buildActivity({ sessions: new Map(), persisted, now: NOW });
    expect(out.last_hour).toHaveLength(20);
    expect(out.last_hour[0].path).toBe('/w/0');
  });

  it('skips records with missing workdir or bad lastUsed without throwing', () => {
    const persisted = { a: null, b: { lastUsed: NOW }, c: { workdir: '/w/x', lastUsed: 'soon' } };
    const out = buildActivity({ sessions: new Map(), persisted, now: NOW });
    expect(out).toEqual({ live_sessions: 0, last_hour: [] });
  });
});

describe('buildLimits', () => {
  it('returns as_of + lines verbatim from a warm cache', () => {
    const lines = [{ id: 'session', label: 'Session', percent: 39, resets_at: '2026-08-11T01:00:00.000Z' }];
    expect(buildLimits({ lines, fetchedAt: 123 })).toEqual({ as_of: 123, lines });
  });
  it('returns null for a cold or empty cache', () => {
    expect(buildLimits({ lines: null, fetchedAt: 0 })).toBeNull();
    expect(buildLimits({ lines: [], fetchedAt: 123 })).toBeNull();
    expect(buildLimits({ lines: [{ id: 'x' }], fetchedAt: 0 })).toBeNull();
    expect(buildLimits(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/spawn-capacity.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/spawn-capacity.js`:**

```js
// Pure builders for the capacity blocks attached to the recent_folders RPC
// reply (spec: 2026-08-10 agent-spawn bridge + capacity design). Kept free
// of index.js state so they unit-test without a bridge: index.js passes the
// live `sessions` Map, the persisted-session record map, and the
// usageLimitsCache. Never blocks and never throws — a capacity report is a
// convenience, not worth failing the reply over.

const HOUR_MS = 60 * 60 * 1000;
const LAST_HOUR_CAP = 20;

// live_sessions = sessions running right now; last_hour = workdirs with a
// session used in the trailing hour, session-counted (not path-deduped like
// recent-folders). Live and persisted views of the same session share the
// roomId key, so a live session with a fresh persisted record counts once —
// and a live session counts toward its workdir even when its persisted
// record has gone stale (it is, by definition, in use).
export function buildActivity({ sessions, persisted, now = Date.now() }) {
  const byPath = new Map(); // path -> { keys: Set, recency: number }
  const add = (path, key, at) => {
    if (typeof path !== 'string' || !path) return;
    let entry = byPath.get(path);
    if (!entry) byPath.set(path, entry = { keys: new Set(), recency: 0 });
    entry.keys.add(key);
    if (at > entry.recency) entry.recency = at;
  };
  let live = 0;
  for (const [key, s] of sessions instanceof Map ? sessions : new Map()) {
    if (!s || !s.alive || s._autoStopped) continue;
    live += 1;
    add(s.workdir, key, typeof s.lastActivityAt === 'number' ? s.lastActivityAt : now);
  }
  for (const [key, rec] of Object.entries(persisted && typeof persisted === 'object' ? persisted : {})) {
    if (!rec || typeof rec.workdir !== 'string' || typeof rec.lastUsed !== 'number') continue;
    if (now - rec.lastUsed > HOUR_MS) continue;
    add(rec.workdir, key, rec.lastUsed);
  }
  const last_hour = [...byPath.entries()]
    .sort((a, b) => b[1].recency - a[1].recency)
    .slice(0, LAST_HOUR_CAP)
    .map(([path, e]) => ({ path, sessions: e.keys.size }));
  return { live_sessions: live, last_hour };
}

// The account-limits cache verbatim (index.js's usageLimitsCache shape:
// {lines, fetchedAt}). Null when cold — the reply then omits `limits`
// entirely rather than blocking on a `claude -p "/usage"` boot.
export function buildLimits(cache) {
  if (!cache || !Array.isArray(cache.lines) || cache.lines.length === 0) return null;
  if (!Number.isInteger(cache.fetchedAt) || cache.fetchedAt <= 0) return null;
  return { as_of: cache.fetchedAt, lines: cache.lines };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/spawn-capacity.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add lib/spawn-capacity.js test/spawn-capacity.test.js && git commit -m "feat(spawn): pure capacity builders for recent_folders enrichment"` (with Co-Authored-By trailer).

---

### Task 3: `lib/journal-rpc.js` — capacity on `recent_folders`, `prompt`+`room_id` on `start`

**Files:**
- Modify: `lib/journal-rpc.js`
- Test: `test/journal-rpc-handlers.test.js` (existing file — follow its stub style)

**Interfaces:**
- Consumes: nothing new from Task 2 directly (thunks injected).
- Produces: `createRpcRequestHandler` gains injected deps `getActivity = () => null`, `getLimits = () => null`, `bindSpawnRoom = null`, `unbindSpawnRoom = null`, `injectTurn = null`, `serverLabel = ''`. Also exports `composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel })` for reuse/tests. `start` answers `{convo_id}` as today; new failure codes on the spawn path reuse `spawn_failed`.

- [ ] **Step 1: Write failing tests** in `test/journal-rpc-handlers.test.js` (mirror the file's existing harness — it builds `createRpcRequestHandler` with stubs and calls `handle({request_id, from_device_id, method, params})`, asserting on captured `respondRpc` calls). New cases:

```
1. recent_folders includes activity+limits when thunks return them:
   getActivity: () => ({ live_sessions: 1, last_hour: [{ path: '/w', sessions: 1 }] }),
   getLimits: () => ({ as_of: 5, lines: [{ id: 'session', label: 'Session', percent: 1 }] })
   → result has .activity and .limits verbatim alongside .folders.
2. recent_folders omits the keys when thunks return null (assert
   !('activity' in result) && !('limits' in result)).
3. recent_folders still answers when a thunk throws (activity omitted,
   folders intact) — capacity must never break the picker.
4. start with room_id + prompt (happy path): startSession returns a fake
   session {roomId: 'sess-key', journalConvoId: 'convo-9'}; bindSpawnRoom
   and injectTurn (returning true) are spies. Assert call ORDER
   bindSpawnRoom → injectTurn (capture a sequence array), injectTurn
   received the fake session and a string containing the task verbatim,
   the room id, and the from_name; response ok with {convo_id: 'convo-9'}.
5. start with room_id but missing/empty prompt → error bad_request; no
   startSession call.
6. start where injectTurn returns false → stopSession called with the
   session, unbindSpawnRoom called with room_id, response error
   spawn_failed.
7. start where bindSpawnRoom throws → same teardown (stopSession +
   unbindSpawnRoom) and spawn_failed; unbindSpawnRoom must be called even
   though bind threw (it is idempotent — remove of an absent record).
8. start WITHOUT room_id behaves exactly as before (no bind/inject calls) —
   guard the existing contract.
9. start with room_id when bindSpawnRoom/injectTurn deps are absent (null)
   → error unsupported_mode (a bridge build without spawn wiring must not
   half-start), session torn down.
10. composeSpawnOpeningTurn output contains: task verbatim, room_id,
    fromName when given, a "report there when done" instruction, and the
    user-can-read-everything sentence; with fromName omitted it still
    composes (generic "another of the user's agent sessions").
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/journal-rpc-handlers.test.js` → new cases FAIL.

- [ ] **Step 3: Implement.** In `createRpcRequestHandler`'s options add:

```js
  // Capacity thunks (2026-08-10 capacity spec): answered from cache, never
  // blocking. Null/throw -> the block is simply omitted from the reply.
  getActivity = () => null,
  getLimits = () => null,
  // Spawn-room wiring (2026-08-09 agent-spawn spec). All three must be
  // present for `start` to accept room_id; a build without them answers
  // unsupported_mode rather than spawning an unreachable orphan.
  bindSpawnRoom = null,    // (roomId, session) -> void; registers the room-session binding
  unbindSpawnRoom = null,  // (roomId) -> void; idempotent
  injectTurn = null,       // (session, text) -> boolean; false = injection refused
  serverLabel = '',
```

In `recent_folders`, before `respond(request, true, { folders })`:

```js
      let activity = null;
      let limits = null;
      try { activity = getActivity(); } catch { /* capacity is best-effort */ }
      try { limits = getLimits(); } catch { /* capacity is best-effort */ }
      respond(request, true, {
        folders,
        ...(activity ? { activity } : {}),
        ...(limits ? { limits } : {}),
      });
```

In `start`, after the existing workdir resolution and BEFORE `startSession` add param validation:

```js
      const roomId = typeof params.room_id === 'string' && params.room_id && params.room_id.length <= 200 ? params.room_id : null;
      if (params.room_id !== undefined && !roomId) return respond(request, false, { code: 'bad_request', detail: 'bad room_id' });
      const prompt = typeof params.prompt === 'string' && params.prompt ? params.prompt : null;
      if (roomId && !prompt) return respond(request, false, { code: 'bad_request', detail: 'room_id requires prompt' });
      const fromName = typeof params.from_name === 'string' && params.from_name ? params.from_name : null;
```

After the existing `convoId` guard succeeds (we have a session with a usable convo id), add the spawn-room attach — teardown mirrors the existing `unsupported_mode` path:

```js
      if (roomId) {
        // Room-first ordering is the journal's; ours is bind-then-inject so
        // the room routes before the child can possibly answer into it. Any
        // failure tears the whole session down: an orphaned agent on another
        // box with no channel back is the worst outcome available
        // (2026-08-09 spec, "matron-bridge changes").
        if (!bindSpawnRoom || !injectTurn || !unbindSpawnRoom) {
          try { stopSession(session); } catch { /* best-effort teardown */ }
          return respond(request, false, { code: 'unsupported_mode', detail: 'spawn-room wiring absent' });
        }
        try {
          bindSpawnRoom(roomId, session);
          const opening = composeSpawnOpeningTurn({ task: prompt, roomId, fromName, serverLabel });
          if (!injectTurn(session, opening)) throw new Error('opening turn refused');
        } catch (e) {
          try { unbindSpawnRoom(roomId); } catch { /* idempotent remove */ }
          try { stopSession(session); } catch { /* best-effort teardown */ }
          return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
        }
      }
      respond(request, true, { convo_id: convoId });
```

Module-level export (the TARGET bridge composes the framing — a parent
cannot dictate it; spec "What the child wakes up to"):

```js
// The spawned child's first turn. Composed HERE, on the target bridge, so a
// parent can never dictate its own framing. States provenance, the task
// verbatim (it is what the user approved), the channel back, and that the
// user reads everything.
export function composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel }) {
  const parent = fromName ? `the user's agent session on "${fromName}"` : `another of the user's agent sessions`;
  const here = serverLabel ? ` You are running on "${serverLabel}".` : '';
  return [
    `[spawned session] You were started by ${parent} via a spawn request the user approved.${here}`,
    ``,
    `Task (verbatim, as approved by the user):`,
    task,
    ``,
    `The agent chat room ${roomId} is your channel back to the session that started you. It is asynchronous: use agent_chat_send with chat_room_id "${roomId}" to report progress and your final outcome there, and expect replies to arrive as later turns. The user can read everything you write, here and in the room.`,
  ].join('\n');
}
```

`fromName` arrives journal-sanitized but flatten defensively: run it through `oneLine` from `'./peer-text.js'` at the top of `composeSpawnOpeningTurn` (check lib/peer-text.js's actual export names and adjust; do the same for `serverLabel`). `task` is injected verbatim — the journal flattened it to one line at spawn_request time and the user approved that exact text.

- [ ] **Step 4: Run tests** — `npx vitest run test/journal-rpc-handlers.test.js test/journal-rpc-dispatch.test.js` → PASS.

- [ ] **Step 5: Commit** — `feat(spawn): capacity on recent_folders + prompt/room_id on start RPC` (with trailer).

---

### Task 4: `lib/agent-spawn.js` — parent-side handlers + spawn-frame router

**Files:**
- Create: `lib/agent-spawn.js`
- Test: `test/agent-spawn.test.js`

**Interfaces:**
- Consumes: `publisher.sendRoomOp(frame) -> boolean` (raw op sender, lib/journal-publisher.js:1104 — generic despite the name), `publisher.identity() -> {device_id, ...} | null`, `sessions` Map, `journalConvoIdFor(session)`, `rooms` (agent-rooms registry), `notifyParent({session, convoId, text})` (index.js seam: user notice + turn injection).
- Produces: `createAgentSpawnHandlers({...}) -> { boxes, sessionStart, onSpawnFrame, onOpError }`. `boxes`/`sessionStart` are `async (data) -> {status, body}` loopback handlers (agent-chat shape). `onSpawnFrame(frame)` consumes `kind:'spawn'` frames. `onOpError({code, ref, detail}) -> boolean` (true = consumed). Task 5 wires all four.

- [ ] **Step 1: Write failing tests** `test/agent-spawn.test.js` (vitest, modeled on `test/agent-chat.test.js`'s fake-publisher style). Build a `mk()` harness returning `{handlers, sent, notices, rooms}` with a fake publisher whose `sendRoomOp` records frames and returns true (overridable), `identity: () => ({ device_id: 7 })`, a `sessions` Map holding `{roomId: 'sess-1', journalConvoId: 'convo-1'}` keyed `'sess-1'`, a recording `rooms` stub (`record`, `isActive`), and a recording `notifyParent`. Cases:

```
boxes:
 1. happy path — call handlers.boxes({roomId: 'sess-1'}); assert a
    spawn_targets frame was sent with a request_id; then feed
    handlers.onSpawnFrame({kind:'spawn', event:'targets', request_id: <that id>,
    boxes: [{device_id: 2, name: 'eric', online: true, folders: [],
    activity: {live_sessions: 0, last_hour: []}}]});
    await the promise → {status: 200, body: {boxes: [...]}} verbatim.
 2. identity unknown (identity: () => null) → status 409, error mentions
    journal identity; NO frame sent (fail-closed).
 3. sendRoomOp returns false → 502 journal_unreachable; waiter cleaned up.
 4. timeout (targetsTimeoutMs: 20, no frame fed) → 504 timeout error;
    waiters map empty afterwards.
 5. unknown caller session ({roomId: 'nope'}) → 404.
sessionStart:
 6. happy path — sessionStart({roomId: 'sess-1', device_id: 2,
    workdir: '/w', task: 'do the thing', topic: 'T'}); assert frame
    {op: 'spawn_request', request_id, from_convo_id: 'convo-1',
    target_device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T'};
    feed onSpawnFrame({kind:'spawn', event:'pending', request_id: <id>,
    spawn_id: 'row-1'}) → {status: 200, body: {status: 'pending',
    spawn_id: 'row-1'}}.
 7. validation: missing task / task > 2000 chars / topic > 200 /
    non-integer device_id / missing workdir → 400 before any frame.
 8. journal op error — arm, then onOpError({code: 'conflict',
    ref: <request_id>, detail: 'too many requests awaiting user approval'})
    returns true and the awaited call resolves 409 with the detail;
    onOpError with an unknown ref returns false (falls through to invites).
 9. session with no journal convo id (journalConvoIdFor -> null) → 409.
outcomes:
10. started — after a successful sessionStart ack for spawn 'row-1', feed
    onSpawnFrame({kind:'spawn', event:'outcome', request_id: 'row-1',
    outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1'});
    assert rooms.record called with ('room-9', {role: 'owner',
    state: 'joined', sessionRoomId: 'sess-1', ...}); notifyParent called
    once, text contains 'started' and 'room-9'.
11. declined — notifyParent text contains 'declined'; rooms.record NOT
    called.
12. outcome with no pending context (unknown request_id) — notifyParent
    still called with session: null and a text naming the outcome (bridge
    restarted; the user still learns of it); no throw.
13. duplicate outcome for the same spawn id → second call produces NO
    second notifyParent (exactly-once surfacing).
frame hygiene:
14. onSpawnFrame with malformed frames (no event, wrong types, unknown
    event) → no throw, no effect.
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `lib/agent-spawn.js`.** Shape:

```js
// Parent-side agent spawn (spec: docs/superpowers/specs/
// 2026-08-10-agent-spawn-bridge-capacity-design.md): the bridge half of the
// journal's consent-brokered spawn flow. Two loopback handlers backing the
// agent_boxes / agent_session_start MCP tools, plus the kind:'spawn' frame
// consumer. Correlation is a request_id-keyed waiter map in the
// agent-invites style — armed BEFORE the frame is sent, because a frame
// batch can drain in one tick.

import { randomUUID } from 'crypto';

const TASK_MAX_CHARS = 2000;      // journal SPAWN_TASK_MAX_CHARS
const TOPIC_MAX_CHARS = 200;      // journal INVITE_TOPIC_MAX_CHARS
const WORKDIR_MAX_CHARS = 1024;   // journal SPAWN_WORKDIR_MAX_CHARS

export function createAgentSpawnHandlers({
  sessions,
  publisher,
  rooms,
  journalConvoIdFor = () => null,
  notifyParent = () => {},
  targetsTimeoutMs = 10000,
  pendingTimeoutMs = 10000,
  log = console,
} = {}) {
  const waiters = new Map();        // request_id -> {resolve, timer}
  const pendingSpawns = new Map();  // spawn_id -> {sessionKey, convoId, task, topic}

  const await_ = (requestId, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(requestId); resolve({ kind: 'timeout' }); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.set(requestId, { resolve, timer });
  });
  const settle = (requestId, value) => {
    const w = waiters.get(requestId);
    if (!w) return false;
    waiters.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(value);
    return true;
  };
  ...
}
```

Handler flow details:
- `callerSession(data)`: `sessions.get(data.roomId)` — 400 `{error: 'roomId required'}` when absent, 404 `{error: 'unknown session'}` when not found (copy agent-chat.js's exact wording).
- `boxes(data)`: caller check → `publisher.identity()` null ⇒ 409 `{error: 'journal identity unknown; try again shortly'}` → `rid = randomUUID()` → **arm** `p = await_(rid, targetsTimeoutMs)` → `publisher.sendRoomOp({op: 'spawn_targets', request_id: rid})`; false ⇒ settle-cleanup and 502 `{error: 'journal unreachable'}` → `const r = await p` → timeout ⇒ 504; `{kind: 'targets', boxes}` ⇒ 200 `{boxes}`; `{kind: 'op_error', code, detail}` ⇒ 502 with code+detail.
- `sessionStart(data)`: caller check → validate `device_id` (`Number.isInteger`), `workdir` (non-empty string ≤ WORKDIR_MAX_CHARS), `task` (non-empty string ≤ TASK_MAX_CHARS), `topic` (absent or string ≤ TOPIC_MAX_CHARS) — 400 each → `from_convo_id = journalConvoIdFor(session)`; null ⇒ 409 `{error: 'session has no journal conversation yet'}` → arm rid → send `{op: 'spawn_request', request_id: rid, from_convo_id, target_device_id: data.device_id, workdir: data.workdir, task: data.task, ...(data.topic ? {topic: data.topic} : {})}` → await: `{kind: 'pending', spawnId}` ⇒ record `pendingSpawns.set(spawnId, {sessionKey: data.roomId, convoId: from_convo_id, task: data.task, topic: data.topic || ''})` and 200 `{status: 'pending', spawn_id: spawnId}`; op_error ⇒ map `conflict`→409, `agent_unreachable`→502 `'target box is offline'`, `not_found`→404, else 502; timeout ⇒ 504.
- `onSpawnFrame(frame)`: ignore unless `frame && frame.kind === 'spawn' && typeof frame.event === 'string'`. `event === 'targets'` ⇒ `settle(frame.request_id, {kind: 'targets', boxes: Array.isArray(frame.boxes) ? frame.boxes : []})`. `event === 'pending'` ⇒ `settle(frame.request_id, {kind: 'pending', spawnId: typeof frame.spawn_id === 'string' ? frame.spawn_id : null})` (a null spawnId ⇒ treat as op_error internal in sessionStart). `event === 'outcome'` ⇒ `handleOutcome(frame)`.
- `handleOutcome(frame)`: `const ctx = pendingSpawns.get(frame.request_id)` — delete BEFORE notifying (exactly-once; a duplicate frame finds nothing). If no ctx: `notifyParent({session: null, convoId: null, text: describeOutcome(frame, null)})` and return. Else resolve `session = sessions.get(ctx.sessionKey) || null`; on `outcome === 'started'` and valid `room_id` string: `rooms.record(frame.room_id, {role: 'owner', state: 'joined', sessionRoomId: ctx.sessionKey, topic: ctx.topic, title: ctx.topic || ctx.task.slice(0, 80)})` inside try/catch (registry write must not swallow the notify) — this binding is what routes the child's future room reports back into the parent session. Then `notifyParent({session, convoId: ctx.convoId, text: describeOutcome(frame, ctx)})`.
- `describeOutcome(frame, ctx)`: single-line summaries —
  `started`: `🚀 Spawn ${id}: session started on the target box. Chat room ${frame.room_id} is the channel; the child was seeded with your task and will report there. Child conversation: ${frame.child_convo_id}.`
  `declined`: `🚫 Spawn ${id}: the user declined the request.`
  `expired`: `⌛ Spawn ${id}: the request expired unanswered (24h).`
  `failed`: `❌ Spawn ${id}: failed (${frame.error_code || 'unknown'}).`
  where `id` is `frame.request_id`, and when `ctx` exists prefix the task: `…: "${ctx.task.slice(0, 60)}" — `. Keep it one paragraph, no newlines (peer discipline: frame fields are journal-sanitized, but slice defensively).
- `onOpError({code, ref, detail})`: `ref` must be a string in `waiters` — `settle(ref, {kind: 'op_error', code, detail})`, return the settle result; else return false.

- [ ] **Step 4: Run tests** — `npx vitest run test/agent-spawn.test.js` → PASS.

- [ ] **Step 5: Commit** — `feat(spawn): parent-side agent-spawn handlers + spawn frame router` (with trailer).

---

### Task 5: Wiring — publisher dispatch, index.js, ask-user.js MCP tools

**Files:**
- Modify: `lib/journal-publisher.js` (spawn frame branch + option)
- Modify: `index.js` (rpc-handler deps, agent-spawn construction, loopback routes, onOpError chain, publisher thunk)
- Modify: `ask-user.js` (two MCP tools)
- Test: `test/journal-publisher.test.js` or the dispatch test file (spawn branch), plus source-inspection pins in the index-wiring test style if the repo has one (check `test/` for an index-pin pattern; if none exists, skip pins — do NOT invent a new pin framework)

**Interfaces:**
- Consumes: everything Tasks 2–4 produced.
- Produces: running bridge answers enriched `recent_folders`, spawn-capable `start`, `/agent-boxes`, `/agent-session-start`; MCP tools `agent_boxes`, `agent_session_start`.

- [ ] **Step 1: Publisher dispatch (failing test first).** In the publisher's message-dispatch test file (grep `kind === 'invite'` under `test/` to find it), add: a frame `{kind: 'spawn', event: 'pending', request_id: 'r'}` reaches a provided `onSpawnFrame` callback; a malformed one (`event` missing) does not; absence of the callback does not throw. Then implement in `lib/journal-publisher.js`: destructure `onSpawnFrame` in the options (near `onInviteFrame`, ~line 155-172) and add before the `msg.kind === 'journal'` branch (~line 583):

```js
      } else if (msg.kind === 'spawn' && onSpawnFrame) {
        if (typeof msg.event === 'string') {
          try { onSpawnFrame(msg); } catch (e) { warn(`[journal-publisher] onSpawnFrame threw: ${e.message}`); }
        }
```

- [ ] **Step 2: index.js — rpc handler deps.** At the `createRpcRequestHandler({...})` call (index.js:665-682) add:

```js
    getActivity: () => buildActivity({ sessions, persisted: loadPersistedSessions() }),
    getLimits: () => { refreshUsageLimits(DEFAULT_WORKDIR); return buildLimits(usageLimitsCache); },
    bindSpawnRoom: (roomId, session) => {
      agentRooms.record(roomId, { role: 'guest', state: 'joined', sessionRoomId: session.roomId });
    },
    unbindSpawnRoom: (roomId) => agentRooms.remove(roomId),
    injectTurn: (session, text) => sendTextToSession(session, text, { skipJournalMirror: true }),
    serverLabel: SERVER_LABEL,
```

Import `buildActivity, buildLimits` from `./lib/spawn-capacity.js`. CHECK ORDER: `agentRooms` is constructed at ~index.js:7223, AFTER the rpc handler at :665 — so the arrows must late-bind (they do: they only dereference at call time; mirror how `onRpcRequest` late-binds `journalRpcHandler`). Verify `SERVER_LABEL` is defined before :665; if not, use the same expression `agentChatHandlers` gets (`serverLabel: SERVER_LABEL` at :7791) — resolve whichever way the file allows, keeping a late-bound thunk if necessary (`serverLabel` may become `getServerLabel: () => SERVER_LABEL` ONLY if a const-order problem actually exists — check first, don't restructure preemptively).

- [ ] **Step 3: index.js — agent-spawn construction + frame thunks.** Next to `agentChatHandlers` (:7779-7793):

```js
const agentSpawnHandlers = createAgentSpawnHandlers({
  sessions,
  publisher: journalPublisher,
  rooms: agentRooms,
  journalConvoIdFor,
  notifyParent: ({ session, convoId, text }) => {
    if (convoId) journalPublishNotice(convoId, text);
    if (session) {
      roomDelivery.deliver(session, session.roomId, { roomId: 'spawn', roomTitle: 'spawn', from: 'bridge', body: text, at: Date.now() });
    }
  },
  log: console,
});
```

ACTUALLY — check `roomDelivery.deliver`'s formatting first (`lib/room-delivery.js:107` `formatOne`): if `[room "spawn"] bridge: …` reads wrong for a non-room event, instead inject directly with busy-coalescing via the simpler existing precedent `journalNotifyRoomEvent` (index.js:7477) — read that function and mimic its delivery for a session-directed non-room notice. Choose ONE mechanism, don't build a new one.

In `createJournalPublisher({...})` (index.js:376-399) add `onSpawnFrame: (frame) => agentSpawnHandlers?.onSpawnFrame(frame),` and change the `onOpError` thunk to try spawn first:

```js
    onOpError: (e) => { if (agentSpawnHandlers?.onOpError?.(e)) return; agentInvites?.onOpError(e); },
```

(`agentSpawnHandlers` is declared later in the file — the thunk late-binds like `onInviteFrame` does; keep `?.`.)

- [ ] **Step 4: index.js — loopback routes.** After the `/agent-chat-read` route (~:8052-8056), in the same style:

```js
      if (url.pathname === '/agent-boxes') {
        await respondAgentChatRoute(res, data, agentSpawnHandlers.boxes,
          (status, b) => debug(`agent-boxes ${status} ${(b.boxes || []).length ?? ''} ${b.error || ''}`));
        return;
      }
      if (url.pathname === '/agent-session-start') {
        await respondAgentChatRoute(res, data, agentSpawnHandlers.sessionStart,
          (status, b) => debug(`agent-session-start ${status} ${b.spawn_id || ''} ${b.status || b.error || ''}`));
        return;
      }
```

- [ ] **Step 5: ask-user.js — the two tools.** After `agent_chat_start` (:246), same POST-loopback pattern:

`agent_boxes` — no params (`{}`). Description:

```
List the user's other agent boxes (machines) as spawn targets, with recent
folders, current activity, and account usage limits. Use this when the user
asks to run work on another machine or to find a box with spare capacity:
prefer a box whose usage percentages are low and whose activity shows few
or no recent sessions. Data may be minutes old; offline boxes cannot be
spawned on.
```

Handler POSTs `/agent-boxes` and renders per box (plain text, one block per box):
`<name> (device <device_id>) — online|offline`, then up to 5 folders (`  <path>`), then when present `  activity: <live_sessions> live; last hour: <path> (<sessions>), …` (cap 5 entries, `+N more` beyond), then when present `  limits: <label> <percent>%` joined by ` · ` plus ` (as of <ISO from as_of>)`. Keep the renderer a small pure function at the top of the file near `describeRoomOutcome`.

`agent_session_start` — params:

```js
{
  device_id: z.number().int().describe('Target box device id, from agent_boxes'),
  workdir: z.string().describe('Absolute working directory on the target box, from agent_boxes folders'),
  task: z.string().max(2000).describe('The task prompt. Shown VERBATIM on the user\'s consent card and executed verbatim as the new session\'s first turn — write it for both audiences.'),
  topic: z.string().max(200).optional().describe('Optional short room/session title'),
}
```

Description (the spec's ask-first instruction is mandatory, keep its substance):

```
Ask the user's consent to start a new agent session on another of their
boxes, seeded with a task. If the user has not already said which box and
directory the work should happen in, ask them before calling this — they
usually have a preference, and the consent card can only be approved or
declined, it cannot be corrected. The result is pending: do NOT wait or
poll — the user's decision and the spawn outcome arrive automatically as
later turns. On approval a chat room links you to the new session; its
reports arrive there.
```

Handler POSTs `/agent-session-start`; success renders `Spawn request <spawn_id> sent — awaiting the user's approval. Continue your own work; the outcome will arrive as a later turn.`; failure renders `agent_session_start failed: <error>`.

- [ ] **Step 6: Docs touch.** `BRIDGE_CLAUDE.md`: add one sentence to the agent-to-agent section listing `agent_boxes` and `agent_session_start` (mirror the existing tool-list style).

- [ ] **Step 7: Full bridge suite** — `npm test` → green (fix what the wiring broke; do not skip).

- [ ] **Step 8: Commit** — `feat(spawn): wire agent-spawn — publisher dispatch, loopback routes, MCP tools` (with trailer).

---

### Task 6: Full-suite verification pass (both repos)

**Files:** none new — verification + fixes only.

- [ ] **Step 1:** matron-bridge: `npm test` full run; `npx eslint .` if the repo lints (check package.json scripts — run whatever `lint` script exists).
- [ ] **Step 2:** matron-journal (branch `feat/agent-spawn-journal`): `npm test` full run. Known pre-existing flake: whole-file cancellations under heavy host load — isolate-rerun to confirm before treating as real.
- [ ] **Step 3:** Fix anything red that this campaign broke (and only that — pre-existing failures get reported, not fixed).
- [ ] **Step 4:** Commit any fixes with focused messages (with trailer). Report exact suite numbers in the task report.
