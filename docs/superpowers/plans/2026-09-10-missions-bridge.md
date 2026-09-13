# Missions & milestones — bridge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Claude Code session six `mission_*`/`milestone_*` MCP tools plus `item_move`, backed by the journal's `/missions` and `/milestones` routes, and teach both prompt files when to use them.

**Architecture:** Same three-layer shape as the items tools: `ask-user.js` registers the tools and POSTs to the bridge loopback `/missions/<op>`; `index.js` allowlists the ops with one anchored regex and dispatches into `lib/missions-tools.js`; the handlers validate, inject the session's journal `convo_id`, call `lib/missions-client.js` (Bearer, never throws, `status 0` = unreachable) and hand the JSON to `lib/missions-format.js` renderers. `item_move` is one more handler in `lib/items-tools.js` behind a new `move` op.

**Tech Stack:** Node 22 ESM, `@modelcontextprotocol/sdk` + zod v4, vitest 4, source-inspection wiring tests (`test/items-wiring.test.js` idiom).

**Spec:** `docs/superpowers/specs/2026-09-10-missions-milestones-design.md` (copied into this repo alongside this plan; canonical copy in matron-apple). Requires the journal plan deployed first (`GET /missions` must answer).

## Global Constraints

- Tools never throw and never set `isError`: every failure is a sentence the model can act on (`mission_start failed: …`).
- The bridge injects `convo_id` from `journalConvoIdFor(session)`; the agent never passes one. A session with no journal conversation yet answers 409 "journal conversation not established yet — try again shortly".
- Loopback route ops must match `[a-z|]+` (the wiring test's regex) — `start|post|update|join|get|close` under `/missions/`, and `move` added to `/items/`.
- `test/items-wiring.test.js`'s `TOOLS` array is an exact-equality assertion — update it in lockstep with the `/items/` regex.
- Every new `lib/*.js` file is appended to `package.json`'s `check` chain.
- Prompt files are read once at boot; a prompt edit needs a bridge restart. Never print or log the journal token.
- Limits mirror the journal: title ≤ 200, body/summary ≤ 32768 bytes.

## File map

| File | Responsibility |
|---|---|
| `lib/missions-client.js` | **new** — HTTP verbs for `/missions*`, `/milestones*` (clone of `items-client.js`) |
| `lib/missions-format.js` | **new** — `missionLine`, `formatMissionDetail`, `formatMilestoneAck`, `formatCloseBlocked`, `formatNoMission` |
| `lib/missions-tools.js` | **new** — loopback handlers `start`, `post`, `update`, `join`, `get`, `close` |
| `lib/items-client.js` | `update` already exists — reused for `move` |
| `lib/items-tools.js` | `move` handler |
| `index.js` | client construction; handler construction; `/missions/(…)` route; `move` in the `/items/` regex |
| `ask-user.js` | `callMissions` helper; seven `server.tool` registrations |
| `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md` | "## Missions & milestones" sections |
| `package.json` | `check` chain |
| `test/missions-client.test.js`, `test/missions-format.test.js`, `test/missions-tools.test.js`, `test/missions-wiring.test.js`, `test/items-tools.test.js`, `test/items-wiring.test.js` | tests |

---

### Task 1: `lib/missions-client.js`

**Files:**
- Create: `lib/missions-client.js`
- Test: `test/missions-client.test.js`

**Interfaces:**
- Produces: `createMissionsClient({ baseUrl, token, fetchImpl, timeoutMs })` returning
  `{ start(body, {idemKey}), list(query), get(idOrNum), update(id, body), join(id, body), close(id, body), postMilestone(body, {idemKey}), listMilestones(convoId) }`, each resolving `{ status, data }`; `status 0` on no base URL / transport failure.

- [ ] **Step 1: Write the failing test**

`test/missions-client.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createMissionsClient } from '../lib/missions-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

describe('createMissionsClient', () => {
  it('start posts to /missions with bearer, idempotency key and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { mission: { id: 'ms_1', num: 61 } } }));
    const c = createMissionsClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.start({ title: 'M', body: 'goal', convo_id: 'c1' }, { idemKey: 'k1' });
    expect(r).toEqual({ status: 201, data: { mission: { id: 'ms_1', num: 61 } } });
    expect(calls[0].url).toBe('https://j/missions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'M', body: 'goal', convo_id: 'c1' });
  });

  it('routes every verb to the documented path', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.get('#61'); await c.update('ms_1', { title: 'x' }); await c.join('ms_1', { convo_id: 'c2' });
    await c.close('ms_1', { summary: 's' }); await c.postMilestone({ convo_id: 'c1', kind: 'progress', title: 't' }, {});
    await c.listMilestones('c1'); await c.list({ state: 'open' });
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'GET https://j/missions/%2361', 'PATCH https://j/missions/ms_1', 'POST https://j/missions/ms_1/join',
      'POST https://j/missions/ms_1/close', 'POST https://j/milestones', 'GET https://j/milestones?convo=c1', 'GET https://j/missions?state=open',
    ]);
  });

  it('non-2xx passes status and error through; transport failure and no base URL are status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict', blocked_by: 'no_mission' } }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.postMilestone({}, {})).toEqual({ status: 409, data: { error: 'conflict', blocked_by: 'no_mission' } });
    const boom = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createMissionsClient({ baseUrl: '', token: 't', fetchImpl });
    expect(await none.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/missions-client.test.js`
Expected: FAIL — cannot find `../lib/missions-client.js`.

- [ ] **Step 3: Write the client**

`lib/missions-client.js`:

```js
// HTTP client for the journal's missions & milestones routes (spec
// 2026-09-10, "HTTP API"). Same contract as lib/items-client.js: Bearer
// against the derived HTTP base URL, bounded timeout, RETURNS the status
// (the tool layer tells a 409 no_mission from a 409 closed from a 404).
// Never throws; never logs the token.
export function createMissionsClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  async function request(method, path, { body = null, idemKey = null } = {}) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    try {
      const res = await fetchImpl(`${base}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data || typeof data !== 'object') data = res.ok ? {} : { error: `HTTP ${res.status}` };
      if (!res.ok && typeof data.error !== 'string') data = { ...data, error: `HTTP ${res.status}` };
      return { status: res.status, data };
    } catch {
      return { status: 0, data: { error: 'journal unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  const enc = (s) => encodeURIComponent(String(s));
  const qs = (query) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) { if (v === undefined || v === null || v === '') continue; p.set(k, String(v)); }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    start: (body, { idemKey = null } = {}) => request('POST', '/missions', { body, idemKey }),
    list: (query) => request('GET', `/missions${qs(query)}`),
    get: (idOrNum) => request('GET', `/missions/${enc(idOrNum)}`),
    update: (id, body) => request('PATCH', `/missions/${enc(id)}`, { body }),
    join: (id, body) => request('POST', `/missions/${enc(id)}/join`, { body }),
    close: (id, body) => request('POST', `/missions/${enc(id)}/close`, { body }),
    postMilestone: (body, { idemKey = null } = {}) => request('POST', '/milestones', { body, idemKey }),
    listMilestones: (convoId) => request('GET', `/milestones${qs({ convo: convoId })}`),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/missions-client.test.js`
Expected: PASS (3).

- [ ] **Step 5: Add to the `check` chain and commit**

In `package.json`'s `check` script append ` && node --check lib/missions-client.js`.

```bash
git add lib/missions-client.js test/missions-client.test.js package.json
git commit -m "missions: journal client for /missions and /milestones"
```

---

### Task 2: `lib/missions-format.js`

**Files:**
- Create: `lib/missions-format.js`
- Test: `test/missions-format.test.js`

**Interfaces:**
- Produces:
  - `missionLine(mission)` → `#61 Title — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_…)`
  - `formatStartAck(data)` → `Started mission #61 "Title" (id ms_…)` or `Already in mission #61 "Title" — nothing changed (id ms_…)` when `data.existing`
  - `formatMilestoneAck(data)` → `Milestone #63 posted to mission #61 "Title"`
  - `formatMissionDetail(data)` → header line, standing body, then `Milestones:` (newest first, `- #63 [user_input] title — <iso> in <convo_id>`), `Open items:` (`- #64 title — awaiting user`), `Conversations:` (`- <id> title (box, state)`)
  - `formatBlocked(data)` → for `blocked_by` values: `no_mission` → "this conversation has no mission — call mission_start(title, body) first, then post the milestone again"; `closed` → "mission is closed — no more milestones or joins"; `user_items` → "blocked by items awaiting the user: #64 Q?, #70 R? — only the user can clear those"; `agent_items` → "blocked by open items: #71 T — close each with a real resolution (item_close), or item_move it to the mission it belongs to"; `other_mission` → "this conversation already belongs to another mission"; anything else → `data.error`.

- [ ] **Step 1: Write the failing test**

`test/missions-format.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { missionLine, formatStartAck, formatMilestoneAck, formatMissionDetail, formatBlocked } from '../lib/missions-format.js';

const mission = { id: 'ms_1', num: 61, title: 'Missions', state: 'open', body: 'Ship it', open_items: 2, needs_you: 1, conversations: 3, milestones: 5 };

describe('missions-format', () => {
  it('missionLine carries number, title, state and counts', () => {
    expect(missionLine(mission)).toBe('#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, state: 'closed', open_items: 0, needs_you: 0, closed_by: 'agent' })).toBe('#61 Missions — closed by agent, 0 open items, 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine(null)).toBe('(unknown mission)');
  });
  it('start ack distinguishes new from existing', () => {
    expect(formatStartAck({ mission })).toBe('Started mission #61 "Missions" (id ms_1)');
    expect(formatStartAck({ mission, existing: true })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1)');
  });
  it('milestone ack names both numbers', () => {
    expect(formatMilestoneAck({ milestone: { num: 63, kind: 'progress', title: 'Landed PR' }, mission })).toBe('Milestone #63 posted to mission #61 "Missions"');
  });
  it('detail lists milestones newest first, open items, conversations', () => {
    const out = formatMissionDetail({
      mission,
      milestones: [{ num: 63, kind: 'progress', title: 'Landed', created_at: 1700000000000, convo_id: 'c1' }],
      items: [{ num: 64, title: 'Q?', awaiting: 'user' }, { num: 65, title: 'T', awaiting: 'agent' }],
      conversations: [{ id: 'c1', title: 'Session', box: 'dev-2', state: 'running' }],
    });
    expect(out.split('\n')).toEqual([
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      'Ship it', '',
      'Milestones (newest first):',
      '- #63 [progress] Landed — 2023-11-14T22:13:20.000Z in c1',
      'Open items:',
      '- #64 Q? — awaiting user',
      '- #65 T — awaiting agent',
      'Conversations:',
      '- c1 Session (dev-2, running)',
    ]);
  });
  it('blocked renders every 409 reason as an instruction', () => {
    expect(formatBlocked({ error: 'conflict', blocked_by: 'no_mission' })).toMatch(/call mission_start\(title, body\) first/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toMatch(/closed/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] })).toBe('blocked by items awaiting the user: #64 Q? — only the user can clear those');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'agent_items', items: [{ num: 71, title: 'T' }] })).toBe('blocked by open items: #71 T — close each with a real resolution (item_close), or item_move it to the mission it belongs to');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).toMatch(/another mission/);
    expect(formatBlocked({ error: 'weird' })).toBe('weird');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/missions-format.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the formatter**

`lib/missions-format.js`:

```js
// Compact renderings of the journal's mission JSON for the mission_* tools.
// Pure and defensive (a journal a version ahead must degrade to a duller
// line, never throw inside a handler). One line per fact, never raw JSON.
const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };

export function missionLine(m) {
  if (!m || typeof m !== 'object') return '(unknown mission)';
  const state = m.state === 'closed' ? `closed${m.closed_by ? ` by ${m.closed_by}` : ''}` : (str(m.state) || 'open');
  const open = n(m.open_items); const need = n(m.needs_you);
  const openText = `${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`;
  const id = str(m.id);
  return `#${m.num ?? '?'} ${str(m.title) || '(untitled)'} — ${state}, ${openText}, ${n(m.conversations)} conversation${n(m.conversations) === 1 ? '' : 's'}, ${n(m.milestones)} milestone${n(m.milestones) === 1 ? '' : 's'}${id ? ` (id ${id})` : ''}`;
}

export function formatStartAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission started.';
  const id = str(m.id) ? ` (id ${m.id})` : '';
  return data.existing
    ? `Already in mission #${m.num ?? '?'} "${str(m.title)}" — nothing changed${id}`
    : `Started mission #${m.num ?? '?'} "${str(m.title)}"${id}`;
}

export function formatMilestoneAck(data) {
  const l = data?.milestone; const m = data?.mission;
  return `Milestone #${l?.num ?? '?'} posted to mission #${m?.num ?? '?'} "${str(m?.title)}"`;
}

export function formatMissionDetail(data) {
  const lines = [missionLine(data?.mission)];
  const body = str(data?.mission?.body).trim();
  if (body) lines.push(body);
  if (data?.mission?.state === 'closed' && str(data.mission.close_summary).trim()) lines.push(`Closed: ${data.mission.close_summary.trim()}`);
  lines.push('');
  const ms = Array.isArray(data?.milestones) ? data.milestones : [];
  lines.push('Milestones (newest first):');
  if (!ms.length) lines.push('- (none yet)');
  for (const l of ms) lines.push(`- #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)} in ${str(l.convo_id) || '?'}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  lines.push('Open items:');
  if (!items.length) lines.push('- (none)');
  for (const i of items) lines.push(`- #${i.num ?? '?'} ${str(i.title)}${i.awaiting ? ` — awaiting ${i.awaiting}` : ''}`);
  const convos = Array.isArray(data?.conversations) ? data.conversations : [];
  lines.push('Conversations:');
  if (!convos.length) lines.push('- (none)');
  for (const c of convos) lines.push(`- ${str(c.id)} ${str(c.title)} (${str(c.box) || 'unknown box'}, ${str(c.state) || 'unknown'})`);
  return lines.join('\n');
}

const itemList = (items) => (Array.isArray(items) ? items : []).map((i) => `#${i.num ?? '?'} ${str(i.title)}`).join(', ');

export function formatBlocked(data) {
  switch (data?.blocked_by) {
    case 'no_mission': return 'this conversation has no mission — call mission_start(title, body) first, then post the milestone again';
    case 'closed': return 'mission is closed — no more milestones or joins';
    case 'user_items': return `blocked by items awaiting the user: ${itemList(data.items)} — only the user can clear those`;
    case 'agent_items': return `blocked by open items: ${itemList(data.items)} — close each with a real resolution (item_close), or item_move it to the mission it belongs to`;
    case 'other_mission': return 'this conversation already belongs to another mission';
    default: return str(data?.error) || 'conflict';
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/missions-format.test.js`
Expected: PASS (5).

- [ ] **Step 5: `check` chain + commit**

Append ` && node --check lib/missions-format.js` to `check`.

```bash
git add lib/missions-format.js test/missions-format.test.js package.json
git commit -m "missions: tool result renderers"
```

---

### Task 3: `lib/missions-tools.js` handlers

**Files:**
- Create: `lib/missions-tools.js`
- Test: `test/missions-tools.test.js`

**Interfaces:**
- Consumes: `createMissionsClient` shape (Task 1); `formatBlocked` is used at the loopback layer? No — handlers return `{status, body}`; rendering happens in `ask-user.js` (Task 5). Handlers only validate and pass through.
- Produces: `createMissionsHandlers({ sessions, journalConvoIdFor, client })` → `{ start, post, update, join, get, close }`, each `async (data) → { status, body }`.
  - `start(data)`: `title` required (≤200), `body` optional (≤32 KiB) → `client.start({title, body, convo_id}, {idemKey})`.
  - `post(data)`: `kind ∈ {user_input, progress}`, `title` required, `body` optional → `client.postMilestone({convo_id, kind, title, body}, {idemKey})`.
  - `update(data)`: at least one of `title`/`body` → resolves the conversation's mission via `client.listMilestones`? No: resolves via `client.get`? The journal has no "mission for convo" route; use `client.list({})` and find `origin_convo_id`? That misses joined conversations. **Resolution:** handlers call `client.postMilestone`… no. Add one client call: `GET /missions?convo=<id>` is not in the spec. Instead the handler calls `client.listMilestones(convoId)` — also no mission on an empty list. **Decision for this plan:** the journal's `GET /missions/:id` accepts a mission id or number, and the bridge tracks the current mission per session in memory after `start`/`join`/`post`/`get` (`session.missionId`), seeded lazily by `GET /missions` filtered by `conversations` — see `resolveMission` below. This keeps the journal API as specified.
  - `join(data)`: `num` required → `client.join(num, {convo_id})`; on 200 caches `session.missionId`.
  - `get(data)`: `num` optional → `client.get(num ?? resolved)`.
  - `close(data)`: `summary` required → `client.close(resolved, {summary})`.

- [ ] **Step 1: Write the failing tests**

`test/missions-tools.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createMissionsHandlers } from '../lib/missions-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const mission = { id: 'ms_1', num: 61, title: 'M', origin_convo_id: 'c1', state: 'open' };
  const client = {
    start: vi.fn(async () => ({ status: 201, data: { mission } })),
    list: vi.fn(async () => ({ status: 200, data: { missions: [] } })),
    get: vi.fn(async () => ({ status: 200, data: { mission, milestones: [], items: [], conversations: [{ id: 'c1' }] } })),
    update: vi.fn(async () => ({ status: 200, data: { mission } })),
    join: vi.fn(async () => ({ status: 200, data: { mission } })),
    close: vi.fn(async () => ({ status: 200, data: { mission: { ...mission, state: 'closed' } } })),
    postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { id: 'ml_1', num: 63 }, mission } })),
    listMilestones: vi.fn(async () => ({ status: 200, data: { milestones: [] } })),
    ...clientOverrides,
  };
  const h = createMissionsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client });
  return { h, client, session, mission };
}

describe('missions handlers', () => {
  it('start: validates title/body, fills convo_id, passes idem key, caches the mission on the session', async () => {
    const { h, client, session } = fixture();
    expect((await h.start({ roomId: '!r:s', title: '' })).status).toBe(400);
    expect((await h.start({ roomId: '!r:s', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await h.start({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.start({ roomId: '!r:s', title: ' M ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.start.mock.calls[0]).toEqual([{ title: 'M', body: 'goal', convo_id: 'c1' }, { idemKey: 'k' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.get({})).status).toBe(400);
    expect((await h.get({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.get({ roomId: '!r:s' })).status).toBe(409);
  });

  it('post: validates kind and title; passes convo_id; 409 bodies pass through; status 0 → 502', async () => {
    const { h, client } = fixture();
    expect((await h.post({ roomId: '!r:s', kind: 'nope', title: 't' })).status).toBe(400);
    expect((await h.post({ roomId: '!r:s', kind: 'progress', title: '' })).status).toBe(400);
    const r = await h.post({ roomId: '!r:s', kind: 'user_input', title: 'Dan asked', body: 'b', idem_key: 'm' });
    expect(r.status).toBe(201);
    expect(client.postMilestone.mock.calls[0]).toEqual([{ convo_id: 'c1', kind: 'user_input', title: 'Dan asked', body: 'b' }, { idemKey: 'm' }]);
    const blocked = fixture({ postMilestone: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'no_mission' } })) });
    const b = await blocked.h.post({ roomId: '!r:s', kind: 'progress', title: 't' });
    expect(b.status).toBe(409); expect(b.body.blocked_by).toBe('no_mission');
    const down = fixture({ postMilestone: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.post({ roomId: '!r:s', kind: 'progress', title: 't' })).status).toBe(502);
  });

  it('get: explicit num goes straight through; no num resolves the conversation mission from GET /missions and caches it', async () => {
    const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [{ ...mission, id: 'ms_9', num: 9 }] } })) });
    await h.get({ roomId: '!r:s', num: 5 });
    expect(client.get.mock.calls[0][0]).toBe(5);
    client.get.mockResolvedValueOnce({ status: 200, data: { mission: { id: 'ms_9', num: 9 }, milestones: [], items: [], conversations: [{ id: 'c1' }] } });
    const r = await h.get({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(client.list).toHaveBeenCalledWith({ state: 'open' });
    expect(session.missionId).toBe('ms_9');
  });

  it('get / update / close with no resolvable mission answer 404 with a helpful error', async () => {
    const { h, client } = fixture();
    const r = await h.update({ roomId: '!r:s', title: 'x' });
    expect(r.status).toBe(404); expect(r.body.error).toMatch(/no mission/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('update: requires title or body; close: requires summary; join: requires num — each uses the resolved/explicit mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    expect((await h.update({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.update({ roomId: '!r:s', title: 'New' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { title: 'New' }]);
    expect((await h.close({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.close({ roomId: '!r:s', summary: 'done' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['ms_1', { summary: 'done' }]);
    expect((await h.join({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.join({ roomId: '!r:s', num: 61 })).status).toBe(200);
    expect(client.join.mock.calls[0]).toEqual([61, { convo_id: 'c1' }]);
  });

  it('close 409 carries blocked_by and the items list unchanged', async () => {
    const { h, session } = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] } })) });
    session.missionId = 'ms_1';
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409); expect(r.body.items).toEqual([{ num: 64, title: 'Q?' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/missions-tools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handlers**

`lib/missions-tools.js`:

```js
// Loopback handlers behind the mission_* / milestone_post MCP tools (spec
// 2026-09-10, "Agent tools"). HTTP-agnostic, same {status, body} contract
// as lib/items-tools.js; index.js mounts them with respondAgentChatRoute.
const KINDS = new Set(['user_input', 'progress']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;

const NO_ROUTES = 'this journal deployment does not have the /missions routes yet — deploy the journal update (matron-journal missions plan)';
const NO_MISSION = 'this conversation has no mission yet — call mission_start(title, body) first';

const bad = (error) => ({ status: 400, body: { error } });
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}
function passthroughCollection(r) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: NO_ROUTES } };
  return out;
}

export function createMissionsHandlers({ sessions, journalConvoIdFor, client }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  const title = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= TITLE_MAX ? v.trim() : null);
  const optBody = (v) => (v === undefined ? { ok: true } : (typeof v === 'string' && byteLen(v) <= BODY_MAX ? { ok: true, value: v } : { ok: false }));
  const idem = (data) => ({ idemKey: typeof data.idem_key === 'string' ? data.idem_key : null });

  // The journal has no "mission for this conversation" route by design (a
  // conversation's mission is a column, not a resource). The bridge
  // remembers the mission it last saw for the session and, cold, finds it
  // in GET /missions by conversation membership. A miss is a 404 the model
  // can act on, never a guess.
  async function resolveMission(session, convoId) {
    if (session.missionId) return session.missionId;
    const r = await client.list({ state: 'open' });
    if (r.status !== 200 || !Array.isArray(r.data?.missions)) return null;
    for (const m of r.data.missions) {
      if (m.origin_convo_id === convoId) { session.missionId = m.id; return m.id; }
    }
    for (const m of r.data.missions) {
      const d = await client.get(m.id);
      if (d.status === 200 && Array.isArray(d.data?.conversations) && d.data.conversations.some((c) => c.id === convoId)) {
        session.missionId = m.id; return m.id;
      }
    }
    return null;
  }

  const remember = (session, r) => { if ((r.status === 200 || r.status === 201) && r.body?.mission?.id) session.missionId = r.body.mission.id; return r; };

  return {
    async start(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { title: t, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      return remember(session, passthroughCollection(await client.start(body, idem(data))));
    },

    async post(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'user_input' or 'progress'");
      const t = title(data.title); if (!t) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { convo_id: convoId, kind: data.kind, title: t };
      if (b.value !== undefined) body.body = b.value;
      return remember(session, passthroughCollection(await client.postMilestone(body, idem(data))));
    },

    async update(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(`title must be at most ${TITLE_MAX} characters`); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (!Object.keys(patch).length) return bad('title or body is required');
      const id = await resolveMission(session, convoId);
      if (!id) return { status: 404, body: { error: NO_MISSION } };
      return passthrough(await client.update(id, patch));
    },

    async join(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!Number.isInteger(data.num) || data.num < 1) return bad('num is required');
      return remember(session, passthrough(await client.join(data.num, { convo_id: convoId })));
    },

    async get(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      let id = data.num;
      if (id === undefined) {
        id = await resolveMission(session, convoId);
        if (!id) return { status: 404, body: { error: NO_MISSION } };
      } else if (!Number.isInteger(id) || id < 1) return bad('num must be a positive integer');
      return remember(session, passthroughCollection(await client.get(id)));
    },

    async close(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (typeof data.summary !== 'string' || !data.summary.trim() || byteLen(data.summary) > BODY_MAX) return bad(`summary is required (at most ${BODY_MAX} bytes)`);
      const id = await resolveMission(session, convoId);
      if (!id) return { status: 404, body: { error: NO_MISSION } };
      return passthrough(await client.close(id, { summary: data.summary }));
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/missions-tools.test.js`
Expected: PASS (7).

- [ ] **Step 5: `check` chain + commit**

Append ` && node --check lib/missions-tools.js` to `check`.

```bash
git add lib/missions-tools.js test/missions-tools.test.js package.json
git commit -m "missions: loopback handlers for the mission_* tools"
```

---

### Task 4: `item_move` in `lib/items-tools.js`

**Files:**
- Modify: `lib/items-tools.js` (add `move`), `test/items-tools.test.js`, `test/items-wiring.test.js` (`TOOLS` gains `'move'`)

**Interfaces:**
- Produces: `move(data)` — `id` (item id or `#num`) required; `mission` is a positive integer, a `#num` string, or `null` → `client.update(id, { mission })`.

- [ ] **Step 1: Write the failing test**

Append to `test/items-tools.test.js` inside the `describe`:

```js
  it('move: sets or clears the item mission through PATCH; validates the target', async () => {
    const { h, client } = fixture();
    expect((await h.move({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: 'sixty' })).status).toBe(400);
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: 61 })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['it_1', { mission: '#61' }]);
    expect((await h.move({ roomId: '!r:s', id: '#4', mission: '#62' })).status).toBe(200);
    expect(client.update.mock.calls[1]).toEqual(['#4', { mission: '#62' }]);
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: null })).status).toBe(200);
    expect(client.update.mock.calls[2]).toEqual(['it_1', { mission: null }]);
  });
```

And in `test/items-wiring.test.js` change `TOOLS` to `['create', 'list', 'get', 'comment', 'close', 'reopen', 'reorder', 'move']` and the description strings from "seven" to "eight".

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/items-tools.test.js test/items-wiring.test.js`
Expected: FAIL — `h.move` is not a function; wiring regex mismatch.

- [ ] **Step 3: Add the handler**

In `lib/items-tools.js`, inside the returned object after `reorder`:

```js
    // Missions (spec 2026-09-10): move an item to a mission by number, or
    // detach it (null). The only way an agent ever changes items.mission_id.
    async move(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      let mission;
      if (data.mission === null) mission = null;
      else if (Number.isInteger(data.mission) && data.mission > 0) mission = `#${data.mission}`;
      else if (typeof data.mission === 'string' && /^#\d+$/.test(data.mission)) mission = data.mission;
      else return bad("mission must be a mission number (61 or '#61') or null to detach");
      return passthrough(await client.update(data.id, { mission }));
    },
```

- [ ] **Step 4: Wire the route regex (index.js) — done in Task 5; run the handler tests now**

Run: `npx vitest run test/items-tools.test.js`
Expected: PASS. (`items-wiring` stays red until Task 5.)

- [ ] **Step 5: Commit**

```bash
git add lib/items-tools.js test/items-tools.test.js test/items-wiring.test.js
git commit -m "items: item_move handler — set or clear an item's mission"
```

---

### Task 5: Wiring — `index.js` routes and `ask-user.js` tools

**Files:**
- Modify: `index.js` (client + handlers construction near lines 458–469 and 9792–9802; routes near 10236–10245), `ask-user.js` (before the transport connect at the bottom)
- Test: `test/missions-wiring.test.js` (new), `test/items-wiring.test.js`

- [ ] **Step 1: Write the failing wiring test**

`test/missions-wiring.test.js`:

```js
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS = ['start', 'post', 'update', 'join', 'get', 'close'];
const TOOLS = { mission_start: 'start', milestone_post: 'post', mission_update: 'update', mission_join: 'join', mission_get: 'get', mission_close: 'close' };

describe('missions wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  it('mounts all six /missions routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/missions\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /missions route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('missionsHandlers[name]');
    expect(index).toMatch(/createMissionsHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: missionsClient,?\s*\}\)/);
  });

  it('registers the six mission tools and item_move, each posting through the loopback helper', () => {
    for (const [tool, op] of Object.entries(TOOLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through callMissions`).toContain(`callMissions('${op}',`);
    }
    expect(askUser).toContain(`'item_move',`);
    expect(askUser).toContain(`callItems('move',`);
  });

  it('both prompt files carry the missions section', () => {
    expect(claudeMd).toMatch(/^## Missions & milestones/m);
    expect(claudeMd).toMatch(/mission_start/);
    expect(claudeMd).toMatch(/kind: "user_input"/);
    expect(claudeMd).toMatch(/refused until the conversation has a mission/);
    expect(codexMd).toMatch(/^## Missions & milestones/m);
    expect(codexMd).toMatch(/POST \$BASE\/milestones/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/missions-wiring.test.js`
Expected: FAIL on all three.

- [ ] **Step 3: `index.js` — client, handlers, routes**

Imports (next to the items imports at lines 8–9):

```js
import { createMissionsClient } from './lib/missions-client.js';
import { createMissionsHandlers } from './lib/missions-tools.js';
```

Directly after `const itemsClient = createItemsClient({...})` (~line 469):

```js
// Missions & milestones (spec 2026-09-10): same base URL and token as the
// items client; a missing journal resolves status 0 → 502 in the handlers.
const missionsClient = createMissionsClient({
  baseUrl: JOURNAL_WS_URL && _journalToken ? deriveMediaHttpBaseUrl(JOURNAL_WS_URL) : '',
  token: _journalToken,
});
```

Directly after `const itemsHandlers = createItemsHandlers({...})` (~line 9802):

```js
const missionsHandlers = createMissionsHandlers({
  sessions,
  journalConvoIdFor,
  client: missionsClient,
});
```

Routes: change the items regex to `/^\/items\/(create|list|get|comment|close|reopen|reorder|move)$/` and, right after the items block, add:

```js
      // The six mission_* / milestone_post tool routes; same one-matcher
      // allowlist shape as /items above.
      const missionsRoute = url.pathname.match(/^\/missions\/(start|post|update|join|get|close)$/);
      if (missionsRoute) {
        const name = missionsRoute[1];
        await respondAgentChatRoute(res, data, missionsHandlers[name],
          (status, b) => debug(`missions/${name} ${status} ${b.error || (b.mission ? `#${b.mission.num ?? '?'}` : 'ok')}`));
        return;
      }
```

- [ ] **Step 4: `ask-user.js` — helper and tools**

Add to the imports: `import { formatStartAck, formatMilestoneAck, formatMissionDetail, missionLine, formatBlocked } from './lib/missions-format.js';`

Before the `const transport = new StdioServerTransport();` line, add:

```js
// --- Missions & milestones (spec 2026-09-10) ---
//
// Same shape as callItems. A 409 is the interesting case here: the journal
// says WHY (blocked_by) and the renderer turns that into the next call the
// model should make — never isError, never raw JSON.
async function callMissions(name, args, render) {
  try {
    const res = await fetch(`${BRIDGE_API}/missions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, ...args }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return { content: [{ type: 'text', text: `${toolName(name)} failed: ${formatBlocked(data)}` }] };
    if (!res.ok) return { content: [{ type: 'text', text: `${toolName(name)} failed: ${data.error || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
}
const toolName = (op) => ({ start: 'mission_start', post: 'milestone_post', update: 'mission_update', join: 'mission_join', get: 'mission_get', close: 'mission_close' }[op] || `mission_${op}`);

server.tool(
  'mission_start',
  "Start the mission for this conversation — the human-readable record of one piece of work, shared by every agent and app of this user. Do this as soon as you know what the work is (usually right after the user's first substantive input): name it and state the goal in body, with the whole conversation as context. Milestones are refused until the conversation has a mission. If it already has one this returns it unchanged.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal and the standing description'),
  },
  async (args) => callMissions('start', args, formatStartAck),
);

server.tool(
  'milestone_post',
  "Post a milestone: a checkpoint on this conversation's mission that is also a jump target back to this exact point in the transcript. kind 'user_input' whenever an input from the user starts or redirects work (skip typos, one-word answers, clarifications) — the user's stated purpose is to get back to their last input easily. kind 'progress' as often as useful: a landed PR, a diagnosis, a decision, a phase done. There is no cap. Refused with an instruction if the conversation has no mission yet.",
  {
    kind: z.enum(['user_input', 'progress']),
    title: z.string().describe('One line, ≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB — what happened, in a sentence or two'),
  },
  async (args) => callMissions('post', args, formatMilestoneAck),
);

server.tool(
  'mission_update',
  "Rename this conversation's mission or rewrite its standing description (title and/or body). Use it when the work changes shape.",
  {
    title: z.string().optional().describe('≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB'),
  },
  async (args) => callMissions('update', args, (d) => missionLine(d.mission)),
);

server.tool(
  'mission_join',
  'Attach this conversation to an existing mission by number (e.g. work handed over from another session). Items filed here from now on belong to that mission.',
  { num: z.number().int().min(1).describe('The mission number, e.g. 61') },
  async (args) => callMissions('join', args, (d) => missionLine(d.mission)),
);

server.tool(
  'mission_get',
  "Read a mission: its milestones newest first, open items (awaiting the user first) and conversations. Default: this conversation's mission.",
  { num: z.number().int().min(1).optional().describe('A mission number; omit for this conversation\'s mission') },
  async (args) => callMissions('get', args, formatMissionDetail),
);

server.tool(
  'mission_close',
  "Close this conversation's mission when the work is DONE (not when the session ends), with a summary. Refuses while items are open: close each with a real resolution, or item_move it to the mission it belongs to. Items awaiting the user block you outright — only they can clear those.",
  { summary: z.string().describe('Markdown ≤32 KiB — how it went, what shipped, what is left') },
  async (args) => callMissions('close', args, (d) => missionLine(d.mission)),
);

server.tool(
  'item_move',
  "Move an item to another mission by number, or detach it (mission: null). The only way an item's mission ever changes.",
  {
    id: z.string().describe("Item id ('it_…') or '#12'"),
    mission: z.number().int().min(1).nullable().describe('Target mission number, or null to detach'),
  },
  async (args) => callItems('move', args, (d) => itemLine(d.item)),
);
```

- [ ] **Step 5: Run the wiring tests (prompt assertions still red until Task 6)**

Run: `npx vitest run test/missions-wiring.test.js test/items-wiring.test.js`
Expected: the route and tool-registration tests PASS; the prompt-file test FAILS (Task 6).

- [ ] **Step 6: Commit**

```bash
git add index.js ask-user.js test/missions-wiring.test.js
git commit -m "missions: loopback routes, MCP tools, item_move wiring"
```

---

### Task 6: Prompt sections

**Files:**
- Modify: `BRIDGE_CLAUDE.md` (new `## Missions & milestones` after `## Tasks & decisions (`item_*` tools)`), `BRIDGE_CODEX.md` (new `## Missions & milestones` appended after the items section)

- [ ] **Step 1: `BRIDGE_CLAUDE.md`**

Insert after the Tasks & decisions section:

```markdown
## Missions & milestones

A mission is the human-readable record of one piece of work; milestones are its checkpoints, and each one is a link back to where it happened in the transcript. The user reads the mission page to see the shape of hours of work without scrolling.

- **Start the mission with `mission_start` (title + goal) as soon as you know what the work is** — usually right after the user's first substantive input. Milestones are refused until the conversation has a mission; name it yourself from what you know, then post the milestone again. Rename later with `mission_update` if the work changes shape. A spawned session inherits its parent's mission; `mission_join` attaches this conversation to an existing one by number.
- Post a milestone with `kind: "user_input"` whenever an input from the user starts or redirects work. Skip typos, one-word answers and clarifications. The user's stated purpose is "to be able to go back to my last input easily".
- Post `kind: "progress"` milestones as often as they are useful — a landed PR, a diagnosis, a decision, a phase done. There is no upper limit; hours of unattended work should leave a readable trail.
- Close the mission (`mission_close` with a summary) when the work is done, not when the session ends. It refuses while items are open: close each with a real resolution, or `item_move` it to the mission it belongs to. Items awaiting the user block you outright — only they can clear those.
- Numbers are shared: `#63` may be an item, a mission or a milestone. Refer to any of them by number. `mission_get` reads a mission's milestones, open items and conversations.
```

- [ ] **Step 2: `BRIDGE_CODEX.md`**

Append after the items section:

````markdown
## Missions & milestones

A mission is the human-readable record of one piece of work; milestones are its checkpoints and jump targets back into the transcript. Same base URL and token discipline as the items routes above. **Start the mission as soon as you know what the work is; milestones are refused until the conversation has one.** Post a milestone with `kind:"user_input"` whenever an input from the user starts or redirects work, and `kind:"progress"` as often as useful. Close it when the work is done, not when the session ends.

- `POST $BASE/missions` — `{"title":"...","body":"goal","convo_id":"<id>"}` → 201 mission (`num` is its number); 200 with `existing:true` if the conversation already has one.
- `POST $BASE/milestones` — `{"convo_id":"<id>","kind":"user_input"|"progress","title":"...","body":"..."}` → 201; 409 `blocked_by:"no_mission"` means start the mission first, then retry.
- `GET $BASE/missions/:num` — milestones newest first, open items, conversations. `PATCH $BASE/missions/:num` `{"title"?,"body"?}` to rename.
- `POST $BASE/missions/:num/join` `{"convo_id":"<id>"}` — attach this conversation to an existing mission.
- `POST $BASE/missions/:num/close` `{"summary":"..."}` — 409 `blocked_by:"user_items"|"agent_items"` lists the open items: close each (`/items/:id/close`) or move it (`PATCH $BASE/items/:id` `{"mission":"#N"}`); items awaiting the user cannot be cleared by you.
- Give every `POST` an `Idempotency-Key` header.

```bash
curl -sS -X POST "$BASE/missions" \
  -H "Authorization: Bearer $(cat "$JOURNAL_TOKEN_FILE")" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"title\":\"Missions & milestones\",\"body\":\"Ship the journal half\",\"convo_id\":\"$CONVO_ID\"}"

curl -sS -X POST "$BASE/milestones" \
  -H "Authorization: Bearer $(cat "$JOURNAL_TOKEN_FILE")" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"convo_id\":\"$CONVO_ID\",\"kind\":\"user_input\",\"title\":\"Dan asked for missions\"}"
```
````

- [ ] **Step 3: Full suite**

Run: `npm run ci`
Expected: lint, check, tests, audit all green (`test/missions-wiring.test.js` now fully passes).

- [ ] **Step 4: Commit**

```bash
git add BRIDGE_CLAUDE.md BRIDGE_CODEX.md
git commit -m "missions: prompt sections for Claude and Codex bridges"
```

---

### Task 7: Deploy

- [ ] Confirm the journal is deployed (`GET /missions` answers 200 with a device token).
- [ ] Merge to `master` (`--admin` is needed on this repo per the 2026-09-06 memory), then fleet deploy with the existing script; **dan-mac last** — restarting it kills the session that ran this plan.
- [ ] End-to-end on one box before the fleet: a real session runs `mission_start`, posts a `user_input` and a `progress` milestone, `milestone_post` on a fresh conversation without a mission renders the "call mission_start first" sentence, `mission_close` is blocked by an open question, `item_move` moves it, close succeeds.

## Self-review against the spec

- Tools table: `mission_start` (T3/T5, `existing` rendered "already in mission #N"), `milestone_post` (T3/T5, `no_mission` rendered as the instruction), `mission_update` (404-as-text when no mission: T3 `NO_MISSION`), `mission_join`, `mission_get` (default = this conversation's mission via `resolveMission`), `mission_close` (409 rendered with items and what to do: T2 `formatBlocked`), `item_move` (T4/T5).
- "The bridge injects `convo_id`": every handler uses `callerSession`. "Tools never throw; 409 becomes actionable text; status 0 → journal unreachable": T1/T3/T5.
- Codex raw-curl equivalents: T6. Prompt section bullets: T6 copies the spec's six bullets.
- Testing: each tool against a fake client incl. 409/502/status 0 (T3), format snapshots (T2), allowlist admits only the new ops (T5 wiring test, exact-equality), prompt file contains the section (T5 test / T6).
- One deviation, stated: the spec's `mission_update`/`mission_get`/`mission_close` say "on the conversation's mission" without saying how the bridge learns it. This plan remembers the mission per session and, cold, resolves it from `GET /missions` membership (`resolveMission`). No journal API change.
- Placeholders: none. Type consistency: handler op names `start|post|update|join|get|close` match the route regex, the `callMissions` op strings, and `toolName`.
