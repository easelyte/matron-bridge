# Coordinator (bridge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bridge know which conversation is the user's Coordinator (from the journal), run that session with a coordinator instruction block, no file-editing tools and `opus[1m]` by default, react live when the role moves, and give every session `mission_create` plus `agent_session_start mission`.

**Architecture:** A new pure-ish module `lib/coordinator.js` owns the journal lookup (`GET /coordinator`, cached, throttled, refreshed on every hello_ok and every `coordinator` event) and every decision (spawn args, turn text, model plan, stale-event check). `index.js` only wires it: `createSession` reads the cached role synchronously and passes it to the three spawn builders (print, interactive, Codex); a new router seam hands `coordinator` events to an async handler that re-reads the journal, respawns an idle session so the role applies at once, switches the model the `/model` way when the user never picked one, and injects the assigned/released turn. `mission_create` and the `mission` param ride the existing missions and spawn plumbing; on the receiving side, an RPC `start` carrying `mission_num` joins the new conversation to the mission before its opening turn.

**Tech Stack:** Node ≥ 22 ESM, vitest 5 (`npx vitest run <file>`), eslint (`--max-warnings=0`), zod (MCP schemas in `ask-user.js`). No new dependencies.

**Spec:** `/Users/danbarker/Dev/matron-apple-coordinator/docs/superpowers/specs/2026-09-23-coordinator-redesign-design.md` (bridge = §2; also "Rollout order" and "Testing"). Cross-repo contract: `/tmp/coord-plan/contract.md` — its bridge-relevant points are copied verbatim into Global Constraints below, because `/tmp` does not survive a reboot.

## Global Constraints

- Worktree: `/Users/danbarker/Dev/matron-bridge-coordinator`, branch `feat/coordinator`. `~/Dev/matron-bridge` is the LIVE deployed bridge — never edit it or switch its branch.
- Commits: `git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit …`, message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git config user.*`. Do not push.
- Journal routes/events assumed to exist (journal is planned separately and deploys first): `GET /coordinator` (agent bearer) → 200 `{"convo_id": string|null}` — `null` also when the journal's privacy filter hides the Coordinator's convo from this agent (it sits on another box's private convo); null, 404 and any failure all mean "treat this spawn as an ordinary session"; event type `"coordinator"` with payload `{"role":"assigned"}` / `{"role":"released"}`, sender = the user's sender string; mission create is the existing `POST /missions` with body field `"attach": false` (`/missions/create` exists on the journal only as an alias — the bridge uses `POST /missions`); spawn request accepts optional `mission_num`, rejects with error code `no_mission` / `mission_closed`; the `start` rpc params may carry `mission_num`.
- Joining a spawned session to its mission: the journal joins only after the `start` reply, but the bridge writes the opening turn before replying. So when `start` carries `mission_num`, the bridge joins the new conversation to that mission through its existing missions join path (`lib/missions-tools.js` `join` → journal `POST /missions/:num/join`) BEFORE the opening turn, and the opening turn names the mission ("You are on mission #N — run mission_get …"). A failed join is logged and the session still starts; the journal's own join follows.
- Instruction file: `BRIDGE_COORDINATOR.md` at the repo root, next to `BRIDGE_CLAUDE.md`.
- Coordinator enforcement: Claude `--disallowed-tools Edit Write NotebookEdit` (the CLI's kebab spelling of the contract's `--disallowedTools`, matching the existing `'--disallowed-tools', 'AskUserQuestion'` arg); Codex sandbox `read-only`. `Bash` stays available.
- Turn text, verbatim: assigned → starts `[coordinator] You are now this user's Coordinator.` followed by a blank line and the block; released → `[coordinator] You are no longer the Coordinator; carry on as an ordinary session.`
- Model: `opus[1m]`. On `assigned`, only when the room has no explicitly user-chosen model; an explicit choice is kept.
- New MCP tool `mission_create {title: string, body?: string}` → mission create with `attach: false` + idem key; returns `Mission #N "title" created (unassigned)`.
- `agent_session_start` gains optional `mission` (integer) → sent as `mission_num`.
- Every new `lib/*.js` file is added to the `check` script in `package.json`.
- Tests: vitest; `index.js` cannot be imported in-process (top-level side effects), so its wiring is pinned by source inspection, the pattern in `test/start-model-flag-wiring.test.js` and `test/missions-wiring.test.js`.

## Review Focus

1. **A replayed or reversed `coordinator` event** (bridge was down while the user assigned A then B; on reconnect the cursor replays both) — expected: only the role the journal currently confirms is acted on; A gets no "You are now the Coordinator" turn. Pinned in Task 6 (`decideCoordinatorEvent` stale cases).
2. **Assignment lands mid-turn** — expected: the assigned turn is queued, not dropped, and the parked model switch stays *implicit* (so a later re-assignment can still change it). Pinned in Task 2 (`planCoordinatorTransition` occupied cases) and Task 5 (`--implicit` park text).
3. **An old journal with no `/coordinator` route (404)** — expected: treated as "nobody is the Coordinator", logged once, sessions spawn normally, no request storm. Pinned in Task 1.
4. **An old journal that ignores `attach:false`** and answers `existing:true` with the Coordinator's own mission — expected: `mission_create` reports an error naming the journal deploy, never "created (unassigned)". Pinned in Task 7.
5. **Legacy rooms with no `modelExplicit` flag** — expected: a persisted alias (`sonnet`, `opus`) the user picked before this change counts as explicit and is kept; an observed full id (`claude-…`) written by `/resume`, or the New Chat picker's preselected `default`, does not. Pinned in Task 2 (`isModelExplicit`).

---

## File Structure

- Create `lib/coordinator.js` — journal lookup + cache (`createCoordinatorLookup`), pure spawn/turn/model/event helpers, constants.
- Create `BRIDGE_COORDINATOR.md` — the coordinator instruction block.
- Create `test/coordinator.test.js` — unit tests for `lib/coordinator.js`.
- Create `test/coordinator-wiring.test.js` — source-inspection pins for `index.js` / `ask-user.js`.
- Modify `lib/journal-input-router.js` — `onCoordinatorEvent` seam.
- Modify `lib/missions-client.js`, `lib/missions-tools.js`, `lib/missions-format.js` — `create`.
- Modify `lib/agent-spawn.js` — `mission` param.
- Modify `ask-user.js` — `mission_create` tool, `agent_session_start` `mission`.
- Modify `index.js` — lookup construction, spawn sites, explicit-model flag sites, live event handler, `/missions/create` route.
- Modify `BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md` — mention `mission_create` and `mission`.
- Modify `package.json` — `check` script.
- Modify existing tests: `test/journal-input-router.test.js`, `test/missions-client.test.js`, `test/missions-tools.test.js`, `test/missions-format.test.js`, `test/missions-wiring.test.js`, `test/agent-spawn.test.js`.

---

### Task 1: Coordinator lookup and cache

**Files:**
- Create: `lib/coordinator.js`
- Create: `test/coordinator.test.js`
- Modify: `package.json` (`check` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `createCoordinatorLookup({ baseUrl, token, fetchImpl?, timeoutMs?, minRefreshMs?, now?, log? })` returning
  - `refresh({ force?: boolean }) -> Promise<{ known: boolean, convoId: string|null, fetched: boolean }>` — never rejects; `fetched` is true only when this call's GET succeeded and was not superseded by `apply`.
  - `apply(convoId: string, role: 'assigned'|'released') -> void`
  - `roleFor(candidates: Array<string|null|undefined>) -> { known: boolean, coordinator: boolean }`
  - `snapshot() -> { known: boolean, convoId: string|null }`

- [ ] **Step 1: Write the failing tests**

Create `test/coordinator.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createCoordinatorLookup } from '../lib/coordinator.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

function recordingLog() {
  const warns = [];
  return { warns, log: { warn: (m) => warns.push(m), error: () => {} } };
}

describe('createCoordinatorLookup', () => {
  it('is unknown until the journal answers, and an unknown role is never the coordinator', () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(l.snapshot()).toEqual({ known: false, convoId: null });
    expect(l.roleFor(['c1'])).toEqual({ known: false, coordinator: false });
  });

  it('refresh reads convo_id with the agent bearer; roleFor matches any non-empty candidate', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await l.refresh({ force: true });
    expect(r).toEqual({ known: true, convoId: 'c1', fetched: true });
    expect(calls[0].url).toBe('https://j/coordinator');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(l.roleFor([undefined, null, '', 'other', 'c1'])).toEqual({ known: true, coordinator: true });
    expect(l.roleFor(['other'])).toEqual({ known: true, coordinator: false });
    expect(l.roleFor(null)).toEqual({ known: true, coordinator: false });
  });

  it('convo_id null (nobody, or hidden from this agent by the privacy filter) means known, nobody: every spawn is ordinary', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: null } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    expect(l.roleFor(['c1']).coordinator).toBe(false);
  });

  it('journal unreachable before it ever answered: stays unknown (ordinary spawns), warns once, never throws', async () => {
    const { fetchImpl } = fakeFetch(() => new Error('ECONNREFUSED'));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    const r1 = await l.refresh({ force: true });
    const r2 = await l.refresh({ force: true });
    expect(r1).toEqual({ known: false, convoId: null, fetched: false });
    expect(r2.fetched).toBe(false);
    expect(l.roleFor(['c1'])).toEqual({ known: false, coordinator: false });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/role unknown; sessions start as ordinary sessions/);
  });

  it('a failure after a good answer keeps the last known coordinator', async () => {
    let fail = false;
    const { fetchImpl } = fakeFetch(() => (fail ? { status: 503, body: {} } : { status: 200, body: { convo_id: 'c1' } }));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    fail = true;
    const r = await l.refresh({ force: true });
    expect(r).toEqual({ known: true, convoId: 'c1', fetched: false });
    expect(warns[0]).toMatch(/HTTP 503/);
    expect(warns[0]).toMatch(/keeping the last known coordinator \(c1\)/);
  });

  it('404 (journal predates /coordinator) is known-nobody, warned once', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { error: 'not_found' } }));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/predates GET \/coordinator/);
  });

  it('an unreadable body is a failure, not "nobody"', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 42 } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log: recordingLog().log });
    const r = await l.refresh({ force: true });
    expect(r.fetched).toBe(false);
    expect(l.snapshot().known).toBe(false);
  });

  it('no base URL: never fetches, stays unknown', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: '', token: 't', fetchImpl, log: recordingLog().log });
    const r = await l.refresh({ force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ known: false, convoId: null, fetched: false });
  });

  it('throttles unforced refreshes; force bypasses; concurrent calls share one request', async () => {
    let t = 1_000_000;
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, minRefreshMs: 30_000, now: () => t });
    await Promise.all([l.refresh(), l.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 10_000;
    const throttled = await l.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(throttled).toEqual({ known: true, convoId: 'c1', fetched: false });
    await l.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    t += 30_000;
    await l.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('apply: assigned sets, released clears only the matching convo', () => {
    const l = createCoordinatorLookup({ baseUrl: '', token: 't' });
    l.apply('c1', 'assigned');
    expect(l.snapshot()).toEqual({ known: true, convoId: 'c1' });
    l.apply('c2', 'released');
    expect(l.snapshot()).toEqual({ known: true, convoId: 'c1' });
    l.apply('c1', 'released');
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    l.apply('', 'assigned');
    l.apply('c3', 'bogus');
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
  });

  it('an event applied while a GET is in flight is not clobbered by the stale answer; a forced refresh re-reads', async () => {
    const answers = [];
    const { fetchImpl } = fakeFetch(() => new Promise((resolve) => answers.push(resolve)));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    const first = l.refresh({ force: true });
    l.apply('c2', 'assigned');
    const second = l.refresh({ force: true });
    answers.shift()({ status: 200, body: { convo_id: 'c1' } }); // stale: sent before the event
    expect(await first).toEqual({ known: true, convoId: 'c2', fetched: false });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers.shift()({ status: 200, body: { convo_id: 'c2' } });
    expect(await second).toEqual({ known: true, convoId: 'c2', fetched: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coordinator.test.js`
Expected: FAIL — `Failed to resolve import "../lib/coordinator.js"`.

- [ ] **Step 3: Write the implementation**

Create `lib/coordinator.js`:

```js
// The user's Coordinator (spec 2026-09-23 coordinator redesign, §2): which
// conversation holds the role, read from the journal, and every decision the
// bridge makes about it. Kept out of index.js so it is unit-testable; the
// wiring there is pinned by source inspection (test/coordinator-wiring.test.js).
//
// The role lives on the journal (GET /coordinator → {convo_id}), one per
// user; a bridge's agent token belongs to exactly one user, so this is one
// cached value per bridge. The answer is filtered by the journal's privacy
// rules: a Coordinator convo on another box's private conversation reads
// as null here — which is fine, because only the bridge that owns that
// room ever needs to know, and it sees the id. Null, a 404 and every
// failure all come out of roleFor() as "not the coordinator": the spawn is
// an ordinary session. createSession is synchronous with a dozen
// callers, so spawns read the cache; it is kept current by a forced refresh
// on every hello_ok, a forced refresh on every `coordinator` event, and a
// throttled refresh kicked behind every spawn. Never throws, never logs the
// token.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;

export function createCoordinatorLookup({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minRefreshMs = DEFAULT_MIN_REFRESH_MS,
  now = () => Date.now(),
  log = console,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  let known = false;
  let convoId = null;
  // Bumped by apply(): a GET that was already in flight when a live event
  // landed carries an answer from before the event, so it must not
  // overwrite what the event just set.
  let epoch = 0;
  let lastAttempt = -Infinity;
  let inFlight = null;
  let warnedFailure = false;
  let warnedLegacy = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function snapshot() {
    return { known, convoId };
  }

  async function fetchOnce() {
    if (!base) return { ok: false, reason: 'no journal configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/coordinator`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A journal that predates the Coordinator has no such route. Until it
      // is deployed nobody can be the Coordinator, so "nobody" is the truth.
      if (res.status === 404) return { ok: true, convoId: null, legacy: true };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const value = data?.convo_id;
      if (value === null) return { ok: true, convoId: null };
      if (typeof value === 'string' && value) return { ok: true, convoId: value };
      return { ok: false, reason: 'unreadable response' };
    } catch (e) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timed out' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh({ force = false } = {}) {
    // A forced refresh must see the journal AFTER whatever made the caller
    // force it, so it never piggybacks on a request already on the wire.
    if (inFlight) return force ? inFlight.then(() => refresh({ force: true })) : inFlight;
    if (!force && now() - lastAttempt < minRefreshMs) return Promise.resolve({ ...snapshot(), fetched: false });
    lastAttempt = now();
    const startEpoch = epoch;
    inFlight = fetchOnce().then((r) => {
      const current = r.ok && startEpoch === epoch;
      if (current) {
        known = true;
        convoId = r.convoId;
        warnedFailure = false;
        if (r.legacy && !warnedLegacy) {
          warnedLegacy = true;
          warn('[coordinator] this journal predates GET /coordinator — no session is the Coordinator until it is updated');
        }
      } else if (!r.ok && !warnedFailure) {
        warnedFailure = true;
        warn(`[coordinator] GET /coordinator failed (${r.reason}) — ${known
          ? `keeping the last known coordinator (${convoId ?? 'none'})`
          : 'role unknown; sessions start as ordinary sessions until the journal answers'}`);
      }
      return { ...snapshot(), fetched: current };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function apply(id, role) {
    if (typeof id !== 'string' || !id) return;
    if (role === 'assigned') {
      epoch += 1;
      known = true;
      convoId = id;
    } else if (role === 'released') {
      epoch += 1;
      if (known && convoId === id) convoId = null;
    }
  }

  function roleFor(candidates) {
    const ids = (Array.isArray(candidates) ? candidates : []).filter((c) => typeof c === 'string' && c);
    return { known, coordinator: known && convoId !== null && ids.includes(convoId) };
  }

  return { refresh, apply, roleFor, snapshot };
}
```

Note on the `apply` test: `apply('', 'assigned')` and `apply('c3', 'bogus')` must not bump state — they return before touching anything (the `bogus` branch matches neither role).

In `package.json`, append ` && node --check lib/coordinator.js` to the end of the `check` script (after `node --check lib/work-hold.js`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coordinator.test.js && npm run check && npx eslint lib/coordinator.js test/coordinator.test.js --max-warnings=0`
Expected: all tests PASS; check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add lib/coordinator.js test/coordinator.test.js package.json
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: journal lookup + cache for the Coordinator role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Coordinator block, spawn args, turn text and model plan (pure)

**Files:**
- Create: `BRIDGE_COORDINATOR.md`
- Modify: `lib/coordinator.js` (append)
- Test: `test/coordinator.test.js` (append)

**Interfaces:**
- Consumes: `normalizeModelArg`, `SWITCHABLE_ALIASES` from `lib/model-aliases.js`; `AGENT_CLAUDE` from `lib/agent-backend.js`.
- Produces (all exported from `lib/coordinator.js`):
  - constants `COORDINATOR_MODEL = 'opus[1m]'`, `COORDINATOR_DISALLOWED_TOOLS = ['Edit','Write','NotebookEdit']` (frozen), `COORDINATOR_CODEX_SANDBOX = 'read-only'`, `COORDINATOR_ASSIGNED_PREFIX`, `COORDINATOR_RELEASED_TURN`, `FALLBACK_COORDINATOR_BLOCK`
  - `loadCoordinatorBlock({ readFile: (path) => string, path: string, log? }) -> string`
  - `claudeCoordinatorArgs({ coordinator: boolean, basePrompt: string, block: string, baseDisallowed?: string[] }) -> { appendSystemPrompt: string, disallowedTools: string[] }`
  - `codexCoordinatorOptions({ coordinator: boolean, baseInstructions: string, block: string, baseSandbox: string }) -> { developerInstructions: string, sandbox: string }`
  - `coordinatorTurnText(role: string, block: string) -> string|null`
  - `explicitModelFlag(model) -> { modelExplicit: true } | {}`
  - `isModelExplicit(persistedRecord|null) -> boolean`
  - `planCoordinatorTransition({ role, agent, occupied: boolean, persisted }) -> { action: 'respawn'|'switch-model-live'|'next-spawn', model: string|null }`

- [ ] **Step 1: Write the failing tests**

Append to `test/coordinator.test.js` (and extend the import at the top to
`import { createCoordinatorLookup, loadCoordinatorBlock, claudeCoordinatorArgs, codexCoordinatorOptions, coordinatorTurnText, explicitModelFlag, isModelExplicit, planCoordinatorTransition, COORDINATOR_MODEL, COORDINATOR_ASSIGNED_PREFIX, COORDINATOR_RELEASED_TURN, FALLBACK_COORDINATOR_BLOCK } from '../lib/coordinator.js';`
plus `import { readFileSync } from 'node:fs';`):

```js
describe('coordinator block file', () => {
  const block = readFileSync(new URL('../BRIDGE_COORDINATOR.md', import.meta.url), 'utf8');
  it('says the essentials of spec §2b', () => {
    expect(block).toMatch(/^# You are this user's Coordinator/m);
    expect(block).toMatch(/never do the work yourself/i);
    expect(block).toMatch(/mission_create/);
    expect(block).toMatch(/agent_session_start/);
    expect(block).toMatch(/`mission: N`/);
    expect(block).toMatch(/mission_join/);
    expect(block).toMatch(/item_list.*scope: "all"/);
    expect(block).toMatch(/mission_get/);
    expect(block).toMatch(/kind: "question"/);
    expect(block).toMatch(/Never call `mission_start` or `mission_join` for this conversation/);
  });
});

describe('loadCoordinatorBlock', () => {
  it('trims the file; falls back (and warns) when unreadable or empty', () => {
    expect(loadCoordinatorBlock({ readFile: () => '  hi \n', path: '/x' })).toBe('hi');
    const warns = [];
    const log = { warn: (m) => warns.push(m) };
    expect(loadCoordinatorBlock({ readFile: () => { throw new Error('ENOENT'); }, path: '/x', log })).toBe(FALLBACK_COORDINATOR_BLOCK);
    expect(loadCoordinatorBlock({ readFile: () => '   ', path: '/x', log })).toBe(FALLBACK_COORDINATOR_BLOCK);
    expect(warns).toHaveLength(2);
  });
});

describe('claudeCoordinatorArgs', () => {
  it('a non-coordinator room gets exactly the base prompt and base disallowed list — no block, no flags', () => {
    const base = ['AskUserQuestion'];
    const r = claudeCoordinatorArgs({ coordinator: false, basePrompt: 'BASE', block: 'BLOCK', baseDisallowed: base });
    expect(r).toEqual({ appendSystemPrompt: 'BASE', disallowedTools: ['AskUserQuestion'] });
    expect(r.disallowedTools).not.toBe(base);
    expect(claudeCoordinatorArgs({ coordinator: false, basePrompt: 'BASE', block: 'BLOCK' }).disallowedTools).toEqual([]);
  });
  it('the coordinator room gets the block appended and Edit/Write/NotebookEdit disallowed, without duplicates', () => {
    const r = claudeCoordinatorArgs({ coordinator: true, basePrompt: 'BASE', block: 'BLOCK', baseDisallowed: ['AskUserQuestion', 'Edit'] });
    expect(r.appendSystemPrompt).toBe('BASE\n\nBLOCK');
    expect(r.disallowedTools).toEqual(['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit']);
  });
});

describe('codexCoordinatorOptions', () => {
  it('ordinary: unchanged; coordinator: block appended and read-only sandbox', () => {
    expect(codexCoordinatorOptions({ coordinator: false, baseInstructions: 'B', block: 'K', baseSandbox: 'danger-full-access' }))
      .toEqual({ developerInstructions: 'B', sandbox: 'danger-full-access' });
    expect(codexCoordinatorOptions({ coordinator: true, baseInstructions: 'B', block: 'K', baseSandbox: 'danger-full-access' }))
      .toEqual({ developerInstructions: 'B\n\nK', sandbox: 'read-only' });
  });
});

describe('coordinatorTurnText', () => {
  it('uses the contract wording verbatim', () => {
    expect(COORDINATOR_ASSIGNED_PREFIX).toBe("[coordinator] You are now this user's Coordinator.");
    expect(COORDINATOR_RELEASED_TURN).toBe('[coordinator] You are no longer the Coordinator; carry on as an ordinary session.');
    expect(coordinatorTurnText('assigned', 'BLOCK')).toBe("[coordinator] You are now this user's Coordinator.\n\nBLOCK");
    expect(coordinatorTurnText('released', 'BLOCK')).toBe(COORDINATOR_RELEASED_TURN);
    expect(coordinatorTurnText('other', 'BLOCK')).toBeNull();
  });
});

describe('explicit model', () => {
  it('explicitModelFlag marks real picks only (not the preselected "default", not empty)', () => {
    expect(explicitModelFlag('sonnet')).toEqual({ modelExplicit: true });
    expect(explicitModelFlag('claude-opus-4-8')).toEqual({ modelExplicit: true });
    expect(explicitModelFlag('opus[1m]')).toEqual({ modelExplicit: true });
    expect(explicitModelFlag('default')).toEqual({});
    expect(explicitModelFlag('')).toEqual({});
    expect(explicitModelFlag(null)).toEqual({});
  });
  it('isModelExplicit: the flag wins; legacy records count a persisted alias, not an observed full id', () => {
    expect(isModelExplicit({ modelExplicit: true, model: 'claude-fable-5' })).toBe(true);
    expect(isModelExplicit({ modelExplicit: false, model: 'sonnet' })).toBe(false);
    expect(isModelExplicit({ model: 'sonnet' })).toBe(true);
    expect(isModelExplicit({ model: 'OPUS' })).toBe(true);
    expect(isModelExplicit({ model: 'claude-opus-4-8' })).toBe(false);
    expect(isModelExplicit({ model: 'default' })).toBe(false);
    expect(isModelExplicit({})).toBe(false);
    expect(isModelExplicit(null)).toBe(false);
  });
});

describe('planCoordinatorTransition', () => {
  it('assigned, idle Claude room with no explicit model: respawn onto opus[1m]', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: false, persisted: { model: 'claude-fable-5' } }))
      .toEqual({ action: 'respawn', model: COORDINATOR_MODEL });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: false, persisted: null }))
      .toEqual({ action: 'respawn', model: 'opus[1m]' });
  });
  it('an explicit user model is kept: respawn only to apply the role', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: false, persisted: { model: 'sonnet', modelExplicit: true } }))
      .toEqual({ action: 'respawn', model: null });
  });
  it('already on opus[1m]: no model change', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: false, persisted: { model: 'opus[1m]', modelExplicit: false } }))
      .toEqual({ action: 'respawn', model: null });
  });
  it('Codex never gets a Claude model', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'codex', occupied: false, persisted: {} }))
      .toEqual({ action: 'respawn', model: null });
  });
  it('mid-turn: model switch goes through the live /model path; with nothing to switch, wait for the next spawn', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {} }))
      .toEqual({ action: 'switch-model-live', model: 'opus[1m]' });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: { model: 'haiku', modelExplicit: true } }))
      .toEqual({ action: 'next-spawn', model: null });
  });
  it('released never touches the model', () => {
    expect(planCoordinatorTransition({ role: 'released', agent: 'claude', occupied: false, persisted: {} }))
      .toEqual({ action: 'respawn', model: null });
    expect(planCoordinatorTransition({ role: 'released', agent: 'claude', occupied: true, persisted: {} }))
      .toEqual({ action: 'next-spawn', model: null });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coordinator.test.js`
Expected: FAIL — `ENOENT … BRIDGE_COORDINATOR.md` and the new imports undefined.

- [ ] **Step 3: Write the block file and the helpers**

Create `BRIDGE_COORDINATOR.md`:

```markdown
# You are this user's Coordinator

This conversation is the user's Coordinator: the one place they come to say what they want done. Your job is to turn that into work other agents do, keep track of it, and tell the user how it is going. **You never do the work yourself.**

## Never do the work

- Do not edit files, write code, run builds or tests, or investigate problems. File-editing tools are switched off in this session. Do not get around that with `Bash` (no `sed -i`, no `cat >`, no `git commit`, no scripts that write files).
- A quick look to route work well is fine: a README, a directory listing, which repo or box something lives in, a journal search. If you catch yourself debugging, stop and hand it out.
- If the user asks you to do something yourself, make it a mission and start a session on it, and tell them that is what you did.

## Hand work out as missions

- One mission per independent piece of work: `mission_create` with a short title and the goal in `body` (what done looks like, constraints, links). It is created unassigned; this conversation does not join it. Never call `mission_start` or `mission_join` for this conversation.
- File the tasks you already know into it (`item_create`, then `item_move` to the mission) so the agent that picks it up finds them.
- Assign it by starting a session: `agent_boxes` to choose a box and folder (spare capacity first; ask the user with a question item if the box or directory is not obvious), then `agent_session_start` with `mission: N` and a task written for both the user, who sees it on the consent card, and the new agent. The new session is on the mission from its first turn.
- Or give it to an agent that is already running: `agent_chat_start` with that session and ask it to `mission_join N`.
- Several independent requests become several missions, each with its own session. Do not bundle them.

## Your own tasks are coordination steps only

- Keep tasks in this conversation only for coordination: "check back on #N tomorrow", "tell the user when #12, #13 and #14 are done". Work is never your task; it is a mission.
- Use `reminder_create` for check-backs more than an hour away.

## Questions go through the tracker

- Every decision you need from the user is an `item_create` with `kind: "question"`: it reaches them in Decisions. Do not end a turn with a question that only exists in chat.
- Pass on a working agent's question only when it needs the user and the agent has not filed it itself.

## Read the state of the world from the journal

- `mission_get N` for a mission's milestones, open items and conversations; `item_list` with `scope: "all"` for everything open across the user's sessions; journal search (see "Searching the journal") for what was said where.
- Do not open repos or read code to find out how work is going. Ask the mission.
- Report in a few lines: what is running where, what is waiting on the user, what finished.
```

Append to `lib/coordinator.js` (and add these imports at the top of the file, above the constants of Task 1):

```js
import { normalizeModelArg, SWITCHABLE_ALIASES } from './model-aliases.js';
import { AGENT_CLAUDE } from './agent-backend.js';
```

```js
// --- Spawn-time shape (spec §2a, §2c) ---

export const COORDINATOR_MODEL = 'opus[1m]';
export const COORDINATOR_DISALLOWED_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit']);
export const COORDINATOR_CODEX_SANDBOX = 'read-only';
export const COORDINATOR_ASSIGNED_PREFIX = "[coordinator] You are now this user's Coordinator.";
export const COORDINATOR_RELEASED_TURN = '[coordinator] You are no longer the Coordinator; carry on as an ordinary session.';
// Used only when BRIDGE_COORDINATOR.md cannot be read: a Coordinator with a
// one-line brief still delegates; one with no brief at all does the work.
export const FALLBACK_COORDINATOR_BLOCK = "You are this user's Coordinator. Never do the work yourself: turn each request into a mission (mission_create) and start a session on it (agent_session_start with mission). Keep your own tasks for coordination steps only.";

export function loadCoordinatorBlock({ readFile, path, log = console }) {
  try {
    const text = String(readFile(path)).trim();
    if (text) return text;
    try { log.warn(`[coordinator] ${path} is empty — using the built-in coordinator brief`); } catch { /* logging must never throw */ }
  } catch (e) {
    try { log.warn(`[coordinator] could not read ${path}: ${e.message} — using the built-in coordinator brief`); } catch { /* logging must never throw */ }
  }
  return FALLBACK_COORDINATOR_BLOCK;
}

// Claude print and interactive spawns. A non-coordinator room gets back
// exactly what it had (a fresh copy of the list), so nothing changes for
// every ordinary session.
export function claudeCoordinatorArgs({ coordinator, basePrompt, block, baseDisallowed = [] }) {
  const disallowedTools = [...baseDisallowed];
  if (!coordinator) return { appendSystemPrompt: basePrompt, disallowedTools };
  for (const tool of COORDINATOR_DISALLOWED_TOOLS) {
    if (!disallowedTools.includes(tool)) disallowedTools.push(tool);
  }
  return { appendSystemPrompt: `${basePrompt}\n\n${block}`, disallowedTools };
}

export function codexCoordinatorOptions({ coordinator, baseInstructions, block, baseSandbox }) {
  if (!coordinator) return { developerInstructions: baseInstructions, sandbox: baseSandbox };
  return { developerInstructions: `${baseInstructions}\n\n${block}`, sandbox: COORDINATOR_CODEX_SANDBOX };
}

export function coordinatorTurnText(role, block) {
  if (role === 'assigned') return `${COORDINATOR_ASSIGNED_PREFIX}\n\n${block}`;
  if (role === 'released') return COORDINATOR_RELEASED_TURN;
  return null;
}

// --- Model (spec §2e) ---
//
// The persisted record cannot tell a pick from a default on its own: the
// live snapshot persists whatever model Claude reported (a full claude-* id)
// and /resume copies that to the top-level `model`. So every site where a
// person (or an agent on their behalf) picks a model now also persists
// `modelExplicit: true`, and the Coordinator's own implicit write persists
// `modelExplicit: false`. Records written before the flag existed fall back
// to: a persisted ALIAS was typed or tapped by someone (the snapshot never
// writes aliases), a full id was observed. `default` is the New Chat
// picker's preselected option, not a choice.
const LEGACY_PICKED_ALIASES = new Set([...SWITCHABLE_ALIASES.map((a) => a.alias), 'best']);

export function explicitModelFlag(model) {
  const m = normalizeModelArg(model);
  return m && m !== 'default' ? { modelExplicit: true } : {};
}

export function isModelExplicit(persisted) {
  if (persisted?.modelExplicit === true) return true;
  if (persisted?.modelExplicit === false) return false;
  const m = normalizeModelArg(persisted?.model);
  return m !== 'default' && LEGACY_PICKED_ALIASES.has(m);
}

// What a live role change does to a running session. An idle session is
// respawned (the recreateSession path /model and /restart use), so the block
// and the tool restrictions apply now rather than at the next idle reap; a
// busy one keeps running and picks the role up at its next spawn, except
// that a pending model switch is handed to the live /model path, which parks
// it until the turn ends.
export function planCoordinatorTransition({ role, agent, occupied, persisted }) {
  const model = role === 'assigned'
    && agent === AGENT_CLAUDE
    && !isModelExplicit(persisted)
    && normalizeModelArg(persisted?.model) !== COORDINATOR_MODEL
    ? COORDINATOR_MODEL
    : null;
  if (!occupied) return { action: 'respawn', model };
  if (model) return { action: 'switch-model-live', model };
  return { action: 'next-spawn', model: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coordinator.test.js && npx eslint lib/coordinator.js test/coordinator.test.js --max-warnings=0`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add BRIDGE_COORDINATOR.md lib/coordinator.js test/coordinator.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: instruction block, spawn args, turn text and model plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Input router accepts `coordinator` events

**Files:**
- Modify: `lib/journal-input-router.js` (parameter list of `createJournalInputConsumer` ~line 216; body of `onJournalEvent` right after the `if (type === 'prompt' && Number.isInteger(frame.seq)) { … }` block, before `const room = typeof roomFor === 'function' …` ~line 473)
- Test: `test/journal-input-router.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: optional seam `onCoordinatorEvent(convoId: string, { role: 'assigned'|'released', seq: number|null }) -> void` on `createJournalInputConsumer`. Called for any sender; never routed as a turn, never triggers resume or the unknown-convo notice.

- [ ] **Step 1: Write the failing tests**

Append to `test/journal-input-router.test.js`:

```js
describe('coordinator events', () => {
  function consumer(overrides = {}) {
    const seams = {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => null),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      resumeSessionForConvo: vi.fn(() => null),
      noticeUnknownConvo: vi.fn(),
      onCoordinatorEvent: vi.fn(),
      log: silentLog,
      ...overrides,
    };
    return { onEvent: createJournalInputConsumer(seams), seams };
  }

  it('hands assigned/released to the seam from any sender, with the seq', () => {
    const { onEvent, seams } = consumer();
    onEvent(baseFrame({ seq: 7, type: 'coordinator', sender: 'user:dan', payload: { role: 'assigned' } }));
    onEvent(baseFrame({ seq: 8, type: 'coordinator', sender: 'agent:box', payload: { role: 'released' } }));
    onEvent(baseFrame({ seq: 9, type: 'coordinator', sender: 'system', payload: { role: 'assigned' } }));
    expect(seams.onCoordinatorEvent.mock.calls).toEqual([
      ['convo-1', { role: 'assigned', seq: 7 }],
      ['convo-1', { role: 'released', seq: 8 }],
      ['convo-1', { role: 'assigned', seq: 9 }],
    ]);
  });

  it('is never input: no text route, no resume, no unknown-convo notice', () => {
    const { onEvent, seams } = consumer();
    onEvent(baseFrame({ type: 'coordinator', payload: { role: 'assigned' } }));
    expect(seams.routeTextToSession).not.toHaveBeenCalled();
    expect(seams.resumeSessionForConvo).not.toHaveBeenCalled();
    expect(seams.findSessionByConvoId).not.toHaveBeenCalled();
    expect(seams.noticeUnknownConvo).not.toHaveBeenCalled();
  });

  it('drops an unknown role or a missing convo id', () => {
    const { onEvent, seams } = consumer();
    onEvent(baseFrame({ type: 'coordinator', payload: { role: 'promoted' } }));
    onEvent(baseFrame({ type: 'coordinator', payload: null }));
    onEvent(baseFrame({ type: 'coordinator', convo_id: '', payload: { role: 'assigned' } }));
    expect(seams.onCoordinatorEvent).not.toHaveBeenCalled();
  });

  it('a throwing seam is contained; an unwired seam is a silent drop', () => {
    const warns = [];
    const { onEvent } = consumer({ onCoordinatorEvent: () => { throw new Error('boom'); }, log: { warn: (m) => warns.push(m) } });
    expect(() => onEvent(baseFrame({ type: 'coordinator', payload: { role: 'assigned' } }))).not.toThrow();
    expect(warns.some((w) => /onCoordinatorEvent threw: boom/.test(w))).toBe(true);
    const { onEvent: bare, seams } = consumer({ onCoordinatorEvent: undefined });
    bare(baseFrame({ type: 'coordinator', payload: { role: 'assigned' } }));
    expect(seams.noticeUnknownConvo).not.toHaveBeenCalled();
  });

  it('a coordinator frame in an active room convo still goes to the coordinator seam, not the room', () => {
    const routeRoomFrame = vi.fn();
    const { onEvent, seams } = consumer({ roomFor: () => ({ peerName: 'x' }), routeRoomFrame });
    onEvent(baseFrame({ type: 'coordinator', payload: { role: 'assigned' } }));
    expect(routeRoomFrame).not.toHaveBeenCalled();
    expect(seams.onCoordinatorEvent).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/journal-input-router.test.js -t "coordinator events"`
Expected: FAIL — `onCoordinatorEvent` never called.

- [ ] **Step 3: Implement the seam**

In `lib/journal-input-router.js`, add to the seam doc comment above `createJournalInputConsumer` (after the `routeItemToSession` entry):

```js
//   onCoordinatorEvent(convoId, {role, seq}) -> void (optional) — a journal
//     `coordinator` event (spec 2026-09-23 coordinator redesign, §2a):
//     role 'assigned' | 'released'. Any sender. Never a turn by itself.
```

Add `onCoordinatorEvent,` to the destructured parameter list right after `routeItemToSession,`.

Insert right after the closing `}` of the `if (type === 'prompt' && Number.isInteger(frame.seq)) { … }` block and before the `// Agent-chat room carve-out` comment:

```js
      // Coordinator role change (spec 2026-09-23 coordinator redesign, §2a).
      // Journal-authored with the user's sender, but accepted from ANY sender
      // and ahead of the room carve-out and the user:-only filter below: the
      // caller treats it as a hint and re-reads GET /coordinator before acting
      // on it, so a forged or replayed frame cannot make a session the
      // Coordinator by itself. It is never input — no turn, no resume, no
      // unknown-convo notice.
      if (type === 'coordinator') {
        const role = payload?.role;
        if ((role === 'assigned' || role === 'released')
          && typeof convoId === 'string' && convoId
          && typeof onCoordinatorEvent === 'function') {
          try {
            onCoordinatorEvent(convoId, { role, seq: Number.isInteger(frame.seq) ? frame.seq : null });
          } catch (e) {
            warn(`[journal-input] onCoordinatorEvent threw: ${e?.message ?? String(e)}`);
          }
        }
        return;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/journal-input-router.test.js && npx eslint lib/journal-input-router.js --max-warnings=0`
Expected: PASS (whole file — the existing router tests must stay green).

- [ ] **Step 5: Commit**

```bash
git add lib/journal-input-router.js test/journal-input-router.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "journal-input: route coordinator events to an onCoordinatorEvent seam

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Spawn sites read the role (print, interactive, Codex)

**Files:**
- Modify: `index.js` — imports (top, next to `import { createMissionsHandlers } from './lib/missions-tools.js';` line 12); paths (lines 175–176 and 426–427); after `const CODEX_BRIDGE_PROMPT = loadCodexBridgePrompt();` (~458); after `missionsClient` (~507–510); `handleJournalReconnect` (572–582); `if (JOURNAL_ENABLED) {` block (~656); `createSession` (1719; role after line 1732 `const agent = resolveAgent(…)`); print args (1840–1846) and session literal (1949); `createCodexSessionForRoom` (2223; adapter options 2244–2255; literal 2258); `createInteractiveSessionForRoom` (2670; `claudeArgs.push(` 2738–2748; literal 2793).
- Create: `test/coordinator-wiring.test.js`

**Interfaces:**
- Consumes: `createCoordinatorLookup`, `loadCoordinatorBlock`, `claudeCoordinatorArgs`, `codexCoordinatorOptions` (Tasks 1–2).
- Produces (module-level in `index.js`, used by Task 6): `coordinatorLookup` (the lookup instance), `COORDINATOR_BLOCK: string`, `function coordinatorRoleAtSpawn(roomId, resumeSessionId, options, persisted) -> boolean`; every session object gains `coordinator: boolean` (true iff spawned with the block).

- [ ] **Step 1: Write the failing wiring tests**

Create `test/coordinator-wiring.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the coordinator wiring is pinned by source inspection — same
// approach as test/start-model-flag-wiring.test.js. The decisions themselves
// are unit-tested in test/coordinator.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('coordinator spawn wiring (source inspection)', () => {
  it('loads BRIDGE_COORDINATOR.md with an env override, like the other prompt files', () => {
    expect(index).toContain("const DEFAULT_BRIDGE_COORDINATOR_MD_PATH = path.join(__dirname, 'BRIDGE_COORDINATOR.md');");
    expect(index).toContain('const BRIDGE_COORDINATOR_MD_PATH = process.env.BRIDGE_COORDINATOR_MD_PATH || DEFAULT_BRIDGE_COORDINATOR_MD_PATH;');
    expect(index).toMatch(/const COORDINATOR_BLOCK = loadCoordinatorBlock\(\{/);
  });

  it('builds one lookup on the journal HTTP base and refreshes it at boot and on every hello_ok', () => {
    expect(index).toMatch(/const coordinatorLookup = createCoordinatorLookup\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,/);
    const reconnect = body('function handleJournalReconnect()', '\nfunction ');
    expect(reconnect).toContain('coordinatorLookup.refresh({ force: true });');
    const boot = body('if (JOURNAL_ENABLED) {', '\nfunction expandHome(');
    expect(boot).toContain('coordinatorLookup.refresh({ force: true });');
  });

  it('createSession resolves the role before any agent branch and hands it to all three builders', () => {
    const cs = body('function createSession(roomId, workdir, resumeSessionId, options = {}) {', 'if (agent === AGENT_CODEX) {');
    expect(cs).toContain('const coordinator = coordinatorRoleAtSpawn(roomId, resumeSessionId, options, persistedMode);');
    expect(cs).toContain('options = { ...options, coordinator };');
  });

  it('an unknown role spawns an ordinary session and logs it — never a failed spawn', () => {
    const fn = body('function coordinatorRoleAtSpawn(', '\nfunction ');
    expect(fn).toContain('coordinatorLookup.roleFor(candidates)');
    expect(fn).toContain('coordinatorLookup.refresh();');
    expect(fn).toMatch(/starting as an ordinary session/);
    expect(fn).not.toMatch(/throw /);
  });

  it('print mode: prompt and disallowed tools come from claudeCoordinatorArgs', () => {
    const cs = body('function createSession(roomId, workdir, resumeSessionId, options = {}) {', '\nfunction ');
    expect(cs).toMatch(/const printCoord = claudeCoordinatorArgs\(\{ coordinator: !!options\.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK, baseDisallowed: \['AskUserQuestion'\] \}\);/);
    expect(cs).toContain("'--disallowed-tools', ...printCoord.disallowedTools,");
    expect(cs).toContain("'--append-system-prompt', printCoord.appendSystemPrompt,");
  });

  it('interactive mode: same helper, --disallowed-tools only when there is something to disallow', () => {
    const iv = body('function createInteractiveSessionForRoom(', '\nfunction ');
    expect(iv).toMatch(/const ivCoord = claudeCoordinatorArgs\(\{ coordinator: !!options\.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK \}\);/);
    expect(iv).toContain("...(ivCoord.disallowedTools.length ? ['--disallowed-tools', ...ivCoord.disallowedTools] : []),");
    expect(iv).toContain("'--append-system-prompt', ivCoord.appendSystemPrompt,");
  });

  it('no spawn site appends the bare BRIDGE_SYSTEM_PROMPT any more', () => {
    expect(index).not.toContain("'--append-system-prompt', BRIDGE_SYSTEM_PROMPT");
  });

  it('Codex: developer instructions and sandbox come from codexCoordinatorOptions', () => {
    const cx = body('function createCodexSessionForRoom(', '\nfunction ');
    expect(cx).toMatch(/const codexCoord = codexCoordinatorOptions\(\{ coordinator: !!options\.coordinator, baseInstructions: CODEX_BRIDGE_PROMPT, block: COORDINATOR_BLOCK, baseSandbox: CODEX_SANDBOX_MODE \}\);/);
    expect(cx).toContain('sandbox: codexCoord.sandbox,');
    expect(cx).toContain('developerInstructions: codexCoord.developerInstructions + (CODEX_APP_SERVER');
    expect(cx).not.toContain('sandbox: CODEX_SANDBOX_MODE,');
  });

  it('every session records whether it was spawned as the Coordinator', () => {
    expect(index.match(/^\s+coordinator: !!options\.coordinator,$/gm)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coordinator-wiring.test.js`
Expected: FAIL on every `it`.

- [ ] **Step 3: Wire it**

3a. Import (after line 12, `import { createMissionsHandlers } from './lib/missions-tools.js';`):

```js
import { createCoordinatorLookup, loadCoordinatorBlock, claudeCoordinatorArgs, codexCoordinatorOptions } from './lib/coordinator.js';
```

3b. Paths. After line 176 (`const DEFAULT_BRIDGE_CODEX_MD_PATH = …`):

```js
const DEFAULT_BRIDGE_COORDINATOR_MD_PATH = path.join(__dirname, 'BRIDGE_COORDINATOR.md');
```

After line 427 (`const BRIDGE_CODEX_MD_PATH = …`):

```js
const BRIDGE_COORDINATOR_MD_PATH = process.env.BRIDGE_COORDINATOR_MD_PATH || DEFAULT_BRIDGE_COORDINATOR_MD_PATH;
```

After `const CODEX_BRIDGE_PROMPT = loadCodexBridgePrompt();`:

```js
// The Coordinator's instruction block (spec 2026-09-23 §2b), appended to the
// system prompt / Codex developer instructions of the one room that holds
// the role. Read once at boot like the two prompt files above.
const COORDINATOR_BLOCK = loadCoordinatorBlock({
  readFile: (p) => fs.readFileSync(p, 'utf-8'),
  path: BRIDGE_COORDINATOR_MD_PATH,
  log: console,
});
```

3c. After the `missionsClient` block (~line 510):

```js
// Which conversation is the user's Coordinator (spec 2026-09-23 §2a):
// GET /coordinator on the same host and token as the items/missions
// clients, cached (lib/coordinator.js). No journal configured → the base URL
// is empty, the role stays unknown, and every session spawns ordinary.
const coordinatorLookup = createCoordinatorLookup({
  baseUrl: journalHttpBase,
  token: _journalToken,
  log: console,
});
```

3d. In `handleJournalReconnect`, after `publishBoxStatus('reconnect');`:

```js
  // A fresh epoch may follow a gap in which the Coordinator moved; the
  // replayed `coordinator` events cover a live bridge, this covers a cursor
  // reset (snapshot_required) that skipped them.
  coordinatorLookup.refresh({ force: true });
```

In the `if (JOURNAL_ENABLED) {` block (~line 656), as its first statement:

```js
  // Warm the Coordinator cache before the first resume can ask for it.
  coordinatorLookup.refresh({ force: true });
```

3e. Add just above `function createSession(`:

```js
// Coordinator role for one spawn (spec 2026-09-23 §2a). createSession is
// synchronous with a dozen callers, so the spawn reads the cached answer and
// kicks a throttled GET /coordinator behind it; hello_ok and `coordinator`
// events are what keep the cache current. The room's journal conversation id
// can sit in any of these fields depending on the path (fresh, resume,
// pre-init restart, agent switch), so all of them are candidates. A role
// that is not known yet (journal not reached since boot) spawns an ordinary
// session and says so — never a failed spawn.
function coordinatorRoleAtSpawn(roomId, resumeSessionId, options, persisted) {
  const candidates = [
    options.journalConvoId,
    persisted?.journalConvoId,
    persisted?.sessionId,
    resumeSessionId,
    options.presetSessionId,
  ];
  const role = coordinatorLookup.roleFor(candidates);
  coordinatorLookup.refresh();
  if (!role.known && candidates.some((c) => typeof c === 'string' && c)) {
    console.warn(`[coordinator] ${roomId}: coordinator not known yet (journal has not answered GET /coordinator) — starting as an ordinary session`);
  }
  return role.coordinator;
}
```

In `createSession`, directly after `const agent = resolveAgent({ option: options.agent, persisted: persistedMode?.agent, fallback: DEFAULT_AGENT });`:

```js
  const coordinator = coordinatorRoleAtSpawn(roomId, resumeSessionId, options, persistedMode);
  options = { ...options, coordinator };
```

3f. Print mode. Just above `const args = [` (line ~1839), add:

```js
  const printCoord = claudeCoordinatorArgs({ coordinator: !!options.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK, baseDisallowed: ['AskUserQuestion'] });
```

and replace the two lines

```js
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
```

with

```js
    '--disallowed-tools', ...printCoord.disallowedTools,
    '--append-system-prompt', printCoord.appendSystemPrompt,
```

In the print `const session = {` literal (~1949), after the `roomId,` line add:

```js
    coordinator: !!options.coordinator,
```

3g. Codex. In `createCodexSessionForRoom`, just above `const Adapter = CODEX_APP_SERVER ? …`:

```js
  const codexCoord = codexCoordinatorOptions({ coordinator: !!options.coordinator, baseInstructions: CODEX_BRIDGE_PROMPT, block: COORDINATOR_BLOCK, baseSandbox: CODEX_SANDBOX_MODE });
```

Replace `sandbox: CODEX_SANDBOX_MODE,` with `sandbox: codexCoord.sandbox,` and replace `developerInstructions: CODEX_BRIDGE_PROMPT + (CODEX_APP_SERVER ? '' : …),` with `developerInstructions: codexCoord.developerInstructions + (CODEX_APP_SERVER ? '' : '\nLegacy exec transport: native approvals, native questions, and Matron MCP tools are unavailable. If blocked, explain it in your final response.'),` (the tail string unchanged). In the Codex `const session = {` literal (~2258), after `roomId,` add `coordinator: !!options.coordinator,`.

3h. Interactive. In `createInteractiveSessionForRoom`, just above `const claudeArgs = [...identity.cliArgs];`:

```js
  const ivCoord = claudeCoordinatorArgs({ coordinator: !!options.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK });
```

In the `claudeArgs.push(` call replace `'--append-system-prompt', BRIDGE_SYSTEM_PROMPT,` with:

```js
    // The Coordinator runs without file-editing tools (spec §2c). iv mode has
    // no other disallowed tool, so an ordinary session gets no flag at all.
    ...(ivCoord.disallowedTools.length ? ['--disallowed-tools', ...ivCoord.disallowedTools] : []),
    '--append-system-prompt', ivCoord.appendSystemPrompt,
```

In the iv `const session = {` literal (~2793), after `roomId,` add `coordinator: !!options.coordinator,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coordinator-wiring.test.js test/box-status-wiring.test.js test/queued-release-wiring.test.js && npm run check && npm run lint`
Expected: PASS; check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add index.js test/coordinator-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: block + no-edit tools for the Coordinator room at every spawn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Persist which model picks were explicit

**Files:**
- Modify: `index.js` — `journalStartSessionForRpc` persist (~981–983); `!start` persist (~6385–6387); `!restart` persist (~6503–6506); `!resume` persist (~6812–6826); `!workdir` persist (~6913–6915); `case '!model':` (~7279–7283); `applyModelSwitch` (11010–11070).
- Test: `test/coordinator-wiring.test.js` (append)

**Interfaces:**
- Consumes: `explicitModelFlag` (Task 2).
- Produces: persisted rooms carry `modelExplicit: true` after any explicit pick; `applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit = true })`; the parked text `!model <alias> --implicit` for an implicit busy switch; `!model <alias> --implicit` handled by the `!model` case.

- [ ] **Step 1: Write the failing wiring tests**

Append to `test/coordinator-wiring.test.js`:

```js
describe('explicit model picks are persisted as such (source inspection)', () => {
  it('imports explicitModelFlag', () => {
    expect(index).toMatch(/import \{[^}]*\bexplicitModelFlag\b[^}]*\} from '\.\/lib\/coordinator\.js'/);
  });

  it('RPC start, !start, !restart, !resume and !workdir mark the picked model explicit', () => {
    const rpc = body('function journalStartSessionForRpc(', '\nfunction ');
    expect(rpc).toContain('model ? { model, ...explicitModelFlag(model) } : undefined');
    expect(index).toContain('startModel ? { model: startModel, ...explicitModelFlag(startModel) } : undefined');
    expect(index).toContain('{ model: restartModelFlag.model, ...explicitModelFlag(restartModelFlag.model) }');
    expect(index).toContain('...(resumeModelFlag.model ? explicitModelFlag(resumeModelFlag.model) : {}),');
    expect(index).toContain('workdirModel ? { model: workdirModel, ...explicitModelFlag(workdirModel) } : undefined');
  });

  it('applyModelSwitch takes an explicit option; implicit switches persist modelExplicit:false and park with --implicit', () => {
    const fn = body('function applyModelSwitch(', '\nfunction ');
    expect(fn).toContain('function applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit = true }) {');
    expect(fn).toContain("session._deferredCommandText = `!model ${decision.normalized}${explicit ? '' : ' --implicit'}`;");
    expect(fn.match(/explicit \? explicitModelFlag\([^)]*\) : \{ modelExplicit: false \}/g)).toHaveLength(3);
  });

  it('!model reads --implicit (the parked coordinator switch) and passes explicit through', () => {
    const block = body("case '!model': {", "case '!mode': {");
    expect(block).toContain("const implicit = parts.slice(2).includes('--implicit');");
    expect(block).toContain('applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit: !implicit });');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coordinator-wiring.test.js -t "explicit model picks"`
Expected: FAIL.

- [ ] **Step 3: Implement**

3a. Extend the Task 4 import line to `import { createCoordinatorLookup, loadCoordinatorBlock, claudeCoordinatorArgs, codexCoordinatorOptions, explicitModelFlag } from './lib/coordinator.js';`.

3b. `journalStartSessionForRpc`: replace

```js
    persistSession(sessionRoomId, session.claudeSessionId, session.workdir, null,
      model ? { model } : undefined);
```

with

```js
    persistSession(sessionRoomId, session.claudeSessionId, session.workdir, null,
      model ? { model, ...explicitModelFlag(model) } : undefined);
```

3c. `!start`: replace `startModel ? { model: startModel } : undefined);` with `startModel ? { model: startModel, ...explicitModelFlag(startModel) } : undefined);`.

3d. `!restart`: replace `{ model: restartModelFlag.model });` with `{ model: restartModelFlag.model, ...explicitModelFlag(restartModelFlag.model) });`. (`restart_session` with `model` reaches this same case as `!restart --model …`, so an agent's restart onto a model the user asked for counts as a pick.)

3e. `!resume`: in the `persistSession(sessionRoomId, resumeSessionId, …, {` object, directly after `model: session.currentModel || null,` add:

```js
        // Only a --model typed now is a pick; resumeState.model may be a
        // model Claude merely reported, so it must not be marked explicit.
        ...(resumeModelFlag.model ? explicitModelFlag(resumeModelFlag.model) : {}),
```

3f. `!workdir`: replace `workdirModel ? { model: workdirModel } : undefined);` with `workdirModel ? { model: workdirModel, ...explicitModelFlag(workdirModel) } : undefined);`.

3g. `case '!model':` replace

```js
      const arg = parts[1];
      if (arg) {
        applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
        break;
      }
```

with

```js
      const arg = parts[1];
      if (arg) {
        // `--implicit` is how a Coordinator model switch parked mid-turn
        // (applyModelSwitch explicit:false) replays without turning into a
        // user pick; nothing else sends it.
        const implicit = parts.slice(2).includes('--implicit');
        applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit: !implicit });
        break;
      }
```

3h. `applyModelSwitch`: change the signature to `function applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit = true }) {` and extend its header comment with: `explicit:false is the Coordinator's default-model switch (spec 2026-09-23 §2e): same path, but persisted as modelExplicit:false so a later assignment may change it again.` Then:

- Codex branch: `persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model });` → `persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model, ...(explicit ? explicitModelFlag(model) : { modelExplicit: false }) });`
- iv branch: replace

```js
  if (session.iv) {
    // Interactive: type /model into the live TUI. Not persisted by design —
    // the pick applies to the live session only (spec non-goal); a restart
    // falls back to the persisted/default model.
    switchModelInSession(session, arg, sendReply);
    return;
  }
```

with

```js
  if (session.iv) {
    // Interactive: type /model into the live TUI. The MODEL is not persisted
    // by design — the pick applies to the live session only (spec non-goal);
    // a restart falls back to the persisted/default model. Whether a person
    // picked it is persisted, so a later Coordinator assignment leaves it
    // alone. The Coordinator's own switch does persist the model, so its
    // next spawn stays on it.
    const switched = switchModelInSession(session, arg, sendReply);
    if (switched) {
      persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId,
        explicit ? explicitModelFlag(arg) : { model: normalizeModelArg(arg), modelExplicit: false });
    }
    return;
  }
```

(Check first that `switchModelInSession` returns a truthy value on success — `lib/model-command.js` ends its success path with `return true;`, line ~41 — and that `normalizeModelArg` is imported in `index.js`; if not, add it to the existing `./lib/model-aliases.js` import.)

- Deferred park: replace ``session._deferredCommandText = `!model ${decision.normalized}`;`` with ``session._deferredCommandText = `!model ${decision.normalized}${explicit ? '' : ' --implicit'}`;``.
- Print persist: replace `persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model: decision.normalized });` with `persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model: decision.normalized, ...(explicit ? explicitModelFlag(decision.normalized) : { modelExplicit: false }) });`.

That gives exactly three `explicit ? explicitModelFlag(...) : { modelExplicit: false }` occurrences (Codex, iv, print), as the test pins.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coordinator-wiring.test.js test/start-model-flag-wiring.test.js test/model-command.test.js test/restart-deferral.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js test/coordinator-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "model: persist modelExplicit on every explicit pick; implicit /model path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live assign/release on a running (or sleeping) session

**Files:**
- Modify: `lib/coordinator.js` (append `decideCoordinatorEvent`, `withCoordinatorModel`)
- Modify: `index.js` — new functions next to `journalOnItem` (~8389); the `createJournalInputConsumer({` config (~9471; add after `routeItemToSession: journalOnItem,`).
- Test: `test/coordinator.test.js`, `test/coordinator-wiring.test.js` (append)

**Interfaces:**
- Consumes: `coordinatorLookup`, `COORDINATOR_BLOCK` (Task 4); `coordinatorTurnText`, `planCoordinatorTransition` (Task 2); `applyModelSwitch(..., { explicit:false })` (Task 5); router seam `onCoordinatorEvent` (Task 3); existing `findSessionByClaudeSessionId`, `recreateSession`, `persistSession`, `getPersistedSession`, `loadPersistedSessions`, `savePersistedSessions`, `sessionOccupiedForRoomDelivery`, `journalQueueMedia`, `sendTextToSession`, `journalSessionCommandCtx`, `normalizeAgent`, `AGENT_CLAUDE`.
- Produces: `decideCoordinatorEvent({ role, convoId, truth, live: boolean, sessionCoordinator: boolean }) -> 'stale'|'persist-sleeping'|'none'|'transition'`; `withCoordinatorModel(record, model?) -> record`; `async function journalOnCoordinator(convoId, { role })` in `index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/coordinator.test.js` (extend the import with `decideCoordinatorEvent, withCoordinatorModel`):

```js
describe('decideCoordinatorEvent', () => {
  const live = { live: true, sessionCoordinator: false };
  it('acts only on what the journal confirms: a replayed or reversed event is stale', () => {
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth: { fetched: true, convoId: 'b' }, ...live })).toBe('stale');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, convoId: 'a' }, live: true, sessionCoordinator: true })).toBe('stale');
  });
  it('journal unreachable right now: trusts the event (it came from the journal socket)', () => {
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth: { fetched: false, convoId: null }, ...live })).toBe('transition');
  });
  it('no live session: an assignment is persisted for the next resume; a release needs nothing', () => {
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth: { fetched: true, convoId: 'a' }, live: false, sessionCoordinator: false })).toBe('persist-sleeping');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, convoId: null }, live: false, sessionCoordinator: false })).toBe('none');
  });
  it('a session already running in that role is left alone (no duplicate turn)', () => {
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth: { fetched: true, convoId: 'a' }, live: true, sessionCoordinator: true })).toBe('none');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, convoId: 'b' }, live: true, sessionCoordinator: false })).toBe('none');
  });
  it('otherwise: transition', () => {
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth: { fetched: true, convoId: 'a' }, ...live })).toBe('transition');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, convoId: 'b' }, live: true, sessionCoordinator: true })).toBe('transition');
  });
});

describe('withCoordinatorModel', () => {
  it('sets the top-level model the spawn reads, the claude agent state resume reads, and marks it implicit', () => {
    const rec = { workdir: '/w', model: 'claude-fable-5', agentSessions: { claude: { sessionId: 's', model: 'claude-fable-5' }, codex: { sessionId: 't', model: 'gpt' } } };
    const out = withCoordinatorModel(rec);
    expect(out.model).toBe('opus[1m]');
    expect(out.modelExplicit).toBe(false);
    expect(out.agentSessions.claude).toEqual({ sessionId: 's', model: 'opus[1m]' });
    expect(out.agentSessions.codex).toEqual({ sessionId: 't', model: 'gpt' });
    expect(rec.model).toBe('claude-fable-5');
    expect(withCoordinatorModel({ workdir: '/w' })).toEqual({ workdir: '/w', model: 'opus[1m]', modelExplicit: false });
  });
});
```

Append to `test/coordinator-wiring.test.js`:

```js
describe('live coordinator events (source inspection)', () => {
  it('the router seam is wired to journalOnCoordinator with a catch', () => {
    expect(index).toMatch(/onCoordinatorEvent: \(convoId, ev\) => \{\s*journalOnCoordinator\(convoId, ev\)\.catch\(/);
  });

  it('journalOnCoordinator applies the event, re-reads the journal, then decides', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    const applyAt = fn.indexOf('coordinatorLookup.apply(convoId, role);');
    const refreshAt = fn.indexOf('await coordinatorLookup.refresh({ force: true });');
    const decideAt = fn.indexOf('decideCoordinatorEvent({');
    expect(applyAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(applyAt);
    expect(decideAt).toBeGreaterThan(refreshAt);
  });

  it('respawns idle sessions via recreateSession, switches a busy one via applyModelSwitch explicit:false, then delivers the turn', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain('planCoordinatorTransition({');
    expect(fn).toContain("recreateSession(roomId, plan.model ? { model: plan.model } : {}, ctx)");
    expect(fn).toContain('{ model: plan.model, modelExplicit: false }');
    expect(fn).toContain('applyModelSwitch(roomId, session, plan.model, { ...ctx, explicit: false });');
    expect(fn).toContain('await deliverCoordinatorTurn(sessions.get(roomId) || session, coordinatorTurnText(role, COORDINATOR_BLOCK));');
  });

  it('a busy session gets the turn queued, an idle one injected, neither mirrored to the journal', () => {
    const fn = body('async function deliverCoordinatorTurn(', '\nfunction ');
    expect(fn).toContain('sessionOccupiedForRoomDelivery(session)');
    expect(fn).toContain('mirrorToJournal: false');
    expect(fn).toContain('sendTextToSession(session, text, { skipJournalMirror: true })');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coordinator.test.js test/coordinator-wiring.test.js`
Expected: FAIL on the new describes.

- [ ] **Step 3: Implement**

Append to `lib/coordinator.js`:

```js
// --- Live role changes (spec §2a) ---
//
// `truth` is the answer of the forced GET /coordinator made after the event
// (createCoordinatorLookup.refresh). When it was fetched, it outranks the
// event: a frame replayed after a reconnect may describe a role that has
// moved on since, and a forged frame describes nothing. When the journal
// could not be reached, the event is all there is, and it did arrive on the
// journal's own socket.
export function decideCoordinatorEvent({ role, convoId, truth, live, sessionCoordinator }) {
  if (truth?.fetched && (role === 'assigned') !== (truth.convoId === convoId)) return 'stale';
  if (!live) return role === 'assigned' ? 'persist-sleeping' : 'none';
  if (!!sessionCoordinator === (role === 'assigned')) return 'none';
  return 'transition';
}

// The persisted-record edit for a Coordinator that is not running: the
// Claude spawn reads the top-level `model`, a resume reads the claude agent
// state's `model` (lib/agent-handoff.js getPersistedAgentState), so both are
// set. modelExplicit:false keeps the legacy alias rule in isModelExplicit
// from mistaking this write for a user pick.
export function withCoordinatorModel(record, model = COORDINATOR_MODEL) {
  const next = { ...record, model, modelExplicit: false };
  if (record?.agentSessions?.claude) {
    next.agentSessions = { ...record.agentSessions, claude: { ...record.agentSessions.claude, model } };
  }
  return next;
}
```

In `index.js`, extend the coordinator import to also bring in `coordinatorTurnText, planCoordinatorTransition, decideCoordinatorEvent, withCoordinatorModel`. Then add, right after `journalOnItem` (~line 8412):

```js
// A journal `coordinator` event (spec 2026-09-23 §2a/§2e; router seam
// onCoordinatorEvent). The event is applied to the cache at once, then the
// journal is re-read and only a role it confirms is acted on
// (decideCoordinatorEvent). For a running session: an idle one is respawned
// through recreateSession — the /model and /restart path — so the block and
// the no-edit tools apply now, moving onto opus[1m] on the way when nobody
// picked a model; a busy one gets the model switch through applyModelSwitch
// (parked until the turn ends) and the role at its next spawn. Either way it
// is then told, as an injected turn. A Coordinator that is not running only
// has its persisted model updated; its next resume reads the role from the
// cache.
async function journalOnCoordinator(convoId, { role }) {
  coordinatorLookup.apply(convoId, role);
  const truth = await coordinatorLookup.refresh({ force: true });
  const session = findSessionByClaudeSessionId(convoId);
  const live = !!(session && session.alive);
  const verdict = decideCoordinatorEvent({ role, convoId, truth, live, sessionCoordinator: !!session?.coordinator });
  if (verdict === 'stale') {
    console.warn(`[coordinator] ignoring ${role} for ${convoId}: the journal says the Coordinator is ${truth.convoId ?? 'nobody'}`);
    return;
  }
  if (verdict === 'persist-sleeping') {
    persistCoordinatorModelForSleepingConvo(convoId);
    return;
  }
  if (verdict !== 'transition') return;
  const roomId = session.roomId;
  const ctx = journalSessionCommandCtx(session);
  const plan = planCoordinatorTransition({
    role,
    agent: session.agent,
    occupied: sessionOccupiedForRoomDelivery(session),
    persisted: getPersistedSession(roomId),
  });
  if (plan.action === 'respawn') {
    ctx.sendReply(role === 'assigned'
      ? '🧭 This chat is now the Coordinator — restarting the session to apply it (history preserved).'
      : '🧭 This chat is no longer the Coordinator — restarting the session to lift its restrictions (history preserved).');
    const next = recreateSession(roomId, plan.model ? { model: plan.model } : {}, ctx);
    if (next && plan.model) {
      // Same tail as applyModelSwitch: the replacement's live snapshot cannot
      // know the new model until its first event, so say it, then persist.
      next.currentModel = plan.model;
      persistSession(roomId, next.claudeSessionId, next.workdir, next.originRoomId, { model: plan.model, modelExplicit: false });
    }
  } else if (plan.action === 'switch-model-live') {
    applyModelSwitch(roomId, session, plan.model, { ...ctx, explicit: false });
  }
  await deliverCoordinatorTurn(sessions.get(roomId) || session, coordinatorTurnText(role, COORDINATOR_BLOCK));
}

// The injected assigned/released turn. Same inject-or-queue rule as a
// tracker reply (lib/items-turn.js): a busy session queues it behind the
// running turn instead of losing it. Never mirrored — the journal already
// shows the `coordinator` marker the apps render.
async function deliverCoordinatorTurn(session, text) {
  if (!text || !session?.alive) return;
  if (sessionOccupiedForRoomDelivery(session)) {
    await journalQueueMedia(session, {
      blocks: [{ type: 'text', text }],
      mirrorToJournal: false,
      preview: text.split('\n')[0],
      fullText: text,
    });
    return;
  }
  if (!sendTextToSession(session, text, { skipJournalMirror: true })) {
    console.warn(`[coordinator] could not deliver the coordinator turn to ${session.roomId}`);
  }
}

// A Coordinator assigned while its session is not running: move the
// persisted model onto opus[1m] unless someone picked one (spec §2e). Same
// record lookup as journalResumeConvo. Codex rooms keep their model.
function persistCoordinatorModelForSleepingConvo(convoId) {
  const data = loadPersistedSessions();
  for (const [roomId, rec] of Object.entries(data)) {
    if (!rec || (rec.journalConvoId !== convoId && rec.sessionId !== convoId)) continue;
    const plan = planCoordinatorTransition({
      role: 'assigned',
      agent: normalizeAgent(rec.agent) || AGENT_CLAUDE,
      occupied: false,
      persisted: rec,
    });
    if (!plan.model) return;
    data[roomId] = withCoordinatorModel(rec, plan.model);
    savePersistedSessions(data);
    return;
  }
}
```

In the `createJournalInputConsumer({` config, directly after `routeItemToSession: journalOnItem,` add:

```js
  // Coordinator role changes (spec 2026-09-23 §2a): never a turn by
  // themselves; journalOnCoordinator re-reads the journal and decides.
  onCoordinatorEvent: (convoId, ev) => {
    journalOnCoordinator(convoId, ev).catch((e) => {
      try { console.warn(`[coordinator] handling ${ev?.role} for ${convoId} failed: ${e?.message ?? e}`); } catch { /* logging must never throw */ }
    });
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coordinator.test.js test/coordinator-wiring.test.js test/journal-input-router.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/coordinator.js index.js test/coordinator.test.js test/coordinator-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "coordinator: live assign/release — respawn, opus[1m] default, injected turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `mission_create` (unassigned missions)

**Files:**
- Modify: `lib/missions-client.js`, `lib/missions-tools.js`, `lib/missions-format.js`, `ask-user.js` (import line 11; `callMissions` ~742; `missionToolName` ~758; new tool after `mission_start` ~770), `index.js` (missions route matcher ~10451)
- Test: `test/missions-client.test.js`, `test/missions-tools.test.js`, `test/missions-format.test.js`, `test/missions-wiring.test.js`

**Interfaces:**
- Consumes: journal mission create with `attach: false` (the existing `POST /missions` route — see note in Step 3).
- Produces: `client.create(body, { idemKey }) -> {status, data}`; handler `create({ roomId, title, body?, idem_key? }) -> {status, body}` (never sets `session.missionId`); `formatCreateAck(data) -> string`; bridge route `POST /missions/create`; MCP tool `mission_create`.

- [ ] **Step 1: Write the failing tests**

`test/missions-client.test.js` — append inside `describe('createMissionsClient', …)`:

```js
  it('create posts to the mission create route with attach:false in the body and the idempotency key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { mission: { id: 'ms_2', num: 62 } } }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.create({ title: 'M', convo_id: 'c1', attach: false }, { idemKey: 'k2' });
    expect(r.status).toBe(201);
    expect(calls[0].url).toBe('https://j/missions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k2');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'M', convo_id: 'c1', attach: false });
  });
```

`test/missions-tools.test.js` — add `create: vi.fn(async () => ({ status: 201, data: { mission: { ...mission, id: 'ms_2', num: 62, origin_convo_id: 'c1' } } })),` to the `client` object in `fixture`, then append:

```js
  it('create: attach:false, convo_id for provenance, idem key; does NOT join (no missionId cached)', async () => {
    const { h, client, session } = fixture();
    expect((await h.create({ roomId: '!r:s', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.create({ roomId: '!r:s', title: ' Fix login ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0]).toEqual([{ title: 'Fix login', body: 'goal', convo_id: 'c1', attach: false }, { idemKey: 'k' }]);
    expect(client.start).not.toHaveBeenCalled();
    expect(session.missionId).toBeUndefined();
  });

  it('create: a journal that ignored attach:false (existing:true) is an error, never "created"', async () => {
    const { h, session } = fixture({ create: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 }, existing: true } })) });
    const r = await h.create({ roomId: '!r:s', title: 'X' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/does not support unassigned missions/);
    expect(session.missionId).toBeUndefined();
  });

  it('create: unreachable → 502; 404 on the convo → the convo sentence', async () => {
    const down = fixture({ create: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.create({ roomId: '!r:s', title: 'X' })).status).toBe(502);
    const noConvo = fixture({ create: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await noConvo.h.create({ roomId: '!r:s', title: 'X' })).body.error).toMatch(/did not accept this conversation/);
  });
```

`test/missions-format.test.js` — add `formatCreateAck` to the import and append inside the describe:

```js
  it('create ack uses the contract wording', () => {
    expect(formatCreateAck({ mission })).toBe('Mission #61 "Missions" created (unassigned)');
    expect(formatCreateAck({})).toBe('Mission created (unassigned).');
  });
```

`test/missions-wiring.test.js` — change `const OPS = ['start', 'post', 'update', 'join', 'get', 'close'];` to `const OPS = ['start', 'create', 'post', 'update', 'join', 'get', 'close'];`, add `mission_create: "callMissions('create', args, formatCreateAck)",` to `TOOL_CALLS`, rename the two `it` titles that say "six" to "seven", and append:

```js
  it('mission_create sends an idem_key and renders through formatCreateAck', () => {
    const start = askUser.indexOf('async function callMissions');
    const fn = askUser.slice(start, askUser.indexOf('const missionToolName'));
    expect(fn).toMatch(/name === 'start' \|\| name === 'post' \|\| name === 'create'/);
    expect(askUser).toMatch(/import \{[^}]*\bformatCreateAck\b[^}]*\} from '\.\/lib\/missions-format\.js'/);
    expect(askUser).toContain("create: 'mission_create'");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/missions-client.test.js test/missions-tools.test.js test/missions-format.test.js test/missions-wiring.test.js`
Expected: FAIL (`c.create is not a function`, `h.create is not a function`, missing export, matcher mismatch).

- [ ] **Step 3: Implement**

`lib/missions-client.js` — above `return {`, add:

```js
  // mission_create goes to the journal's create route, POST /missions
  // (src/missions-http.js handleCreate), with attach:false in the body. The
  // journal also mounts /missions/create as an alias; the canonical route is
  // used so the bridge works against the same path start() already uses.
  const MISSIONS_CREATE_PATH = '/missions';
```

and add to the returned object, after `start`:

```js
    create: (body, { idemKey = null } = {}) => request('POST', MISSIONS_CREATE_PATH, { body, idemKey }),
```

`lib/missions-tools.js` — add near the other constants:

```js
// attach:false never answers existing:true (the contract: the "convo
// already has a mission" short-circuit does not apply). A journal that does
// is one that ignored attach and handed back THIS conversation's mission.
const NO_ATTACH_FALSE = 'this journal does not support unassigned missions yet (it ignored attach:false and returned this conversation\'s own mission) — deploy the journal Coordinator update; no mission was created';
```

and add to the returned handler object, after `start`:

```js
    // mission_create (spec 2026-09-23 §2d): a mission for work handed to
    // someone else. convo_id is provenance only (origin_convo_id); with
    // attach:false this conversation is not joined, so the mission is NOT
    // remembered as the session's own — that is what mission_start is for.
    async create(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { title: t, convo_id: convoId, attach: false };
      if (b.value !== undefined) body.body = b.value;
      const r = passthroughConvo(await client.create(body, idem(data)));
      if (r.status === 200 && r.body?.existing === true) return { status: 502, body: { error: NO_ATTACH_FALSE } };
      return r;
    },
```

(The key order in `body` — `title`, `convo_id`, `attach`, then `body` — is what the `toEqual` in the test compares; `toEqual` ignores key order anyway.)

`lib/missions-format.js` — after `formatStartAck`:

```js
export function formatCreateAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission created (unassigned).';
  return `Mission #${m.num ?? '?'} "${str(m.title)}" created (unassigned)`;
}
```

`ask-user.js`:
- line 11 import: add `formatCreateAck` to the `./lib/missions-format.js` import list.
- in `callMissions`: `if (name === 'start' || name === 'post') {` → `if (name === 'start' || name === 'post' || name === 'create') {`.
- `missionToolName`: add `create: 'mission_create', ` to the map (after `start: 'mission_start', `).
- after the `mission_start` tool registration:

```js
server.tool(
  'mission_create',
  "Create a mission WITHOUT joining this conversation to it (an unassigned mission) — for work you are handing to another agent. Assign it by starting a session with agent_session_start and mission: N, or by asking a running agent (agent_chat_start) to mission_join N. mission_start is the one that creates AND joins, for your own work. Returns the mission number.",
  {
    title: z.string().describe('One line, ≤200 chars — what the work is'),
    body: z.string().optional().describe('Markdown ≤32 KiB — the goal: what done looks like, constraints, links'),
  },
  async (args) => callMissions('create', args, formatCreateAck),
);
```

`index.js` — the missions route matcher: `url.pathname.match(/^\/missions\/(start|post|update|join|get|close)$/)` → `url.pathname.match(/^\/missions\/(start|create|post|update|join|get|close)$/)`, and update the comment above it from "six" to "seven" (`mission_create` added).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/missions-client.test.js test/missions-tools.test.js test/missions-format.test.js test/missions-wiring.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/missions-client.js lib/missions-tools.js lib/missions-format.js ask-user.js index.js test/missions-client.test.js test/missions-tools.test.js test/missions-format.test.js test/missions-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "missions: mission_create — unassigned missions (attach:false)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `agent_session_start` joins a mission

**Files:**
- Modify: `lib/agent-spawn.js` (`sessionStart`, ~200–290), `ask-user.js` (`agent_session_start`, ~359–390)
- Test: `test/agent-spawn.test.js` (append inside `describe('sessionStart', …)`), `test/coordinator-wiring.test.js` (append)

**Interfaces:**
- Consumes: journal `spawn_request` accepting `mission_num`; `op_error` codes `no_mission`, `mission_closed`.
- Produces: `sessionStart` accepts `mission` (positive integer), sends `mission_num`, echoes `mission_num` in its 200 body; MCP param `mission`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('sessionStart', …)` in `test/agent-spawn.test.js`:

```js
    it('mission: sent as mission_num, echoed back; absent when not given', async () => {
      const { handlers, sent } = mk();
      const p = handlers.sessionStart({ ...good, mission: 64 });
      expect(sent[0].mission_num).toBe(64);
      expect('mission' in sent[0]).toBe(false);
      handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: sent[0].request_id, spawn_id: 'row-1' });
      expect(await p).toEqual({ status: 200, body: { status: 'pending', spawn_id: 'row-1', mission_num: 64 } });
      const p2 = handlers.sessionStart(good);
      expect('mission_num' in sent[1]).toBe(false);
      handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: sent[1].request_id, spawn_id: 'row-2' });
      await p2;
    });

    it('mission must be a positive integer; nothing is sent otherwise', async () => {
      const { handlers, sent } = mk();
      for (const mission of [0, -1, 1.5, '64', true]) {
        const r = await handlers.sessionStart({ ...good, mission });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/mission must be a positive integer/);
      }
      expect(sent).toHaveLength(0);
      const nullOk = handlers.sessionStart({ ...good, mission: null });
      expect('mission_num' in sent[0]).toBe(false);
      handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: sent[0].request_id, spawn_id: 'r' });
      await nullOk;
    });

    it('journal refusals no_mission / mission_closed become sentences the agent can act on', async () => {
      const a = mk();
      const p1 = a.handlers.sessionStart({ ...good, mission: 99 });
      a.handlers.onOpError({ code: 'no_mission', ref: a.sent[0].request_id, detail: 'x' });
      const r1 = await p1;
      expect(r1.status).toBe(404);
      expect(r1.body.error).toMatch(/no mission #99/);
      expect(r1.body.error).toMatch(/nothing was sent to the user/);
      const b = mk();
      const p2 = b.handlers.sessionStart({ ...good, mission: 61 });
      b.handlers.onOpError({ code: 'mission_closed', ref: b.sent[0].request_id, detail: 'x' });
      const r2 = await p2;
      expect(r2.status).toBe(409);
      expect(r2.body.error).toMatch(/mission #61 is closed/);
      expect(r2.body.error).toMatch(/mission_create/);
    });
```

Append to `test/coordinator-wiring.test.js`:

```js
describe('agent_session_start mission (source inspection)', () => {
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const tool = askUser.slice(askUser.indexOf("'agent_session_start',"), askUser.indexOf("'restart_session',"));
  it('exposes an optional positive-integer mission and forwards it', () => {
    expect(tool).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(tool).toContain('async ({ device_id, workdir, task, topic, model, link, mission }) => {');
    expect(tool).toContain('...(mission ? { mission } : {})');
  });
  it('the ack says the new session joins the mission', () => {
    expect(tool).toContain('` The new session joins mission #${mission} from its first turn.`');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/agent-spawn.test.js test/coordinator-wiring.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`lib/agent-spawn.js`, in `sessionStart`:
- destructure: `const { device_id: deviceId, workdir, task, topic, model, link, mission } = data || {};`
- after the `link` validation block add:

```js
      // Optional mission the spawned session joins before its first turn
      // (spec 2026-09-23 §1c/§2d). The journal validates it against the
      // user's missions and refuses a missing or closed one; this only
      // refuses shapes that could never be a mission number.
      const hasMission = mission !== undefined && mission !== null;
      if (hasMission && (!Number.isInteger(mission) || mission < 1)) {
        return { status: 400, body: { error: 'mission must be a positive integer (a mission number from mission_create or mission_get)' } };
      }
```

- in the `frame` literal, after the `link` spread: `...(hasMission ? { mission_num: mission } : {}),`
- in the `op_error` branch, before the final `return { status: 502, … }`:

```js
        if (r.code === 'no_mission') return { status: 404, body: { error: `there is no mission #${mission} (or it isn't visible to you) — check the number with mission_get; nothing was sent to the user` } };
        if (r.code === 'mission_closed') return { status: 409, body: { error: `mission #${mission} is closed — create a new one with mission_create, or start the session without mission; nothing was sent to the user` } };
```

- in the pending 200 body, after `status: 'pending', spawn_id: r.spawnId,` add `...(hasMission ? { mission_num: mission } : {}),`.

`ask-user.js`, `agent_session_start`:
- append to the description string, before its closing quote: ` Pass mission: N to put the new session on mission #N from its first turn (the consent card says so) — the way to assign a mission made with mission_create.`
- schema, after `link`: `mission: z.number().int().min(1).optional().describe('Mission number the new session joins before its first turn — e.g. one you made with mission_create. The consent card shows it.'),`
- handler signature: `async ({ device_id, workdir, task, topic, model, link, mission }) => {`
- body JSON: add `...(mission ? { mission } : {})` after the `link` spread.
- the success text: replace

```js
      return { content: [{ type: 'text', text: `Spawn request ${data.spawn_id} sent — awaiting the user's approval.${waking} Continue your own work; the outcome will arrive as a later turn.` }] };
```

with

```js
      const joins = mission ? ` The new session joins mission #${mission} from its first turn.` : '';
      return { content: [{ type: 'text', text: `Spawn request ${data.spawn_id} sent — awaiting the user's approval.${joins}${waking} Continue your own work; the outcome will arrive as a later turn.` }] };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/agent-spawn.test.js test/coordinator-wiring.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-spawn.js ask-user.js test/agent-spawn.test.js test/coordinator-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "agent_session_start: optional mission, sent as mission_num

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: A spawned session joins its mission before its opening turn

**Files:**
- Modify: `lib/journal-rpc.js` — deps of `createRpcRequestHandler` (~30–80); `start` (~186–300); `handleRpcRequest` (~303–320); `composeSpawnOpeningTurn` (~327–350)
- Modify: `index.js` — the `createRpcRequestHandler({` config (~986–1039)
- Test: `test/journal-rpc-handlers.test.js` (append inside `describe('spawn (room_id + prompt)', …)` and a new describe), `test/coordinator-wiring.test.js` (append)

**Interfaces:**
- Consumes: `missionsHandlers.join({ roomId, num }) -> Promise<{ status, body }>` (existing, `lib/missions-tools.js`; caches `session.missionId` on success).
- Produces: `createRpcRequestHandler` deps `joinMission?: (session, num) => Promise<{status, body}>`, `joinRetryDelayMs = 300`, `sleep?: (ms) => Promise<void>`; `start` accepts `params.mission_num` (positive integer, else `bad_request` / `bad mission_num`); `composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel, missionNum? })`.

The journal's own `joinMission` runs only after it receives the `start` reply, while the opening turn is written before that reply — so without this task the child's first turn can run with no mission. Order when `mission_num` is present: spawn → join (up to 3 attempts, 300 ms apart, retrying only "convo not there yet / journal unreachable" answers — the new conversation's row reaches the journal over the WebSocket and can trail the HTTP join) → bind room / inject opening turn → reply. A join that still fails is logged and the session starts anyway.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('spawn (room_id + prompt)', …)` in `test/journal-rpc-handlers.test.js`:

```js
    it('mission_num: joins the mission BEFORE the opening turn, names it in the turn, then replies', async () => {
      const joins = [];
      const { handler, responses, session, sequence, injected } = spawnHarness({
        joinMission: async (s, num) => { sequence.push('join'); joins.push([s, num]); return { status: 200, body: { mission: { num } } }; },
      });
      handler(REQ('start', { prompt: 'do the thing', mission_num: 64 }));
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(sequence).toEqual(['join', 'inject']);
      expect(joins).toEqual([[session, 64]]);
      expect(injected[0][1]).toContain('You are on mission #64 — run mission_get');
      expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: true, result: { convo_id: 'convo-9' } });
    });

    it('mission_num: retries while the convo is not on the journal yet, then succeeds', async () => {
      const answers = [{ status: 404, body: { error: 'not found' } }, { status: 409, body: { error: 'journal conversation not established yet' } }, { status: 200, body: {} }];
      const joinMission = vi.fn(async () => answers.shift());
      const { handler, responses, sequence } = spawnHarness({ joinMission, joinRetryDelayMs: 0 });
      handler(REQ('start', { prompt: 'do the thing', mission_num: 64 }));
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(joinMission).toHaveBeenCalledTimes(3);
      expect(sequence).toEqual(['inject']);
      expect(responses[0].ok).toBe(true);
    });

    it('mission_num: a join that keeps failing is logged and the session still starts (the journal joins after the reply)', async () => {
      const warns = [];
      const joinMission = vi.fn(async () => { throw new Error('ECONNRESET'); });
      const { handler, responses, stopped, injected } = spawnHarness({ joinMission, joinRetryDelayMs: 0, log: { warn: (m) => warns.push(m), error: () => {} } });
      handler(REQ('start', { prompt: 'do the thing', mission_num: 64 }));
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(joinMission).toHaveBeenCalledTimes(3);
      expect(stopped).toHaveLength(0);
      expect(injected[0][1]).toContain('You are on mission #64');
      expect(responses[0].ok).toBe(true);
      expect(warns.some((w) => /could not join mission #64 before the opening turn/.test(w))).toBe(true);
    });

    it('mission_num: a closed mission (409 blocked_by) is not retried', async () => {
      const joinMission = vi.fn(async () => ({ status: 409, body: { error: 'conflict', blocked_by: 'closed' } }));
      const { handler, responses } = spawnHarness({ joinMission, joinRetryDelayMs: 0 });
      handler(REQ('start', { prompt: 'do the thing', mission_num: 61 }));
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(joinMission).toHaveBeenCalledTimes(1);
      expect(responses[0].ok).toBe(true);
    });

    it('mission_num must be a positive integer; nothing is spawned otherwise', () => {
      let started = 0;
      const { handler, responses } = spawnHarness({ startSession: () => { started += 1; return { journalConvoId: 'c' }; } });
      handler(REQ('start', { prompt: 'x', mission_num: '64' }));
      handler(REQ('start', { prompt: 'x', mission_num: 0 }, 'r2'));
      expect(started).toBe(0);
      expect(responses.map((r) => r.error)).toEqual([
        { code: 'bad_request', detail: 'bad mission_num' },
        { code: 'bad_request', detail: 'bad mission_num' },
      ]);
    });

    it('no mission_num: the start stays synchronous and never calls joinMission', () => {
      const joinMission = vi.fn();
      const { handler, responses } = spawnHarness({ joinMission });
      handler(REQ('start', { prompt: 'do the thing' }));
      expect(responses).toHaveLength(1);
      expect(joinMission).not.toHaveBeenCalled();
    });
```

(`vi` must be imported: change the first line of the file to `import { describe, it, expect, vi } from 'vitest';`.)

Append a new describe at the end of the file:

```js
describe('composeSpawnOpeningTurn mission line', () => {
  it('names the mission only when one is given', () => {
    const withMission = composeSpawnOpeningTurn({ task: 't', roomId: null, fromName: 'a', serverLabel: 'b', missionNum: 64 });
    expect(withMission).toMatch(/\n\nYou are on mission #64 — run mission_get to read its goal, milestones and open items/);
    expect(withMission).toMatch(/Do not call mission_start/);
    const without = composeSpawnOpeningTurn({ task: 't', roomId: null, fromName: 'a', serverLabel: 'b' });
    expect(without).not.toMatch(/mission/);
  });
});
```

Append to `test/coordinator-wiring.test.js`:

```js
describe('spawn mission join (source inspection)', () => {
  it('index wires the RPC start join to the existing missions join handler', () => {
    const cfg = body('const journalRpcHandler = createRpcRequestHandler({', '\n});');
    expect(cfg).toContain('joinMission: (session, num) => missionsHandlers.join({ roomId: session.roomId, num }),');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/journal-rpc-handlers.test.js test/coordinator-wiring.test.js`
Expected: FAIL (no join; no mission line; `mission_num: '64'` currently spawns).

- [ ] **Step 3: Implement**

`lib/journal-rpc.js`:

3a. Deps — after `serverLabel = '',` add:

```js
  // Spawn onto a mission (spec 2026-09-23 §1c). The journal joins the new
  // conversation to params.mission_num only after it gets this handler's
  // reply, but the opening turn is written BEFORE the reply — so the bridge
  // joins first, through the same missions join path as the mission_join
  // tool: async (session, num) -> {status, body}. Unwired: no pre-join, the
  // journal's join still follows.
  joinMission = null,
  joinRetryDelayMs = 300,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === 'function') t.unref(); }),
```

3b. Just above `const handlers = {`, add:

```js
  // Up to JOIN_ATTEMPTS tries. Retries only answers that mean "not yet":
  // the new conversation's row reaches the journal over the WebSocket and
  // can trail this HTTP call (404, or the handler's own 409 before a convo
  // id exists), or the journal is momentarily unreachable (0 / 502). A 409
  // with blocked_by (closed, other_mission) is final. Never throws; false
  // means the session starts unjoined and the journal's join follows.
  const JOIN_ATTEMPTS = 3;
  async function joinSpawnMission(session, num) {
    let last = null;
    for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
      try { last = await joinMission(session, num); } catch (e) { last = { status: 0, body: { error: e?.message ?? String(e) } }; }
      if (last?.status === 200) return true;
      const retryable = last?.status === 0 || last?.status === 404 || last?.status === 502
        || (last?.status === 409 && !last?.body?.blocked_by);
      if (!retryable) break;
      if (attempt < JOIN_ATTEMPTS) await sleep(joinRetryDelayMs);
    }
    log.warn?.(`[journal-rpc] start: could not join mission #${num} before the opening turn (${last?.status ?? '?'} ${last?.body?.blocked_by || last?.body?.error || ''}) — starting anyway; the journal joins it after the reply`);
    return false;
  }
```

3c. In `start`, directly after the `if (prompt && prompt.length > SPAWN_PROMPT_MAX_CHARS) …` line, add:

```js
      // Optional mission for this spawn (journal spawn relay only). Refused
      // like any other malformed param rather than silently dropped: a
      // spawn the user approved "onto mission #N" must not start off it.
      const hasMissionNum = params.mission_num !== undefined && params.mission_num !== null;
      if (hasMissionNum && (!Number.isInteger(params.mission_num) || params.mission_num < 1)) {
        return respond(request, false, { code: 'bad_request', detail: 'bad mission_num' });
      }
      const missionNum = hasMissionNum ? params.mission_num : null;
```

3d. In `start`, replace everything from `if (prompt) {` (the bind-then-inject block after the `unsupported_mode` convo-id guard) through `respond(request, true, { convo_id: convoId });` with:

```js
      // Bind/inject and the reply, run either now or after the mission join.
      const finish = () => {
        if (prompt) {
          // Room-first ordering is the journal's; ours is bind-then-inject so
          // the room routes before the child can possibly answer into it. Any
          // failure tears the whole session down: an orphaned agent on another
          // box with no channel back is the worst outcome available
          // (2026-08-09 spec, "matron-bridge changes"). A detached spawn has
          // no room to bind — it is just the opening turn.
          if (!injectTurn || (roomId && (!bindSpawnRoom || !unbindSpawnRoom))) {
            try { stopSession(session); } catch { /* best-effort teardown */ }
            return respond(request, false, { code: 'unsupported_mode', detail: roomId ? 'spawn-room wiring absent' : 'spawn wiring absent' });
          }
          try {
            if (roomId) bindSpawnRoom(roomId, session);
            const opening = composeSpawnOpeningTurn({ task: prompt, roomId, fromName, serverLabel, missionNum });
            if (!injectTurn(session, opening)) throw new Error('opening turn refused');
          } catch (e) {
            if (roomId) { try { unbindSpawnRoom(roomId); } catch { /* idempotent remove */ } }
            try { stopSession(session); } catch { /* best-effort teardown */ }
            return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
          }
        }
        return respond(request, true, { convo_id: convoId });
      };
      // With a mission: join first (spec 2026-09-23 §1c), so the child's
      // first turn already runs on it. Everything else stays synchronous.
      if (missionNum && typeof joinMission === 'function') {
        return joinSpawnMission(session, missionNum).then(finish);
      }
      return finish();
```

3e. `handleRpcRequest`: replace `handler(request);` with:

```js
      const out = handler(request);
      // `start` goes async when it joins a mission first. A rejection there
      // must still produce the one reply every request is owed.
      if (out && typeof out.then === 'function') {
        out.catch((e) => {
          const detail = e?.message ?? String(e);
          log.warn?.(`[journal-rpc] ${request.method} handler rejected: ${detail}`);
          respond(request, false, { code: 'internal', detail });
        });
      }
```

3f. `composeSpawnOpeningTurn`: change the signature to `export function composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel, missionNum = null }) {`, add above the `return [`:

```js
  // The journal-approved mission this spawn is on (already joined by the
  // time this turn is delivered, or joined right after — see start()). Named
  // so the child reads the goal instead of starting a mission of its own.
  const missionLines = Number.isInteger(missionNum) && missionNum > 0
    ? ['', `You are on mission #${missionNum} — run mission_get to read its goal, milestones and open items, and post your milestones there as you work. Do not call mission_start.`]
    : [];
```

and change the final `channel,\n  ].join('\n');` to `channel,\n    ...missionLines,\n  ].join('\n');`.

`index.js`, in the `createRpcRequestHandler({` config after `injectTurn: …,`:

```js
  // Spawn onto a mission: join the new conversation before its opening turn
  // (lib/journal-rpc.js start). Late-bound — missionsHandlers is constructed
  // further down; this only runs once the socket is live.
  joinMission: (session, num) => missionsHandlers.join({ roomId: session.roomId, num }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/journal-rpc-handlers.test.js test/journal-rpc-dispatch.test.js test/rpc-start-agent-wiring.test.js test/coordinator-wiring.test.js && npm run lint`
Expected: PASS (the existing synchronous start tests are untouched: without `mission_num` nothing awaits).

- [ ] **Step 5: Commit**

```bash
git add lib/journal-rpc.js index.js test/journal-rpc-handlers.test.js test/coordinator-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "rpc start: join mission_num before the opening turn and name it there

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Tell ordinary sessions about `mission_create` and `mission`

**Files:**
- Modify: `BRIDGE_CLAUDE.md` ("Missions & milestones" first bullet; "Agent-to-agent chat" last bullet), `BRIDGE_CODEX.md` (line 32 paragraph; missions HTTP list ~81–84)
- Test: `test/missions-wiring.test.js` (update the inheritance pin; append)

**Interfaces:**
- Consumes: tool names from Tasks 7–8.
- Produces: prompt text only.

- [ ] **Step 1: Update the pins (failing)**

In `test/missions-wiring.test.js`, replace the pinned sentence

```js
    expect(claudeMd).toContain("Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not — put the mission number in its task and have it `mission_join #N`.");
```

with

```js
    expect(claudeMd).toContain("Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not, unless you pass `mission: N` — then it is on mission #N from its first turn.");
```

and append a new `it`:

```js
  it('both prompt files teach mission_create and the agent_session_start mission param', () => {
    expect(claudeMd).toMatch(/`mission_create` creates a mission without joining this conversation to it/);
    expect(claudeMd).toMatch(/`agent_session_start` .*`mission: N`/);
    expect(codexMd).toMatch(/`mission_create`/);
    expect(codexMd).toMatch(/`mission: N`/);
    expect(codexMd).toMatch(/"attach":false/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/missions-wiring.test.js`
Expected: FAIL.

- [ ] **Step 3: Edit the prompt files**

`BRIDGE_CLAUDE.md`, "Missions & milestones", first bullet: replace its last sentence

> Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not — put the mission number in its task and have it `mission_join #N`.

with

> Sub-chats and subagents inherit this conversation's mission automatically; a session you start on another box with `agent_session_start` does not, unless you pass `mission: N` — then it is on mission #N from its first turn.

and add a new bullet directly after that first bullet:

> - `mission_create` creates a mission without joining this conversation to it (an unassigned mission) — for work you are handing to someone else. Assign it with `agent_session_start` and `mission: N`, or ask a running agent to `mission_join N`. Use `mission_start` for your own work.

In "Agent-to-agent chat", last bullet, after the sentence ending "…`agent_session_start` asks the user's consent to seed a task on one of them — the outcome, like everything else here, arrives as a later turn." insert: ` Pass \`mission: N\` to put the new session on that mission from its first turn.`

`BRIDGE_CODEX.md`, line 32 paragraph: after "`agent_session_start` requests user consent to seed a task elsewhere;" insert ` pass \`mission: N\` to put the new session on mission #N from its first turn (\`mission_create\` makes a mission without joining you to it, for exactly this);`.

`BRIDGE_CODEX.md` missions list: after the `- \`POST $BASE/missions\` …` line, add:

```markdown
- Same route with `"attach":false` — `{"title":"...","body":"goal","convo_id":"<id>","attach":false}` → 201 mission created WITHOUT joining this conversation (unassigned; the `mission_create` tool). Give it to another session with `agent_session_start` and `mission: N`.
```

and in the `…/join` line replace "a session you start on another box with `agent_session_start` does not — put the mission number in its task and have it join that mission by number." with "a session you start on another box with `agent_session_start` does not, unless you pass `mission: N`."

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/missions-wiring.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add BRIDGE_CLAUDE.md BRIDGE_CODEX.md test/missions-wiring.test.js
git -c user.email=dan@yearbookmachine.com -c user.name="Dan Barker" commit -m "prompts: mission_create and agent_session_start mission for every session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification

**Files:** none new.

- [ ] **Step 1: Run the whole CI script**

Run: `npm run ci 2>&1 | tail -40`
Expected: lint clean, check clean, vitest summary `Test Files  N passed (N)` with **no** failed files, audit clean. Read the vitest summary line itself — do not trust a piped exit code.

- [ ] **Step 2: Smoke the spawn args by hand (no journal needed)**

Run:
```bash
node -e "
import('./lib/coordinator.js').then(({ claudeCoordinatorArgs, loadCoordinatorBlock }) => {
  const fs = require('fs');
  const block = loadCoordinatorBlock({ readFile: (p) => fs.readFileSync(p, 'utf8'), path: './BRIDGE_COORDINATOR.md' });
  const a = claudeCoordinatorArgs({ coordinator: true, basePrompt: 'BASE', block, baseDisallowed: ['AskUserQuestion'] });
  console.log(a.disallowedTools.join(' '));
  console.log(a.appendSystemPrompt.slice(0, 60));
});"
```
Expected: `AskUserQuestion Edit Write NotebookEdit` then `BASE` followed by `# You are this user's Coordinator`.

- [ ] **Step 3: Confirm the CLI accepts the flag set**

Run: `claude --print --disallowed-tools AskUserQuestion Edit Write NotebookEdit --append-system-prompt x --help >/dev/null && echo ok`
Expected: `ok` (the installed CLI parses the variadic flag followed by another option).

- [ ] **Step 4: Commit any fixes** (only if Steps 1–3 required changes), same commit form as above.

---

## Self-Review

**Spec coverage (§2 + Rollout + Testing):**
- §2a lookup at spawn/resume, cached, refreshed on event → Tasks 1, 4, 6. Block appended at both Claude sites + Codex `developerInstructions` → Task 4. Live event → injected turns → Tasks 3, 6.
- §2b block text → Task 2 (`BRIDGE_COORDINATOR.md`).
- §2c `--disallowed-tools Edit Write NotebookEdit`, Codex read-only, Bash kept → Tasks 2, 4.
- §2d `mission_create` → Task 7; `agent_session_start mission` → Task 8; consent card "joins mission #N" → journal-composed (see deviations); tool ack text → Task 8.
- §1c "joined before the first turn" — the journal joins only after the `start` reply, so the target bridge joins first and names the mission in the opening turn → Task 9.
- §2e `opus[1m]` on assign unless explicit, via the `/model` path → Tasks 2, 5, 6. "New coordinator chat" `start` with `opus[1m]`: already accepted by `lib/journal-rpc.js` (`isValidModelArg('opus[1m]')`), persisted explicit by Task 5.
- Rollout "until deployed, behaves as today": an old journal 404s `/coordinator` → nobody (Task 1); `mission_num` is ignored by an old journal (the spawn still happens without it — acceptable, journal deploys first).
- Testing bullets: coordinator-only block/flags (Tasks 2, 4), assign/release turns (Tasks 2, 6), `mission_create` / `mission` payloads (Tasks 7, 8), explicit model kept (Task 2), unreachable journal → ordinary + logged (Tasks 1, 4), released → no block on next spawn (Task 1 `apply` + Task 2 `claudeCoordinatorArgs` — the pair is exactly what `createSession` evaluates).

**Deliberate deviations from the letter of the contract (each flagged in code comments):**
1. "fetches GET /coordinator at every spawn/resume": `createSession` is synchronous with ~13 callers, so a spawn reads the cache and kicks a throttled refresh behind it; the cache is forced fresh at boot, on every hello_ok, and on every `coordinator` event.
2. "POST /missions/create": settled with the journal plan — the canonical route is the existing `POST /missions` plus `attach:false` (`/missions/create` is only an alias there). The bridge posts to `POST /missions`, behind one constant (`MISSIONS_CREATE_PATH`).
3. "consent card text mentions joins mission #N": the card and its tracker item are composed by the journal (`src/consent-items.js` `spawnConsentItemFields`) and the apps from the spawn row; the bridge only sends `mission_num`. The journal plan must add the line.
4. Live assign/release additionally respawns an idle session (spec says "the next spawn/resume picks up the system-prompt form") so the no-edit enforcement is true at once rather than after the idle reap; a busy session keeps the spec's next-spawn behaviour.
5. Explicit model: the persisted state cannot distinguish a pick from a default, so a `modelExplicit` flag is persisted at every pick site, with a legacy rule (persisted alias = picked, full id = observed, `default` = not a pick).
6. `GET /coordinator` null for a Coordinator on another box's private convo (journal privacy filter): harmless — only the owning bridge needs the id and it sees it; null/404/failure all spawn an ordinary session (Task 1).

**Placeholder scan:** none — every code step carries its code; every test step its assertions.

**Type consistency:** `coordinatorLookup.refresh` → `{known, convoId, fetched}` used by `decideCoordinatorEvent({truth})`; `roleFor` → `{known, coordinator}` used by `coordinatorRoleAtSpawn`; `planCoordinatorTransition` actions `'respawn'|'switch-model-live'|'next-spawn'` match `journalOnCoordinator`; `applyModelSwitch(..., { explicit })` matches Tasks 5 and 6; `session.coordinator` set in Task 4, read in Task 6.
