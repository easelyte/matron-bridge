import { afterEach, expect, it, vi } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createRestartNotes } from '../lib/restart-notes.js';
import { createRestartCancellation, createRestartBoot } from '../lib/restart-boot.js';
import { createRestartLatch } from '../lib/restart-latch.js';
import { sessionOccupied } from '../lib/restart-quiet.js';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
it('reconciles synchronously before timers and startup dispatch', async () => {
  const body = source.slice(source.indexOf('async function main() {'), source.indexOf('\nmain().catch'));
  const calls = [];
  const context = new Proxy({ calls, console: { log() {}, error() {} }, process: { exit() {}, env: {} },
    fs: { promises: { mkdir: async () => {} } },
    plannedRestartAvailable: false,
    restartBoot: { reconcile: () => calls.push('reconcile') },
    setInterval: () => ({ unref() {} }),
    timerStore: { init: () => calls.push('timers') },
    secretRequests: { init: () => 0 }, PRE_REAP_HANDOFF: {},
    JOURNAL_WS_URL: 'journal', _journalToken: 'fake',
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  await runInNewContext(`${body}\nmain()`, context);
  expect(calls[0]).toBe('reconcile');
  expect(calls).toContain('timers');
});

it('hands restart notes through the conversation resume path and propagates handoff failures', async () => {
  const start = source.indexOf('async function deliverRestartNote(');
  expect(start, 'restart delivery adapter exists').toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start) + 2;
  const delivered = [];
  const target = { alive: true };
  const context = {
    findSessionByClaudeSessionId: () => null,
    journalResumeConvo: () => target,
    sendToSession: (session, blocks) => { delivered.push({ session, text: blocks[0].text }); return true; },
    journalRouteTextToSession: vi.fn(),
    sessionOccupied, effortFlowHoldsInput: () => false,
    restartLatch: { beginInput: () => () => {} },
  };
  const deliver = runInNewContext(`${source.slice(start, end)}\ndeliverRestartNote`, context);
  expect(await deliver({ convoId: 'alice', text: 'Continue work' })).toBe(true);
  expect(delivered).toEqual([{ session: target, text: 'Continue work' }]);
  context.sendToSession = () => false;
  expect(await deliver({ convoId: 'alice', text: 'Continue' })).toBe(false);
  context.journalResumeConvo = () => null;
  expect(await deliver({ convoId: 'bob', text: 'Continue' })).toBe(false);
  context.journalResumeConvo = () => target;
  context.sendToSession = () => { throw new Error('handoff failed'); };
  await expect(deliver({ convoId: 'alice', text: 'Continue' })).rejects.toThrow('handoff failed');
});

it('filters planned participants before automatic carry-on and card publication', () => {
  const start = source.indexOf('function publishRestartCarryOnCards(');
  const body = source.slice(start, source.indexOf('\nasync function main()', start));
  const cards = [];
  runInNewContext(`${body}\npublishRestartCarryOnCards(restartBoot)`, {
    JOURNAL_ENABLED: true, PLANNED_RESTART_ENABLED: true, plannedRestartAvailable: true,
    inflightMarker: { takeStale: () => [{ convoId: 'alice', ageMs: 1 }, { convoId: 'bob', ageMs: 1 }] },
    RESTART_CARRY_ON_MAX_AGE_MS: 1000,
    restartBoot: { stamp: null, suppressCard: id => id === 'alice' },
    takeSelfRestartStamp: () => null, SELF_RESTART_STAMP_FILE: 'stamp',
    loadPersistedSessions: () => ({ alice: { sessionId: 'alice' }, bob: { sessionId: 'bob' } }),
    selectAutoCarryOn: entries => ({ auto: [], card: entries }),
    CODE_UPDATE_AUTO_CARRY_ON: false,
    isResumeConvoId: () => true,
    formatInterruptedAgo: () => 'a moment ago',
    journalPublishCardForConvo: id => { cards.push(id); return true; },
    console: { log() {}, warn() {} },
  });
  expect(cards).toEqual(['bob']);
});

const roots = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function recovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-recovery-'));
  roots.push(root);
  const stateOptions = { file: path.join(root, 'state.json'), historyFile: path.join(root, 'history.jsonl') };
  const state = createPlannedRestartState(stateOptions);
  const notes = createRestartNotes({ heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json') });
  state.addRequest({ request_key: 'alice' });
  state.setState('restarting', { participants: ['alice'], boot_id: 'box-a', expected_sha: 'code', restarting_at: Date.now() });
  const timers = [];
  const boot = options => createRestartBoot({ stateStore: state, notesStore: notes,
    markerStore: { list: () => ({}) }, bootId: 'box-b', bootSha: 'code', maxAgeMs: 1000000,
    takeStamp: () => null, schedule: fn => timers.push(fn), deliver: async () => true, ...options });
  return { state, stateOptions, notes, boot, timers };
}
const adapterBody = source.slice(source.indexOf('async function deliverRestartNote('),
  source.indexOf('function publishRestartCarryOnCards('));
const cardsBody = source.slice(source.indexOf('function publishRestartCarryOnCards('),
  source.indexOf('async function main()'));
function cardsContext(boot, markerBootId = 'box-b') {
  const cards = [];
  const context = { JOURNAL_ENABLED: true, PLANNED_RESTART_ENABLED: true, plannedRestartAvailable: true,
    inflightMarker: { takeStale: () => [{ convoId: 'alice', bootId: markerBootId, ageMs: 1 }] },
    RESTART_CARRY_ON_MAX_AGE_MS: 1000, restartBoot: boot,
    takeSelfRestartStamp: () => null, SELF_RESTART_STAMP_FILE: 'stamp',
    loadPersistedSessions: () => ({ alice: { sessionId: 'alice' } }),
    selectAutoCarryOn: entries => ({ auto: [], card: entries }), CODE_UPDATE_AUTO_CARRY_ON: false,
    isResumeConvoId: () => true, formatInterruptedAgo: () => 'a moment ago',
    journalPublishCardForConvo: id => { cards.push(id); return true; }, console: { log() {}, warn() {} } };
  return { context, cards };
}
it.each(['refused', 'throwing'])('retries a %s router through the production adapter', async failure => {
  vi.useFakeTimers();
  const f = recovery();
  const route = vi.fn(() => { if (failure === 'throwing') throw new Error('unavailable'); return false; });
  const deliver = runInNewContext(`${adapterBody}\ndeliverRestartNote`, {
    journalRouteTextToSession: vi.fn(), sessionOccupied, effortFlowHoldsInput: () => false, restartLatch: null, findSessionByClaudeSessionId: () => ({ alive: true }), sendToSession: route,
  });
  const boot = f.boot({ schedule: setTimeout, deliver });
  boot.reconcile(); boot.listenerReady();
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenCalledTimes(3);
  expect(f.state.getState().verdicts.alice.outcome).toBe('failed');
});
it('offers a recovery card after a completed restart and a later interrupted turn', async () => {
  const f = recovery();
  const first = f.boot(); first.reconcile(); first.listenerReady();
  await f.timers.shift()();
  expect(f.state.getState().state).toBe('back');
  const later = f.boot(); later.reconcile();
  const h = cardsContext(later);
  runInNewContext(`${cardsBody}\npublishRestartCarryOnCards(restartBoot)`, h.context);
  expect(h.cards).toEqual(['alice']);
});
it.each(['box-a', 'box-b'])('suppresses only the interruption from the restarted process: %s', markerBootId => {
  const f = recovery(); const boot = f.boot(); boot.reconcile();
  const h = cardsContext(boot, markerBootId);
  runInNewContext(`${cardsBody}\npublishRestartCarryOnCards(restartBoot)`, h.context);
  expect(h.cards).toEqual(markerBootId === 'box-a' ? [] : ['alice']);
});
it('falls back to legacy carry-on when restart state initialization rejects corrupt data', async () => {
  const f = recovery();
  f.notes.hold(f.state.getState().id, 'alice', 'Continue');
  f.notes.moveToPending(f.state.getState().id);
  fs.writeFileSync(f.stateOptions.file, '{invalid');
  const pending = JSON.stringify(f.notes.listPending());
  const calls = [];
  const h = cardsContext(null);
  const context = new Proxy({ ...h.context, fs, createPlannedRestartState: () => createPlannedRestartState(f.stateOptions),
    PLANNED_RESTART_ENABLED: true, process: { env: {}, on() {}, exit() {} },
    execFileSync: () => 'code', stripJournalCreds: () => ({}), __dirname: '.',
    RESTART_ENV_FILE: 'token', queueRestartNotices() {},
    console: { log() {}, error() {}, warn: text => calls.push(text) },
    createRestartBoot: () => { calls.push('delivery'); return f.boot(); },
    inflightMarker: { takeStale: () => { calls.push('legacy'); return []; } },
    restartBoot: null,
    JOURNAL_WS_URL: 'journal', _journalToken: 'fake', secretRequests: { init: () => 0 }, PRE_REAP_HANDOFF: {},
    setInterval: () => ({ unref() {} }), timerStore: { init() {} },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const init = source.slice(source.indexOf('let plannedRestartAvailable = false;'),
    source.indexOf('const plannedRestartRuntime ='));
  const main = source.slice(source.indexOf('async function main() {'), source.indexOf('\nmain().catch'));
  await runInNewContext(`let plannedRestartState, RESTART_BOOT_SHA, RESTART_TOKEN;\n${init}\n${cardsBody}\n${main}\nmain()`, context);
  expect(calls).not.toContain('delivery');
  expect(calls).toContain('legacy');
  expect(fs.readFileSync(f.stateOptions.file, 'utf8')).toBe('{invalid');
  expect(JSON.stringify(f.notes.listPending())).toBe(pending);
});

it.each(['/stop carry on', '!stop', 'y', '1', '/compact'])('delivers a stored note as an ordinary turn: %s', async text => {
  const session = { alive: true, pendingUnclassifiedPrompt: true, waitingForAnswer: true };
  const commands = vi.fn();
  const send = vi.fn(() => true);
  const deliver = runInNewContext(`${adapterBody}\ndeliverRestartNote`, {
    restartLatch: null, findSessionByClaudeSessionId: () => session, sessionOccupied, effortFlowHoldsInput: () => false,
    sendToSession: send, journalRouteTextToSession: commands,
  });
  expect(await deliver({ convoId: 'alice', text })).toEqual({ deferred: true });
  expect(send).not.toHaveBeenCalled();
  session.pendingUnclassifiedPrompt = false;
  session.waitingForAnswer = false;
  expect(await deliver({ convoId: 'alice', text })).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(session, [{ type: 'text', text }], { plainTurn: true });
  expect(commands).not.toHaveBeenCalled();
  session.busy = true;
  expect(await deliver({ convoId: 'alice', text })).toEqual({ deferred: true });
});

it.each(['busy', '_awaitingInputReady', 'effort', 'waitingForAnswer', 'pendingInteractivePrompt', 'pendingUnclassifiedPrompt'])('keeps notes through ten %s deferrals, then resumes once idle', async hold => {
  vi.useFakeTimers();
  const f = recovery();
  const session = { alive: true, [hold]: true };
  const send = vi.fn(() => true);
  const deliver = runInNewContext(`${adapterBody}\ndeliverRestartNote`, {
    restartLatch: null, findSessionByClaudeSessionId: () => session,
    sessionOccupied, effortFlowHoldsInput: target => target.effort === true, sendToSession: send,
  });
  const boot = f.boot({ schedule: setTimeout, deliver });
  boot.reconcile(); boot.listenerReady();
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(i === 0 ? 15000 : 60000);
    expect(f.notes.listPending()).toHaveLength(1);
    expect(f.notes.listPending()[0]).toMatchObject({ status: 'pending', retry_at: Date.now() + 60000 });
    expect(f.notes.listPending()[0].attempts || 0).toBe(0);
    expect(f.state.getState().verdicts).toEqual({});
    expect(f.state.getState().state).toBe('restarting');
    expect(send).not.toHaveBeenCalled();
  }
  session[hold] = false;
  await vi.advanceTimersByTimeAsync(59999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.state.getState().verdicts.alice.outcome).toBe('resumed');
  expect(f.state.getState().state).toBe('back');
  expect(f.notes.listPending()).toEqual([]);
});

it('abandons a deferred note as stale on a boot beyond the maximum age', async () => {
  vi.useFakeTimers();
  const f = recovery();
  const deliver = vi.fn(async () => ({ deferred: true }));
  const boot = f.boot({ schedule: setTimeout, deliver });
  boot.reconcile(); boot.listenerReady();
  await vi.advanceTimersByTimeAsync(15000 + 9 * 60000);
  expect(f.notes.listPending()).toHaveLength(1);
  expect(f.state.getState().verdicts).toEqual({});
  vi.clearAllTimers();
  vi.setSystemTime(f.state.getState().restarting_at + 1000001);
  const later = f.boot({ schedule: setTimeout, deliver });
  later.reconcile(); later.listenerReady();
  await vi.runAllTimersAsync();
  expect(deliver).toHaveBeenCalledTimes(10);
  expect(f.state.getState().verdicts.alice.outcome).toBe('stale');
  expect(f.state.getState().state).toBe('abandoned');
  expect(f.notes.listPending()).toEqual([]);
});

it.each(['/compact', '/context-full'])('keeps stored text out of native command handling: %s', text => {
  const start = source.indexOf('function sendToSession(');
  const body = source.slice(start, source.indexOf('\nfunction sendTextToSession(', start));
  const send = vi.fn(() => true), compact = vi.fn(() => true);
  const session = { alive: true, agent: 'codex', codex: { transport: 'app-server', send, compact } };
  const context = new Proxy({ Date, restartLatch: null, AGENT_CODEX: 'codex', codexInput: blocks => blocks,
    isCompactCommand: value => value.startsWith('/compact'), contextFullToNative: () => '/context',
    applyPendingAgentHandoff: (target, blocks) => ({ blocks, pending: null }),
    inflightMarker: { noteTurnStart() {} }, journalConvoIdFor: () => 'alice',
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const dispatch = runInNewContext(`${body}\nsendToSession`, context);
  expect(dispatch(session, [{ type: 'text', text }], { plainTurn: true })).toBe(true);
  expect(send).toHaveBeenCalledWith([{ type: 'text', text }]);
  expect(compact).not.toHaveBeenCalled();
});

it.each(['initial', 'retry'])('catches storage rejection at the production %s timer and retries without losing evidence', async boundary => {
  vi.useFakeTimers();
  const f = recovery();
  const log = vi.fn();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const deliver = vi.fn(async () => false);
    const boot = f.boot({ schedule: undefined, deliver, log });
    boot.reconcile(); boot.listenerReady();
    if (boundary === 'retry') await vi.advanceTimersByTimeAsync(15000);
    const pending = f.notes.listPending();
    const write = vi.spyOn(f.notes, 'putPending').mockImplementationOnce(() => { throw Object.assign(new Error('storage full'), { code: 'ENOSPC' }); });
    await vi.advanceTimersByTimeAsync(boundary === 'initial' ? 15000 : 60000);
    expect(log).toHaveBeenCalledWith('Planned restart recovery degraded; delivery remains pending');
    expect(unhandled).not.toHaveBeenCalled();
    expect(f.notes.listPending()).toEqual(pending);
    write.mockRestore();
    await vi.advanceTimersByTimeAsync(60000);
    expect(deliver).toHaveBeenCalledTimes(boundary === 'initial' ? 1 : 2);
    expect(f.notes.listPending()[0].attempts).toBe(boundary === 'initial' ? 1 : 2);
  } finally { process.off('unhandledRejection', unhandled); }
});

const tickBody = source.slice(source.indexOf('if (plannedRestartAvailable) {\n  let previousState;'), source.indexOf('\nconst apiServer ='));
const cancelBody = source.slice(source.indexOf('let restartCancellation;'), source.indexOf('async function deliverRestartNote('));
it('retries interrupted cancellation on later production ticks with one notice per session', async () => {
  const f = recovery();
  f.state.setState('pending');
  const id = f.state.getState().id;
  f.notes.hold(id, 'alice', 'Continue');
  f.notes.hold(id, 'bob', 'Continue');
  let tick;
  let failed = false;
  const notices = [];
  const context = { plannedRestartAvailable: true, plannedRestartState: f.state,
    createRestartCancellation, createRestartNotes: () => f.notes,
    journalPublisher: { publishText: (convoId, payload, options) => {
      if (!failed) { failed = true; return false; }
      notices.push({ convoId, key: options.idemKey }); (options.onLocalSendComplete || options.onDelivered)(); return true;
    } },
    plannedRestart: {}, codeUpdateWatcher: null, console: { warn() {} },
    publishRestartStatus() {}, queueRestartNotices() {},
    setInterval: fn => { tick = fn; return { unref() {} }; },
  };
  const cancel = runInNewContext(`${cancelBody}\n${tickBody}\ncancelPlannedRestart`, context);
  await expect(cancel()).rejects.toThrow('Restart cancellation notice refused');
  expect(f.state.getState().state).toBe('cancelling');
  tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.state.getState().state).toBe('cancelled');
  expect(f.notes.listHeld(id)).toEqual([]);
  tick();
  expect(notices).toEqual([{ convoId: 'alice', key: `restart-cancel:${id}:alice` }, { convoId: 'bob', key: `restart-cancel:${id}:bob` }]);
});

it('retries cancellation after journal hello', () => {
  const start = source.indexOf('function handleJournalReconnect() {');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  const retry = vi.fn();
  const context = new Proxy({ retryRestartCancellation: retry, coordinatorLookup: { refresh() {} }, memoryLookup: { refresh() {} }, userDefaults: { refresh() {} }, journalIdentity: { refresh() {} } }, { get: (target, key) => key in target ? target[key] : () => {} });
  runInNewContext(`${body}\nhandleJournalReconnect()`, context);
  expect(retry).toHaveBeenCalledOnce();
});

it('polls expensive restart gates every five seconds and stops when unavailable', () => {
  let tick, time = 0;
  const probe = vi.fn(() => ({}));
  const context = { plannedRestartAvailable: true, plannedRestartState: { getState: () => ({ state: 'pending' }) },
    plannedRestart: { tick: probe }, plannedRestartRuntime: {}, codeUpdateWatcher: null,
    queueRestartNotices() {}, publishRestartStatus() {}, console: { warn() {} }, Date: { now: () => time },
    setInterval: fn => { tick = fn; return { unref() {} }; },
  };
  runInNewContext(tickBody, context);
  for (time = 0; time < 5000; time += 1000) tick();
  expect(probe).toHaveBeenCalledTimes(1);
  tick();
  expect(probe).toHaveBeenCalledTimes(2);
  context.plannedRestartAvailable = false;
  time = 10000; tick();
  expect(probe).toHaveBeenCalledTimes(2);
});

const gateBody = source.slice(source.indexOf('const plannedRestart = plannedRestartAvailable ?'), source.indexOf('if (plannedRestartAvailable) {\n  let previousState;'));
it('refuses the ready callback after restart initialization becomes unavailable', () => {
  let options;
  const readState = vi.fn(() => ({ state: 'pending' }));
  const context = new Proxy({ plannedRestartAvailable: true, plannedRestartState: { getState: readState }, plannedRestartRuntime: {},
    createPlannedRestart: value => { options = value; return {}; }, createRestartLatch,
    process: { env: {} }, __dirname: '.', RESTART_COLLECT_MS: 0, sessions: [],
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  runInNewContext(gateBody, context);
  context.plannedRestartAvailable = false;
  expect(options.onReady({})).toEqual({ latched: false });
  expect(readState).not.toHaveBeenCalled();
});

it('drops completed background markers from the participant inventory using live work', () => {
  let latchOptions;
  const markers = { alice: { kind: 'background' }, bob: { kind: 'background' }, 'box-a': { kind: 'turn' } };
  const context = new Proxy({ JSON, Object, Array, plannedRestartAvailable: true, plannedRestartState: {}, plannedRestartRuntime: {},
    createPlannedRestart: () => ({}), createRestartLatch: value => { latchOptions = value; return {}; },
    process: { env: {} }, __dirname: '.', RESTART_COLLECT_MS: 0, sessions: [], INFLIGHT_FILE: 'markers',
    fs: { readFileSync: () => JSON.stringify(markers) },
    findSessionByClaudeSessionId: id => ({ id }), sessionHasBackgroundWork: session => session.id === 'bob',
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  runInNewContext(gateBody, context);
  expect(latchOptions.listMarkers()).toEqual({ bob: markers.bob, 'box-a': markers['box-a'] });
});

it('keeps the listener available and falls back to carry-on when listener recovery throws', () => {
  const start = source.indexOf('apiServer.listen(API_PORT,');
  const body = source.slice(start, source.indexOf('\nfunction hydrateAgentState', start));
  const legacy = vi.fn(), warn = vi.fn();
  const context = { plannedRestartAvailable: true, restartBoot: { listenerReady: () => { throw new Error('storage full'); } },
    apiServer: { listen: (_port, _host, callback) => callback() }, API_PORT: 0,
    atomicWriteFileSync() {}, RESTART_ENV_FILE: 'token', RESTART_TOKEN: 'token', restartTokenWritten: false,
    publishRestartCarryOnCards: legacy, console: { warn, log() {} },
  };
  expect(() => runInNewContext(body, context)).not.toThrow();
  expect(context.plannedRestartAvailable).toBe(false);
  expect(context.restartBoot).toBe(null);
  expect(legacy).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith('[restart] recovery initialization failed; planned restart unavailable');
});

it('never redelivers an uncertain handoff after a post-delivery storage failure', async () => {
  vi.useFakeTimers();
  const f = recovery();
  const deliver = vi.fn(async () => false);
  const boot = f.boot({ schedule: undefined, deliver });
  boot.reconcile(); boot.listenerReady();
  const write = f.notes.putPending.bind(f.notes);
  let writes = 0;
  vi.spyOn(f.notes, 'putPending').mockImplementation(entry => {
    if (++writes === 2) throw new Error('storage full');
    return write(entry);
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.notes.listPending()[0].status).toBe('delivering');
  await vi.advanceTimersByTimeAsync(60000);
  expect(deliver).toHaveBeenCalledOnce();
  expect(f.state.getState().verdicts.alice.outcome).toBe('possibly_delivered');
  expect(f.notes.listPending()).toEqual([]);
});
