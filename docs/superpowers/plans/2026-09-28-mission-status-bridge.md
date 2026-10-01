# Mission status (bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent a `mission_status` tool that writes the status paragraph on a mission's card, give the Coordinator a `mission_list` tool to find every open mission, and teach sessions and the Coordinator when to use them.

**Architecture:** Same path as the existing mission tools. `ask-user.js` registers the MCP tools and POSTs to the bridge loopback (`/missions/status`, `/missions/list`); `index.js` routes those names to `lib/missions-tools.js` handlers; the handlers validate, fill in `convo_id` and call the journal via `lib/missions-client.js` (`PATCH /missions/:id`, `GET /missions?state=`); `lib/missions-format.js` renders replies and errors as sentences. Instructions live in `BRIDGE_CLAUDE.md` (the "Matron Bridge Instructions" every Claude session gets), `BRIDGE_CODEX.md` and `BRIDGE_COORDINATOR.md`.

**Tech Stack:** Node ≥22 ESM, `@modelcontextprotocol/sdk` + zod (tool schemas), vitest 5, eslint 10.

**Spec:** matron-apple `docs/superpowers/specs/2026-09-28-missions-dashboard-design.md`, §2 "Bridge: `mission_status` tool" (and §1 for the journal contract it calls). Read §1 and §2 before starting.

## Global Constraints

- Tool signature: `mission_status({ status: string, mission?: number })` → `PATCH /missions/:id {status, convo_id}`, `convo_id` = the calling conversation, always.
- Tool description is the spec's text VERBATIM: "Set the mission's status — one short paragraph (≤600 chars) saying where the work is, what's next, and anything blocked or waiting on the user. It is the headline on the mission's card in the apps, so write it for the user at a glance, not as a log. Replace it whenever that picture changes: after a progress milestone, when you get blocked, when you hand off. Pass `mission` only to set another mission's status (the Coordinator does this)."
- Status limit: 1–600 characters after trimming, counted in UTF-16 code units (JS `String.length`), as the journal counts.
- Errors read `mission_status failed: …` (the existing `callMissions` shape). No mission and no `mission` argument → an instruction to start or join a mission first.
- The exact app refresh message the Coordinator must recognise: "Refresh the status of every open mission from its latest milestones, sessions and open items."
- Instruction rule, verbatim in spirit: after a `progress` milestone, on becoming blocked, or on handing off, call `mission_status`; "one status, overwritten, not a second milestone log".
- **Merge gate:** the bridge PR merges only AFTER the journal half (matron-journal `status` on `PATCH /missions/:id`) is deployed to services-1. An old journal answers every status write with 400.
- **The implementer does not deploy.** No `deploy.sh`, no fleet deploys, no restarts.
- Work only in `/Users/danbarker/Dev/matron-bridge-mission-status`. NEVER touch `/Users/danbarker/Dev/matron-bridge` (the live deploy tree).
- Commits: `git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit …`, message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git config user.*`.
- Status has no bridge-side control-character check: the journal rejects control characters (400), and the bridge turns that 400 into a sentence. Do not duplicate journal validation beyond trim + length.

## Review Focus

1. **The Coordinator calling `mission_status` without `mission`.** It has no mission of its own: the cold resolve scans every mission and ends in 404. The reply must tell it to pass `mission: N`, not only "call mission_start" (which the Coordinator must never do). Pinned in Task 1 (`no mission and no mission argument`).
2. **A bridge that is live before the journal half.** A status-only PATCH to an old journal is 400 `bad_request`; the generic sentence ("title ≤ 200 characters…") would mislead. Status gets its own sentence naming the journal update. Pinned in Task 2 (`status bad_request`).
3. **An explicit `mission` the caller can't write** (private-owned → 404, a colleague's shared mission → 403 `forbidden`). Both must read as sentences, and neither may clear this conversation's cached mission. Pinned in Task 1 (`explicit mission 404`) and Task 2 (`forbidden`).
4. **Non-ASCII status at the limit.** Emoji are two UTF-16 units; the bridge must count as the journal does so it never lets through a status the journal rejects, or rejects one it would accept. Pinned in Task 1 (`validates status`).
5. **A closed mission.** Today's 409 `closed` sentence says "no more milestones or joins", which is wrong for a status write. Pinned in Task 2 (`closed`).

## Before you start

Run once in the worktree (there is no `node_modules` yet):

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status && npm ci --no-audit --no-fund
```

Baseline (verified 2026-09-28 on this Mac): `npx vitest run test/missions-tools.test.js` → `Tests  25 passed (25)`; `test/missions-format.test.js` → `12 passed`; `test/missions-wiring.test.js` → `8 passed`. The FULL suite has pre-existing macOS-local failures in exactly these files: `codex-completion`, `codex-liveness`, `codex-producer`, `file-link-guard`, `interactive-session`, `permission-gate`, `pre-trust` (Linux `/proc` and node-pty assumptions; 12–16 tests, count varies run to run). CI (Linux) is the full-suite gate; locally, a failure outside those files is yours.

## File map

| File | Change |
|---|---|
| `lib/missions-tools.js` | `status` and `list` handlers; `viaResolvedMission` takes an optional no-mission sentence |
| `lib/missions-format.js` | `formatStatusAck`, `formatMissionList`, status line in `formatMissionDetail`, status/forbidden error sentences, closed sentence |
| `ask-user.js` | register `mission_status`, `mission_list`; import the two renderers |
| `index.js` | add `status` and `list` to the `/missions/(…)` loopback matcher |
| `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`, `BRIDGE_COORDINATOR.md` | instructions |
| `test/missions-tools.test.js`, `test/missions-format.test.js`, `test/missions-wiring.test.js` | tests |

`lib/missions-client.js` needs NO change: `update(id, body)` already PATCHes `/missions/:id` and `list(query)` already takes a query. The journal's `getMission` accepts `ms_…` ids, bare numbers and `#N` (`String(idOrNum).replace(/^#/, '')`), so an explicit mission number is sent as the integer (`/missions/7`), exactly as `mission_join` and `mission_get` already do.

---

### Task 1: `status` and `list` handlers

**Files:**
- Modify: `lib/missions-tools.js:4-16` (constants), `:58-59` (validators), `:102-114` (`viaResolvedMission`), `:173-181` (after `update`, add `status` and `list`)
- Test: `test/missions-tools.test.js` (append inside the top-level `describe`, before the closing `});` at line 331)

**Interfaces:**
- Consumes: `client.update(id, body)` → `{status, data}`; `client.list(query)` → `{status, data}` (both existing, `lib/missions-client.js`).
- Produces: handler `status({ roomId, status, mission? })` → `{status, body}`; body on success is the journal's `{ mission }`. Handler `list({ roomId, state? })` → `{status, body}`; body on success is `{ missions: [...] }`. The route names are `status` and `list` (Task 3 wires them).

- [ ] **Step 1: Write the failing tests**

Append to `test/missions-tools.test.js`, inside `describe('missions handlers', …)`, just before its final `});`:

```js
  it('status: own mission — trims, carries convo_id, PATCHes the cached mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: '  PR #12 open, waiting on review.  ' });
    expect(r.status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { status: 'PR #12 open, waiting on review.', convo_id: 'c1' }]);
  });

  it('status: cold resolve finds the conversation mission, PATCHes it and caches it', async () => {
    const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [mission] } })) });
    const r = await h.status({ roomId: '!r:s', status: 'Diagnosed; fixing next.' });
    expect(r.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { status: 'Diagnosed; fixing next.', convo_id: 'c1' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it('status: explicit mission goes by number, never resolves or touches the cache, still carries convo_id', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: 'Blocked on #64', mission: 7 });
    expect(r.status).toBe(200);
    expect(client.list).not.toHaveBeenCalled();
    expect(client.update.mock.calls[0]).toEqual([7, { status: 'Blocked on #64', convo_id: 'c1' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it("status: explicit mission 404 passes through and leaves this conversation's cache alone", async () => {
    const { h, session } = fixture({ update: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: 'x', mission: 99 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
    expect(session.missionId).toBe('ms_1');
  });

  it('status: no mission and no mission argument → 404 naming mission_start AND the mission argument', async () => {
    const { h, client } = fixture();
    const r = await h.status({ roomId: '!r:s', status: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("this conversation has no mission yet — call mission_start(title, body) first, or pass mission: N to set another mission's status");
    expect(client.update).not.toHaveBeenCalled();
  });

  it('status: validates status (non-empty after trim, ≤600 UTF-16 units, as the journal counts) and mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    for (const bad of [undefined, '', '   \n ', 42, 'x'.repeat(601)]) {
      const r = await h.status({ roomId: '!r:s', status: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('status must be a non-empty string of at most 600 characters');
    }
    // 600 after trimming passes even with surrounding whitespace.
    expect((await h.status({ roomId: '!r:s', status: ` ${'x'.repeat(600)} ` })).status).toBe(200);
    // Each emoji is 2 UTF-16 units: 300 = 600 passes, 301 = 602 is refused.
    expect((await h.status({ roomId: '!r:s', status: '😀'.repeat(300) })).status).toBe(200);
    expect((await h.status({ roomId: '!r:s', status: '😀'.repeat(301) })).status).toBe(400);
    for (const m of [0, -1, 1.5, '7', null]) {
      const r = await h.status({ roomId: '!r:s', status: 'ok', mission: m });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('mission must be a positive integer');
    }
    expect(client.update).toHaveBeenCalledTimes(2);
  });

  it('status: 409 closed passes through with blocked_by; unreachable → 502; session guards apply', async () => {
    const closed = fixture({ update: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })) });
    closed.session.missionId = 'ms_1';
    const r = await closed.h.status({ roomId: '!r:s', status: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.blocked_by).toBe('closed');
    expect(closed.session.missionId).toBe('ms_1');
    const down = fixture({ update: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.status({ roomId: '!r:s', status: 'x', mission: 3 })).status).toBe(502);
    expect((await down.h.status({ status: 'x' })).status).toBe(400);
    expect((await down.h.status({ roomId: '!other:s', status: 'x' })).status).toBe(404);
  });

  it('list: open by default, closed on request, bad state 400, a 404 is the missing-routes sentence', async () => {
    const { h, client } = fixture();
    expect((await h.list({ roomId: '!r:s' })).status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([{ state: 'open' }]);
    expect((await h.list({ roomId: '!r:s', state: 'closed' })).status).toBe(200);
    expect(client.list.mock.calls[1]).toEqual([{ state: 'closed' }]);
    const bad = await h.list({ roomId: '!r:s', state: 'all' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("state must be 'open' or 'closed'");
    expect((await h.list({})).status).toBe(400);
    const old = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await old.h.list({ roomId: '!r:s' })).body.error).toMatch(/does not have the \/missions routes/);
    const down = fixture({ list: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-tools.test.js`
Expected: 8 failed, 25 passed; failures read `TypeError: h.status is not a function` / `h.list is not a function`.

- [ ] **Step 3: Implement**

In `lib/missions-tools.js`, after line 6 (`const BODY_MAX = 32768;`) add:

```js
// Mission status (spec 2026-09-28 missions dashboard §1): 1–600 characters
// after trimming, counted in UTF-16 units — JS String.length, as the journal
// counts — so the bridge never passes one the journal refuses, or the reverse.
const STATUS_MAX = 600;
```

After line 9 (`const NO_MISSION = …`) add:

```js
// mission_status's own no-mission sentence: the Coordinator never has a
// mission and must never mission_start one, so it has to hear about `mission`.
const NO_MISSION_STATUS = "this conversation has no mission yet — call mission_start(title, body) first, or pass mission: N to set another mission's status";
```

After line 16 (`const BAD_TITLE = …`) add:

```js
const BAD_STATUS = `status must be a non-empty string of at most ${STATUS_MAX} characters`;
```

After the `optBody` validator (line 59) add:

```js
  const statusText = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= STATUS_MAX ? v.trim() : null);
```

Change `viaResolvedMission` (lines 107–114) so the no-mission sentence can be the caller's:

```js
  async function viaResolvedMission(session, convoId, fn, noMission = NO_MISSION) {
    const { id, err } = await resolveMission(session, convoId);
    if (err) return err;
    if (!id) return { status: 404, body: { error: noMission } };
    const r = await fn(id);
    if (r.status === 404) delete session.missionId;
    return r;
  }
```

(Keep the comment block above it; add one line to it: `// noMission: the 404 sentence when the conversation has none.`)

After the `update` handler (closing `},` at line 181) add:

```js

    // mission_status (spec 2026-09-28 missions dashboard §2): the status
    // paragraph on a mission's card. No `mission` → this conversation's own
    // mission, resolved and cached like update. An explicit `mission` is any
    // mission the caller can see (the Coordinator refreshes missions it is
    // not on): addressed by number, never cached, and its 404 must not clear
    // this conversation's cache. convo_id rides along either way — the
    // journal records it as status_convo_id when the conversation is the
    // caller's own. No idem key: a retried PATCH just overwrites.
    async status(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const s = statusText(data.status); if (!s) return bad(BAD_STATUS);
      const patch = { status: s, convo_id: convoId };
      if (data.mission !== undefined) {
        if (!Number.isInteger(data.mission) || data.mission < 1) return bad('mission must be a positive integer');
        return passthrough(await client.update(data.mission, patch));
      }
      return viaResolvedMission(session, convoId, async (id) => passthrough(await client.update(id, patch)), NO_MISSION_STATUS);
    },

    // mission_list: the user's missions, open by default — how the
    // Coordinator finds every mission to refresh (spec §2, "Coordinator
    // instructions"). GET /missions is the collection route, so its 404
    // honestly means the routes are missing.
    async list(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const state = data.state === undefined ? 'open' : data.state;
      if (state !== 'open' && state !== 'closed') return bad("state must be 'open' or 'closed'");
      return passthroughCollection(await client.list({ state }));
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-tools.test.js`
Expected: `Tests  33 passed (33)`

- [ ] **Step 5: Lint**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx eslint lib/missions-tools.js test/missions-tools.test.js --max-warnings=0`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status
git add lib/missions-tools.js test/missions-tools.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: status and list handlers for mission_status / mission_list

mission_status PATCHes {status, convo_id} to this conversation's mission,
or to mission #N when given (never cached). mission_list reads GET
/missions?state=open|closed so the Coordinator can find every mission.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Renderers and error sentences

**Files:**
- Modify: `lib/missions-format.js:6` (add `statusLine` after `isoTime`), `:32-35` (add `formatStatusAck` after `formatMilestoneAck`), `:37-40` (`formatMissionDetail` status line), `:65` (closed sentence), `:78-84` (`formatJournalError`), end of file (`formatMissionList`)
- Test: `test/missions-format.test.js:3` (import), append before the final `});` at line 112

**Interfaces:**
- Consumes: journal mission JSON — `status`, `status_by` (`'user'|'agent'`), `status_updated_at` (ms), `last_milestone` `{num, kind, title, created_at}` (spec §1; `last_milestone` already on list rows).
- Produces: `formatStatusAck(data) → string`, `formatMissionList(data) → string` (Task 3 imports both into `ask-user.js`); `formatJournalError('status', data)` status-specific sentence (Task 3's `callMissions` passes the op name `'status'`).

- [ ] **Step 1: Write the failing tests**

Change line 3 of `test/missions-format.test.js` to:

```js
import { missionLine, formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, formatBlocked, formatJournalError, formatStatusAck, formatMissionList } from '../lib/missions-format.js';
```

Append before the file's final `});`:

```js
  it('status ack names the mission', () => {
    expect(formatStatusAck({ mission })).toBe('Status set on mission #61 "Missions"');
    expect(formatStatusAck({})).toBe('Status set.');
  });

  it('detail shows the status with when and by whom, only when one is set', () => {
    const withStatus = { ...mission, status: 'PR #12 open; waiting on review.', status_by: 'agent', status_updated_at: 1700000000000 };
    expect(formatMissionDetail({ mission: withStatus, milestones: [], items: [], conversations: [] }).split('\n')).toEqual([
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      'Ship it',
      'Status (2023-11-14T22:13:20.000Z, by an agent): PR #12 open; waiting on review.',
      '',
      'Milestones (newest first):', '- (none yet)',
      'Open items:', '- (none)',
      'Conversations:', '- (none)',
    ]);
    expect(formatMissionDetail({ mission: { ...withStatus, status_by: 'user' } })).toContain('Status (2023-11-14T22:13:20.000Z, by the user): PR #12');
    expect(formatMissionDetail({ mission: { ...mission, status: null, status_by: null, status_updated_at: null } })).not.toContain('Status');
    expect(formatMissionDetail({ mission: { ...mission, status: '   ' } })).not.toContain('Status');
  });

  it('mission list: one block per mission — line, status or none, last milestone or none', () => {
    const [open, closed] = shapes.list_200.missions;
    const out = formatMissionList({ missions: [
      { ...open, status: 'Journal half deployed; bridge next.', status_by: 'agent', status_updated_at: 1789057300000 },
      closed,
      { ...mission, last_milestone: null },
    ] });
    expect(out.split('\n')).toEqual([
      '#1 Missions & milestones — open, 2 open items (1 need you), 2 conversations, 2 milestones (id ms_7Kq2XwvN)',
      '  Status (2026-09-10T16:21:40.000Z, by an agent): Journal half deployed; bridge next.',
      '  Last milestone: #5 [progress] Journal half deployed — 2026-09-10T16:20:00.000Z',
      '#6 Items tracker — closed by agent, 0 open items, 1 conversation, 4 milestones (id ms_0Fh4Ly)',
      '  Status: (none yet)',
      '  Last milestone: #12 [progress] All PRs merged — 2026-09-09T18:00:00.000Z',
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      '  Status: (none yet)',
      '  Last milestone: (none yet)',
    ]);
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('undefined');
    expect(formatMissionList({ missions: [] })).toBe('No missions.');
    expect(formatMissionList({})).toBe('No missions.');
  });

  it('status errors: bad_request names the limits AND an old journal; forbidden and closed are sentences', () => {
    expect(formatJournalError('status', shapes.error_400_bad_request)).toBe('the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs (a journal older than mission status rejects every status: deploy the journal update)');
    // Every other op keeps the existing sentence.
    expect(formatJournalError('update', shapes.error_400_bad_request)).toMatch(/^the journal rejected it — check the number and the limits/);
    expect(formatJournalError('status', { error: 'forbidden' })).toBe("that mission is shared with you by another user — only its owner's sessions can change it");
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toBe('mission is closed — no more milestones, joins or status changes');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-format.test.js`
Expected: FAIL — `SyntaxError: The requested module '../lib/missions-format.js' does not provide an export named 'formatMissionList'` (the whole file fails to import).

- [ ] **Step 3: Implement**

In `lib/missions-format.js`, after line 6 (`const isoTime = …`) add:

```js
// The status paragraph (spec 2026-09-28 missions dashboard): when and by
// whom, so the Coordinator can tell a status newer than the last milestone.
function statusLine(m) {
  const s = str(m?.status).trim();
  if (!s) return null;
  const by = m.status_by === 'user' ? ', by the user' : (m.status_by === 'agent' ? ', by an agent' : '');
  return `Status (${isoTime(m.status_updated_at)}${by}): ${s}`;
}
```

After `formatMilestoneAck` add:

```js
export function formatStatusAck(data) {
  const m = data?.mission;
  if (!m) return 'Status set.';
  return `Status set on mission #${m.num ?? '?'} "${str(m.title)}"`;
}
```

In `formatMissionDetail`, directly after `if (body) lines.push(body);` add:

```js
  const status = statusLine(data?.mission);
  if (status) lines.push(status);
```

In `formatBlocked`, change the `closed` case to:

```js
    case 'closed': return 'mission is closed — no more milestones, joins or status changes';
```

Replace `formatJournalError`'s switch with (update its comment's "Map the two it can actually hit" to "Map the ones it can actually hit"):

```js
  switch (str(data?.error)) {
    case 'not_found': return "no mission with that number, or it isn't visible to this session";
    case 'bad_request':
      // A status-only PATCH to a journal from before mission status is a
      // 400 too (it sees no fields it knows) — say so, or the model retries
      // a status that was never the problem.
      if (op === 'status') return 'the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs (a journal older than mission status rejects every status: deploy the journal update)';
      return 'the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB; a mission already holding 200 conversations refuses joins)';
    // A colleague's shared mission is readable but not writable (journal
    // missions-http: getSharedMission → 403).
    case 'forbidden': return "that mission is shared with you by another user — only its owner's sessions can change it";
    default: return str(data?.error);
  }
```

At the end of the file add:

```js
// mission_list: GET /missions rows in the journal's order, each with its
// status and last milestone — what the Coordinator needs to decide which
// missions to refresh.
export function formatMissionList(data) {
  const ms = Array.isArray(data?.missions) ? data.missions : [];
  if (!ms.length) return 'No missions.';
  const lines = [];
  for (const m of ms) {
    lines.push(missionLine(m));
    lines.push(`  ${statusLine(m) || 'Status: (none yet)'}`);
    const l = m?.last_milestone;
    lines.push(l && typeof l === 'object'
      ? `  Last milestone: #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)}`
      : '  Last milestone: (none yet)');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-format.test.js`
Expected: `Tests  16 passed (16)`

- [ ] **Step 5: Lint**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx eslint lib/missions-format.js test/missions-format.test.js --max-warnings=0`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status
git add lib/missions-format.js test/missions-format.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "missions: render mission status, the mission list and status errors

mission_get shows the status with when and by whom; mission_list renders
each mission with its status and last milestone. A status 400 names the
limits and an old journal; forbidden and closed read as sentences.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Register the tools and mount the routes

**Files:**
- Modify: `ask-user.js:11` (import), `:815-816` (after the `mission_update` registration, add two tools)
- Modify: `index.js:11005-11007` (the `/missions/(…)` matcher and its comment)
- Test: `test/missions-wiring.test.js:4-14` (OPS, TOOL_CALLS), `:24`, `:31` (test names), append a test

**Interfaces:**
- Consumes: handlers `status`, `list` (Task 1); `formatStatusAck`, `formatMissionList` (Task 2); `callMissions(name, args, render)` (existing, `ask-user.js:755`) — it already POSTs `{roomId, ...args}` to `${BRIDGE_API}/missions/${name}` and prefixes errors with `missionToolName(name)`, whose fallback `mission_${op}` yields `mission_status` / `mission_list`.
- Produces: MCP tools `mission_status`, `mission_list` on the `ask-user` server; loopback routes `POST /missions/status`, `POST /missions/list`.

- [ ] **Step 1: Write the failing tests**

In `test/missions-wiring.test.js` replace lines 4–14 with:

```js
const OPS = ['start', 'create', 'post', 'update', 'status', 'join', 'get', 'list', 'close'];
const TOOL_CALLS = {
  mission_start: "callMissions('start', args, formatStartAck)",
  mission_create: "callMissions('create', args, formatCreateAck)",
  milestone_post: "callMissions('post', args, formatMilestoneAck)",
  mission_update: "callMissions('update', args, (d) => missionLine(d.mission))",
  mission_status: "callMissions('status', args, formatStatusAck)",
  mission_join: "callMissions('join', args, (d) => missionLine(d.mission))",
  mission_get: "callMissions('get', args, formatMissionDetail)",
  mission_list: "callMissions('list', args, formatMissionList)",
  mission_close: "callMissions('close', args, (d) => missionLine(d.mission))",
  item_move: "callItems('move', args, (d) => itemLine(d.item))",
};
// Spec 2026-09-28 missions dashboard §2 — the agent reads exactly this.
const MISSION_STATUS_DESCRIPTION = "Set the mission's status — one short paragraph (≤600 chars) saying where the work is, what's next, and anything blocked or waiting on the user. It is the headline on the mission's card in the apps, so write it for the user at a glance, not as a log. Replace it whenever that picture changes: after a progress milestone, when you get blocked, when you hand off. Pass `mission` only to set another mission's status (the Coordinator does this).";
```

Rename the test at (old) line 24 to `'mounts all nine /missions routes through the shared handler map'` and the one at (old) line 31 to `'registers the nine mission tools and item_move, each pinned to its exact renderer'` (bodies unchanged).

Append before the file's final `});`:

```js
  it('mission_status carries the spec description verbatim and its schema; mission_list takes only state', () => {
    const tool = askUser.slice(askUser.indexOf("'mission_status',"), askUser.indexOf("'mission_list',"));
    expect(tool).toContain(JSON.stringify(MISSION_STATUS_DESCRIPTION));
    expect(tool).toMatch(/status: z\.string\(\)/);
    expect(tool).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    const list = askUser.slice(askUser.indexOf("'mission_list',"), askUser.indexOf("'mission_join',"));
    expect(list).toMatch(/state: z\.enum\(\['open', 'closed'\]\)\.optional\(\)/);
    expect(askUser).toMatch(/import \{[^}]*\bformatStatusAck\b[^}]*\bformatMissionList\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
  });
```

(`JSON.stringify` of the description yields the double-quoted JS literal the registration uses; the description contains no `"` or `\`, so the two forms are identical.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-wiring.test.js`
Expected: 3 failed, 6 passed — the route matcher lacks `status`/`list`, `mission_status is not registered`, and the new description test.

- [ ] **Step 3: Implement**

`ask-user.js` line 11 becomes:

```js
import { formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, missionLine, formatBlocked, formatJournalError, formatStatusAck, formatMissionList } from './lib/missions-format.js';
```

After the `mission_update` registration (the `);` at line 815) insert:

```js

server.tool(
  'mission_status',
  "Set the mission's status — one short paragraph (≤600 chars) saying where the work is, what's next, and anything blocked or waiting on the user. It is the headline on the mission's card in the apps, so write it for the user at a glance, not as a log. Replace it whenever that picture changes: after a progress milestone, when you get blocked, when you hand off. Pass `mission` only to set another mission's status (the Coordinator does this).",
  {
    status: z.string().describe('One short paragraph, ≤600 characters'),
    mission: z.number().int().min(1).optional().describe("Another mission's number (the Coordinator); omit for this conversation's mission"),
  },
  async (args) => callMissions('status', args, formatStatusAck),
);

server.tool(
  'mission_list',
  "List the user's missions — open by default, state: 'closed' for closed ones — each with its counts, its status (when and by whom) and its last milestone. The Coordinator uses it to find every mission whose status to refresh.",
  { state: z.enum(['open', 'closed']).optional().describe("Default 'open'") },
  async (args) => callMissions('list', args, formatMissionList),
);
```

`index.js` lines 11005–11007 become:

```js
      // The nine mission_* / milestone_post tool routes; same one-matcher
      // allowlist shape as /items above.
      const missionsRoute = url.pathname.match(/^\/missions\/(start|create|post|update|status|join|get|list|close)$/);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-wiring.test.js test/missions-tools.test.js test/missions-format.test.js`
Expected: `Test Files  3 passed (3)`, `Tests  58 passed (58)` (9 + 33 + 16).

- [ ] **Step 5: Syntax check and lint**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npm run check && npm run lint`
Expected: both exit 0; `check` prints nothing after its header, `lint` prints only its header.

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status
git add ask-user.js index.js test/missions-wiring.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "ask-user: mission_status and mission_list tools

Registered on the ask-user MCP server (Claude and Codex sessions alike)
and routed through the /missions loopback matcher.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Instructions — sessions and the Coordinator

**Files:**
- Modify: `BRIDGE_CLAUDE.md:82` (insert a bullet after the `kind: "progress"` bullet)
- Modify: `BRIDGE_CODEX.md:90` (tool list + one sentence), `:95` (HTTP fallback line)
- Modify: `BRIDGE_COORDINATOR.md:43` (Read-the-state bullet), append a section at the end
- Test: `test/missions-wiring.test.js` (append two tests)

**Interfaces:**
- Consumes: tool names `mission_status`, `mission_list` (Task 3); the journal HTTP contract `PATCH /missions/:num {"status","convo_id"}`, `GET /missions?state=open` (spec §1).
- Produces: nothing code-facing. `BRIDGE_CLAUDE.md` is the "Matron Bridge Instructions" text every Claude session sees (its first line is `# Matron Bridge Instructions`), so the bullet added here IS the one bullet the spec asks for in that text.

- [ ] **Step 1: Write the failing tests**

Append before the final `});` of `test/missions-wiring.test.js`:

```js
  it('both prompt files teach mission_status: after a progress milestone, blocked, handing off — one status, overwritten', () => {
    for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
      const section = md.slice(md.indexOf('## Missions & milestones'));
      expect(section, name).toMatch(/`mission_status`/);
      expect(section, name).toMatch(/after a `progress` milestone, when you become blocked, and when you hand off/);
      expect(section, name).toMatch(/one status, overwritten, not a second milestone log/);
    }
    expect(codexMd).toMatch(/`mission_close`, `milestone_post`, `mission_status`, `mission_list`, `item_move`/);
    expect(codexMd).toContain('`{"status":"...","convo_id":"<id>"}` sets the status');
    expect(codexMd).toContain('`GET $BASE/missions?state=open`');
  });

  it('the Coordinator brief carries the refresh procedure and the exact app message', () => {
    const coord = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
    expect(coord).toContain("## Keep every mission's status current");
    expect(coord).toContain('"Refresh the status of every open mission from its latest milestones, sessions and open items."');
    expect(coord).toMatch(/`mission_list` for the open missions, then for each one `mission_get N` and `mission_status` with `mission: N`/);
    expect(coord).toMatch(/status is newer than its last milestone and whose sessions are all idle/);
    expect(coord).toMatch(/one line per mission you changed/);
    expect(coord).toContain('Never call `mission_status` without `mission`');
    expect(coord).toMatch(/`mission_list` for every open mission/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-wiring.test.js`
Expected: 2 failed, 9 passed.

- [ ] **Step 3: Edit `BRIDGE_CLAUDE.md`**

After the bullet that begins `- Post \`kind: "progress"\` milestones as often as they are useful` (line 82), insert:

```markdown
- Keep the mission's status current with `mission_status`: one short paragraph (≤600 characters) on where the work is, what's next, and anything blocked or waiting on the user — it is the headline on the mission's card in the apps. Set it after a `progress` milestone, when you become blocked, and when you hand off. Keep it current rather than frequent: one status, overwritten, not a second milestone log.
```

- [ ] **Step 4: Edit `BRIDGE_CODEX.md`**

In line 90, replace

```
`mission_start`, `mission_update`, `mission_join`, `mission_get`, `mission_close`, `milestone_post`, `item_move`
```

with

```
`mission_start`, `mission_update`, `mission_join`, `mission_get`, `mission_close`, `milestone_post`, `mission_status`, `mission_list`, `item_move`
```

and in the same line replace

```
and `kind:"progress"` as often as useful. Close it when the work is done, not when the session ends.
```

with

```
and `kind:"progress"` as often as useful. Keep the mission's status current with `mission_status` — one short paragraph (≤600 characters): where the work is, what's next, anything blocked or waiting on the user. Set it after a `progress` milestone, when you become blocked, and when you hand off; one status, overwritten, not a second milestone log. Close it when the work is done, not when the session ends.
```

Replace line 95 in full with:

```markdown
- `GET $BASE/missions/:num` — milestones newest first, open items, conversations. `PATCH $BASE/missions/:num` `{"title"?,"body"?}` to rename; `{"status":"...","convo_id":"<id>"}` sets the status (1–600 characters; the `mission_status` tool). `GET $BASE/missions?state=open` lists open missions with their status and last milestone (the `mission_list` tool).
```

- [ ] **Step 5: Edit `BRIDGE_COORDINATOR.md`**

Line 43 becomes:

```markdown
- `mission_list` for every open mission with its status and last milestone; `mission_get N` for a mission's milestones, open items and conversations; `item_list` with `scope: "all"` for everything open across the user's sessions; journal search (see "Searching the journal") for what was said where.
```

Append at the end of the file (one blank line before it):

```markdown
## Keep every mission's status current

- Every mission carries a status: one short paragraph on its card in the apps saying where the work is, what's next and what is blocked or waiting on the user. Working agents keep their own mission's status current; you refresh them all when asked.
- When asked to refresh mission statuses — the apps send exactly "Refresh the status of every open mission from its latest milestones, sessions and open items." — call `mission_list` for the open missions, then for each one `mission_get N` and `mission_status` with `mission: N`, written from its latest milestones, its conversations and its open items.
- You may skip a mission whose status is newer than its last milestone and whose sessions are all idle: nothing has changed since it was written.
- Then reply in the chat with one line per mission you changed: `#N title — the new status's first sentence`. If you changed none, say so in one line.
- Never call `mission_status` without `mission`: this conversation has no mission of its own.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npx vitest run test/missions-wiring.test.js test/coordinator.test.js test/memory-wiring.test.js test/work-hold-wiring.test.js test/room-wake-wiring.test.js test/journal-read-proxy.test.js test/reminders-wiring.test.js test/secret-requests-wiring.test.js test/tracker-refs-outside-matron.test.js test/agent-chat.test.js`
Expected: `Test Files  10 passed (10)`, 0 failed (these are every test that reads the three prompt files).

- [ ] **Step 7: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status
git add BRIDGE_CLAUDE.md BRIDGE_CODEX.md BRIDGE_COORDINATOR.md test/missions-wiring.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -m "prompts: keep mission status current; Coordinator refresh procedure

Sessions set mission_status after a progress milestone, when blocked and
on hand-off. The Coordinator answers the apps' refresh message with
mission_list, then mission_get + mission_status (mission: N) per mission.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification and PR (no merge, no deploy)

**Files:** none changed.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a pushed branch and an open PR against `master` that says it waits for the journal deploy.

- [ ] **Step 1: Run the full CI script**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && npm run lint && npm run check && npx vitest run 2>&1 | grep -E "^ FAIL " | awk '{print $2}' | sort -u`
Expected: lint and check exit 0; the FAIL list is empty or a subset of `test/codex-completion.test.js test/codex-liveness.test.js test/codex-producer.test.js test/file-link-guard.test.js test/interactive-session.test.js test/permission-gate.test.js test/pre-trust.test.js` (pre-existing macOS-local failures). Any other file is a regression to fix before going on.

- [ ] **Step 2: Confirm authorship before pushing (the CLA check fails on anything else)**

Run: `cd /Users/danbarker/Dev/matron-bridge-mission-status && git log origin/master..HEAD --format='%an <%ae> | %s'`
Expected: every line `Dan Barker <dan@yearbookmachine.com> | …`.

- [ ] **Step 3: Push and open the PR**

```bash
cd /Users/danbarker/Dev/matron-bridge-mission-status
git push -u origin HEAD:feat/mission-status
gh pr create --repo Matronhq/matron-bridge --base master --head feat/mission-status \
  --title "mission_status + mission_list tools; Coordinator status refresh" \
  --body "$(cat <<'EOF'
Bridge half of the missions dashboard (matron-apple spec 2026-09-28-missions-dashboard-design.md §2).

- `mission_status({status, mission?})` → `PATCH /missions/:id {status, convo_id}` on this conversation's mission, or mission #N.
- `mission_list({state?})` → `GET /missions?state=open|closed`, so the Coordinator can find every mission to refresh (the spec's procedure needs it; there was no list tool).
- `mission_get` shows the status; status errors (old journal 400, shared-mission 403, closed 409) read as sentences.
- BRIDGE_CLAUDE.md / BRIDGE_CODEX.md: set the status after a progress milestone, when blocked, on hand-off. BRIDGE_COORDINATOR.md: the refresh procedure for the apps' fixed message.

**Merge gate: do not merge until the matron-journal mission-status PR is deployed to services-1.** Against an older journal every status write answers 400 (reported to the agent as "deploy the journal update").

Not deployed — fleet deploy is a separate step after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. Do NOT merge. Do NOT run `deploy.sh` or touch any box.
