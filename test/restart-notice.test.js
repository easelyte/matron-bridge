import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRestartLatch } from '../lib/restart-latch.js';
import { switchEffortInSession } from '../lib/effort-command.js';
import { switchModelInSession } from '../lib/model-command.js';
import { normalizeModelArg } from '../lib/model-aliases.js';
import { markJournalOrigin, planQueueFlush } from '../lib/queue-flush.js';
import { normalizeAgent } from '../lib/agent-backend.js';
import { getPersistedAgentState, mergeAgentStates, resolveNativeSessionIdForPersistence, snapshotAgentState } from '../lib/agent-handoff.js';
import { TURN_TIER } from '../lib/peer-priority.js';
import { EventEmitter } from 'node:events';
import { InteractiveSession } from '../lib/interactive-session.js';
import { createRestartNotices, validateControlParams, authorizeControl, JOURNAL_DEVICE_ID, JOURNAL_ONLY_ACTIONS, CONTROL_KINDS, planSessionControl, controlNotice, TURN_STARTING_OPS } from '../lib/session-control.js';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createPlannedRestart } from '../lib/planned-restart.js';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-notice-'));
  roots.push(root);
  let notices;
  let count = 0;
  const store = createPlannedRestartState({ file: path.join(root, 'state.json'),
    historyFile: path.join(root, 'history.jsonl'), now: () => 100,
    makeId: () => ++count === 1 ? 'restart-a' : `restart-${count}`, onPending: state => options.onPending?.(state) });
  const send = vi.fn(() => true);
  const persist = vi.fn(session => fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify(session)));
  const drain = vi.fn(session => {
    if (session.busy || session.waitingForAnswer) return;
    const slot = session._deferredControls?.restart_notice;
    if (slot && notices.apply(session, slot)) delete session._deferredControls.restart_notice;
  });
  notices = createRestartNotices({ stateStore: store, send, persist, drain });
  store.addRequest({ request_key: 'alice', reason: 'update' });
  const session = { roomId: 'room-a', journalConvoId: 'alice', alive: true, busy: false,
    lastActivityAt: 100 - 5 * 60 * 60_000, ...options.session };
  return { root, store, notices, send, persist, drain, session };
}
function unwarned(store, sessions) {
  return createPlannedRestart({ stateStore: store, sessions: () => sessions,
    git: () => { throw new Error('unavailable'); },
    quietEvaluator: () => ({ quiet: true, holders: [], probe_error: null }) }).evaluate().waiting_on.unwarned;
}

// Run the production notice wiring and transport dispatch without spawning agents.
function wiredSetup(backend, available = true) {
  const h = setup();
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const persisted = new Map();
  const backendSend = vi.fn(() => true);
  const iv = new EventEmitter();
  iv.sendText = backendSend;
  iv.detector = { reset: vi.fn() };
  h.session.agent = backend === 'codex' ? 'codex' : 'claude';
  if (backend === 'codex') h.session.codex = { send: backendSend };
  else h.session.iv = iv;
  const timers = new Map();
  let timerId = 0;
  const noop = () => {};
  const context = {
    restartLatch: undefined, TURN_TIER, bumpTurnGeneration: noop, clearTurnClassification: noop, console: { warn: vi.fn() }, queueMicrotask, CONTROL_KINDS, TURN_STARTING_OPS, planSessionControl, controlNotice,
    createRestartNotices, plannedRestartAvailable: available, plannedRestartState: available ? h.store : null,
    sessions: new Map([['room-a', h.session]]),
    journalConvoIdFor: session => session.journalConvoId || session.claudeSessionId,
    persistSession: (roomId, id, cwd, origin, extra) => persisted.set(roomId,
      { journalConvoId: context.sessions.get(roomId)?.journalConvoId, ...extra }),
    getPersistedSession: roomId => persisted.get(roomId), persistControlState: noop,
    flushRoomInbox: vi.fn(), drainPreReapCompact: () => false, effortFlowHoldsInput: () => false,
    foreignSessions: { drainParked: () => false, end: noop }, canSwitchAgent: () => true,
    postControlNotice: noop, journalSessionCommandCtx: () => ({}),
    AGENT_CODEX: 'codex', AGENT_CLAUDE: 'claude',
    notePreReapTurnStart: noop, inflightMarker: { noteTurnStart: noop, noteTurnEnd: noop },
    journalSessionState: noop, journalActivity: noop, contextFullToNative: () => null,
    contentBlocksToCodexPrompt: blocks => blocks[0].text,
    applyPendingAgentHandoff: (session, blocks) => ({ blocks, pending: null }),
    commitDispatchedUserTurn: vi.fn(), debug: noop,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id), RESUME_READY_QUIET_MS: 10, RESUME_READY_HARDCAP_MS: 100,
    isIdleReadyScreen: text => text === 'ready',
    resolveAgent: () => 'claude', ENV_DEFAULT_AGENT: 'claude',
    getPersistedAgentState: prev => ({ sessionId: prev?.sessionId }),
    hydrateAgentState: noop, agentLabel: agent => agent, notice: (kind, plain, html) => ({ plain, html }),
    sendToRoom: noop, markdownToHtml: text => text, escapeHtml: text => text,
    sendButtonMessage: noop, DEFAULT_WORKDIR: '.', planItems: { reconcileRestored: noop },
    setupSubagentWatcher: noop, postRootBypassWarning: noop,
    pinViewerRootIdentities: () => [], expandHome: value => value, codexDefaultModelNow: () => null, codexDefaultEffortNow: () => null,
    effectiveExtras: extras => extras, DEFAULT_MCP_EXTRAS: [], CODEX_APP_SERVER: false,
    codexCoordinatorOptions: () => ({}), CODEX_BRIDGE_PROMPT: '', COORDINATOR_BLOCK: '',
    CODEX_SANDBOX_MODE: '', CODEX_NETWORK_ACCESS: false, memoryBlockNow: noop, noticesBlockNow: noop,
    buildCodexSpawnEnv: () => ({}), API_PORT: 0, JOURNAL_PROXY_HEADER_FILE: null,
    newSessionConvoId: () => 'bob', mergeAgentStates: () => ({}),
    journalFlushForSession: noop, journalSpawnStatus: noop,
    CodexExecSession: class extends EventEmitter { constructor() { super(); this.send = vi.fn(() => true); } },
  };
  vm.createContext(context);
  function load(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Missing production seam');
    vm.runInContext(source.slice(start, end + (endMarker === '\n}\n' ? 2 : 0)), context);
  }
  load('function reportSessionSendFailure(', '\nfunction flushResponse(');
  load('function sendToSession(', '\nfunction submitCodexAsyncAnswer(');
  load('function enterResumeHold(', '\nfunction formatQueueSummary(');
  load('function sessionOccupiedForRoomDelivery(', '\n// The one shared room-flush');
  load('async function applyControlSteps(', '\n// The Coordinator');
  load('const restartNotices = plannedRestartAvailable ?', '\n// The room-delivery half');
  load('function resumePersistedSession(', '\n// Open secure-input');
  load('function createCodexSessionForRoom(', '\nfunction codexToolIndicator(');
  const constructorStart = source.indexOf('function createInteractiveSessionForRoom(');
  const constructorEnd = source.indexOf('\n// Surface a detected TUI prompt', constructorStart);
  const registration = source.lastIndexOf('  sessions.set(roomId, session);', constructorEnd);
  vm.runInContext('function finishInteractiveConstruction(session, roomId, resumeSessionId, cwd, sessionId, ivRootDowngraded) {\n'
    + source.slice(registration, constructorEnd), context);
  return { ...h, context, persisted, backendSend, load,
    flush: async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); },
    releaseReady: () => { for (const { fn, ms } of [...timers.values()]) if (ms === 10) fn(); },
  };
}

describe('restart notices', () => {
  it('defers PTY notice writes until an unclassified prompt closes', () => {
    vi.useFakeTimers();
    try {
      const h = setup({ session: { pendingUnclassifiedPrompt: { text: 'Choose an option' } } });
      const write = vi.fn();
      const iv = new InteractiveSession({ roomId: 'room-a', workdir: '.', sessionId: 'alice',
        ptyHandle: { write, onData() {}, onExit() {} }, tail: new EventEmitter() });
      h.send.mockImplementation((_session, text) => iv.sendText(text));
      h.notices.enqueue(h.session);
      h.drain(h.session);
      vi.runAllTimers();
      expect(write).not.toHaveBeenCalled();
      expect(h.store.getState().notified).toEqual({});
      expect(h.session._deferredControls.restart_notice).toBeDefined();
      h.session.pendingUnclassifiedPrompt = null;
      h.drain(h.session);
      vi.runAllTimers();
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[0][0]).toContain('write your resume note');
      expect(h.store.getState().notified.alice).toBeDefined();
      expect(h.session._deferredControls.restart_notice).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
  it('notifies a session idle for hours in one immediate drain with the resume instructions', () => {
    const h = setup();
    h.notices.enqueue(h.session);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.drain).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][1]).toBe('The bridge will restart once nothing is running on it (update). Before ending this turn, write your resume note with `reminder_create restart_note: true`: what you are doing, what runs in the background and where, any in-process wait you rely on (ScheduleWakeup, CronCreate, Monitor) since those die with the process, and the next step. Your work will not be cut off; you will be carried on after the restart.');
    expect(h.store.getState().notified.alice).toEqual({ at: 100, turnEnded: false });
    expect(h.store.getState().participants).toEqual([]);
    const bob = { ...h.session, journalConvoId: 'bob', _deferredControls: null };
    const mark = vi.spyOn(h.store, 'markNotified').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => h.notices.enqueue(bob)).toThrow('storage unavailable');
    expect(h.store.getState().notified.bob).toBeUndefined();
    expect(() => h.notices.turnEnd(bob)).toThrow('storage unavailable');
    mark.mockRestore();
    h.notices.enqueue(bob);
    expect(h.store.getState().notified.bob.turnEnded).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(2);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => h.store.markNotified('restart-a', 'box-a')).toThrow('storage unavailable');
    expect(() => h.store.markNoticeTurnEnded('restart-a', 'alice')).toThrow('storage unavailable');
    expect(h.store.getState().notified['box-a']).toBeUndefined();
    expect(h.store.getState().notified.alice.turnEnded).toBe(false);
    rename.mockRestore();
  });
  it('deduplicates delivered notices and permits one for the next restart', () => {
    const h = setup();
    h.notices.enqueue(h.session);
    for (let i = 0; i < 100; i++) h.notices.enqueue(h.session);
    expect(h.send).toHaveBeenCalledOnce();
    h.store.setState('cancelled');
    h.store.addRequest({ request_key: 'bob', reason: 'config' });
    h.notices.enqueue(h.session);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
  it('parks a busy session until its next idle point without replacing its slot', () => {
    const h = setup({ session: { busy: true } });
    h.notices.enqueue(h.session);
    const slot = h.session._deferredControls?.restart_notice;
    expect(slot?.kind).toBe('restart_notice');
    h.notices.enqueue(h.session);
    expect(h.session._deferredControls.restart_notice).toBe(slot);
    expect(h.send).not.toHaveBeenCalled();
    h.session.busy = false;
    h.drain(h.session);
    expect(h.send).toHaveBeenCalledOnce();
  });
  it('persists a reaped slot and delivers it on resume without making a participant', () => {
    const h = setup({ session: { alive: false } });
    h.notices.enqueue(h.session);
    expect(h.persist).toHaveBeenCalledWith(h.session);
    expect(h.session._deferredControls?.restart_notice?.kind).toBe('restart_notice');
    expect(h.send).not.toHaveBeenCalled();
    expect(unwarned(h.store, [h.session])).toEqual([]);
    const resumed = { ...JSON.parse(fs.readFileSync(path.join(h.root, 'session.json'), 'utf8')), alive: true };
    h.notices.enqueue(resumed);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.store.getState().participants).toEqual([]);
  });
  it('reports only alive unnotified sessions and clears them after delivery', () => {
    const h = setup();
    expect(unwarned(h.store, [h.session, { journalConvoId: 'bob', alive: false }])).toEqual(['alice']);
    h.notices.enqueue(h.session);
    expect(unwarned(h.store, [h.session])).toEqual([]);
  });
  it('notifies a newly created session while pending', () => {
    const h = setup();
    h.notices.enqueue(h.session);
    h.notices.enqueue({ ...h.session, journalConvoId: 'bob', _deferredControls: null });
    expect(Object.keys(h.store.getState().notified)).toEqual(['alice', 'bob']);
  });
  it('records the end of the notice turn idempotently', () => {
    const h = setup();
    h.notices.enqueue(h.session);
    h.notices.turnEnd(h.session);
    h.notices.turnEnd(h.session);
    expect(h.store.getState().notified.alice?.turnEnded).toBe(true);
  });
  it.each(['codex', 'pty'])('delivers a notice to the %s backend exactly once', async backend => {
    const h = wiredSetup(backend);
    h.context.enqueueRestartNotice(h.session);
    await h.flush();
    h.context.enqueueRestartNotice(h.session);
    expect(h.backendSend).toHaveBeenCalledOnce();
    const payload = h.backendSend.mock.calls[0][0];
    expect(backend === 'pty' ? payload : payload[0].text).toContain('write your resume note');
    expect(h.store.getState().notified.alice).toEqual({ at: 100, turnEnded: false });
    expect(h.session._deferredControls?.restart_notice).toBeUndefined();
  });
  it.each(['codex', 'pty'])('retains a notice refused by the %s backend until accepted', async backend => {
    const h = wiredSetup(backend);
    h.backendSend.mockReturnValue(false);
    h.context.enqueueRestartNotice(h.session);
    await h.flush();
    expect(h.backendSend).toHaveBeenCalledOnce();
    expect(h.store.getState().notified).toEqual({});
    expect(h.session._deferredControls?.restart_notice).toBeDefined();
    h.backendSend.mockReturnValue(true);
    h.context.maybeFlushRoomDelivery(h.session);
    await h.flush();
    expect(h.backendSend).toHaveBeenCalledTimes(2);
    expect(h.store.getState().notified.alice).toBeDefined();
  });
  it.each([true, false])('waits for resumed PTY readiness before delivery (accepted: %s)', async accepted => {
    const h = wiredSetup('pty');
    h.session.alive = false;
    h.context.enqueueRestartNotice(h.session);
    const prev = { sessionId: 'alice', journalConvoId: 'alice', workdir: '.' ,
      _deferredControls: h.session._deferredControls, chatHistory: [] };
    h.backendSend.mockReturnValue(accepted);
    h.context.createSession = (roomId, cwd, resumeSessionId) => {
      h.session.alive = true;
      // Execute the production constructor's registration and enqueue seam.
      return h.context.finishInteractiveConstruction(h.session, roomId, resumeSessionId, cwd, 'alice', false);
    };
    h.context.resumePersistedSession('room-a', prev);
    await h.flush();
    expect(h.session._awaitingInputReady).toBe(true);
    expect(h.backendSend).not.toHaveBeenCalled();
    expect(h.store.getState().notified).toEqual({});
    h.session.iv.emit('pty-data', 'ready');
    h.releaseReady();
    await h.flush();
    expect(h.session._awaitingInputReady).toBe(false);
    expect(h.backendSend).toHaveBeenCalledOnce();
    expect(h.store.getState().notified.alice !== undefined).toBe(accepted);
    expect(h.session._deferredControls?.restart_notice !== undefined).toBe(!accepted);
  });
  it.each(['disabled', 'cancelled'])('drops an obsolete notice and delivers the following carry-on when %s', async mode => {
    const h = wiredSetup('codex', mode !== 'disabled');
    h.session._deferredControls = {
      restart_notice: { kind: 'restart_notice', id: h.store.getState().id, params: {} },
      carry_on: { kind: 'carry_on', params: { action: 'carry_on', message: 'Continue the work.' } },
    };
    if (mode === 'cancelled') h.store.setState('cancelled');
    h.context.maybeFlushRoomDelivery(h.session);
    await h.flush();
    expect(h.backendSend).toHaveBeenCalledOnce();
    expect(h.backendSend.mock.calls[0][0][0].text).toContain('Continue the work.');
    expect(h.session._deferredControls).toBeNull();
    expect(h.store.getState().notified).toEqual({});
  });
  it('gives a fresh Codex session a stable id and exactly one pending notice before user input', async () => {
    const h = wiredSetup('codex');
    h.context.getPersistedSession = roomId => h.persisted.get(roomId);
    const session = h.context.createCodexSessionForRoom('room-b', '.');
    expect(session.claudeSessionId).toBeNull();
    expect(session.journalConvoId).toBe('bob');
    expect(h.persisted.get('room-b').journalConvoId).toBe('bob');
    expect(unwarned(h.store, [session])).toEqual(['bob']);
    await h.flush();
    h.context.enqueueRestartNotice(session);
    expect(session.codex.send).toHaveBeenCalledOnce();
    expect(h.store.getState().notified.bob).toBeDefined();
    expect(unwarned(h.store, [session])).toEqual([]);
  });
  it.each(['false', 'throw'])('keeps a refused notice parked when delivery returns %s', mode => {
    const h = setup();
    h.send.mockImplementation(() => { if (mode === 'throw') throw new Error('unavailable'); return false; });
    try { h.notices.enqueue(h.session); } catch { /* Refusal retains the slot. */ }
    expect(h.session._deferredControls?.restart_notice?.kind).toBe('restart_notice');
    expect(h.store.getState().notified).toEqual({});
  });
  it.each(['read', 'persist'])('refuses sending when %s fails', mode => {
    const h = setup();
    if (mode === 'read') vi.spyOn(h.store, 'getState').mockImplementation(() => { throw new Error('unavailable'); });
    else h.persist.mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => h.notices.enqueue(h.session)).toThrow('unavailable');
    expect(h.send).not.toHaveBeenCalled();
    if (mode === 'persist') {
      expect(h.session._deferredControls).toBeUndefined();
      const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
      const start = source.indexOf('const restartNotices = plannedRestartAvailable ?');
      const end = source.indexOf('\nfunction enqueueRestartNotice(', start);
      const context = { plannedRestartAvailable: true, plannedRestartState: h.store, createRestartNotices,
        persistSession: vi.fn(), getPersistedSession: () => null,
        maybeFlushRoomDelivery: vi.fn(), sendTextToSession: h.send };
      vm.createContext(context);
      const wired = vm.runInContext(source.slice(start, end) + ';restartNotices', context);
      expect(() => wired.enqueue(h.session)).toThrow('Restart notice not persisted');
      expect(h.send).not.toHaveBeenCalled();
      h.persist.mockImplementation(() => {});
      h.notices.enqueue(h.session);
      expect(h.send).toHaveBeenCalledOnce();
    }
  });
  it('ignores cancelled slots and sessions without a conversation id', () => {
    const h = setup({ session: { busy: true } });
    h.notices.enqueue(h.session);
    expect(h.session._deferredControls?.restart_notice).toBeDefined();
    h.store.setState('cancelled');
    h.session.busy = false;
    h.drain(h.session);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.session._deferredControls.restart_notice).toBeUndefined();
    h.notices.enqueue({ alive: true });
    expect(h.store.getState().notified).toEqual({});
  });
  it('fires the pending transition after committing state, including an unlatch', () => {
    const onPending = vi.fn();
    const h = setup({ onPending });
    expect(onPending).toHaveBeenCalledOnce();
    expect(onPending.mock.calls[0][0]).toEqual(h.store.getState());
    h.store.addRequest({ request_key: 'bob', reason: 'config' });
    expect(onPending).toHaveBeenCalledOnce();
    h.store.setState('restarting');
    h.store.setState('pending');
    expect(onPending).toHaveBeenCalledTimes(2);
  });
  it('rejects stale notification writes and preserves the first notification record', () => {
    const h = setup();
    for (const method of ['markNotified', 'markNoticeTurnEnded']) {
      for (const [id, convoId] of [['stale', 'alice'], [null, 'alice'], ['', 'alice'], ['restart-a', null], ['restart-a', '']]) {
        expect(() => h.store[method](id, convoId)).toThrow('Invalid restart notice');
      }
      h.store[method]('restart-a', 'alice');
    }
    h.store.markNoticeTurnEnded('restart-a', 'bob');
    h.store.markNoticeTurnEnded('restart-a', '__proto__');
    expect(Object.keys(h.store.getState().notified)).toEqual(['alice']);
    h.store.markNotified('restart-a', 'alice');
    h.store.markNoticeTurnEnded('restart-a', 'alice');
    h.store.markNotified('restart-a', 'alice');
    expect(h.store.getState().notified.alice).toEqual({ at: 100, turnEnded: true });
    h.store.setState('cancelled');
    for (const method of ['markNotified', 'markNoticeTurnEnded']) {
      expect(() => h.store[method]('restart-a', 'alice')).toThrow('Invalid restart notice');
    }
    fs.writeFileSync(path.join(h.root, 'state.json'), '{');
    expect(() => h.notices.enqueue(h.session)).toThrow();
    fs.unlinkSync(path.join(h.root, 'state.json'));
    expect(h.notices.enqueue(h.session)).toBe(false);
    expect(() => h.store.markNotified('restart-a', 'alice')).toThrow('Invalid restart notice');
  });
});

it('holds a fresh PTY notice until the first ready screen', async () => {
  const h = wiredSetup('pty');
  h.context.finishInteractiveConstruction(h.session, 'room-a', null, '.', 'alice', false);
  await h.flush();
  expect(h.backendSend).not.toHaveBeenCalled();
  expect(h.store.getState().notified).toEqual({});
  h.session.iv.emit('pty-data', 'ready');
  h.releaseReady();
  await h.flush();
  h.context.enqueueRestartNotice(h.session);
  expect(h.backendSend).toHaveBeenCalledOnce();
  expect(h.store.getState().notified.alice).toBeDefined();
});

it('cleans up a throwing PTY notice dispatch and retries successfully', async () => {
  const h = wiredSetup('pty');
  const marker = new Set();
  h.context.inflightMarker = { noteTurnStart: id => marker.add(id), noteTurnEnd: id => marker.delete(id) };
  h.backendSend.mockImplementationOnce(() => { throw new Error('write failed'); });
  h.context.enqueueRestartNotice(h.session);
  await h.flush();
  expect(h.session.busy).toBe(false);
  expect(marker.size).toBe(0);
  expect(h.store.getState().notified).toEqual({});
  expect(h.session._deferredControls.restart_notice).toBeDefined();
  h.context.enqueueRestartNotice(h.session);
  await h.flush();
  expect(h.backendSend).toHaveBeenCalledTimes(2);
  expect(h.store.getState().notified.alice).toBeDefined();
});

it('retries failed notice turn completion on the idle sweep without resending', async () => {
  const h = wiredSetup('pty');
  h.context.loadPersistedSessions = () => ({});
  h.context.enqueueRestartNotice(h.session);
  await h.flush();
  h.session.busy = false;
  const end = vi.spyOn(h.store, 'markNoticeTurnEnded').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  h.context.endRestartNoticeTurn(h.session);
  expect(h.store.getState().notified.alice.turnEnded).toBe(false);
  h.context.queueRestartNotices();
  await h.flush();
  expect(end).toHaveBeenCalledTimes(2);
  expect(h.store.getState().notified.alice.turnEnded).toBe(true);
  expect(h.backendSend).toHaveBeenCalledOnce();
});

it('persists and publishes a fresh Codex identity before native startup without a pending restart', async () => {
  const h = wiredSetup('codex');
  h.store.setState('cancelled');
  const sessionFile = path.join(h.root, 'sessions.json');
  Object.assign(h.context, {
    normalizeAgent, getPersistedAgentState, mergeAgentStates, resolveNativeSessionIdForPersistence, snapshotAgentState,
    recentFolders: { touch: () => {} },
    loadPersistedSessions: () => fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : {},
    savePersistedSessions: data => fs.writeFileSync(sessionFile, JSON.stringify(data)),
    journalPublisher: { upsertConvo: vi.fn() },
  });
  h.load('function persistSession(', '\nfunction getPersistedSession(');
  h.load('function getPersistedSession(', '\n// Codex stores rollouts');
  h.load('function journalFlushForSession(', '\n// Room card');
  const session = h.context.createCodexSessionForRoom('room-b', '.');
  expect(fs.existsSync(sessionFile)).toBe(true);
  expect(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))['room-b'].journalConvoId).toBe('bob');
  expect(session.claudeSessionId).toBeNull();
  expect(h.context.journalPublisher.upsertConvo).toHaveBeenCalledWith('bob', { title: undefined });
  expect(session._journalConvoEstablished).toBe(true);
  await h.flush();
  expect(session.codex.send).not.toHaveBeenCalled();
});

function inputWiring() {
  const h = wiredSetup('pty');
  Object.assign(h.context, {
    dispatchJournalBridgeCommand: async () => false, dispatchPlanBuild: async () => false,
    dispatchJournalRescueKeystroke: async () => false, maybeResolveInteractivePrompt: () => false,
    armOperatorCompact: () => {}, journalPublishNotice: () => {}, JOURNAL_RESUME_NOTICE: 'Continue.',
    findSessionByClaudeSessionId: () => h.session, console: { warn() {}, log() {} },
    contextWindowForSession: () => 100000, hasQueuedCompact: () => false, markJournalOrigin, planQueueFlush,
    pendingMediaMirror: () => [], journalPublishUserItem: () => {}, journalMirrorUserMedia: () => {},
    validateControlParams, authorizeControl, JOURNAL_DEVICE_ID, JOURNAL_ONLY_ACTIONS, boxLabelForControl: () => 'box-a',
    controlOccupied: () => false, postControlNotice: () => {}, shouldCompactBefore: () => false,
    journalPublisher: { flushCursor() {} },
    switchModelInSession, switchEffortInSession, noteEffortWrite: () => {}, guardEffortDefault: () => {}, scheduleEffortSettle: () => {}, normalizeModelArg, bringAutoResumeForward: () => {},
    explicitModelFlag: () => ({}), journalStatus: () => {},
  });
  for (const name of ['journalRouteTextToSession', 'fireTimer', 'carryOnConvo', 'fireAutoResume', 'applyControlEffort', 'journalControlSession', 'journalHandleControlCommand']) {
    h.load(`async function ${name}(`, '\n}\n');
  }
  for (const name of ['journalResumeConvo', 'resumeSleepingSession', 'applyModelSwitch', 'switchEffortAndTrack', 'dispatchMergedFlush', 'flushQueue']) {
    h.load(`function ${name}(`, '\n}\n');
  }
  const shutdown = vi.fn();
  const key = { sha: 'head', env_hash: 'env', deps_stamp: 'deps' };
  const deps = { stateStore: h.store, runtime: {}, bootId: 'box-a', now: () => 100,
    quiet: () => ({ quiet: true, holders: [], probe_error: null }),
    readCode: () => ({ sha: 'head', code: null }), cacheKey: () => key,
    getPreflight: () => ({ status: 'ok', key, at: 100 }), listHeld: () => [], listMarkers: () => ({}),
    writeStamp: () => {}, deleteStamp: () => {}, publishRestartStatus: () => {}, gracefulShutdown: shutdown,
  };
  const latch = createRestartLatch(deps);
  h.context.restartLatch = latch;
  return { ...h, deps, latch, shutdown, ready: () => latch.onReady({ sha: 'head', state: h.store.getState() }) };
}

it.each(['journalRouteTextToSession', 'fireTimer', 'carryOnConvo', 'fireAutoResume', 'applyControlSteps', 'applyControlEffort', 'journalControlSession', 'journalHandleControlCommand', 'flushQueue'])(
  'holds the latch while %s input is in flight and releases it after delivery', async name => {
    const h = inputWiring();
    let release;
    let task;
    const waiting = new Promise(resolve => { release = resolve; });
    h.context.dispatchJournalBridgeCommand = () => waiting;
    if (name === 'journalRouteTextToSession') task = h.context[name](h.session, 'Continue.');
    if (name === 'fireTimer') task = h.context[name]({ convoId: 'alice', id: 'bob', text: 'Continue.' });
    if (name === 'carryOnConvo') task = h.context[name]('alice', h.session, () => {}, 'Continue.');
    if (name === 'fireAutoResume') task = h.context[name]('room-a', 'alice', { text: 'Continue.' });
    if (name === 'applyControlSteps') task = h.context[name](h.session, [{ op: 'compact', command: 'Continue.' }]);
    if (name === 'applyControlEffort') {
      h.session._controlTypedAt = Date.now();
      h.context.setTimeout = fn => { waiting.then(fn); };
      h.context.switchEffortAndTrack = session => session.iv.sendText('/effort high');
      h.context.armEffortAutoConfirm = () => {};
      task = h.context[name](h.session, 'high', { sendReply() {} });
    }
    if (name === 'journalControlSession') {
      h.context.coordinatorLookup = { snapshot: () => ({ known: false }), refresh: () => waiting };
      task = h.context[name]({ action: 'alert', convo_id: 'alice', message: 'Continue.' }, { fromDeviceId: JOURNAL_DEVICE_ID });
    }
    if (name === 'journalHandleControlCommand') {
      h.context.JOURNAL_CONTROL_CONVO_ID = 'bob';
      h.context.ALLOWED_USER_IDS = ['alice'];
      h.context.classifyJournalControlCommand = () => ({ cmd: 'status', normalizedText: 'Continue.' });
      h.context.handleCommand = async () => {
        await waiting;
        return h.context.sendTextToSession(h.session, 'Continue.', { skipJournalMirror: true });
      };
      task = h.context[name]('Continue.');
    }
    if (name === 'flushQueue') {
      h.session.agent = 'codex'; h.session.busy = true;
      h.session.codex = { transport: 'app-server', steer: () => waiting };
      Object.assign(h.context, { planQueueFlush: () => ({ blocks: [{ type: 'text', text: 'Continue.' }], mirrorText: '' }),
        pendingMediaMirror: () => [], finalizeSentQueue: () => {},
      });
      expect(h.context.flushQueue(h.session, [[{ type: 'text', text: 'Continue.' }]], { convoId: 'alice', entries: [] })).toBe('deferred');
      task = waiting;
    }
    expect(h.ready().latched).toBe(false);
    expect(h.shutdown).not.toHaveBeenCalled();
    release(name === 'flushQueue' ? true : name === 'journalControlSession' ? { known: true, convoId: 'alice' } : false);
    await task;
    await h.flush();
    if (name === 'flushQueue') expect(h.context.commitDispatchedUserTurn).toHaveBeenCalledOnce();
    else expect(h.backendSend).toHaveBeenCalledOnce();
    expect(h.ready().latched).toBe(true);
    expect(h.shutdown).toHaveBeenCalledOnce();
  });

it.each(['journalRouteTextToSession', 'fireTimer', 'carryOnConvo', 'fireAutoResume'])(
  'delivers valid %s input entering after the stamp while suppressing shutdown', async name => {
    const h = inputWiring();
    let task;
    h.deps.onStep = step => {
      if (step !== 'stamp') return;
      if (name === 'journalRouteTextToSession') task = h.context[name](h.session, 'Continue.');
      if (name === 'fireTimer') task = h.context[name]({ convoId: 'alice', id: 'bob', text: 'Continue.' });
      if (name === 'carryOnConvo') task = h.context[name]('alice', h.session, () => {}, 'Continue.');
      if (name === 'fireAutoResume') task = h.context[name]('room-a', 'alice', { text: 'Continue.' });
    };
    h.context.restartLatch = createRestartLatch(h.deps);
    expect(h.context.restartLatch.onReady({ sha: 'head', state: h.store.getState() }).latched).toBe(false);
    await task;
    expect(h.backendSend).toHaveBeenCalledWith('Continue.');
    expect(h.store.getState().state).toBe('pending');
    expect(h.shutdown).not.toHaveBeenCalled();
  });

it('resumes a persisted conversation after the stamp and delivers input when ready', async () => {
  const h = inputWiring();
  h.session.alive = false;
  const prev = { sessionId: 'alice', journalConvoId: 'alice', workdir: '.', chatHistory: [] };
  h.context.loadPersistedSessions = () => ({ 'room-a': prev });
  h.context.createSession = (roomId, cwd, resumeSessionId) => {
    h.session.alive = true;
    return h.context.finishInteractiveConstruction(h.session, roomId, resumeSessionId, cwd, 'alice', false);
  };
  let resumed;
  h.deps.onStep = step => { if (step === 'stamp') resumed = h.context.journalResumeConvo('alice'); };
  h.context.restartLatch = createRestartLatch(h.deps);
  expect(h.context.restartLatch.onReady({ sha: 'head', state: h.store.getState() }).latched).toBe(false);
  expect(resumed).toBe(h.session);
  expect(h.context.sendToSession(resumed, [{ type: 'text', text: 'Continue.' }], { skipJournalMirror: true })).toBe(true);
  h.session.iv.emit('pty-data', 'ready');
  h.releaseReady();
  await h.flush();
  expect(h.backendSend).toHaveBeenCalledWith('Continue.');
  expect(h.shutdown).not.toHaveBeenCalled();
});

it('unlatches an interactive model control after the stamp and writes it to the PTY', () => {
  const h = inputWiring();
  h.deps.onStep = step => {
    if (step === 'stamp') expect(h.context.applyModelSwitch('room-a', h.session, 'sonnet', { sendReply() {} })).toBe(true);
  };
  h.context.restartLatch = createRestartLatch(h.deps);
  expect(h.context.restartLatch.onReady({ sha: 'head', state: h.store.getState() }).latched).toBe(false);
  expect(h.backendSend).toHaveBeenCalledWith('/model sonnet');
  expect(h.store.getState().state).toBe('pending');
  expect(h.shutdown).not.toHaveBeenCalled();
});

it('unlatches an interactive effort control after the stamp and writes it to the PTY', () => {
  const h = inputWiring();
  h.deps.onStep = step => {
    if (step === 'stamp') expect(h.context.switchEffortAndTrack(h.session, 'high', () => {})).toBe(true);
  };
  h.context.restartLatch = createRestartLatch(h.deps);
  expect(h.context.restartLatch.onReady({ sha: 'head', state: h.store.getState() }).latched).toBe(false);
  expect(h.backendSend).toHaveBeenCalledWith('/effort high');
  expect(h.store.getState().state).toBe('pending');
  expect(h.shutdown).not.toHaveBeenCalled();
});

it('reports a failed durable input unlatch without dispatching or rejecting carry-on', async () => {
  const h = inputWiring();
  const persist = h.store.setState.bind(h.store);
  h.store.setState = (state, patch) => {
    if (state === 'pending') throw new Error('storage unavailable');
    return persist(state, patch);
  };
  h.context.journalPublishNotice = vi.fn();
  let task;
  h.deps.onStep = step => {
    if (step === 'stamp') task = h.context.carryOnConvo('alice', h.session, () => {});
  };
  h.context.restartLatch = createRestartLatch(h.deps);
  expect(h.context.restartLatch.onReady({ sha: 'head', state: h.store.getState() }).latched).toBe(false);
  await expect(task).resolves.toBeUndefined();
  expect(h.context.journalPublishNotice).toHaveBeenCalledWith('alice', '⚠️ Could not carry on: storage unavailable');
  expect(h.backendSend).not.toHaveBeenCalled();
  expect(h.shutdown).not.toHaveBeenCalled();
});
