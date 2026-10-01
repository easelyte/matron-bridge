# Projects + conversation↔mission history (bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent `project_*` tools (list, get, create, update, status; close and merge for the Coordinator), let a conversation be on several missions with one current (`mission_join` adds and makes current, new `mission_leave`, `milestone_post` may name a mission), file missions into projects from `mission_start` / `mission_create` / `mission_update`, resolve a conversation's current mission in one journal call, and teach sessions and the Coordinator how to use all of it.

**Architecture:** Same path as the existing mission tools. `ask-user.js` registers the MCP tools and POSTs to the bridge loopback (`/missions/<op>`, new `/projects/<op>`); `index.js` routes those names to handlers in `lib/missions-tools.js` and the new `lib/projects-tools.js`; the handlers validate, fill in `convo_id`, enforce the Coordinator gate for `project_close` / `project_merge`, and call the journal through `lib/missions-client.js` and the new `lib/projects-client.js` (which shares the missions client's request function). `lib/missions-format.js` and the new `lib/projects-format.js` render replies and errors as sentences. Instructions live in `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`, `BRIDGE_COORDINATOR.md` and the fallback brief in `lib/coordinator.js`.

**Tech Stack:** Node ≥22 ESM, `@modelcontextprotocol/sdk` + zod (tool schemas), vitest, eslint.

**Spec:** matron-apple `docs/superpowers/specs/2026-09-30-projects-and-mission-links-design.md` (spec PR Matronhq/matron-apple#276). Bridge scope is §5; the journal routes it calls are §3 "Routes" and §4.2. Read §3, §4 and §5 before starting.

## Global Constraints

- The object is called **Project**. Every prompt that mentions it defines it once as the user's tracker object that groups missions, "not a working directory, and nothing to do with `~/.claude/projects`".
- A mission is in **at most one** project (`project: N` or `null`).
- **Any agent** may call `project_create`, `project_update`, `project_status`, and may file a mission (`mission_start` / `mission_create` with `project`, `mission_update` with `project`). `project_close` and `project_merge` are **Coordinator only**: the bridge refuses a non-Coordinator session with a 403 sentence before any journal call, and the journal also answers 403 `not_coordinator`.
- Project status limit is copied from mission status: 1–600 characters after folding CRLF to LF and trimming, counted in UTF-16 units (JS `String.length`).
- Title ≤ 200 characters after trimming; body and summary ≤ 32 KiB (`Buffer.byteLength`).
- Journal routes, exactly as the spec names them: `POST /missions/:id/join`, `POST /missions/:id/leave {convo_id}`, `POST /milestones` with optional `mission`, `GET /conversations/:id/missions` (current first), `POST /projects {title, body?, convo_id?}` + `Idempotency-Key`, `GET /projects?state=`, `GET /projects/:id`, `PATCH /projects/:id {title?, body?, status?, convo_id?}`, `POST /projects/:id/close {summary}`, `POST /projects/:id/merge {into}`, `PATCH /missions/:id` gains `project: id|#n|n|null`, `POST /missions` gains optional `project`.
- `mission_join` never says "already belongs to another mission" again. `mission_leave(num)` is new.
- The cold resolve uses `GET /conversations/:id/missions` and caches the **current** mission id; when that route answers 404 (journal from before mission links) it falls back to today's O(n) scan.
- Every tool error is plain text `<tool> failed: <sentence>` — never `isError`, never raw JSON — like the existing mission tools.
- The Coordinator's sweep writes each project's status, merges near-duplicate projects (reporting each merge), files **one** question proposing which unfiled missions go into which project and which quiet missions to close, and never moves or closes a mission without the user's answer.
- **Merge gate:** the bridge PR merges only AFTER the journal half (matron-journal projects plan) is deployed to services-1 (spec §7: journal, then bridge, then apps).
- **The implementer does not deploy.** No `deploy.sh`, no fleet deploys, no restarts.
- Work only in a fresh worktree (`/Users/danbarker/Dev/matron-bridge-projects`, branch `feat/projects` from `origin/master`). NEVER touch `~/Dev/claude-matrix-bridge` (the live deploy tree).
- Commits: `git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit …`, message ending with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git config user.*`.

## Review Focus

1. **An old journal silently ignoring the new fields.** A journal from before this work ignores `mission` on `POST /milestones` (the milestone lands on the current mission instead of the named one) and `project` on `POST /missions` / `PATCH /missions/:id` (the mission stays unfiled). The user expects the agent to be told, not a success line naming the wrong mission. Pinned in Task 3 (`post: a journal that ignores mission`) and Task 4 (`project_ignored`).
2. **The current-mission cache after a named post, a leave, or a project lookup.** `milestone_post` with `mission: N` and `project_get` must not overwrite the cached current mission, and `mission_leave` must drop it, or later milestones land on the wrong mission. Pinned in Task 3 (`post with mission never caches`, `leave drops the cache`) and Task 7 (`get with no num`).
3. **Cold resolve on a new journal whose first link is not current, or that has no current link.** The user expects milestones on the current mission, and "no mission" (not a stale ended link) when there is none; an outage on the new route must be reported, not treated as "old journal" and scanned. Pinned in Task 2.
4. **A non-Coordinator calling `project_close` / `project_merge`, and a session that became Coordinator live.** Refused with a sentence before the journal is called; a session the journal currently lists as Coordinator is allowed even if its spawn-time flag is false (the consent tools' Bugbot lesson). Pinned in Task 7 (`close/merge Coordinator gate`) and Task 8 (index wiring of `isCoordinator`).
5. **`project_merge` into itself, or a stale number after a merge.** `num === into` is refused with a sentence before the journal; the journal's `not_found` for either side reads as a sentence naming both numbers. Pinned in Task 7 (`merge validation`) and Task 6 (`merge not_found`).

## Before you start

```bash
git -C /Users/danbarker/Dev/matron-bridge-projects-plan fetch origin
git -C /Users/danbarker/Dev/matron-bridge-projects-plan worktree add -b feat/projects /Users/danbarker/Dev/matron-bridge-projects origin/master
cd /Users/danbarker/Dev/matron-bridge-projects && npm ci --no-audit --no-fund
```

Baseline (verified 2026-09-30 on this Mac, `origin/master` 5421e43): `npx vitest run test/<file>` →
`missions-tools` 38 passed, `missions-format` 16, `missions-wiring` 12, `missions-client` 4, `missions-idem` 6, `coordinator` 57. The FULL suite has pre-existing macOS-local failures in `codex-completion`, `codex-liveness`, `codex-producer`, `file-link-guard`, `interactive-session`, `permission-gate`, `pre-trust` (Linux `/proc` and node-pty assumptions). CI (Linux) is the full-suite gate; locally, a failure outside those files is yours.

## File map

| File | Change |
|---|---|
| `lib/missions-client.js` | export `createJournalRequester`, `enc`, `qs`; add `leave`, `conversationMissions` |
| `lib/projects-client.js` | **new** — journal `/projects` client on the shared requester |
| `lib/missions-tools.js` | cold resolve via `GET /conversations/:id/missions` (+ old-journal scan fallback); `resolveMission` exposed; `leave`; `post` with `mission`; `start` / `create` / `update` with `project`; `update` with explicit `mission`; `get` attaches this conversation's missions |
| `lib/missions-idem.js` | optional `mission` in the key |
| `lib/missions-format.js` | export `statusLine`; `missionLine` shows activity and project; `formatJoinAck`, `formatLeaveAck`, `formatUpdateAck`; start/create acks for projects; detail shows link history; `not_linked` / reworded `other_mission` |
| `lib/projects-format.js` | **new** — project renderers and error sentences |
| `lib/projects-tools.js` | **new** — `list get create update status close merge` handlers |
| `ask-user.js` | new `mission_leave` + seven `project_*` tools; changed mission tool schemas/descriptions; `callProjects` |
| `index.js` | `projectsClient`, `projectsHandlers`, `/missions/…leave…`, `/projects/(list|get|create|update|status|close|merge)` |
| `package.json` | `check` script covers the three new files |
| `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`, `BRIDGE_COORDINATOR.md`, `lib/coordinator.js` | instructions |
| `test/missions-*.test.js`, `test/projects-*.test.js` (new), `test/coordinator.test.js` | tests |

Wiring tests that pin exact lists and must be updated in Task 8: `test/missions-wiring.test.js` `OPS` (the `/missions/(…)` matcher, compared with `toEqual` after sort) and `TOOL_CALLS` (exact renderer call per tool), and its idempotency-key regex on `callMissions`.

---

### Task 1: Journal clients — shared requester, `leave`, `conversationMissions`, projects client

**Files:**
- Modify: `lib/missions-client.js` (whole file)
- Create: `lib/projects-client.js`
- Test: `test/missions-client.test.js` (append), `test/projects-client.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `createJournalRequester({ baseUrl, token, fetchImpl?, timeoutMs? })` → `request(method, path, { body?, idemKey? })` → `Promise<{status, data}>` (status 0 = unreachable; never throws).
  - `enc(s)`, `qs(query)` exported from `lib/missions-client.js`.
  - Missions client gains `leave(id, body)` → `POST /missions/:id/leave`, `conversationMissions(convoId)` → `GET /conversations/:id/missions`.
  - `createProjectsClient(opts)` → `{ list(query), get(idOrNum), create(body, {idemKey}), update(idOrNum, body), close(idOrNum, body), merge(idOrNum, body) }`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('createMissionsClient', …)` in `test/missions-client.test.js`, before its closing `});`:

```js
  it('leave and conversationMissions go to the spec 2026-09-30 routes', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { missions: [] } }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.leave(61, { convo_id: 'c1' });
    await c.conversationMissions('c 1');
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'POST https://j/missions/61/leave',
      'GET https://j/conversations/c%201/missions',
    ]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ convo_id: 'c1' });
    expect(calls[1].init.body).toBeUndefined();
  });
```

Create `test/projects-client.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createProjectsClient } from '../lib/projects-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

describe('createProjectsClient', () => {
  it('create posts to /projects with bearer, idempotency key and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { project: { id: 'pj_1', num: 70 } } }));
    const c = createProjectsClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.create({ title: 'Promo launch', convo_id: 'c1' }, { idemKey: 'k1' });
    expect(r).toEqual({ status: 201, data: { project: { id: 'pj_1', num: 70 } } });
    expect(calls[0].url).toBe('https://j/projects');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'Promo launch', convo_id: 'c1' });
  });

  it('routes every verb to the documented path', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.list({ state: 'open' }); await c.list({});
    await c.get(70); await c.get('pj_1');
    await c.update(70, { status: 's', convo_id: 'c1' });
    await c.close(70, { summary: 'done', convo_id: 'c1' });
    await c.merge(70, { into: 71, convo_id: 'c1' });
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'GET https://j/projects?state=open', 'GET https://j/projects',
      'GET https://j/projects/70', 'GET https://j/projects/pj_1',
      'PATCH https://j/projects/70', 'POST https://j/projects/70/close', 'POST https://j/projects/70/merge',
    ]);
    expect(JSON.parse(calls[6].init.body)).toEqual({ into: 71, convo_id: 'c1' });
  });

  it('non-2xx passes status and error through; transport failure and no base URL are status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict', blocked_by: 'open_missions' } }));
    const c = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.close(70, {})).toEqual({ status: 409, data: { error: 'conflict', blocked_by: 'open_missions' } });
    const boom = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createProjectsClient({ baseUrl: '', token: 't', fetchImpl });
    expect(await none.get(1)).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-client.test.js test/projects-client.test.js`
Expected: FAIL — `c.leave is not a function`, and `Failed to load url ../lib/projects-client.js`.

- [ ] **Step 3: Implement**

Replace `lib/missions-client.js` with:

```js
// HTTP client for the journal's missions & milestones routes (spec
// 2026-09-10, "HTTP API"). Same contract as lib/items-client.js: Bearer
// against the derived HTTP base URL, bounded timeout, RETURNS the status
// (the tool layer tells a 409 no_mission from a 409 closed from a 404).
// Never throws; never logs the token.
//
// createJournalRequester is shared with lib/projects-client.js (spec
// 2026-09-30 projects §5): one request function, one error contract.
export function createJournalRequester({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  return async function request(method, path, { body = null, idemKey = null } = {}) {
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
  };
}

export const enc = (s) => encodeURIComponent(String(s));
export const qs = (query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) { if (v === undefined || v === null || v === '') continue; p.set(k, String(v)); }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function createMissionsClient(opts = {}) {
  const request = createJournalRequester(opts);

  // mission_create goes to the journal's create route, POST /missions
  // (src/missions-http.js handleCreate), with attach:false in the body. The
  // journal also mounts /missions/create as an alias; the canonical route is
  // used so the bridge works against the same path start() already uses.
  const MISSIONS_CREATE_PATH = '/missions';

  return {
    start: (body, { idemKey = null } = {}) => request('POST', '/missions', { body, idemKey }),
    create: (body, { idemKey = null } = {}) => request('POST', MISSIONS_CREATE_PATH, { body, idemKey }),
    list: (query) => request('GET', `/missions${qs(query)}`),
    get: (idOrNum) => request('GET', `/missions/${enc(idOrNum)}`),
    update: (id, body) => request('PATCH', `/missions/${enc(id)}`, { body }),
    join: (id, body) => request('POST', `/missions/${enc(id)}/join`, { body }),
    // Spec 2026-09-30 §3: end this conversation's link to a mission.
    leave: (id, body) => request('POST', `/missions/${enc(id)}/leave`, { body }),
    close: (id, body) => request('POST', `/missions/${enc(id)}/close`, { body }),
    postMilestone: (body, { idemKey = null } = {}) => request('POST', '/milestones', { body, idemKey }),
    listMilestones: (convoId) => request('GET', `/milestones${qs({ convo: convoId })}`),
    // Spec 2026-09-30 §3: this conversation's mission links, current first.
    // 404 on a journal from before mission links (the tool layer falls back).
    conversationMissions: (convoId) => request('GET', `/conversations/${enc(convoId)}/missions`),
  };
}
```

Create `lib/projects-client.js`:

```js
// HTTP client for the journal's /projects routes (spec 2026-09-30 projects
// §4.2). The same request function and error contract as the missions
// client: RETURNS {status, data}, status 0 = unreachable, never throws,
// never logs the token. project_status is a PATCH with {status, convo_id},
// so it goes through update().
import { createJournalRequester, enc, qs } from './missions-client.js';

export function createProjectsClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    list: (query) => request('GET', `/projects${qs(query)}`),
    get: (idOrNum) => request('GET', `/projects/${enc(idOrNum)}`),
    create: (body, { idemKey = null } = {}) => request('POST', '/projects', { body, idemKey }),
    update: (idOrNum, body) => request('PATCH', `/projects/${enc(idOrNum)}`, { body }),
    close: (idOrNum, body) => request('POST', `/projects/${enc(idOrNum)}/close`, { body }),
    merge: (idOrNum, body) => request('POST', `/projects/${enc(idOrNum)}/merge`, { body }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-client.test.js test/projects-client.test.js`
Expected: `Tests  8 passed (8)` (5 + 3).

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/missions-client.js lib/projects-client.js test/missions-client.test.js test/projects-client.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "journal clients: shared requester, mission leave, conversation missions, projects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cold resolve through `GET /conversations/:id/missions`

**Files:**
- Modify: `lib/missions-tools.js:84-120` (`resolveMission` → new `resolveMission` + old body renamed `scanForMission`), `:245-261` (`get`), the returned object (expose `resolveMission`)
- Test: `test/missions-tools.test.js` (fixture at lines 4-22; append tests inside `describe('missions handlers', …)` before the nested `describe('close with mission: N …')` at line 446)

**Interfaces:**
- Consumes: `client.conversationMissions(convoId)` (Task 1).
- Produces: `missionsHandlers.resolveMission(session, convoId)` → `Promise<{id: string|null} | {err: {status, body}}>` (used by `lib/projects-tools.js` in Task 7; NOT a route — the index matcher is an allowlist). `get` with no `num` returns `{ ...detail, conversation_missions: [...] }` when the links route answers 200 (rendered in Task 5).

- [ ] **Step 1: Write the failing tests**

In `test/missions-tools.test.js`, in `fixture()`'s `client` object, after `listMilestones: …,` add:

```js
    // Default: a journal from before mission links (404), so every existing
    // cold-resolve test keeps exercising the old scan.
    conversationMissions: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })),
    leave: vi.fn(async () => ({ status: 200, data: { mission } })),
```

Append inside `describe('missions handlers', …)` (before the nested `describe('close with mission: N (the Coordinator)'`):

```js
  describe('cold resolve through GET /conversations/:id/missions (spec 2026-09-30 §5)', () => {
    const link = (id, num, extra = {}) => ({ id, num, title: `M${num}`, state: 'open', current: false, active: true, joined_at: 1, ended_at: null, how: 'joined', ...extra });

    it('one call, caches the CURRENT link, never scans', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_7', 7, { current: true }), link('ms_3', 3)] } })),
      });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(200);
      expect(client.conversationMissions.mock.calls[0]).toEqual(['c1']);
      expect(client.update.mock.calls[0][0]).toBe('ms_7');
      expect(session.missionId).toBe('ms_7');
      expect(client.list).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
    });

    it('picks the current link wherever it sits; an active-not-current or ended link is never the default', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_3', 3), link('ms_2', 2, { active: false, ended_at: 5 }), link('ms_9', 9, { current: true })] } })),
      });
      await h.update({ roomId: '!r:s', title: 'New' });
      expect(client.update.mock.calls[0][0]).toBe('ms_9');
      expect(session.missionId).toBe('ms_9');
    });

    it('links but none current → the no-mission 404, no scan, nothing cached', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_3', 3, { active: false, ended_at: 5 })] } })),
      });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/call mission_start/);
      expect(session.missionId).toBeUndefined();
      expect(client.list).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });

    it('an outage on the links route is reported — never a scan, never "no mission"', async () => {
      for (const res of [{ status: 0, data: { error: 'journal unreachable' } }, { status: 500, data: { error: 'boom' } }]) {
        const { h, client, session } = fixture({ conversationMissions: vi.fn(async () => res) });
        const r = await h.update({ roomId: '!r:s', title: 'New' });
        expect(r.status).toBe(res.status === 0 ? 502 : 500);
        expect(r.body.error).not.toContain('mission_start');
        expect(client.list).not.toHaveBeenCalled();
        expect(session.missionId).toBeUndefined();
      }
    });

    it('a 200 with an unreadable link list is a 502', async () => {
      const { h, client } = fixture({ conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: 'nope' } })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("the journal returned an unreadable list of this conversation's missions");
      expect(client.update).not.toHaveBeenCalled();
    });

    it('a 404 on the links route (old journal) falls back to the GET /missions scan', async () => {
      const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [mission] } })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(200);
      expect(client.conversationMissions).toHaveBeenCalledTimes(1);
      expect(client.list).toHaveBeenCalledTimes(1);
      expect(session.missionId).toBe('ms_1');
    });

    it('resolveMission is exposed for the projects handlers and shares the cache', async () => {
      const { h, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_7', 7, { current: true })] } })),
      });
      expect(await h.resolveMission(session, 'c1')).toEqual({ id: 'ms_7' });
      expect(session.missionId).toBe('ms_7');
    });

    it("get with no num attaches this conversation's missions; with num it does not", async () => {
      const links = [link('ms_1', 61, { current: true }), link('ms_3', 3)];
      const { h, client, session } = fixture({ conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: links } })) });
      session.missionId = 'ms_1';
      const own = await h.get({ roomId: '!r:s' });
      expect(own.status).toBe(200);
      expect(own.body.conversation_missions).toEqual(links);
      const other = await h.get({ roomId: '!r:s', num: 5 });
      expect(other.body.conversation_missions).toBeUndefined();
      expect(client.conversationMissions).toHaveBeenCalledTimes(1);
    });

    it('get with no num still answers when the links route is missing (old journal)', async () => {
      const { h, session } = fixture();
      session.missionId = 'ms_1';
      const r = await h.get({ roomId: '!r:s' });
      expect(r.status).toBe(200);
      expect(r.body.conversation_missions).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: 7 failed, 40 passed ("old journal falls back" and "get … links route is missing" already pass).

- [ ] **Step 3: Implement**

In `lib/missions-tools.js`, add after the `NO_CONVO` constant:

```js
const UNREADABLE_LINKS = "the journal returned an unreadable list of this conversation's missions";
```

Replace the comment block and function at lines 84-120 (`// The journal has no "mission for this conversation" route …` through the end of `resolveMission`) with:

```js
  // Cold resolve (spec 2026-09-30 projects §5). A conversation can be on
  // several missions; exactly one active link is CURRENT, or none is, and
  // that is the default target of every "this conversation's mission" op.
  // GET /conversations/:id/missions lists the links, current first — one
  // call. Only a link with current === true is cached: an active-but-not-
  // current or ended link is never a default. A 200 with no current link is
  // "no mission" (the model can mission_join or mission_start).
  // A journal from before mission links answers that route 404: fall back to
  // the old scan (scanForMission). Any other failure is an outage, reported
  // as such — scanning or answering "no mission" then would mint duplicates.
  // Returns {id} (id null = no current mission) or {err}, a ready response.
  async function resolveMission(session, convoId) {
    if (session.missionId) return { id: session.missionId };
    const r = await client.conversationMissions(convoId);
    if (r.status === 404) return scanForMission(session, convoId);
    if (r.status !== 200) return { err: passthrough(r) };
    if (!Array.isArray(r.data?.missions)) return { err: { status: 502, body: { error: UNREADABLE_LINKS } } };
    const current = r.data.missions.find((m) => m && m.current === true && typeof m.id === 'string' && m.id);
    if (!current) return { id: null };
    session.missionId = current.id;
    return { id: current.id };
  }

  // The pre-links fallback: a conversation's mission was a single column,
  // not a resource. Cold, find it in GET /missions by conversation
  // membership. A miss is a 404 the model can act on, never a guess.
  // The scan lists missions in EVERY state, not just open ones: after a
  // bridge restart a conversation whose mission is closed would otherwise
  // resolve to "no mission", the model would obey "call mission_start",
  // POST /missions would answer 200 existing:true with that same closed
  // mission, and the loop would never end. Listing closed missions too lets
  // the journal give the real answer — 409 closed on update/close/post.
  // Worst case (no origin_convo_id match) is O(missions): one GET
  // /missions/:id per mission until membership is found.
  async function scanForMission(session, convoId) {
    const r = await client.list();
    // A journal that cannot be reached, or is failing, is not "no mission":
    // telling the model to mission_start now would create a duplicate the
    // moment the journal is back. Surface the outage instead; only a clean
    // 200 with a readable (possibly empty) list means there is nothing to find.
    if (r.status !== 200) return { err: passthroughCollection(r) };
    if (!Array.isArray(r.data?.missions)) {
      return { err: { status: 502, body: { error: 'the journal returned an unreadable mission list' } } };
    }
    for (const m of r.data.missions) {
      if (m.origin_convo_id === convoId) { session.missionId = m.id; return { id: m.id }; }
    }
    for (const m of r.data.missions) {
      const d = await client.get(m.id);
      if (d.status === 200 && Array.isArray(d.data?.conversations) && d.data.conversations.some((c) => c.id === convoId)) {
        session.missionId = m.id; return { id: m.id };
      }
    }
    return { id: null };
  }
```

(The last three `for`/`return` lines are the old body verbatim; only the function name and the comment's first lines change.)

In `get`, replace the `if (id === undefined) { … }` block with:

```js
      if (id === undefined) {
        // No num: resolve the conversation's own (current) mission and cache
        // it. An explicit num, below, is an arbitrary lookup — possibly not
        // this conversation's mission — so it must not clobber that cache.
        const r = await viaResolvedMission(session, convoId, async (resolved) => remember(session, passthrough(await client.get(resolved))));
        if (r.status !== 200) return r;
        // Every mission this conversation is on (spec 2026-09-30 §3), so an
        // agent on several knows which to name on milestone_post. Best
        // effort: an old journal (404) or a failure just leaves it out.
        const links = await client.conversationMissions(convoId);
        if (links.status === 200 && Array.isArray(links.data?.missions)) return { status: 200, body: { ...r.body, conversation_missions: links.data.missions } };
        return r;
      }
```

In the object returned by `createMissionsHandlers`, add as the first property (before `async start(data) {`):

```js
    // Not a route (index.js mounts an allowlist of op names): the projects
    // handlers use it to find this conversation's current mission.
    resolveMission,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: `Tests  47 passed (47)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/missions-tools.js test/missions-tools.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: resolve the current mission in one call, old-journal scan as fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `mission_leave`, `mission_join` as add-and-make-current, `milestone_post` with `mission`

**Files:**
- Modify: `lib/missions-tools.js` constants (after `UNREADABLE_LINKS`), `post` (lines 185-194), after `join` add `leave`
- Test: `test/missions-tools.test.js` (append inside `describe('missions handlers', …)`, before the nested Coordinator `describe`)

**Interfaces:**
- Consumes: `client.leave`, `client.conversationMissions` (Task 1), `resolveMission` cache semantics (Task 2).
- Produces:
  - handler `leave({ roomId, num })` → 200 body `{ ...journalBody, left: num, current: <link row>|null|undefined }` (`undefined` = could not re-read); 404 body `{ error: <sentence> }`.
  - handler `post({ roomId, kind, title, body?, mission?, idem_key? })` — with `mission`, sends `body.mission = <int>` and never caches.
  - Route name `leave` (Task 8 wires it).

- [ ] **Step 1: Write the failing tests**

Append:

```js
  describe('several missions per conversation (spec 2026-09-30 §3)', () => {
    it('join makes the joined mission current in the cache, replacing the old one', async () => {
      const joined = { id: 'ms_9', num: 9, title: 'Next', state: 'open' };
      const { h, client, session } = fixture({ join: vi.fn(async () => ({ status: 200, data: { mission: joined } })) });
      session.missionId = 'ms_1';
      const r = await h.join({ roomId: '!r:s', num: 9 });
      expect(r.status).toBe(200);
      expect(client.join.mock.calls[0]).toEqual([9, { convo_id: 'c1' }]);
      expect(session.missionId).toBe('ms_9');
    });

    it('leave: validates num, posts convo_id, drops the cache and reports the new current mission', async () => {
      const next = { id: 'ms_3', num: 3, title: 'Other', current: true, active: true };
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [next] } })),
      });
      session.missionId = 'ms_1';
      expect((await h.leave({ roomId: '!r:s' })).status).toBe(400);
      expect((await h.leave({ roomId: '!r:s', num: 0 })).status).toBe(400);
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.status).toBe(200);
      expect(client.leave.mock.calls[0]).toEqual([61, { convo_id: 'c1' }]);
      expect(r.body.left).toBe(61);
      expect(r.body.current).toEqual(next);
      expect(session.missionId).toBe('ms_3');
    });

    it('leave: no current mission left → current null and nothing cached', async () => {
      const { h, session } = fixture({ conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [{ id: 'ms_1', num: 61, current: false, active: false, ended_at: 9 }] } })) });
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.body.current).toBeNull();
      expect(session.missionId).toBeUndefined();
    });

    it('leave: the re-read failing still reports the leave (current unknown) and leaves the cache empty', async () => {
      const { h, session } = fixture({ conversationMissions: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.status).toBe(200);
      expect(r.body.current).toBeUndefined();
      expect(session.missionId).toBeUndefined();
    });

    it('leave: 404 is "not on that mission" (or an old journal) in a sentence; the cache is kept; 502 when unreachable', async () => {
      const { h, session } = fixture({ leave: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 5 });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('this conversation is not on mission #5 — nothing to leave (a journal older than mission history cannot leave either: deploy the journal update)');
      expect(session.missionId).toBe('ms_1');
      const down = fixture({ leave: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      expect((await down.h.leave({ roomId: '!r:s', num: 5 })).status).toBe(502);
    });

    it('post with mission: validates it, sends it, and never caches the named mission', async () => {
      const named = { id: 'ms_3', num: 3, title: 'Other', state: 'open' };
      const { h, client, session } = fixture({ postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { num: 80 }, mission: named } })) });
      session.missionId = 'ms_1';
      expect((await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 0 })).status).toBe(400);
      expect((await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: '3' })).status).toBe(400);
      const r = await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3, idem_key: 'k' });
      expect(r.status).toBe(201);
      expect(client.postMilestone.mock.calls[0]).toEqual([{ convo_id: 'c1', kind: 'progress', title: 't', mission: 3 }, { idemKey: 'k' }]);
      expect(session.missionId).toBe('ms_1');
    });

    it('post: a journal that ignores mission (posted to another number) is an error naming both', async () => {
      const { h } = fixture({ postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { num: 80 }, mission: { id: 'ms_1', num: 61 } } })) });
      const r = await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("this journal does not support posting to a named mission yet — the milestone went to this conversation's current mission #61 instead of #3; deploy the journal update (mission links)");
    });

    it('post with mission: 404 names the mission, not only the conversation; 409 not_linked passes through', async () => {
      const gone = fixture({ postMilestone: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      const g = await gone.h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(g.status).toBe(404);
      expect(g.body.error).toBe('no mission #3 is visible to this session, or the journal did not accept this conversation — mission_get 3 checks the number');
      const unlinked = fixture({ postMilestone: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'not_linked' } })) });
      const u = await unlinked.h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(u.status).toBe(409);
      expect(u.body.blocked_by).toBe('not_linked');
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: 7 failed (`h.leave is not a function` ×4, the three `post … mission` tests), 48 passed (the join test passes already: `remember` caches the joined mission).

- [ ] **Step 3: Implement**

Add after `UNREADABLE_LINKS` in `lib/missions-tools.js`:

```js
const notOnMission = (n) => `this conversation is not on mission #${n} — nothing to leave (a journal older than mission history cannot leave either: deploy the journal update)`;
const namedMissionHidden = (n) => `no mission #${n} is visible to this session, or the journal did not accept this conversation — mission_get ${n} checks the number`;
const namedMissionIgnored = (n, got) => `this journal does not support posting to a named mission yet — the milestone went to this conversation's current mission #${got} instead of #${n}; deploy the journal update (mission links)`;
```

Replace `post` with:

```js
    async post(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'user_input' or 'progress'");
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { convo_id: convoId, kind: data.kind, title: t };
      if (b.value !== undefined) body.body = b.value;
      if (data.mission === undefined) return remember(session, passthroughConvo(await client.postMilestone(body, idem(data))));
      // A named mission (spec 2026-09-30 §3): any mission this conversation
      // has an active link to; the journal answers 409 not_linked otherwise.
      // Never cached — the current mission stays the default target.
      if (!Number.isInteger(data.mission) || data.mission < 1) return bad('mission must be a positive integer');
      body.mission = data.mission;
      const r = passthrough(await client.postMilestone(body, idem(data)));
      if (r.status === 404) return { status: 404, body: { error: namedMissionHidden(data.mission) } };
      // A journal from before mission links ignores `mission` and posts to
      // the current mission: say so, never "posted to #N".
      const got = r.body?.mission?.num;
      if ((r.status === 200 || r.status === 201) && Number.isInteger(got) && got !== data.mission) {
        return { status: 502, body: { error: namedMissionIgnored(data.mission, got) } };
      }
      return r;
    },
```

After `join` add:

```js
    // mission_leave (spec 2026-09-30 §3): end this conversation's link to
    // mission N. The journal moves `current` to the most recently joined
    // remaining active link, or to none — so the cache is dropped and the
    // links re-read once, both to cache the new current mission and to tell
    // the model where its milestones go now. The re-read is best effort:
    // `current` undefined means "not known", and the next call resolves cold.
    async leave(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!Number.isInteger(data.num) || data.num < 1) return bad('num is required');
      const r = passthrough(await client.leave(data.num, { convo_id: convoId }));
      if (r.status === 404) return { status: 404, body: { error: notOnMission(data.num) } };
      if (r.status !== 200) return r;
      delete session.missionId;
      let current;
      const links = await client.conversationMissions(convoId);
      if (links.status === 200 && Array.isArray(links.data?.missions)) {
        current = links.data.missions.find((m) => m && m.current === true && typeof m.id === 'string' && m.id) || null;
        if (current) session.missionId = current.id;
      }
      return { status: 200, body: { ...r.body, left: data.num, current } };
    },
```

Also update the comment above `viaResolvedMission`: replace `A 409 (closed / other_mission) means` with `A 409 (closed, or other_mission from a journal before mission links) means`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: `Tests  55 passed (55)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/missions-tools.js test/missions-tools.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: mission_leave, join makes current, milestone_post to a named mission

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Filing missions into projects — `project` on start, create and update; `mission` on update

**Files:**
- Modify: `lib/missions-tools.js` constants, validators (next to `statusText`), `start`, `create`, `update`
- Test: `test/missions-tools.test.js` (append inside `describe('missions handlers', …)`, before the nested Coordinator `describe`)

**Interfaces:**
- Consumes: `client.start/create/update` (existing).
- Produces:
  - `start` / `create` accept `project?: positive int` → `body.project = <int>`; response body gains `project_requested: <int>` and, when the journal ignored it, `project_ignored: true`.
  - `update` accepts `project?: positive int | null` and `mission?: positive int` (explicit mission: by number, never cached); response body gains `project_ignored: true` when an old journal dropped it.
  - Error sentences used by Task 5 tests only through `body.error`.

- [ ] **Step 1: Write the failing tests**

Append:

```js
  describe('filing missions into projects (spec 2026-09-30 §4.2, §5)', () => {
    it('start with project: sends it; the ack data names the project; an existing mission keeps project_requested', async () => {
      const filed = { id: 'ms_1', num: 61, title: 'M', state: 'open', project_id: 'pj_7' };
      const { h, client } = fixture({ start: vi.fn(async () => ({ status: 201, data: { mission: filed } })) });
      expect((await h.start({ roomId: '!r:s', title: 'M', project: 0 })).status).toBe(400);
      expect((await h.start({ roomId: '!r:s', title: 'M', project: null })).status).toBe(400);
      const r = await h.start({ roomId: '!r:s', title: 'M', project: 7, idem_key: 'k' });
      expect(r.status).toBe(201);
      expect(client.start.mock.calls[0]).toEqual([{ title: 'M', convo_id: 'c1', project: 7 }, { idemKey: 'k' }]);
      expect(r.body.project_requested).toBe(7);
      expect(r.body.project_ignored).toBeUndefined();
    });

    it('start/create: a journal with no project_id on the mission row ignored project → project_ignored', async () => {
      const { h } = fixture(); // default fixture mission has no project_id key
      const r = await h.start({ roomId: '!r:s', title: 'M', project: 7 });
      expect(r.status).toBe(201);
      expect(r.body.project_ignored).toBe(true);
      const c = fixture({ get: vi.fn(async (id) => ({ status: 200, data: { mission: { id }, milestones: [], items: [], conversations: [] } })) });
      const rc = await c.h.create({ roomId: '!r:s', title: 'M', project: 7 });
      expect(rc.status).toBe(201);
      expect(c.client.create.mock.calls[0][0]).toEqual({ title: 'M', convo_id: 'c1', attach: false, project: 7 });
      expect(rc.body.project_ignored).toBe(true);
    });

    it('start/create with project: 404 names the project as well as the conversation', async () => {
      const text = 'no project #7 is visible to this session (project_list shows the projects), or the journal did not accept this conversation';
      const s = fixture({ start: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      const rs = await s.h.start({ roomId: '!r:s', title: 'M', project: 7 });
      expect(rs.status).toBe(404); expect(rs.body.error).toBe(text);
      const c = fixture({ create: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      const rc = await c.h.create({ roomId: '!r:s', title: 'M', project: 7 });
      expect(rc.status).toBe(404); expect(rc.body.error).toBe(text);
    });

    it('update with project: number or null; project alone is enough; other values are 400', async () => {
      const filed = { id: 'ms_1', num: 61, title: 'M', state: 'open', project_id: 'pj_7' };
      const { h, client, session } = fixture({ update: vi.fn(async () => ({ status: 200, data: { mission: filed } })) });
      session.missionId = 'ms_1';
      const none = await h.update({ roomId: '!r:s' });
      expect(none.status).toBe(400);
      expect(none.body.error).toBe('title, body or project is required');
      expect((await h.update({ roomId: '!r:s', project: 0 })).status).toBe(400);
      expect((await h.update({ roomId: '!r:s', project: '#7' })).status).toBe(400);
      expect((await h.update({ roomId: '!r:s', project: 7 })).status).toBe(200);
      expect((await h.update({ roomId: '!r:s', project: null })).status).toBe(200);
      expect(client.update.mock.calls).toEqual([['ms_1', { project: 7 }], ['ms_1', { project: null }]]);
    });

    it('update with mission: by number, never resolves or touches the cache', async () => {
      const { h, client, session } = fixture({ update: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_5', num: 5, project_id: 'pj_7' } } })) });
      expect((await h.update({ roomId: '!r:s', mission: 0, project: 7 })).status).toBe(400);
      const r = await h.update({ roomId: '!r:s', mission: 5, project: 7 });
      expect(r.status).toBe(200);
      expect(client.update.mock.calls[0]).toEqual([5, { project: 7 }]);
      expect(client.conversationMissions).not.toHaveBeenCalled();
      expect(client.list).not.toHaveBeenCalled();
      expect(session.missionId).toBeUndefined();
    });

    it('update with project: old journal (400, or 200 without project_id) and unknown project (404) read as sentences', async () => {
      const rejected = fixture({ update: vi.fn(async () => ({ status: 400, data: { error: 'bad_request' } })) });
      const a = await rejected.h.update({ roomId: '!r:s', mission: 5, project: 7 });
      expect(a.status).toBe(400);
      expect(a.body.error).toBe('the journal rejected the project change — check the number with project_get 7 (a closed project takes no missions); a journal older than projects rejects every project change: deploy the journal update');
      const ignored = fixture(); // update returns the fixture mission, no project_id key
      const b = await ignored.h.update({ roomId: '!r:s', mission: 5, title: 'T', project: 7 });
      expect(b.status).toBe(200);
      expect(b.body.project_ignored).toBe(true);
      const hidden = fixture({ update: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      const c = await hidden.h.update({ roomId: '!r:s', mission: 5, project: 7 });
      expect(c.status).toBe(404);
      expect(c.body.error).toBe('no mission #5 or project #7 is visible to this session — mission_get and project_list check the numbers');
      // Without project, errors are untouched.
      const plain = fixture({ update: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      expect((await plain.h.update({ roomId: '!r:s', mission: 5, title: 'T' })).body).toEqual({ error: 'not_found' });
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: 6 failed, 55 passed.

- [ ] **Step 3: Implement**

Add after the Task 3 constants in `lib/missions-tools.js`:

```js
// Filing a mission in a project (spec 2026-09-30 §4.2). The journal's answer
// to an unknown or closed project is not pinned by the spec (404 or 400), so
// each sentence names both possibilities. A journal from before projects
// ignores `project` on POST /missions and on a PATCH that also changes a
// title/body, and 400s a PATCH carrying only `project`: detected by the
// mission row lacking the `project_id` key every new journal sends.
const projectOrConvo = (p) => `no project #${p} is visible to this session (project_list shows the projects), or the journal did not accept this conversation`;
const projectRejected = (p) => `the journal rejected the project change — check the number with project_get ${p} (a closed project takes no missions); a journal older than projects rejects every project change: deploy the journal update`;
const missionOrProject = (m, p) => `no mission${m ? ` #${m}` : ''} or project #${p} is visible to this session — mission_get and project_list check the numbers`;
const BAD_PROJECT = 'project must be a positive integer (a project number from project_list)';
const BAD_PROJECT_OR_NULL = 'project must be a positive integer, or null to take the mission out of its project';
const lacksProjectField = (r) => (r.status === 200 || r.status === 201) && r.body?.mission && typeof r.body.mission === 'object' && !('project_id' in r.body.mission);
```

Add next to the other validators (after `statusText`):

```js
  // undefined → not given; a positive integer → the project number.
  const optProject = (v) => (v === undefined ? { ok: true } : (Number.isInteger(v) && v >= 1 ? { ok: true, value: v } : { ok: false }));
  // start/create: map a 404 to the project-or-conversation sentence and
  // mark what happened to the requested project for the ack.
  function withProject(r, p) {
    if (r.status === 404) return { status: 404, body: { error: projectOrConvo(p) } };
    if (r.status !== 200 && r.status !== 201) return r;
    const body = { ...r.body, project_requested: p };
    if (lacksProjectField(r)) body.project_ignored = true;
    return { status: r.status, body };
  }
```

Replace `start` with:

```js
    async start(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const p = optProject(data.project); if (!p.ok) return bad(BAD_PROJECT);
      const body = { title: t, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      if (p.value !== undefined) body.project = p.value;
      const r = passthroughConvo(await client.start(body, idem(data)));
      return remember(session, p.value === undefined ? r : withProject(r, p.value));
    },
```

In `create`, after the `const b = optBody…` line add:

```js
      const p = optProject(data.project); if (!p.ok) return bad(BAD_PROJECT);
```

after `if (b.value !== undefined) body.body = b.value;` add:

```js
      if (p.value !== undefined) body.project = p.value;
```

replace `const r = passthroughConvo(await client.create(body, idem(data)));` with:

```js
      const sent = await client.create(body, idem(data));
      const r = p.value === undefined ? passthroughConvo(sent) : withProject(passthrough(sent), p.value);
```

(the rest of `create` — the `existing:true` check and the attached-anyway lookup — is unchanged and still reads `r.status` / `r.body`).

Replace `update` with:

```js
    // mission_update: title, body and (spec 2026-09-30 §5) project — a
    // number files the mission, null takes it out. No `mission` → this
    // conversation's current mission, resolved and cached. An explicit
    // `mission` changes any mission the caller can see (any agent may file
    // missions; the Coordinator applies filings the user approved): by
    // number, never cached, its 404 must not clear this conversation's cache.
    async update(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(BAD_TITLE); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (data.project !== undefined) {
        if (data.project !== null && !(Number.isInteger(data.project) && data.project >= 1)) return bad(BAD_PROJECT_OR_NULL);
        patch.project = data.project;
      }
      if (!Object.keys(patch).length) return bad('title, body or project is required');
      if (data.mission !== undefined && !(Number.isInteger(data.mission) && data.mission >= 1)) return bad('mission must be a positive integer');
      const send = async (id) => {
        const r = passthrough(await client.update(id, patch));
        if (patch.project === undefined) return r;
        if (r.status === 400) return { status: 400, body: { error: projectRejected(patch.project ?? 'N') } };
        if (r.status === 404 && patch.project !== null) return { status: 404, body: { error: missionOrProject(data.mission, patch.project) } };
        if (lacksProjectField(r)) return { status: r.status, body: { ...r.body, project_ignored: true } };
        return r;
      };
      if (data.mission !== undefined) return send(data.mission);
      return viaResolvedMission(session, convoId, send);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-tools.test.js`
Expected: `Tests  61 passed (61)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/missions-tools.js test/missions-tools.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: file missions into projects from start, create and update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mission renderers and the idempotency key

**Files:**
- Modify: `lib/missions-format.js` (whole-function replacements listed below), `lib/missions-idem.js`
- Test: `test/missions-format.test.js` (edit lines 19-22, 58, 73-77; append), `test/missions-idem.test.js` (append)

**Interfaces:**
- Consumes: response bodies produced by Tasks 2-4 (`conversation_missions`, `left`, `current`, `project_requested`, `project_ignored`) and spec §3/§4.2 row fields (`activity`, `project_id`, `project_num`, conversation rows' `ended_at`, `subchat_count`).
- Produces (exported from `lib/missions-format.js`): `statusLine(m)`, `formatJoinAck(data)`, `formatLeaveAck(data)`, `formatUpdateAck(data)`; changed `missionLine`, `formatStartAck`, `formatCreateAck`, `formatMissionDetail`, `formatBlocked`. `missionIdemKey({ …, mission? })`.

- [ ] **Step 1: Write the failing tests**

In `test/missions-format.test.js`, replace the import on line 3 with:

```js
import { missionLine, formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, formatBlocked, formatJournalError, formatStatusAck, formatMissionList, formatJoinAck, formatLeaveAck, formatUpdateAck, statusLine } from '../lib/missions-format.js';
```

Replace the existing expectations for the "existing" start ack (line 21 and line 75) with:

```js
    expect(formatStartAck({ mission, existing: true })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1). For different work, mission_create it and mission_join the new number');
```

```js
    expect(formatStartAck(shapes.start_200_existing)).toBe('Already in mission #1 "Missions & milestones" — nothing changed (id ms_7Kq2XwvN). For different work, mission_create it and mission_join the new number');
```

Replace line 58 (`other_mission` expectation) with:

```js
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).toBe('this journal still allows only one mission per conversation — deploy the journal update (mission history); nothing changed');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).not.toMatch(/already belongs/);
```

Append inside the first `describe('missions-format', …)` before its closing `});`:

```js
  it('missionLine shows activity and project only when the journal sends them', () => {
    expect(missionLine({ ...mission, activity: 'quiet', project_id: 'pj_7', project_num: 70 })).toBe('#61 Missions — open, quiet, project #70, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, project_id: null })).toBe('#61 Missions — open, no project, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, project_id: 'pj_7' })).toBe('#61 Missions — open, project pj_7, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    // A closed mission's activity is noise.
    expect(missionLine({ ...mission, state: 'closed', activity: 'quiet' })).toBe('#61 Missions — closed, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
  });

  it('start/create acks say where the mission was filed, or that the journal could not file it', () => {
    expect(formatStartAck({ mission, project_requested: 7 })).toBe('Started mission #61 "Missions" (id ms_1) in project #7');
    expect(formatStartAck({ mission, project_requested: 7, project_ignored: true })).toBe('Started mission #61 "Missions" (id ms_1) — but this journal does not support projects yet, so it was not filed (deploy the journal projects update)');
    expect(formatStartAck({ mission, existing: true, project_requested: 7 })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1). For different work, mission_create it and mission_join the new number; to file this one, mission_update with project: 7');
    expect(formatCreateAck({ mission, project_requested: 7 })).toBe('Mission #61 "Missions" created (unassigned) in project #7');
    expect(formatCreateAck({ mission, project_requested: 7, project_ignored: true })).toBe('Mission #61 "Missions" created (unassigned) — but this journal does not support projects yet, so it was not filed (deploy the journal projects update)');
  });

  it('join, leave and update acks', () => {
    expect(formatJoinAck({ mission })).toBe("Joined mission #61 \"Missions\" (id ms_1) — it is now this conversation's current mission: milestones and new items go there by default. Missions it was already on stay linked; mission_leave N ends one");
    expect(formatJoinAck({})).toBe("Joined — it is now this conversation's current mission");
    expect(formatLeaveAck({ left: 61, current: { num: 3, title: 'Other' } })).toBe('Left mission #61 — the current mission is now #3 "Other"');
    expect(formatLeaveAck({ left: 61, current: null })).toBe('Left mission #61 — this conversation has no current mission now; mission_join one before posting milestones');
    expect(formatLeaveAck({ left: 61 })).toBe('Left mission #61');
    expect(formatUpdateAck({ mission })).toBe(missionLine(mission));
    expect(formatUpdateAck({ mission, project_ignored: true })).toBe(`${missionLine(mission)} — but this journal does not support projects yet, so the project was not changed (deploy the journal projects update)`);
  });

  it('detail: link history on conversations, and this conversation\'s missions when attached', () => {
    const out = formatMissionDetail({
      mission, milestones: [], items: [],
      conversations: [
        { id: 'c1', title: 'Now', box: 'dev-2', state: 'running', current: true, subchat_count: 2 },
        { id: 'c2', title: 'Before', box: 'ang', state: 'idle', current: false, ended_at: 1700000000000, subchat_count: 1 },
      ],
      conversation_missions: [
        { num: 61, title: 'Missions', state: 'open', current: true, active: true },
        { num: 3, title: 'Other', state: 'open', current: false, active: true },
        { num: 2, title: 'Old', state: 'open', current: false, active: false, ended_at: 1700000000000 },
        { num: 1, title: 'Done', state: 'closed', current: false, active: true },
      ],
    });
    expect(out.split('\n').slice(-8)).toEqual([
      'Conversations:',
      '- c1 Now (dev-2, running · 2 sub-chats)',
      '- c2 Before (ang, idle · left 2023-11-14T22:13:20.000Z · 1 sub-chat)',
      "This conversation's missions:",
      '- #61 Missions — current',
      '- #3 Other — also on',
      '- #2 Old — earlier (left 2023-11-14T22:13:20.000Z)',
      '- #1 Done — earlier (closed)',
    ]);
  });

  it('blocked: not_linked is an instruction; either field carries the code', () => {
    const text = 'this conversation is not on that mission — mission_join it first (it becomes the current mission), or leave out `mission` to post to the current one';
    expect(formatBlocked({ error: 'conflict', blocked_by: 'not_linked' })).toBe(text);
    expect(formatBlocked({ error: 'not_linked' })).toBe(text);
  });

  it('statusLine is exported for the project renderers', () => {
    expect(statusLine({ status: ' x ', status_by: 'agent', status_updated_at: 1700000000000 })).toBe('Status (2023-11-14T22:13:20.000Z, by an agent): x');
    expect(statusLine({})).toBeNull();
  });
```

Append inside `describe('missionIdemKey', …)` in `test/missions-idem.test.js`:

```js
  it('a named mission joins the key only when given — keys without it are unchanged', async () => {
    const { createHash } = await import('node:crypto');
    const bucket = Math.floor(base.now / 600_000);
    const legacy = createHash('sha256').update(`post|!r:s|progress|Landed PR|the diff|${bucket}`).digest('hex');
    expect(missionIdemKey(base)).toBe(legacy);
    expect(missionIdemKey({ ...base, mission: undefined })).toBe(legacy);
    expect(missionIdemKey({ ...base, mission: 3 })).not.toBe(legacy);
    expect(missionIdemKey({ ...base, mission: 3 })).not.toBe(missionIdemKey({ ...base, mission: 4 }));
    expect(missionIdemKey({ ...base, mission: 3 })).toBe(missionIdemKey({ ...base, mission: 3 }));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-format.test.js test/missions-idem.test.js`
Expected: FAIL — `formatJoinAck is not a function` / `statusLine is not a function` (import errors fail the new tests), the existing-ack and `other_mission` expectations, and the idem `mission: 3` inequality.

- [ ] **Step 3: Implement**

In `lib/missions-format.js`:

Change `function statusLine(m) {` to `export function statusLine(m) {`.

Replace `missionLine` with:

```js
export function missionLine(m) {
  if (!m || typeof m !== 'object') return '(unknown mission)';
  const state = m.state === 'closed' ? `closed${m.closed_by ? ` by ${m.closed_by}` : ''}` : (str(m.state) || 'open');
  // Spec 2026-09-30 §4.2: rows gain the server-computed activity and the
  // project. Each shows only when sent, so an older journal's row renders
  // exactly as before. `project_id: null` (key present) is a new journal
  // saying "not in a project" — the Coordinator's filing sweep reads it.
  const activity = m.state !== 'closed' && str(m.activity) ? `, ${m.activity}` : '';
  let project = '';
  if (Number.isInteger(m.project_num)) project = `, project #${m.project_num}`;
  else if (str(m.project_id)) project = `, project ${m.project_id}`;
  else if ('project_id' in m) project = ', no project';
  const open = n(m.open_items); const need = n(m.needs_you);
  const openText = `${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`;
  const id = str(m.id);
  return `#${m.num ?? '?'} ${str(m.title) || '(untitled)'} — ${state}${activity}${project}, ${openText}, ${n(m.conversations)} conversation${n(m.conversations) === 1 ? '' : 's'}, ${n(m.milestones)} milestone${n(m.milestones) === 1 ? '' : 's'}${id ? ` (id ${id})` : ''}`;
}

// What happened to the project requested on mission_start / mission_create
// (lib/missions-tools.js withProject sets both fields).
const PROJECTS_UNSUPPORTED = 'this journal does not support projects yet';
function projectNote(data) {
  if (data?.project_ignored) return ` — but ${PROJECTS_UNSUPPORTED}, so it was not filed (deploy the journal projects update)`;
  if (Number.isInteger(data?.project_requested)) return ` in project #${data.project_requested}`;
  return '';
}
```

Replace `formatStartAck` and `formatCreateAck` with:

```js
// A conversation that already has a current mission gets it back unchanged
// from POST /missions (spec 2026-09-30 leaves that route's existing:true
// as is). Moving on to new work is mission_create + mission_join.
export function formatStartAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission started.';
  const id = str(m.id) ? ` (id ${m.id})` : '';
  if (data.existing) {
    const p = data.project_requested;
    const file = Number.isInteger(p) ? `; to file this one, mission_update with project: ${p}` : '';
    return `Already in mission #${m.num ?? '?'} "${str(m.title)}" — nothing changed${id}. For different work, mission_create it and mission_join the new number${file}`;
  }
  return `Started mission #${m.num ?? '?'} "${str(m.title)}"${id}${projectNote(data)}`;
}

export function formatCreateAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission created (unassigned).';
  return `Mission #${m.num ?? '?'} "${str(m.title)}" created (unassigned)${projectNote(data)}`;
}

// mission_join (spec 2026-09-30 §3): adds or reactivates a link and makes it
// current; the missions it was on stay linked.
export function formatJoinAck(data) {
  const m = data?.mission;
  if (!m) return "Joined — it is now this conversation's current mission";
  const id = str(m.id) ? ` (id ${m.id})` : '';
  return `Joined mission #${m.num ?? '?'} "${str(m.title)}"${id} — it is now this conversation's current mission: milestones and new items go there by default. Missions it was already on stay linked; mission_leave N ends one`;
}

// mission_leave: `current` is the re-read link row, null (none), or
// undefined (the re-read failed — say nothing rather than guess).
export function formatLeaveAck(data) {
  const left = `Left mission #${data?.left ?? '?'}`;
  if (data?.current === null) return `${left} — this conversation has no current mission now; mission_join one before posting milestones`;
  if (data?.current && typeof data.current === 'object') return `${left} — the current mission is now #${data.current.num ?? '?'} "${str(data.current.title)}"`;
  return left;
}

export function formatUpdateAck(data) {
  const line = missionLine(data?.mission);
  return data?.project_ignored ? `${line} — but ${PROJECTS_UNSUPPORTED}, so the project was not changed (deploy the journal projects update)` : line;
}
```

In `formatMissionDetail`, replace the conversations loop body and add the links section — replace from `for (const c of convos) {` to `return lines.join('\n');` with:

```js
  for (const c of convos) {
    // The session's persisted header (model, context gauge, stall) when the
    // journal has one — the Coordinator's "which session needs compacting".
    const status = formatConvoStatus(c.status, now);
    // Spec 2026-09-30 §3: a conversation that left keeps its row as history;
    // sub-chats are folded into their parent's row by default.
    const left = c.ended_at ? ` · left ${isoTime(c.ended_at)}` : '';
    const subs = n(c.subchat_count) > 0 ? ` · ${n(c.subchat_count)} sub-chat${n(c.subchat_count) === 1 ? '' : 's'}` : '';
    lines.push(`- ${str(c.id)} ${str(c.title)} (${str(c.box) || 'unknown box'}, ${str(c.state) || 'unknown'}${status ? ` · ${status}` : ''}${left}${subs})`);
  }
  // mission_get with no num attaches every mission THIS conversation is on
  // (lib/missions-tools.js get), so an agent on several can name one.
  if (Array.isArray(data?.conversation_missions)) {
    lines.push("This conversation's missions:");
    if (!data.conversation_missions.length) lines.push('- (none)');
    for (const l of data.conversation_missions) lines.push(`- #${l?.num ?? '?'} ${str(l?.title)} — ${linkState(l)}`);
  }
  return lines.join('\n');
}

function linkState(l) {
  if (l?.current === true) return 'current';
  if (l?.ended_at) return `earlier (left ${isoTime(l.ended_at)})`;
  if (l?.state === 'closed') return 'earlier (closed)';
  return 'also on';
}
```

Replace `formatBlocked` with:

```js
export function formatBlocked(data) {
  // The code rides in blocked_by (house style: {error:'conflict', blocked_by})
  // or, for a route that answers with the bare code, in error.
  switch (data?.blocked_by ?? data?.error) {
    case 'no_mission': return 'this conversation has no mission — call mission_start(title, body) first, then post the milestone again';
    case 'closed': return 'mission is closed — no more milestones, joins or status changes';
    case 'user_items': return `blocked by items awaiting the user: ${itemList(data.items)} — only the user can clear those`;
    case 'agent_items': return `blocked by open items: ${itemList(data.items)} — close each with a real resolution (item_close), or item_move it to the mission it belongs to`;
    case 'not_linked': return 'this conversation is not on that mission — mission_join it first (it becomes the current mission), or leave out `mission` to post to the current one';
    // Only a journal from before mission links still refuses a second mission.
    case 'other_mission': return 'this journal still allows only one mission per conversation — deploy the journal update (mission history); nothing changed';
    default: return str(data?.error) || 'conflict';
  }
}
```

Replace `lib/missions-idem.js`'s function with:

```js
export function missionIdemKey({ op, roomId, kind, title, body, mission, now = Date.now() }) {
  const bucket = Math.floor(Number(now) / BUCKET_MS);
  const parts = [op, roomId, kind, title, body].map((v) => (typeof v === 'string' ? v : ''));
  // milestone_post to a named mission (spec 2026-09-30 §3): the same text
  // posted to two missions is two milestones. The part is appended only
  // when given, so every key minted without it is byte-identical to before.
  const named = mission === undefined || mission === null ? '' : `|m:${mission}`;
  return createHash('sha256').update(`${parts.join('|')}${named}|${bucket}`).digest('hex');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-format.test.js test/missions-idem.test.js test/missions-tools.test.js`
Expected: `Tests  90 passed (90)` (22 + 7 + 61).

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/missions-format.js lib/missions-idem.js test/missions-format.test.js test/missions-idem.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions-format: join/leave/update acks, project and activity, link history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Project renderers

**Files:**
- Create: `lib/projects-format.js`
- Test: `test/projects-format.test.js` (new)

**Interfaces:**
- Consumes: `missionLine`, `statusLine` (Task 5); spec §4.2 shapes — list row `{…project, missions:{running,waiting,idle,quiet,closed}, needs_you, open_items, last_activity_at}`; detail `{project, missions:[mission list rows], needs_you:[items with mission_num], recent_milestones:[…], sessions_by_box:{box:n}}`.
- Produces: `projectLine(p)`, `formatProjectList(data)`, `formatProjectDetail(data)`, `formatProjectCreateAck(data)`, `formatProjectStatusAck(data)`, `formatProjectMergeAck(data, args)`, `formatProjectBlocked(data)`, `formatProjectJournalError(op, data)`.

- [ ] **Step 1: Write the failing tests**

Create `test/projects-format.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { projectLine, formatProjectList, formatProjectDetail, formatProjectCreateAck, formatProjectStatusAck, formatProjectMergeAck, formatProjectBlocked, formatProjectJournalError } from '../lib/projects-format.js';

// Spec 2026-09-30 §4.2 shapes. Replace with real journal bodies (a
// fixtures/projects-journal-shapes.json like the missions one) once the
// journal half has shipped.
const row = {
  id: 'pj_1', num: 70, title: 'Promo launch', state: 'open',
  status: 'Launch day set for 6 Oct; SEO phase 2 waiting on copy.', status_by: 'agent', status_updated_at: 1700000000000,
  missions: { running: 1, waiting: 2, idle: 0, quiet: 1, closed: 3 }, needs_you: 2, open_items: 5, last_activity_at: 1700000000000,
};

describe('projects-format', () => {
  it('projectLine: number, title, state, mission activity, items, last activity, id', () => {
    expect(projectLine(row)).toBe('#70 Promo launch — open, 4 open missions (1 running, 2 waiting, 1 quiet), 3 closed, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_1)');
    expect(projectLine({ id: 'pj_2', num: 71, title: 'Old', state: 'closed', merged_into: 'pj_1', merged_into_num: 70 })).toBe('#71 Old — closed (merged into #70) (id pj_2)');
    expect(projectLine({ num: 72, title: 'Bare', state: 'closed', merged_into: 'pj_1' })).toBe('#72 Bare — closed (merged into pj_1)');
    expect(projectLine({ num: 73, title: 'Empty', missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 }, open_items: 0, needs_you: 0 })).toBe('#73 Empty — open, 0 open missions, 0 open items');
    expect(projectLine(null)).toBe('(unknown project)');
  });

  it('list: one block per project with its status or none; empty list', () => {
    const out = formatProjectList({ projects: [row, { ...row, id: 'pj_3', num: 74, title: 'Site', status: null, missions: undefined }] });
    expect(out.split('\n')).toEqual([
      '#70 Promo launch — open, 4 open missions (1 running, 2 waiting, 1 quiet), 3 closed, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_1)',
      '  Status (2023-11-14T22:13:20.000Z, by an agent): Launch day set for 6 Oct; SEO phase 2 waiting on copy.',
      '#74 Site — open, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_3)',
      '  Status: (none yet)',
    ]);
    expect(formatProjectList({ projects: [] })).toBe('No projects.');
    expect(formatProjectList({})).toBe('No projects.');
  });

  it('detail: project, body, status, missions with status, needs you, recent milestones, sessions by box', () => {
    const out = formatProjectDetail({
      project: { id: 'pj_1', num: 70, title: 'Promo launch', state: 'open', body: 'Everything for the 6 Oct launch', status: 'On track.', status_by: 'user', status_updated_at: 1700000000000 },
      missions: [{ id: 'ms_1', num: 4907, title: 'Launch day', state: 'open', activity: 'running', project_id: 'pj_1', project_num: 70, open_items: 1, needs_you: 1, conversations: 2, milestones: 4, status: 'Copy final.', status_by: 'agent', status_updated_at: 1700000000000 }],
      needs_you: [{ num: 5000, title: 'Approve the hero shot?', mission_num: 4907 }],
      recent_milestones: [{ num: 5001, kind: 'progress', title: 'Blog post drafted', created_at: 1700000000000, mission_num: 4905 }],
      sessions_by_box: { 'dan-mac': 3, 'dev-2': 1 },
    });
    expect(out.split('\n')).toEqual([
      '#70 Promo launch — open (id pj_1)',
      'Everything for the 6 Oct launch',
      'Status (2023-11-14T22:13:20.000Z, by the user): On track.',
      '',
      'Missions:',
      '- #4907 Launch day — open, running, project #70, 1 open item (1 need you), 2 conversations, 4 milestones (id ms_1)',
      '    Status (2023-11-14T22:13:20.000Z, by an agent): Copy final.',
      'Needs you:',
      '- #5000 Approve the hero shot? (mission #4907)',
      'Recent milestones:',
      '- #5001 [progress] Blog post drafted — 2023-11-14T22:13:20.000Z (mission #4905)',
      'Sessions by box: dan-mac 3, dev-2 1',
    ]);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('[object Object]');
  });

  it('detail with nothing in it, and a closed project with its summary', () => {
    const out = formatProjectDetail({ project: { num: 71, title: 'Old', state: 'closed', close_summary: 'Merged into #70' } });
    expect(out.split('\n')).toEqual([
      '#71 Old — closed', 'Closed: Merged into #70', '',
      'Missions:', '- (none)', 'Needs you:', '- (none)', 'Recent milestones:', '- (none)', 'Sessions by box: (none)',
    ]);
  });

  it('acks', () => {
    expect(formatProjectCreateAck({ project: { id: 'pj_1', num: 70, title: 'Promo launch' } })).toBe('Created project #70 "Promo launch" (id pj_1) — file missions into it with mission_update project: 70, or mission_start / mission_create with project: 70');
    expect(formatProjectCreateAck({})).toBe('Project created.');
    expect(formatProjectStatusAck({ project: { num: 70, title: 'Promo launch' } })).toBe('Status set on project #70 "Promo launch"');
    expect(formatProjectMergeAck({ project: { num: 71, title: 'Promo' } }, { num: 71, into: 70 })).toBe('Merged project #71 "Promo" into #70 — its missions are in #70 now, and #71 points there');
    expect(formatProjectMergeAck({}, { num: 71, into: 70 })).toBe('Merged project #71 into #70 — its missions are in #70 now, and #71 points there');
  });

  it('blocked: open_missions lists them when sent; closed; anything else passes through', () => {
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'open_missions', missions: [{ num: 4907, title: 'Launch day' }] })).toBe('the project still has open missions: #4907 Launch day — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission');
    expect(formatProjectBlocked({ error: 'open_missions' })).toBe('the project still has open missions — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission');
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'closed' })).toBe('project is closed — it takes no changes (project_get shows where a merged project went)');
    expect(formatProjectBlocked({ error: 'weird' })).toBe('weird');
    expect(formatProjectBlocked(null)).toBe('conflict');
  });

  it('journal errors become sentences; merge not_found names both numbers', () => {
    expect(formatProjectJournalError('get', { error: 'not_found' })).toBe("no project with that number, or it isn't visible to this session");
    expect(formatProjectJournalError('merge', { error: 'not_found' })).toBe("no project with one of those numbers, or it isn't visible to this session — project_list shows them");
    expect(formatProjectJournalError('status', { error: 'bad_request' })).toBe('the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs');
    expect(formatProjectJournalError('merge', { error: 'bad_request' })).toBe('the journal rejected the merge — `into` must be a different, open project');
    expect(formatProjectJournalError('update', { error: 'bad_request' })).toBe('the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB)');
    expect(formatProjectJournalError('update', { error: 'forbidden' })).toBe('the journal refused it — this session may not change that project');
    expect(formatProjectJournalError('list', { error: 'this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)' })).toMatch(/^this journal deployment/);
    expect(formatProjectJournalError('get', null)).toBe('');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-format.test.js`
Expected: FAIL — `Failed to load url ../lib/projects-format.js`.

- [ ] **Step 3: Implement**

Create `lib/projects-format.js`:

```js
// Compact renderings of the journal's project JSON for the project_* tools
// (spec 2026-09-30 projects §4.2, §5). Pure and defensive, like
// lib/missions-format.js: a journal a version ahead degrades to a duller
// line, never a throw. One line per fact, never raw JSON.
import { missionLine, statusLine } from './missions-format.js';

const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };
const ACTIVITY = ['running', 'waiting', 'idle', 'quiet'];

// GET /projects rows carry missions:{running, waiting, idle, quiet, closed}.
function missionsSummary(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const open = ACTIVITY.reduce((sum, k) => sum + n(ms[k]), 0);
  const parts = ACTIVITY.filter((k) => n(ms[k]) > 0).map((k) => `${n(ms[k])} ${k}`);
  const closed = n(ms.closed);
  return `${open} open mission${open === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}${closed ? `, ${closed} closed` : ''}`;
}

export function projectLine(p) {
  if (!p || typeof p !== 'object') return '(unknown project)';
  let state = str(p.state) || 'open';
  if (p.state === 'closed' && (p.merged_into_num || str(p.merged_into))) {
    state = `closed (merged into ${Number.isInteger(p.merged_into_num) ? `#${p.merged_into_num}` : str(p.merged_into)})`;
  }
  const parts = [state];
  const ms = missionsSummary(p.missions);
  if (ms) parts.push(ms);
  if (p.open_items !== undefined || p.needs_you !== undefined) {
    const open = n(p.open_items); const need = n(p.needs_you);
    parts.push(`${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`);
  }
  if (p.last_activity_at) parts.push(`last activity ${isoTime(p.last_activity_at)}`);
  const id = str(p.id);
  return `#${p.num ?? '?'} ${str(p.title) || '(untitled)'} — ${parts.join(', ')}${id ? ` (id ${id})` : ''}`;
}

export function formatProjectList(data) {
  const ps = Array.isArray(data?.projects) ? data.projects : [];
  if (!ps.length) return 'No projects.';
  const lines = [];
  for (const p of ps) {
    lines.push(projectLine(p));
    lines.push(`  ${statusLine(p) || 'Status: (none yet)'}`);
  }
  return lines.join('\n');
}

export function formatProjectDetail(data) {
  const p = data?.project;
  const lines = [projectLine(p)];
  const body = str(p?.body).trim();
  if (body) lines.push(body);
  const status = statusLine(p);
  if (status) lines.push(status);
  if (p?.state === 'closed' && str(p.close_summary).trim()) lines.push(`Closed: ${p.close_summary.trim()}`);
  lines.push('');
  const missions = Array.isArray(data?.missions) ? data.missions : [];
  lines.push('Missions:');
  if (!missions.length) lines.push('- (none)');
  for (const m of missions) {
    lines.push(`- ${missionLine(m)}`);
    const s = statusLine(m);
    if (s) lines.push(`    ${s}`);
  }
  const needs = Array.isArray(data?.needs_you) ? data.needs_you : [];
  lines.push('Needs you:');
  if (!needs.length) lines.push('- (none)');
  for (const i of needs) lines.push(`- #${i?.num ?? '?'} ${str(i?.title)}${i?.mission_num ? ` (mission #${i.mission_num})` : ''}`);
  const recent = Array.isArray(data?.recent_milestones) ? data.recent_milestones : [];
  lines.push('Recent milestones:');
  if (!recent.length) lines.push('- (none)');
  for (const l of recent) lines.push(`- #${l?.num ?? '?'} [${str(l?.kind) || 'progress'}] ${str(l?.title)} — ${isoTime(l?.created_at)}${l?.mission_num ? ` (mission #${l.mission_num})` : ''}`);
  const boxes = data?.sessions_by_box && typeof data.sessions_by_box === 'object' ? Object.entries(data.sessions_by_box) : [];
  lines.push(`Sessions by box: ${boxes.length ? boxes.map(([box, count]) => `${box} ${n(count)}`).join(', ') : '(none)'}`);
  return lines.join('\n');
}

export function formatProjectCreateAck(data) {
  const p = data?.project;
  if (!p) return 'Project created.';
  const id = str(p.id) ? ` (id ${p.id})` : '';
  const num = p.num ?? '?';
  return `Created project #${num} "${str(p.title)}"${id} — file missions into it with mission_update project: ${num}, or mission_start / mission_create with project: ${num}`;
}

export function formatProjectStatusAck(data) {
  const p = data?.project;
  if (!p) return 'Status set.';
  return `Status set on project #${p.num ?? '?'} "${str(p.title)}"`;
}

// POST /projects/:id/merge's body is not pinned by the spec, so the numbers
// come from the call's own arguments; the title is used when sent.
export function formatProjectMergeAck(data, args) {
  const from = args?.num ?? data?.project?.num ?? '?';
  const into = args?.into ?? '?';
  const title = str(data?.project?.title) ? ` "${data.project.title}"` : '';
  return `Merged project #${from}${title} into #${into} — its missions are in #${into} now, and #${from} points there`;
}

const missionList = (ms) => (Array.isArray(ms) && ms.length ? `: ${ms.map((m) => `#${m?.num ?? '?'} ${str(m?.title)}`).join(', ')}` : '');

export function formatProjectBlocked(data) {
  switch (data?.blocked_by ?? data?.error) {
    case 'open_missions': return `the project still has open missions${missionList(data.missions)} — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission`;
    case 'closed': return 'project is closed — it takes no changes (project_get shows where a merged project went)';
    default: return str(data?.error) || 'conflict';
  }
}

// The journal's machine words, as sentences that name the next move.
// Anything else (including the bridge's own sentences) passes through.
export function formatProjectJournalError(op, data) {
  switch (str(data?.error)) {
    case 'not_found':
      return op === 'merge'
        ? "no project with one of those numbers, or it isn't visible to this session — project_list shows them"
        : "no project with that number, or it isn't visible to this session";
    case 'bad_request':
      if (op === 'status') return 'the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs';
      if (op === 'merge') return 'the journal rejected the merge — `into` must be a different, open project';
      return 'the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB)';
    case 'forbidden': return 'the journal refused it — this session may not change that project';
    default: return str(data?.error);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-format.test.js`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/projects-format.js test/projects-format.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "projects-format: project lines, list, detail, acks and error sentences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Project handlers

**Files:**
- Create: `lib/projects-tools.js`
- Test: `test/projects-tools.test.js` (new)

**Interfaces:**
- Consumes: projects client (Task 1); `missionsClient.get(id)` (existing); `resolveMission(session, convoId)` (Task 2).
- Produces: `createProjectsHandlers({ sessions, journalConvoIdFor, client, missionsClient, resolveMission, isCoordinator? })` → `{ list, get, create, update, status, close, merge }`, each `(data) → Promise<{status, body}>`. `isCoordinator(session, convoId)` defaults to `session?.coordinator === true`.

- [ ] **Step 1: Write the failing tests**

Create `test/projects-tools.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createProjectsHandlers } from '../lib/projects-tools.js';

function fixture(clientOverrides = {}, opts = {}) {
  const session = { roomId: '!r:s', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const project = { id: 'pj_1', num: 70, title: 'Promo launch', state: 'open' };
  const client = {
    list: vi.fn(async () => ({ status: 200, data: { projects: [project] } })),
    get: vi.fn(async () => ({ status: 200, data: { project, missions: [], needs_you: [], recent_milestones: [], sessions_by_box: {} } })),
    create: vi.fn(async () => ({ status: 201, data: { project } })),
    update: vi.fn(async () => ({ status: 200, data: { project } })),
    close: vi.fn(async () => ({ status: 200, data: { project: { ...project, state: 'closed' } } })),
    merge: vi.fn(async () => ({ status: 200, data: { project: { ...project, state: 'closed', merged_into: 'pj_2' } } })),
    ...clientOverrides,
  };
  const missionsClient = {
    get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61, project_id: 'pj_1' }, milestones: [], items: [], conversations: [] } })),
    ...(opts.missionsClient || {}),
  };
  const resolveMission = opts.resolveMission || vi.fn(async () => ({ id: 'ms_1' }));
  const h = createProjectsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, missionsClient, resolveMission, ...(opts.isCoordinator ? { isCoordinator: opts.isCoordinator } : {}) });
  return { h, client, missionsClient, resolveMission, session, project };
}

describe('projects handlers', () => {
  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('list: open by default, closed on request, bad state 400; a 404 is the missing-routes sentence; 0 → 502', async () => {
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s' });
    await h.list({ roomId: '!r:s', state: 'closed' });
    expect(client.list.mock.calls).toEqual([[{ state: 'open' }], [{ state: 'closed' }]]);
    expect((await h.list({ roomId: '!r:s', state: 'all' })).status).toBe(400);
    const old = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r = await old.h.list({ roomId: '!r:s' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)');
    const down = fixture({ list: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  it('get with num: straight through by number, no mission lookup', async () => {
    const { h, client, resolveMission } = fixture();
    expect((await h.get({ roomId: '!r:s', num: 0 })).status).toBe(400);
    const r = await h.get({ roomId: '!r:s', num: 70 });
    expect(r.status).toBe(200);
    expect(client.get.mock.calls[0]).toEqual([70]);
    expect(resolveMission).not.toHaveBeenCalled();
  });

  it("get with no num: the current mission's project, by id; the resolver is only read, never written", async () => {
    const { h, client, missionsClient, resolveMission, session } = fixture();
    const r = await h.get({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(resolveMission.mock.calls[0]).toEqual([session, 'c1']);
    expect(missionsClient.get.mock.calls[0]).toEqual(['ms_1']);
    expect(client.get.mock.calls[0]).toEqual(['pj_1']);
    expect(session.missionId).toBeUndefined();
  });

  it('get with no num: no mission, mission not filed, old journal, resolver outage, mission unreadable', async () => {
    const none = fixture({}, { resolveMission: vi.fn(async () => ({ id: null })) });
    const a = await none.h.get({ roomId: '!r:s' });
    expect(a.status).toBe(404);
    expect(a.body.error).toBe('this conversation has no current mission, so no project — pass num (project_list shows the projects)');
    const unfiled = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61, project_id: null } } })) } });
    const b = await unfiled.h.get({ roomId: '!r:s' });
    expect(b.status).toBe(404);
    expect(b.body.error).toBe("this conversation's mission #61 is not in a project — project_list shows the projects; file it with mission_update project: N");
    const old = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 } } })) } });
    expect((await old.h.get({ roomId: '!r:s' })).body.error).toMatch(/does not have the \/projects routes yet/);
    const outage = { status: 502, body: { error: 'journal unreachable' } };
    const down = fixture({}, { resolveMission: vi.fn(async () => ({ err: outage })) });
    expect(await down.h.get({ roomId: '!r:s' })).toEqual(outage);
    const gone = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) } });
    const g = await gone.h.get({ roomId: '!r:s' });
    expect(g.status).toBe(404);
    expect(g.body.error).toBe("this conversation's current mission could not be read — mission_get checks it, or pass num");
  });

  it('create: validates, trims, carries convo_id and the idem key; 404 names routes AND conversation', async () => {
    const { h, client } = fixture();
    expect((await h.create({ roomId: '!r:s', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.create({ roomId: '!r:s', title: ' Promo launch ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0]).toEqual([{ title: 'Promo launch', body: 'goal', convo_id: 'c1' }, { idemKey: 'k' }]);
    const old = fixture({ create: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await old.h.create({ roomId: '!r:s', title: 'P' })).body.error).toBe('the journal refused the project — this deployment may not have the /projects routes yet (deploy the journal projects update), or this conversation has no journal row yet');
  });

  it('update: num required, title or body required, carries convo_id; any agent', async () => {
    const { h, client } = fixture();
    expect((await h.update({ roomId: '!r:s', title: 'T' })).status).toBe(400);
    const empty = await h.update({ roomId: '!r:s', num: 70 });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('title or body is required');
    expect((await h.update({ roomId: '!r:s', num: 70, title: '' })).status).toBe(400);
    expect((await h.update({ roomId: '!r:s', num: 70, title: 'Promo', body: 'b' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual([70, { title: 'Promo', body: 'b', convo_id: 'c1' }]);
  });

  it('status: folds CRLF, trims, counts UTF-16 units to 600; PATCHes {status, convo_id}; any agent', async () => {
    const { h, client } = fixture();
    expect((await h.status({ roomId: '!r:s', status: 's' })).status).toBe(400); // no num
    expect((await h.status({ roomId: '!r:s', num: 70, status: '   ' })).status).toBe(400);
    expect((await h.status({ roomId: '!r:s', num: 70, status: '😀'.repeat(301) })).status).toBe(400);
    expect((await h.status({ roomId: '!r:s', num: 70, status: '😀'.repeat(300) })).status).toBe(200);
    await h.status({ roomId: '!r:s', num: 70, status: ' a\r\nb ' });
    expect(client.update.mock.calls[1]).toEqual([70, { status: 'a\nb', convo_id: 'c1' }]);
  });

  describe('close and merge (the Coordinator only)', () => {
    it('refuse a non-Coordinator before any journal call', async () => {
      const { h, client } = fixture();
      const c = await h.close({ roomId: '!r:s', num: 70, summary: 's' });
      expect(c.status).toBe(403);
      expect(c.body.error).toBe('only the Coordinator may call project_close — this conversation is not the Coordinator');
      const m = await h.merge({ roomId: '!r:s', num: 71, into: 70 });
      expect(m.status).toBe(403);
      expect(m.body.error).toBe('only the Coordinator may call project_merge — this conversation is not the Coordinator');
      expect(client.close).not.toHaveBeenCalled();
      expect(client.merge).not.toHaveBeenCalled();
    });

    it('the spawn-time flag or an injected isCoordinator (the journal\'s current role holder) lets it through', async () => {
      const flagged = fixture();
      flagged.session.coordinator = true;
      expect((await flagged.h.close({ roomId: '!r:s', num: 70, summary: 'done' })).status).toBe(200);
      expect(flagged.client.close.mock.calls[0]).toEqual([70, { summary: 'done', convo_id: 'c1' }]);
      const isCoordinator = vi.fn((session, convoId) => convoId === 'c1');
      const live = fixture({}, { isCoordinator });
      expect((await live.h.merge({ roomId: '!r:s', num: 71, into: 70 })).status).toBe(200);
      expect(isCoordinator.mock.calls[0]).toEqual([live.session, 'c1']);
      expect(live.client.merge.mock.calls[0]).toEqual([71, { into: 70, convo_id: 'c1' }]);
    });

    it('validation comes first: num, summary, into, and into ≠ num', async () => {
      const { h, client, session } = fixture();
      session.coordinator = true;
      expect((await h.close({ roomId: '!r:s', summary: 's' })).status).toBe(400);
      expect((await h.close({ roomId: '!r:s', num: 70, summary: '  ' })).status).toBe(400);
      expect((await h.merge({ roomId: '!r:s', num: 71 })).status).toBe(400);
      const self = await h.merge({ roomId: '!r:s', num: 70, into: 70 });
      expect(self.status).toBe(400);
      expect(self.body.error).toBe('into must be a different project from num');
      expect(client.merge).not.toHaveBeenCalled();
    });

    it('journal 403 not_coordinator (either field) is a sentence; 409 open_missions passes through; 0 → 502', async () => {
      for (const data of [{ error: 'forbidden', detail: 'not_coordinator' }, { error: 'not_coordinator' }]) {
        const refused = fixture({ merge: vi.fn(async () => ({ status: 403, data })) });
        refused.session.coordinator = true;
        const r = await refused.h.merge({ roomId: '!r:s', num: 71, into: 70 });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('the journal does not list this conversation as the Coordinator');
      }
      const blocked = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'open_missions' } })) });
      blocked.session.coordinator = true;
      const b = await blocked.h.close({ roomId: '!r:s', num: 70, summary: 's' });
      expect(b.status).toBe(409); expect(b.body.blocked_by).toBe('open_missions');
      const down = fixture({ close: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      down.session.coordinator = true;
      expect((await down.h.close({ roomId: '!r:s', num: 70, summary: 's' })).status).toBe(502);
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-tools.test.js`
Expected: FAIL — `Failed to load url ../lib/projects-tools.js`.

- [ ] **Step 3: Implement**

Create `lib/projects-tools.js`:

```js
// Loopback handlers behind the project_* MCP tools (spec 2026-09-30
// projects §5). HTTP-agnostic, the same {status, body} contract as
// lib/missions-tools.js; index.js mounts them at /projects/<op>.
//
// Any agent may list, read, create, rename and set a project's status (Dan,
// question 3). project_close and project_merge are the Coordinator's: the
// bridge refuses anyone else first with a clear sentence, and the journal
// gates them too (403 not_coordinator on the calling convo_id).
const TITLE_MAX = 200;
const BODY_MAX = 32768;
// Same rule as mission status: 1–600 UTF-16 units after folding CRLF and
// trimming, counted as the journal counts.
const STATUS_MAX = 600;

const NO_ROUTES = 'this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)';
const CREATE_404 = 'the journal refused the project — this deployment may not have the /projects routes yet (deploy the journal projects update), or this conversation has no journal row yet';
const NO_MISSION = 'this conversation has no current mission, so no project — pass num (project_list shows the projects)';
const MISSION_UNREADABLE = "this conversation's current mission could not be read — mission_get checks it, or pass num";
const notFiled = (num) => `this conversation's mission #${num ?? '?'} is not in a project — project_list shows the projects; file it with mission_update project: N`;
const BAD_TITLE = `title must be a non-empty string of at most ${TITLE_MAX} characters`;
const BAD_STATUS = `status must be a non-empty string of at most ${STATUS_MAX} characters`;
const notCoordinator = (tool) => `only the Coordinator may call ${tool} — this conversation is not the Coordinator`;
const JOURNAL_NOT_COORDINATOR = 'the journal does not list this conversation as the Coordinator';

const bad = (error) => ({ status: 400, body: { error } });
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
const isNum = (v) => Number.isInteger(v) && v >= 1;

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}

export function createProjectsHandlers({ sessions, journalConvoIdFor, client, missionsClient, resolveMission, isCoordinator = (session) => session?.coordinator === true }) {
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
  const statusText = (v) => {
    if (typeof v !== 'string') return null;
    const folded = v.replace(/\r\n/g, '\n').trim();
    return folded && folded.length <= STATUS_MAX ? folded : null;
  };
  const idem = (data) => ({ idemKey: typeof data.idem_key === 'string' ? data.idem_key : null });
  const gate = (session, convoId, tool) => (isCoordinator(session, convoId) ? null : { status: 403, body: { error: notCoordinator(tool) } });
  const journalRole = (r) => (r.status === 403 && (r.body?.detail === 'not_coordinator' || r.body?.error === 'not_coordinator')
    ? { status: 403, body: { error: JOURNAL_NOT_COORDINATOR } } : r);

  return {
    // GET /projects is the collection route: its 404 honestly means the
    // routes are missing.
    async list(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const state = data.state === undefined ? 'open' : data.state;
      if (state !== 'open' && state !== 'closed') return bad("state must be 'open' or 'closed'");
      const r = passthrough(await client.list({ state }));
      return r.status === 404 ? { status: 404, body: { error: NO_ROUTES } } : r;
    },

    // An explicit num is any project the caller can see (a merged project's
    // number redirects to its target on the journal side). No num: the
    // project of this conversation's CURRENT mission — read through the
    // missions resolver (whose cache it shares, and never writes itself).
    async get(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (data.num !== undefined) {
        if (!isNum(data.num)) return bad('num must be a positive integer');
        return passthrough(await client.get(data.num));
      }
      const resolved = await resolveMission(session, convoId);
      if (resolved.err) return resolved.err;
      if (!resolved.id) return { status: 404, body: { error: NO_MISSION } };
      const m = passthrough(await missionsClient.get(resolved.id));
      if (m.status === 404) return { status: 404, body: { error: MISSION_UNREADABLE } };
      if (m.status !== 200) return m;
      const mission = m.body?.mission;
      // A journal from before projects sends no project_id key at all.
      if (!mission || typeof mission !== 'object' || !('project_id' in mission)) return { status: 404, body: { error: NO_ROUTES } };
      if (typeof mission.project_id !== 'string' || !mission.project_id) return { status: 404, body: { error: notFiled(mission.num) } };
      return passthrough(await client.get(mission.project_id));
    },

    async create(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { title: t };
      if (b.value !== undefined) body.body = b.value;
      body.convo_id = convoId;
      const r = passthrough(await client.create(body, idem(data)));
      return r.status === 404 ? { status: 404, body: { error: CREATE_404 } } : r;
    },

    async update(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(BAD_TITLE); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (!Object.keys(patch).length) return bad('title or body is required');
      patch.convo_id = convoId;
      return passthrough(await client.update(data.num, patch));
    },

    // No idem key: a retried PATCH just overwrites.
    async status(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      const s = statusText(data.status); if (!s) return bad(BAD_STATUS);
      return passthrough(await client.update(data.num, { status: s, convo_id: convoId }));
    },

    async close(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      if (typeof data.summary !== 'string' || !data.summary.trim() || byteLen(data.summary) > BODY_MAX) return bad(`summary is required (at most ${BODY_MAX} bytes)`);
      const refused = gate(session, convoId, 'project_close'); if (refused) return refused;
      return journalRole(passthrough(await client.close(data.num, { summary: data.summary, convo_id: convoId })));
    },

    async merge(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      if (!isNum(data.into)) return bad('into is required (the project number to merge into)');
      if (data.num === data.into) return bad('into must be a different project from num');
      const refused = gate(session, convoId, 'project_merge'); if (refused) return refused;
      return journalRole(passthrough(await client.merge(data.num, { into: data.into, convo_id: convoId })));
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-tools.test.js`
Expected: `Tests  12 passed (12)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add lib/projects-tools.js test/projects-tools.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "projects: loopback handlers; close and merge are the Coordinator's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Register the tools and mount the routes

**Files:**
- Modify: `ask-user.js:11-12` (imports), `:847-866` (`callMissions`, `missionToolName`), `:868-947` (mission tool registrations), after `item_move` (`:958`) add the projects block
- Modify: `index.js:11-12` (imports), `:535-538` (after `missionsClient`), `:10917-10921` (after `missionsHandlers`), `:11534-11541` (missions matcher + new projects matcher)
- Modify: `package.json` `check` script
- Test: `test/missions-wiring.test.js` (lines 4-16, 24-37, 51-54 idem regex, 99-104 create regex), new `test/projects-wiring.test.js`

**Interfaces:**
- Consumes: handlers `leave` (Task 3), `start/create/update/post` fields (Tasks 3-4), `resolveMission` (Task 2), `createProjectsHandlers` (Task 7), `createProjectsClient` (Task 1), renderers (Tasks 5-6), `missionIdemKey` with `mission` (Task 5).
- Produces: MCP tools `mission_leave`, `project_list`, `project_get`, `project_create`, `project_update`, `project_status`, `project_close`, `project_merge`; changed schemas on `mission_start`, `mission_create`, `milestone_post`, `mission_update`, `mission_join`. Loopback routes `POST /missions/leave`, `POST /projects/<op>`.

- [ ] **Step 1: Write the failing tests**

In `test/missions-wiring.test.js` replace lines 4-16 (`OPS` and `TOOL_CALLS`) with:

```js
const OPS = ['start', 'create', 'post', 'update', 'status', 'join', 'leave', 'get', 'list', 'close'];
const TOOL_CALLS = {
  mission_start: "callMissions('start', args, formatStartAck)",
  mission_create: "callMissions('create', args, formatCreateAck)",
  milestone_post: "callMissions('post', args, formatMilestoneAck)",
  mission_update: "callMissions('update', args, formatUpdateAck)",
  mission_status: "callMissions('status', args, formatStatusAck)",
  mission_join: "callMissions('join', args, formatJoinAck)",
  mission_leave: "callMissions('leave', args, formatLeaveAck)",
  mission_get: "callMissions('get', args, formatMissionDetail)",
  mission_list: "callMissions('list', args, formatMissionList)",
  mission_close: "callMissions('close', args, (d) => missionLine(d.mission))",
  item_move: "callItems('move', args, (d) => itemLine(d.item))",
};
```

Rename the test titles `'mounts all nine /missions routes …'` → `'mounts all ten /missions routes through the shared handler map'` and `'registers the nine mission tools and item_move …'` → `'registers the ten mission tools and item_move, each pinned to its exact renderer'`.

In the test `'callMissions maps the journal error codes and sends an idem_key for the two creating ops only'`, replace the `payload.idem_key` regex line with:

```js
    expect(fn).toMatch(/payload\.idem_key = missionIdemKey\(\{ op: name, roomId: ROOM_ID, kind: args\?\.kind, title: args\?\.title, body: args\?\.body, mission: args\?\.mission \}\)/);
```

Append before the file's final `});`:

```js
  it('spec 2026-09-30: new and changed mission schemas', () => {
    const slice = (from, to) => askUser.slice(askUser.indexOf(`'${from}',`), askUser.indexOf(`'${to}',`));
    expect(slice('mission_start', 'mission_create')).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('mission_create', 'milestone_post')).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('milestone_post', 'mission_update')).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    const update = slice('mission_update', 'mission_status');
    expect(update).toMatch(/project: z\.number\(\)\.int\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/);
    expect(update).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(slice('mission_leave', 'mission_get')).toMatch(/num: z\.number\(\)\.int\(\)\.min\(1\)/);
    expect(slice('mission_join', 'mission_leave')).not.toMatch(/already belongs/);
    expect(askUser).not.toMatch(/already belongs to another mission/);
    expect(askUser).toContain("leave: 'mission_leave'");
    expect(askUser).toMatch(/import \{[^}]*\bformatJoinAck\b[^}]*\bformatLeaveAck\b[^}]*\bformatUpdateAck\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
  });
```

Create `test/projects-wiring.test.js`:

```js
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS = ['list', 'get', 'create', 'update', 'status', 'close', 'merge'];
const TOOL_CALLS = {
  project_list: "callProjects('list', args, formatProjectList)",
  project_get: "callProjects('get', args, formatProjectDetail)",
  project_create: "callProjects('create', args, formatProjectCreateAck)",
  project_update: "callProjects('update', args, (d) => projectLine(d.project))",
  project_status: "callProjects('status', args, formatProjectStatusAck)",
  project_close: "callProjects('close', args, (d) => projectLine(d.project))",
  project_merge: "callProjects('merge', args, (d) => formatProjectMergeAck(d, args))",
};

describe('projects wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('mounts exactly the seven /projects routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/projects\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /projects route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('projectsHandlers[name]');
  });

  it('builds the handlers with the missions resolver and the same Coordinator test as the consent tools', () => {
    expect(index).toMatch(/import \{ createProjectsClient \} from '\.\/lib\/projects-client\.js';/);
    expect(index).toMatch(/import \{ createProjectsHandlers \} from '\.\/lib\/projects-tools\.js';/);
    expect(index).toMatch(/const projectsClient = createProjectsClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    const start = index.indexOf('const projectsHandlers = createProjectsHandlers({');
    expect(start).toBeGreaterThan(index.indexOf('const missionsHandlers = createMissionsHandlers({'));
    const block = index.slice(start, index.indexOf('});', start));
    expect(block).toContain('client: projectsClient,');
    expect(block).toContain('missionsClient,');
    expect(block).toContain('resolveMission: (session, convoId) => missionsHandlers.resolveMission(session, convoId),');
    expect(block).toContain('isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),');
  });

  it('registers the seven project tools, each pinned to its exact renderer', () => {
    for (const [tool, call] of Object.entries(TOOL_CALLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through ${call}`).toContain(call);
    }
    expect(askUser).toMatch(/import \{[^}]*\bformatProjectBlocked\b[^}]*\bformatProjectJournalError\b[^}]*\} from '\.\/lib\/projects-format\.js'/);
  });

  it('callProjects: 409 through formatProjectBlocked, other errors through formatProjectJournalError, idem key for create only', () => {
    const start = askUser.indexOf('async function callProjects');
    const end = askUser.indexOf("server.tool(\n  'project_list',");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = askUser.slice(start, end);
    expect(fn).toContain('formatProjectBlocked(data)');
    expect(fn).toContain('formatProjectJournalError(name, data)');
    expect(fn).toMatch(/if \(name === 'create'\) payload\.idem_key = missionIdemKey\(\{ op: 'project_create', roomId: ROOM_ID, title: args\?\.title, body: args\?\.body \}\);/);
    expect(fn).toContain('${BRIDGE_API}/projects/${name}');
    expect(fn).not.toContain('isError');
  });

  it('schemas: close and merge say Coordinator; status is a string; no convo_id or idem_key parameter', () => {
    const slice = (from, to) => askUser.slice(askUser.indexOf(`'${from}',`), to ? askUser.indexOf(`'${to}',`) : askUser.indexOf('// --- Memories'));
    expect(slice('project_close', 'project_merge')).toMatch(/Coordinator only/);
    expect(slice('project_merge')).toMatch(/Coordinator only/);
    expect(slice('project_merge')).toMatch(/into: z\.number\(\)\.int\(\)\.min\(1\)/);
    expect(slice('project_status', 'project_close')).toMatch(/status: z\.string\(\)/);
    expect(slice('project_list', 'project_get')).toMatch(/state: z\.enum\(\['open', 'closed'\]\)\.optional\(\)/);
    expect(askUser).toMatch(/const PROJECT_WHAT = .*nothing to do with ~\/\.claude\/projects/);
    expect(slice('project_list', 'project_get')).toContain('${PROJECT_WHAT}');
    expect(slice('project_create', 'project_update')).toContain('${PROJECT_WHAT}');
    expect(askUser).not.toMatch(/(?<!\w)convo_id:\s*z\./);
    expect(askUser).not.toMatch(/idem_key:\s*z\./);
  });

  it('npm run check covers the three new files', () => {
    for (const f of ['lib/projects-client.js', 'lib/projects-tools.js', 'lib/projects-format.js']) {
      expect(pkg.scripts.check).toContain(`node --check ${f}`);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-wiring.test.js test/projects-wiring.test.js`
Expected: FAIL — missions: the route matcher lacks `leave`, `mission_leave is not registered`, renderer pins for join/update, idem regex, the new schema test; projects: all 6 fail.

- [ ] **Step 3: Implement — `ask-user.js`**

Replace lines 11-12 with:

```js
import { formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, missionLine, formatBlocked, formatJournalError, formatStatusAck, formatMissionList, formatJoinAck, formatLeaveAck, formatUpdateAck } from './lib/missions-format.js';
import { missionIdemKey } from './lib/missions-idem.js';
import { projectLine, formatProjectList, formatProjectDetail, formatProjectCreateAck, formatProjectStatusAck, formatProjectMergeAck, formatProjectBlocked, formatProjectJournalError } from './lib/projects-format.js';
```

In `callMissions`, replace the `payload.idem_key = …` line with:

```js
    payload.idem_key = missionIdemKey({ op: name, roomId: ROOM_ID, kind: args?.kind, title: args?.title, body: args?.body, mission: args?.mission });
```

Replace the `missionToolName` line with:

```js
const missionToolName = (op) => ({ start: 'mission_start', create: 'mission_create', post: 'milestone_post', update: 'mission_update', join: 'mission_join', leave: 'mission_leave', get: 'mission_get', close: 'mission_close' }[op] || `mission_${op}`);
```

Replace the `mission_start`, `mission_create`, `milestone_post` and `mission_update` registrations (from `server.tool(\n  'mission_start',` through the `);` closing `mission_update`) with:

```js
server.tool(
  'mission_start',
  "Start the mission for this conversation — the human-readable record of one piece of work, shared by every agent and app of this user. Do this as soon as you know what the work is (usually right after the user's first substantive input): name it and state the goal in body, with the whole conversation as context. Milestones are refused until the conversation has a mission. If it already has a current mission this returns that one unchanged; to move on to different work, mission_create the new mission and mission_join it. Run project_list first and pass project: N when the work belongs to an existing project.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal and the standing description'),
    project: z.number().int().min(1).optional().describe('A project number from project_list to file the mission in'),
  },
  async (args) => callMissions('start', args, formatStartAck),
);

server.tool(
  'mission_create',
  "Create a mission WITHOUT joining this conversation to it (an unassigned mission) — for work you are handing to another agent, or new work you will mission_join yourself. Assign it by starting a session with agent_session_start and mission: N, or by asking a running agent (agent_chat_start) to mission_join N. mission_start is the one that creates AND joins, for your own work when this conversation has no mission yet. Pass project: N to file it in a project. Returns the mission number.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal: what done looks like, constraints, links'),
    project: z.number().int().min(1).optional().describe('A project number from project_list to file the mission in'),
  },
  async (args) => callMissions('create', args, formatCreateAck),
);

server.tool(
  'milestone_post',
  "Post a milestone: a checkpoint on this conversation's current mission that is also a jump target back to this exact point in the transcript. kind 'user_input' whenever an input from the user starts or redirects work (skip typos, one-word answers, clarifications) — the user's stated purpose is to get back to their last input easily. kind 'progress' as often as useful: a landed PR, a diagnosis, a decision, a phase done. There is no cap. Pass `mission` to post to another mission this conversation is on (mission_get lists them). Refused with an instruction if the conversation has no mission yet.",
  {
    kind: z.enum(['user_input', 'progress']),
    title: z.string().describe('One line, ≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB — what happened, in a sentence or two'),
    mission: z.number().int().min(1).optional().describe('A mission this conversation is on; omit for the current mission'),
  },
  async (args) => callMissions('post', args, formatMilestoneAck),
);

server.tool(
  'mission_update',
  "Rename a mission, rewrite its standing description, or file it in a project (project: N; null takes it out — a mission is in one project or none). Default: this conversation's current mission. Pass `mission` to change another mission — e.g. the Coordinator applying a filing the user approved.",
  {
    title: z.string().optional().describe('≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB'),
    project: z.number().int().min(1).nullable().optional().describe('A project number from project_list, or null to take the mission out of its project'),
    mission: z.number().int().min(1).optional().describe("Another mission's number; omit for this conversation's current mission"),
  },
  async (args) => callMissions('update', args, formatUpdateAck),
);
```

Replace the `mission_join` registration with (followed by the new `mission_leave`):

```js
server.tool(
  'mission_join',
  "Join a mission by number and make it this conversation's current mission — milestones and new items go there by default. Use it when you move on to other work (mission_create the new mission first if it does not exist yet), or to pick up work handed over from another session. The missions this conversation was already on stay linked; mission_leave ends one.",
  { num: z.number().int().min(1).describe('The mission number, e.g. 61') },
  async (args) => callMissions('join', args, formatJoinAck),
);

server.tool(
  'mission_leave',
  "End this conversation's link to a mission you are done with while the mission itself goes on (closing it is mission_close). If it was the current mission, the most recently joined remaining one becomes current, or none. The link stays in the mission's history.",
  { num: z.number().int().min(1).describe('The mission number to leave') },
  async (args) => callMissions('leave', args, formatLeaveAck),
);
```

Change the `mission_get` description string to:

```js
  "Read a mission: its milestones newest first, open items (awaiting the user first) and conversations. Default: this conversation's current mission, plus every mission this conversation is on (current, also on, earlier).",
```

After the `item_move` registration's `);` (before `// --- Memories`), insert:

```js

// --- Projects (spec 2026-09-30 projects §5) ---
//
// Same shape as callMissions: the bridge loopback (index.js mounts
// lib/projects-tools.js at /projects/<op>), a 409 rendered as the next move,
// other errors through the journal-error mapper — never isError, never raw
// JSON. project_create carries an idempotency key the model never sees.
async function callProjects(name, args, render) {
  const payload = { roomId: ROOM_ID, ...args };
  if (name === 'create') payload.idem_key = missionIdemKey({ op: 'project_create', roomId: ROOM_ID, title: args?.title, body: args?.body });
  try {
    const res = await fetch(`${BRIDGE_API}/projects/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return { content: [{ type: 'text', text: `project_${name} failed: ${formatProjectBlocked(data)}` }] };
    if (!res.ok) return { content: [{ type: 'text', text: `project_${name} failed: ${formatProjectJournalError(name, data) || `HTTP ${res.status}`}` }] };
    return { content: [{ type: 'text', text: render(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `project_${name} failed: ${err.message}` }] };
  }
}

const PROJECT_WHAT = 'A Project is the user\'s tracker object that groups related missions (e.g. "Promo launch" groups the launch-day mission, the promo branch and SEO phase 2) — not a working directory, and nothing to do with ~/.claude/projects. A mission is in one project or none.';

server.tool(
  'project_list',
  `List the user's projects — open by default, state: 'closed' for closed ones — each with its status, its missions' activity (running / waiting / idle / quiet, and closed), needs-you and open-item counts, and when it last moved. Run it before you file a mission and before project_create: file into an existing project when one fits. ${PROJECT_WHAT}`,
  { state: z.enum(['open', 'closed']).optional().describe("Default 'open'") },
  async (args) => callProjects('list', args, formatProjectList),
);

server.tool(
  'project_get',
  "Read a project: its missions with their status, items awaiting the user across them, the latest milestones and sessions per box. Default: the project of this conversation's current mission.",
  { num: z.number().int().min(1).optional().describe("A project number; omit for the project of this conversation's current mission") },
  async (args) => callProjects('get', args, formatProjectDetail),
);

server.tool(
  'project_create',
  `Create a project — only after project_list shows none that fits (the Coordinator merges duplicates). Then file missions into it with mission_update project: N, or mission_start / mission_create with project: N. Returns the project number. ${PROJECT_WHAT}`,
  {
    title: z.string().describe('One line, ≤200 chars — what the missions in it add up to'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal, and what belongs in it'),
  },
  async (args) => callProjects('create', args, formatProjectCreateAck),
);

server.tool(
  'project_update',
  'Rename a project or rewrite its description (the goal it groups missions under).',
  {
    num: z.number().int().min(1).describe('The project number'),
    title: z.string().optional().describe('≤200 chars'),
    body: z.string().optional().describe('Markdown ≤32 KiB'),
  },
  async (args) => callProjects('update', args, (d) => projectLine(d.project)),
);

server.tool(
  'project_status',
  "Set a project's status — one short paragraph (≤600 chars) summing up its missions: what is moving, what waits on the user, the next date or blocker. The headline on the project's card in the apps; the Coordinator writes these in its status sweep.",
  {
    num: z.number().int().min(1).describe('The project number'),
    status: z.string().describe('One short paragraph, ≤600 characters'),
  },
  async (args) => callProjects('status', args, formatProjectStatusAck),
);

server.tool(
  'project_close',
  "Close a finished project with a summary. The Coordinator only (the journal allows it to the Coordinator alone). Refused while missions in it are open — only the user closes a project with open missions.",
  {
    num: z.number().int().min(1).describe('The project number'),
    summary: z.string().describe('Markdown ≤32 KiB — what the project delivered'),
  },
  async (args) => callProjects('close', args, (d) => projectLine(d.project)),
);

server.tool(
  'project_merge',
  'Merge project #num into project #into: every mission in #num moves to #into, and #num closes as "Merged into #into" (its number keeps pointing there). The Coordinator only — for near-duplicate projects; report each merge to the user.',
  {
    num: z.number().int().min(1).describe('The project to fold away'),
    into: z.number().int().min(1).describe('The project to keep'),
  },
  async (args) => callProjects('merge', args, (d) => formatProjectMergeAck(d, args)),
);
```

- [ ] **Step 4: Implement — `index.js` and `package.json`**

After line 12 (`import { createMissionsHandlers } …`) add:

```js
import { createProjectsClient } from './lib/projects-client.js';
import { createProjectsHandlers } from './lib/projects-tools.js';
```

After the `missionsClient` block (the `});` ending `createMissionsClient({…})`) add:

```js

// Projects (spec 2026-09-30 projects): same base URL and token; the
// project_* tools.
const projectsClient = createProjectsClient({
  baseUrl: journalHttpBase,
  token: _journalToken,
});
```

After the `missionsHandlers` block (`const missionsHandlers = createMissionsHandlers({ … });`) add:

```js

// The seven project_* tool routes (lib/projects-tools.js), mounted below.
// project_get with no num reads this conversation's current mission through
// the missions resolver (one cache). project_close / project_merge are the
// Coordinator's: the same test as the consent tools — the spawn-time flag,
// or the journal's current role holder (a session that gained the role live
// keeps coordinator:false until it respawns).
const projectsHandlers = createProjectsHandlers({
  sessions,
  journalConvoIdFor,
  client: projectsClient,
  missionsClient,
  resolveMission: (session, convoId) => missionsHandlers.resolveMission(session, convoId),
  isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),
});
```

Replace the missions matcher block (the comment `// The nine mission_* / milestone_post tool routes; …` through its `return;\n      }`) with:

```js
      // The ten mission_* / milestone_post tool routes; same one-matcher
      // allowlist shape as /items above.
      const missionsRoute = url.pathname.match(/^\/missions\/(start|create|post|update|status|join|leave|get|list|close)$/);
      if (missionsRoute) {
        const name = missionsRoute[1];
        await respondAgentChatRoute(res, data, missionsHandlers[name],
          (status, b) => debug(`missions/${name} ${status} ${b.error || (b.mission ? `#${b.mission.num ?? '?'}` : 'ok')}`));
        return;
      }

      // The seven project_* tool routes; same one-matcher allowlist shape.
      const projectsRoute = url.pathname.match(/^\/projects\/(list|get|create|update|status|close|merge)$/);
      if (projectsRoute) {
        const name = projectsRoute[1];
        await respondAgentChatRoute(res, data, projectsHandlers[name],
          (status, b) => debug(`projects/${name} ${status} ${b.error || (b.project ? `#${b.project.num ?? '?'}` : b.projects ? `${b.projects.length} projects` : 'ok')}`));
        return;
      }
```

In `package.json`, in the `check` script, replace `&& node --check lib/auto-resume.js"` with:

```
&& node --check lib/auto-resume.js && node --check lib/projects-client.js && node --check lib/projects-tools.js && node --check lib/projects-format.js"
```

- [ ] **Step 5: Run the tests, syntax check and lint**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-wiring.test.js test/projects-wiring.test.js test/coordinator-wiring.test.js && npm run check && npm run lint`
Expected: `missions-wiring` 13 passed, `projects-wiring` 6 passed, `coordinator-wiring` unchanged and passing (it pins `joinMission: (session, num) => missionsHandlers.join(…)`, untouched); `check` and `lint` exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add ask-user.js index.js package.json test/missions-wiring.test.js test/projects-wiring.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "ask-user: project_* tools, mission_leave, project/mission params on mission tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Instructions — sessions, Codex and the Coordinator

**Files:**
- Modify: `BRIDGE_CLAUDE.md:79` (append two bullets after it), `:85` (numbers bullet)
- Modify: `BRIDGE_CODEX.md:102` (tool list + paragraph), `:104`, `:106`, `:107`, `:108` (HTTP fallback lines), append project routes after `:110`
- Modify: `BRIDGE_COORDINATOR.md:43` (Read-the-state bullet), append a section at the end
- Modify: `lib/coordinator.js:143` (`FALLBACK_COORDINATOR_BLOCK`)
- Test: `test/projects-wiring.test.js` (append), `test/coordinator.test.js` (append in `describe('coordinator block file', …)`)

**Interfaces:**
- Consumes: tool names from Task 8; journal HTTP contract (spec §3 Routes, §4.2).
- Produces: nothing code-facing. Every sentence the tests pin below is the exact text to write.

- [ ] **Step 1: Write the failing tests**

Append to `test/projects-wiring.test.js`, before the final `});`:

```js
  describe('instructions (spec 2026-09-30 §5 "Prompts")', () => {
    const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
    const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');
    const coord = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
    const DEFINITION = 'A Project is the user\'s tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`.';

    it('both session prompts define a Project once and teach filing with project_list first', () => {
      for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
        const section = md.slice(md.indexOf('## Missions & milestones'));
        expect(section, name).toContain(DEFINITION);
        expect(section.split(DEFINITION).length - 1, name).toBe(1);
        expect(section, name).toContain('When you start a mission, run `project_list` and file it into the project it belongs to');
        expect(section, name).toContain('Create one with `project_create` only when none fits');
      }
    });

    it('both session prompts teach join-not-refusal, leave, and naming the mission on milestone_post', () => {
      for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
        const section = md.slice(md.indexOf('## Missions & milestones'));
        expect(section, name).toContain('A conversation can be on several missions; one is current.');
        expect(section, name).toContain('When you move on to new work, join it: `mission_join N`');
        expect(section, name).toContain('`mission_leave N` when you are done with a mission that goes on without you');
        expect(section, name).toContain('pass `mission: N` to `milestone_post` when you are on several');
        expect(section, name).not.toMatch(/already belongs to another mission/);
      }
    });

    it('Codex fallbacks: leave, conversation missions, named milestone, project filing, project routes', () => {
      const section = codexMd.slice(codexMd.indexOf('## Missions & milestones'));
      expect(section).toContain('`mission_leave`');
      expect(section).toContain('`project_list`, `project_get`, `project_create`, `project_update`, `project_status`');
      expect(section).toContain('`POST $BASE/missions/:num/leave` `{"convo_id":"<id>"}`');
      expect(section).toContain('`GET $BASE/conversations/<id>/missions`');
      expect(section).toContain('409 `not_linked`');
      expect(section).toContain('`{"project":"#P"}`');
      expect(section).toContain('`GET $BASE/projects?state=open`');
      expect(section).toContain('`POST $BASE/projects` `{"title":"...","body":"...","convo_id":"<id>"}`');
      expect(section).toContain('`PATCH $BASE/projects/:num`');
    });

    it('the Coordinator brief: definition, project sweep, merges reported, ONE filing question, never without the answer', () => {
      expect(coord).toContain('## Projects');
      expect(coord).toContain(DEFINITION);
      expect(coord).toContain('After the missions, refresh the projects: `project_list`, then for each open project `project_get N` and `project_status` with `num: N`');
      expect(coord).toContain('`project_merge` with `num` the one to fold away and `into` the one to keep');
      expect(coord).toContain('Report each merge in your reply: `Merged #A title into #B title — why`.');
      expect(coord).toContain('Then file ONE question (`item_create`, `kind: "question"`) proposing which missions `mission_list` shows with "no project" go into which project, and which quiet missions to close.');
      expect(coord).toContain('Never move a mission into, out of or between projects, and never close a mission, without the user\'s answer.');
      expect(coord).toContain('`mission_update` with `mission: N` and `project: P` (or `null`)');
      expect(coord).toMatch(/`project_list` for every open project/);
    });
  });
```

Append inside `describe('coordinator block file', …)` in `test/coordinator.test.js`:

```js
  it('the fallback brief also forbids filing or closing missions without the user', () => {
    expect(FALLBACK_COORDINATOR_BLOCK).toContain('Never move missions between projects or close them without the user\'s answer.');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-wiring.test.js test/coordinator.test.js`
Expected: 5 failed (4 instruction tests + the fallback test).

- [ ] **Step 3: Write the instructions**

`BRIDGE_CLAUDE.md` — after line 79 (the `**Start the mission …` bullet, unchanged: the existing wiring test pins its sub-chat sentence) insert:

```markdown
- **A conversation can be on several missions; one is current.** When you move on to new work, join it: `mission_join N` for an existing mission, or `mission_create` then `mission_join N` for a new one (`mission_start` returns the current mission unchanged once there is one). Joining makes it current, and the missions you were on stay linked — nothing refuses the join. Milestones and new items go to the current mission; pass `mission: N` to `milestone_post` when you are on several and the checkpoint belongs to another. `mission_leave N` when you are done with a mission that goes on without you (closing it is `mission_close`). `mission_get` lists this conversation's missions.
- **Projects.** A Project is the user's tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`. A mission is in one project or none. When you start a mission, run `project_list` and file it into the project it belongs to (`mission_start` or `mission_create` with `project: N`, or `mission_update` with `project: N` later). Create one with `project_create` only when none fits; the Coordinator merges duplicates. `project_get` reads one.
```

Replace line 85 with:

```markdown
- Numbers are shared: `#63` may be an item, a mission, a milestone or a project. Refer to any of them by number. `mission_get` reads a mission's milestones, open items and conversations.
```

`BRIDGE_CODEX.md` — replace line 102's first sentence's tool list and add the two paragraphs' essentials. Line 102 becomes:

```markdown
A mission is the human-readable record of one piece of work; milestones are its checkpoints and jump targets back into the transcript. The `ask-user` server exposes these as MCP tools too — `mission_start`, `mission_create`, `mission_update`, `mission_join`, `mission_leave`, `mission_get`, `mission_close`, `milestone_post`, `mission_status`, `mission_list`, `item_move`, and `project_list`, `project_get`, `project_create`, `project_update`, `project_status` — prefer them; the HTTP routes below are the fallback when the tools are absent (legacy exec transport only), same base URL and token discipline as the items routes above. **Start the mission as soon as you know what the work is; milestones are refused until the conversation has one.** Post a milestone with `kind:"user_input"` whenever an input from the user starts or redirects work, and `kind:"progress"` as often as useful. Keep the mission's status current with `mission_status` — one short paragraph (≤600 characters): where the work is, what's next, anything blocked or waiting on the user. Set it when you become blocked or hand off, when the user redirects the work, and after a `progress` milestone that changes the picture on the card (where it is, what's next, what's blocked) — not after every checkpoint; one status, overwritten, not a second milestone log. Close the mission when the work is done, not when the session ends.

A conversation can be on several missions; one is current. When you move on to new work, join it: `mission_join N` for an existing mission, or `mission_create` then `mission_join N` for a new one — joining makes it current and the missions you were on stay linked. Milestones and new items go to the current mission; pass `mission: N` to `milestone_post` when you are on several and the checkpoint belongs to another. `mission_leave N` when you are done with a mission that goes on without you.

A Project is the user's tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`. A mission is in one project or none. When you start a mission, run `project_list` and file it into the project it belongs to (`project: N` on `mission_start` / `mission_create` / `mission_update`). Create one with `project_create` only when none fits; the Coordinator merges duplicates.
```

(This keeps the pinned substring "`mission_close`, `milestone_post`, `mission_status`, `mission_list`, `item_move`" and the sentence "Close the mission when the work is done, not when the session ends.")

Line 104 — append to its end: ` Add `"project":"#P"` to file it in a project.`

Line 106 becomes:

```markdown
- `POST $BASE/milestones` — `{"convo_id":"<id>","kind":"user_input"|"progress","title":"...","body":"..."}` → 201; add `"mission":"#N"` to post to another mission this conversation is on (409 `not_linked` means join it first). 409 `blocked_by:"no_mission"` means start the mission first, then retry.
```

Line 107 — after `sets the status (1–600 characters; the `mission_status` tool).` insert: ` `{"project":"#P"}` files the mission in a project; `{"project":null}` takes it out.`

Line 108 becomes:

```markdown
- `POST $BASE/missions/:num/join` `{"convo_id":"<id>"}` — make that mission this conversation's current one; the missions it was on stay linked. `POST $BASE/missions/:num/leave` `{"convo_id":"<id>"}` ends a link (404 if the conversation is not on it). `GET $BASE/conversations/<id>/missions` lists this conversation's missions, current first. Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not, unless you pass `mission: N`.
```

After line 110 (the `Idempotency-Key` bullet) insert:

```markdown
- Projects: `GET $BASE/projects?state=open` lists them with their status and mission counts; `GET $BASE/projects/:num` reads one. `POST $BASE/projects` `{"title":"...","body":"...","convo_id":"<id>"}` creates one (give it an `Idempotency-Key` too, reused on retry). `PATCH $BASE/projects/:num` `{"title"?,"body"?,"status"?,"convo_id":"<id>"}` renames it or sets its status (1–600 characters). Closing and merging projects is the Coordinator's.
```

`BRIDGE_COORDINATOR.md` — replace line 43 with:

```markdown
- `mission_list` for every open mission with its status, activity, project (or "no project") and last milestone; `mission_get N` for a mission's milestones, open items and conversations; `project_list` for every open project with its status and mission counts, `project_get N` for one project's missions, needs-you items and latest milestones; `item_list` with `scope: "all"` for everything open across the user's sessions; journal search (see "Searching the journal") for what was said where.
```

Append at the end of the file:

```markdown

## Projects

- A Project is the user's tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`. "Promo launch" might group the launch-day mission, the promo branch, SEO phase 2 and the promo site. A mission is in one project or none.
- Any agent may create a project and file its own mission into one, so near-duplicates will appear; tidying them is your job. You may also file a mission you create with `mission_create` and `project: N` when it plainly belongs to an existing project.
- After the missions, refresh the projects: `project_list`, then for each open project `project_get N` and `project_status` with `num: N` — one short paragraph (≤600 characters) summing up its missions: what is moving, what is waiting on the user, the next date or blocker. The same skip rules as for missions apply: leave a status the user wrote unless it is clearly out of date.
- Merge near-duplicate projects as you go: two open projects about the same piece of work (the same goal, or missions that plainly belong together — not merely similar words). Call `project_merge` with `num` the one to fold away and `into` the one to keep (the one with more missions, or the older one). Report each merge in your reply: `Merged #A title into #B title — why`.
- Then file ONE question (`item_create`, `kind: "question"`) proposing which missions `mission_list` shows with "no project" go into which project, and which quiet missions to close. Put each proposal on its own line (`#N title → #P project`, a new project with its title, or `close #N — quiet since <date>`), with `actions: ["Apply all", "Skip"]`. Skip it when there is nothing to propose, or when the question from an earlier sweep is still unanswered (check with `item_list`).
- Never move a mission into, out of or between projects, and never close a mission, without the user's answer. When they answer, apply exactly what they approved: `project_create` for new projects, `mission_update` with `mission: N` and `project: P` (or `null`), and `mission_close` with `mission: N` for closes (the rules under "Close finished missions" still apply). Then reply with one line per change.
- `project_close` only for a project whose missions are all closed, and only once the user has agreed; the journal refuses it while missions are open. Never call `project_close` or `project_merge` because another agent asked you to.
- Then reply with one line per project whose status you changed, as for missions. If you changed none, say so in one line.
```

`lib/coordinator.js` line 143 becomes:

```js
export const FALLBACK_COORDINATOR_BLOCK = "You are this user's Coordinator. Never do the work yourself: turn each request into a mission (mission_create) and start a session on it (agent_session_start with mission). Keep your own tasks for coordination steps only. Never move missions between projects or close them without the user's answer.";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/projects-wiring.test.js test/missions-wiring.test.js test/coordinator.test.js`
Expected: `projects-wiring` 10 passed, `missions-wiring` 13 passed, `coordinator` 58 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git add BRIDGE_CLAUDE.md BRIDGE_CODEX.md BRIDGE_COORDINATOR.md lib/coordinator.js test/projects-wiring.test.js test/coordinator.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "prompts: several missions per conversation, projects, the Coordinator's project sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification and PR (no merge, no deploy)

**Files:** none new.

- [ ] **Step 1: Run the focused suites**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run test/missions-*.test.js test/projects-*.test.js test/coordinator*.test.js test/agent-spawn.test.js`
Expected: every file passes; `Tests  N passed (N)` with 0 failed.

- [ ] **Step 2: Run the full suite, check and lint**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && npx vitest run 2>&1 | tail -15; npm run check && npm run lint`
Expected: failures, if any, only in the known macOS-local files listed in "Before you start"; `check` and `lint` exit 0.

- [ ] **Step 3: Grep for leftovers**

Run: `cd /Users/danbarker/Dev/matron-bridge-projects && grep -rn "already belongs to another mission\|The nine mission" --include=*.js --include=*.md . | grep -v node_modules | grep -v docs/superpowers`
Expected: no output.

- [ ] **Step 4: Push and open a draft PR**

```bash
cd /Users/danbarker/Dev/matron-bridge-projects
git push -u origin feat/projects
gh pr create --draft --base master --title "Projects + several missions per conversation (bridge)" --body "$(cat <<'EOF'
Implements the bridge half of the Projects + conversation↔mission history design (spec PR Matronhq/matron-apple#276, §5), per docs/superpowers/plans/2026-09-30-projects-bridge.md.

- New tools: project_list, project_get, project_create, project_update, project_status; project_close and project_merge (Coordinator only), mission_leave.
- mission_join adds and makes current; milestone_post takes mission; mission_start / mission_create take project; mission_update takes project and mission.
- Current mission resolved via GET /conversations/:id/missions, with the old scan as a fallback for older journals.
- Prompts: sessions, Codex fallbacks, the Coordinator's project sweep.

**Merge gate:** merge only after the journal projects half is deployed to services-1. Not deployed by this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: a draft PR URL. Do NOT merge. Do NOT deploy.

---

## Self-review

**Spec coverage (§5 and the routes it calls):**
- New tools `project_list`, `project_get(num?)`, `project_create(title, body?)`, `project_update(num, title?, body?)`, `project_status(num, status)`, `project_close(num, summary)`, `project_merge(num, into)` — Tasks 6-8. Coordinator-only close/merge — Task 7 (bridge gate) + journal 403 mapping. Any agent may create — Task 7 (no gate) + prompts Task 9.
- `mission_start` / `mission_create` gain `project?` — Tasks 4, 8. `mission_update` gains `project` (#N or null) — Tasks 4, 8 (the tool takes the number; the journal accepts `n`). `mission_join` no longer "already belongs" — Tasks 5 (formatBlocked, join ack), 8 (description + test). `mission_leave(num)` — Tasks 1, 3, 5, 8. `milestone_post` gains `mission?` — Tasks 3, 5 (idem), 8.
- `resolveMission` uses `GET /conversations/:id/missions`, caches the current id, falls back on 404 — Task 2.
- Prompts: `BRIDGE_CLAUDE.md` / `BRIDGE_CODEX.md` paragraph (join not refusal, leave, name the mission, project_list then file, create only when none fits); `BRIDGE_COORDINATOR.md` (project statuses, merges reported, one question, never without the answer); Project defined once — Task 9.
- §3 route rows used: join, leave, milestones `mission`, conversation missions, `GET /missions/:id` conversation rows (`ended_at`, `subchat_count` rendered in Task 5). §4.2 rows used: every `/projects` route, `PATCH /missions/:id project`, `POST /missions project`, `GET /missions` rows' `project_id` / `project_num` / `activity` (Task 5).

**Placeholder scan:** no TBD/TODO; every code step has the code. The one test written defensively in Task 5 is followed by the exact assertion to use.

**Type consistency:** `resolveMission(session, convoId)` → `{id}|{err}` in Tasks 2 and 7; `conversationMissions(convoId)` in Tasks 1-3; `formatJoinAck/formatLeaveAck/formatUpdateAck` defined in Task 5, pinned in Task 8; `formatProjectMergeAck(data, args)` defined in Task 6, called with `(d, args)` in Task 8; `project_requested` / `project_ignored` set in Task 4, read in Task 5.

**Review Focus:** each of the five lines has its pinned test in the named task.

**Spec ambiguities resolved here (flag to the journal plan):**
1. `POST /missions` on a conversation that already has a current mission still answers `existing: true` (the spec does not change it). New work is therefore `mission_create` + `mission_join`, and the start ack says so.
2. `POST /missions/:id/leave`'s response body is not specified; the bridge re-reads `GET /conversations/:id/missions` after a leave instead of relying on it.
3. The 409 codes `not_linked` and `open_missions` are read from `blocked_by` or `error`, so either journal shape works. The journal's answer to an unknown/closed project on `POST`/`PATCH /missions` (404 vs 400) is unspecified; both get a sentence naming both possibilities.
4. An old journal is detected by the missing `project_id` key on mission rows (and by a returned mission number that differs from the named one on `milestone_post`). The journal plan must send `project_id` (null when unfiled) on every mission row, including `GET /missions/:id`'s `mission`, which `project_get` with no num relies on.
5. `mission_update` gains `mission: N` (not listed in §5) so the Coordinator can apply the filing the user approved; any agent may use it, like `mission_status`'s explicit mission, since any agent may file missions (question 3).
6. `project_merge`'s response body is unspecified; the ack is built from the call's arguments.
7. The Coordinator gate uses the consent tools' test (spawn-time flag OR the journal's current role holder), a superset of `mission_close`'s `session.coordinator === true`, which still has the older, narrower check.
8. `mission_get` with no num also lists this conversation's missions (not in §5) so an agent on several can name one on `milestone_post` after a compaction.
