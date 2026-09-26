import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createCoordinatorLookup,
  loadCoordinatorBlock,
  claudeCoordinatorArgs,
  codexCoordinatorOptions,
  coordinatorTurnText,
  explicitModelFlag,
  explicitModelFlagForResume,
  isModelExplicit,
  planCoordinatorTransition,
  decideCoordinatorEvent,
  withCoordinatorModel,
  recreateSpawnModel,
  COORDINATOR_MODEL,
  COORDINATOR_DISALLOWED_TOOLS,
  COORDINATOR_ASSIGNED_PREFIX,
  COORDINATOR_RELEASED_TURN,
  FALLBACK_COORDINATOR_BLOCK,
} from '../lib/coordinator.js';

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
    expect(r.disallowedTools).toEqual(['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
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
  it('explicitModelFlag marks real picks only (not the preselected "default", not empty) — and clears a stale true for either', () => {
    expect(explicitModelFlag('sonnet')).toEqual({ modelExplicit: true });
    expect(explicitModelFlag('claude-opus-4-8')).toEqual({ modelExplicit: true });
    expect(explicitModelFlag('opus[1m]')).toEqual({ modelExplicit: true });
    // Always returns the key (never {}), so a caller spreading this over a
    // persisted record can never leave a previous modelExplicit:true stale —
    // picking "default" is itself a choice to stop being explicit.
    expect(explicitModelFlag('default')).toEqual({ modelExplicit: false });
    expect(explicitModelFlag('')).toEqual({ modelExplicit: false });
    expect(explicitModelFlag(null)).toEqual({ modelExplicit: false });
  });
  it('an explicit /model default after an explicit pick clears the flag (persistSession merges {...existing, ...extra})', () => {
    let persisted = { model: 'sonnet', ...explicitModelFlag('sonnet') };
    expect(isModelExplicit(persisted)).toBe(true);
    // applyModelSwitch's explicit path: persistSession(..., { model: decision.normalized, ...explicitModelFlag(decision.normalized) })
    // merged as { ...existing, ...extra } — the bug this guards was extra
    // omitting the key entirely for "default", leaving the old true in place.
    persisted = { ...persisted, model: 'default', ...explicitModelFlag('default') };
    expect(persisted.modelExplicit).toBe(false);
    expect(isModelExplicit(persisted)).toBe(false);
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

describe('explicitModelFlagForResume', () => {
  it('a typed --model is a fresh pick: same as explicitModelFlag, ignores the persisted record', () => {
    expect(explicitModelFlagForResume('sonnet', { modelExplicit: false })).toEqual({ modelExplicit: true });
    expect(explicitModelFlagForResume('default', { modelExplicit: true })).toEqual({ modelExplicit: false });
  });
  it('no --model: carries the previous record\'s modelExplicit across the new room id', () => {
    expect(explicitModelFlagForResume(undefined, { modelExplicit: true })).toEqual({ modelExplicit: true });
    expect(explicitModelFlagForResume(undefined, { modelExplicit: false })).toEqual({ modelExplicit: false });
  });
  it('no --model and no modelExplicit on the persisted record: omits the key rather than guessing', () => {
    expect(explicitModelFlagForResume(undefined, { model: 'sonnet' })).toEqual({});
    expect(explicitModelFlagForResume(undefined, null)).toEqual({});
    expect(explicitModelFlagForResume(undefined, undefined)).toEqual({});
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

describe('planCoordinatorTransition with a parked /model (controller ruling, Task 5 review)', () => {
  it("the user's own queued /model pick counts as explicit: no implicit opus[1m] over it", () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {}, parkedCommand: '!model sonnet' }))
      .toEqual({ action: 'next-spawn', model: null });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: false, persisted: { model: 'claude-fable-5' }, parkedCommand: '!model haiku' }))
      .toEqual({ action: 'respawn', model: null });
  });
  it('a parked implicit switch or an unrelated parked command does not block it', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {}, parkedCommand: '!model opus --implicit' }))
      .toEqual({ action: 'switch-model-live', model: COORDINATOR_MODEL });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {}, parkedCommand: '!restart --force' }))
      .toEqual({ action: 'switch-model-live', model: COORDINATOR_MODEL });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {}, parkedCommand: '!modelx' }))
      .toEqual({ action: 'switch-model-live', model: COORDINATOR_MODEL });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, persisted: {}, parkedCommand: null }))
      .toEqual({ action: 'switch-model-live', model: COORDINATOR_MODEL });
  });
});

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

describe('decideCoordinatorEvent — fix round 1', () => {
  it('back-to-back events with the real lookup: the superseded one is stale, the latest transitions', async () => {
    const { fetchImpl } = fakeFetch(() => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: { convo_id: 'B' } }), 20)));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log: recordingLog().log });
    const handle = async (convoId, role) => {
      l.apply(convoId, role);
      const truth = await l.refresh({ force: true });
      return decideCoordinatorEvent({ role, convoId, truth, live: true, sessionCoordinator: false });
    };
    const [a, b] = await Promise.all([handle('A', 'assigned'), handle('B', 'assigned')]);
    expect(a).toBe('stale');
    expect(b).toBe('transition');
  });

  it('not fetched but known: judged against the cache snapshot, which already reflects later events', () => {
    const stale = { fetched: false, known: true, convoId: 'B' };
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'A', truth: stale, live: true, sessionCoordinator: false })).toBe('stale');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'B', truth: stale, live: true, sessionCoordinator: true })).toBe('stale');
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'B', truth: stale, live: true, sessionCoordinator: false })).toBe('transition');
  });

  it('only an entirely unknown role trusts the event outright', () => {
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'A', truth: { fetched: false, known: false, convoId: null }, live: true, sessionCoordinator: true })).toBe('transition');
  });

  it('a role already pending on a busy session is not repeated (replay during a long turn)', () => {
    const truth = { fetched: true, known: true, convoId: 'a' };
    expect(decideCoordinatorEvent({ role: 'assigned', convoId: 'a', truth, live: true, sessionCoordinator: false, pendingRole: 'assigned' })).toBe('none');
    // a pending role outranks the spawn-time flag, both ways
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, known: true, convoId: null }, live: true, sessionCoordinator: false, pendingRole: 'assigned' })).toBe('transition');
    expect(decideCoordinatorEvent({ role: 'released', convoId: 'a', truth: { fetched: true, known: true, convoId: null }, live: true, sessionCoordinator: true, pendingRole: 'released' })).toBe('none');
  });
});

describe('planCoordinatorTransition — occupied but not busy (fix round 2)', () => {
  it('a pending question, prompt or resume hold is never respawned over: no live model switch, role at the next spawn', () => {
    expect(planCoordinatorTransition({ role: 'released', agent: 'claude', occupied: true, busy: false, persisted: {} }))
      .toEqual({ action: 'next-spawn', model: null });
  });
  it('the next spawn still gets opus[1m] when nobody picked a model (final review #2, spec §2e)', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, busy: false, persisted: {} }))
      .toEqual({ action: 'next-spawn', model: COORDINATOR_MODEL });
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, busy: false, persisted: { model: 'claude-sonnet-4-5-20250929' } }))
      .toEqual({ action: 'next-spawn', model: COORDINATOR_MODEL });
  });
  it('an explicit pick, a parked user /model, Codex, or already on opus[1m] keeps the next spawn model-less', () => {
    const base = { role: 'assigned', agent: 'claude', occupied: true, busy: false };
    expect(planCoordinatorTransition({ ...base, persisted: { model: 'haiku', modelExplicit: true } })).toEqual({ action: 'next-spawn', model: null });
    expect(planCoordinatorTransition({ ...base, persisted: {}, parkedCommand: '!model sonnet' })).toEqual({ action: 'next-spawn', model: null });
    expect(planCoordinatorTransition({ ...base, agent: 'codex', persisted: {} })).toEqual({ action: 'next-spawn', model: null });
    expect(planCoordinatorTransition({ ...base, persisted: { model: 'opus[1m]' } })).toEqual({ action: 'next-spawn', model: null });
  });
  it('busy: the live /model path parks the switch as before', () => {
    expect(planCoordinatorTransition({ role: 'assigned', agent: 'claude', occupied: true, busy: true, persisted: {} }))
      .toEqual({ action: 'switch-model-live', model: COORDINATOR_MODEL });
  });
});

describe('COORDINATOR_DISALLOWED_TOOLS (final review ruling)', () => {
  it('covers every file-editing tool, MultiEdit included', () => {
    expect([...COORDINATOR_DISALLOWED_TOOLS]).toEqual(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  });
});

describe('recreateSpawnModel (final review #1)', () => {
  it('a Claude session with a pending Coordinator model respawns on it, not on the observed live model', () => {
    expect(recreateSpawnModel({ agent: 'claude', currentModel: 'claude-sonnet-4-5-20250929', pendingModel: 'opus[1m]' })).toBe('opus[1m]');
  });
  it('without a pending model it carries the live model as before (undefined when not observed yet)', () => {
    expect(recreateSpawnModel({ agent: 'claude', currentModel: 'claude-sonnet-4-5-20250929', pendingModel: null })).toBe('claude-sonnet-4-5-20250929');
    expect(recreateSpawnModel({ agent: 'claude', currentModel: null })).toBeUndefined();
  });
  it('Codex keeps its explicit null and ignores any pending model', () => {
    expect(recreateSpawnModel({ agent: 'codex', currentModel: null, pendingModel: 'opus[1m]' })).toBeNull();
    expect(recreateSpawnModel({ agent: 'codex', currentModel: 'gpt-5' })).toBe('gpt-5');
  });
});
