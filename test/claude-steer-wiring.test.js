// Behavioural tests for the index.js side of mid-turn Claude steering: the
// journal busy branch, the steer writer, the result-handler hold and the
// backstop. The real functions are lifted out of index.js and run in a vm
// context with stubbed collaborators.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as steer from '../lib/claude-steer.js';
import { markJournalOrigin } from '../lib/queue-flush.js';
import { hasQueuedCompact, isCompactCommand } from '../lib/compact-priority.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start === -1) start = source.indexOf(`\nasync function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.js`);
  start += 1;
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const LIFTED = [
  'bumpTurnGeneration', 'clearPendingInterrupt', 'steerIntoRunningTurn', 'holdTurnForSteer',
  'releaseStaleSteerHold', 'handleClaudeEvent', 'journalRouteTextToSession',
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'super']);

function setup({ session: overrides = {}, steerEnabled = true } = {}) {
  const lifted = LIFTED.map(sourceOf).join('\n');
  const stdinWrite = vi.fn();
  const session = {
    agent: 'claude', alive: true, busy: true, roomId: 'room', turnGeneration: 7, _cliInitGeneration: 7,
    proc: { stdin: { write: stdinWrite, writable: true } }, queuedMessages: null, queueNotifications: [],
    responseBuffer: 'partial reply', toolCalls: ['tool A'], turnCount: 0,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 },
    ...overrides,
  };
  const replies = [];
  const ctxObj = { sendReply: vi.fn(async (m) => { replies.push(m); }), sendHtml: vi.fn(), sender: 'user' };
  const explicit = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Map, Set, Promise, Math, Number, String, Object, Array, Boolean, Error,
    setTimeout, clearTimeout,
    ...steer,
    CLAUDE_STEER_ENABLED: steerEnabled,
    AGENT_CODEX: 'codex',
    randomUUID: () => 'steer-uuid-1',
    markJournalOrigin, hasQueuedCompact, isCompactCommand,
    restartLatch: undefined,
    inflightMarker: { touch: vi.fn(), noteTurnStart: vi.fn(), noteTurnEnd: vi.fn() },
    foreignSessions: { end: vi.fn() },
    planItems: { opened: vi.fn() },
    journalPublisher: { flushCursor: vi.fn() },
    journalInputConsumer: { queueRelease: null },
    journalConvoIdFor: () => 'convo',
    journalSessionCommandCtx: () => ctxObj,
    dispatchJournalBridgeCommand: vi.fn(async () => false),
    dispatchPlanBuild: vi.fn(async () => false),
    dispatchJournalRescueKeystroke: vi.fn(async () => false),
    dispatchBusyQueueMagicWord: vi.fn(async () => false),
    runCodexControl: vi.fn(async () => false),
    effortFlowHoldsInput: () => false,
    isIvSlashPassthrough: () => false,
    notifyQueuedMessage: vi.fn(async () => {}),
    dispatchDeferredCommand: vi.fn(() => false),
    flushPendingSessionQueue: vi.fn(() => true),
    maybeFlushRoomDelivery: vi.fn(),
    commitDispatchedUserTurn: vi.fn(),
    sendTextToSession: vi.fn(() => true),
    extractTextContent: (event) => event.result || '',
    isLoginExpiredText: () => false,
    isSidechainEvent: () => false,
    sessionHasBackgroundWork: () => false,
    journalPublishUserItem: vi.fn(),
    // Passed by reference (not called) in the busy branch.
    formatQueueSummary: vi.fn(), flushQueue: vi.fn(), clearQueueNotifications: vi.fn(),
    emitRelease: vi.fn(), escapeHtml: (t) => t,
  };
  // Every other function the lifted code calls becomes an inert stub; they
  // are output/journal side effects these tests do not assert on.
  const context = { ...explicit };
  for (const [, name] of lifted.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (KEYWORDS.has(name) || name in context || LIFTED.includes(name)) continue;
    context[name] = vi.fn();
  }
  for (const [name] of lifted.matchAll(/(?<![.\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g)) {
    if (!(name in context)) context[name] = null;
  }
  vm.createContext(context);
  vm.runInContext(lifted, context);
  return { session, context, stdinWrite, replies, ctxObj };
}

const lifecycle = (state, uuid = 'steer-uuid-1') => ({ type: 'command_lifecycle', command_uuid: uuid, state });
const result = (text = 'done') => ({ type: 'result', result: text, usage: { input_tokens: 1, output_tokens: 1 } });

afterEach(() => vi.useRealTimers());

describe('journal text into a running Claude turn', () => {
  it('steers plain typed text: one stdin line with a uuid, nothing queued, notice posted, turn untouched', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'also check the tests', { steerable: true });
    expect(h.stdinWrite).toHaveBeenCalledTimes(1);
    const line = JSON.parse(h.stdinWrite.mock.calls[0][0]);
    expect(line).toMatchObject({ type: 'user', uuid: 'steer-uuid-1', session_id: '', parent_tool_use_id: null });
    expect(line.message.content).toEqual([{ type: 'text', text: 'also check the tests' }]);
    expect(h.session.queuedMessages).toBeNull();
    expect(h.context.notifyQueuedMessage).not.toHaveBeenCalled();
    expect(h.replies).toEqual([steer.STEER_NOTICE]);
    expect(h.session.responseBuffer).toBe('partial reply');
    expect(h.session.toolCalls).toEqual(['tool A']);
    expect(h.session.turnGeneration).toBe(7);
    expect(h.session.busy).toBe(true);
    expect(h.session._steered.get('steer-uuid-1').state).toBe('written');
    expect(h.context.commitDispatchedUserTurn).toHaveBeenCalledWith(h.session, 'also check the tests', null);
    expect(h.context.journalSessionState).not.toHaveBeenCalled();
  });

  it('falls back to the queue when the stdin write throws', async () => {
    const h = setup();
    h.stdinWrite.mockImplementation(() => { throw new Error('EPIPE'); });
    await h.context.journalRouteTextToSession(h.session, 'also check the tests', { steerable: true });
    expect(h.session.queuedMessages).toHaveLength(1);
    expect(h.context.notifyQueuedMessage).toHaveBeenCalledTimes(1);
    expect(h.replies).toEqual([]);
    expect(h.session._steered ?? null).toBeNull();
  });

  const queuedCases = [
    ['a non-empty queue', { queuedMessages: [markJournalOrigin([{ type: 'text', text: 'earlier' }])] }, {}],
    ['a pending interrupt', { pendingInterrupt: { cancel() {} } }, {}],
    ['a turn the CLI has not opened yet', { _cliInitGeneration: 6 }, {}],
    ['a Codex session', { agent: 'codex' }, {}],
    ['an interactive session', { iv: { alive: true } }, {}],
    ['a turn another person started', { foreignTurn: { person: 'p' } }, {}],
    ['a non-user source (timer, reminder, carry-on)', {}, { steerable: false }],
  ];
  it.each(queuedCases)('queues as before for %s', async (_label, sessionOverrides, opts) => {
    const h = setup({ session: sessionOverrides });
    const before = h.session.queuedMessages?.length || 0;
    await h.context.journalRouteTextToSession(h.session, 'also check the tests', { steerable: true, ...opts });
    expect(h.stdinWrite).not.toHaveBeenCalled();
    expect(h.session.queuedMessages).toHaveLength(before + 1);
    expect(h.context.notifyQueuedMessage).toHaveBeenCalledTimes(1);
  });

  it('queues a /compact as before (and it still jumps the queue)', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, '/compact', { steerable: true });
    expect(h.stdinWrite).not.toHaveBeenCalled();
    expect(h.session.queuedMessages).toHaveLength(1);
  });

  it('queues everything when MATRON_CLAUDE_STEER is off', async () => {
    const h = setup({ steerEnabled: false });
    await h.context.journalRouteTextToSession(h.session, 'also check the tests', { steerable: true });
    expect(h.stdinWrite).not.toHaveBeenCalled();
    expect(h.session.queuedMessages).toHaveLength(1);
  });

  it('journalOnText is the only caller that marks text steerable', () => {
    const calls = [...source.matchAll(/journalRouteTextToSession\([^)]*steerable: true/g)];
    expect(calls).toHaveLength(1);
    expect(sourceOf('journalOnText')).toContain('steerable: true');
  });
});

describe('result handling with a steered message', () => {
  it('folded (started before result): normal turn end, queue flushed', () => {
    const h = setup({ session: { queuedMessages: [[{ type: 'text', text: 'q' }]] } });
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, lifecycle('queued'));
    h.context.handleClaudeEvent(h.session, lifecycle('started'));
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(false);
    expect(h.context.flushPendingSessionQueue).toHaveBeenCalledTimes(1);
    expect(h.context.journalSessionState).toHaveBeenCalledWith(h.session, 'waiting');
    expect(h.session._steered).toBeNull();
  });

  it('next-turn case: holds busy through the steered turn, then ends normally', () => {
    vi.useFakeTimers();
    const h = setup({ session: { queuedMessages: [[{ type: 'text', text: 'q' }]] } });
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, lifecycle('queued'));
    h.context.handleClaudeEvent(h.session, result('first reply'));
    expect(h.context.flushResponse).toHaveBeenCalledTimes(1);
    expect(h.session.busy).toBe(true);
    expect(h.session.turnGeneration).toBe(8);
    expect(h.session.responseBuffer).toBe('');
    expect(h.session.toolCalls).toEqual([]);
    expect(h.context.flushPendingSessionQueue).not.toHaveBeenCalled();
    expect(h.context.dispatchDeferredCommand).not.toHaveBeenCalled();
    expect(h.context.maybeFlushRoomDelivery).not.toHaveBeenCalled();
    expect(h.context.journalSessionState).not.toHaveBeenCalledWith(h.session, 'waiting');
    // Turn 1's marker is never cleared during the hold, so it still covers the held turn.
    expect(h.context.inflightMarker.noteTurnEnd).not.toHaveBeenCalled();
    expect(h.session._steerHold).toBeTruthy();

    h.context.handleClaudeEvent(h.session, lifecycle('started'));
    expect(h.session._steerHold).toBeNull();
    h.context.handleClaudeEvent(h.session, { type: 'system', subtype: 'init' });
    expect(h.session._cliInitGeneration).toBe(8);
    h.context.handleClaudeEvent(h.session, lifecycle('completed'));
    h.context.handleClaudeEvent(h.session, result('second reply'));
    expect(h.session.busy).toBe(false);
    expect(h.context.flushPendingSessionQueue).toHaveBeenCalledTimes(1);
    expect(h.context.journalSessionState).toHaveBeenCalledWith(h.session, 'waiting');

    vi.advanceTimersByTime(steer.STEER_HOLD_BACKSTOP_MS * 2);
    expect(h.context.flushPendingSessionQueue).toHaveBeenCalledTimes(1);
  });

  it('a written entry with no lifecycle event yet also holds', () => {
    vi.useFakeTimers();
    const h = setup();
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(true);
  });

  it('backstop: nothing starts, so busy is released and the queue flushed', () => {
    vi.useFakeTimers();
    const h = setup({ session: { queuedMessages: [[{ type: 'text', text: 'q' }]] } });
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, lifecycle('queued'));
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(true);
    vi.advanceTimersByTime(steer.STEER_HOLD_BACKSTOP_MS);
    expect(h.session.busy).toBe(false);
    expect(h.context.flushPendingSessionQueue).toHaveBeenCalledTimes(1);
    expect(h.context.journalSessionState).toHaveBeenCalledWith(h.session, 'waiting');
    expect(h.context.inflightMarker.noteTurnEnd).toHaveBeenCalled();
    expect(h.session._steered).toBeNull();
  });

  it('a second result while still holding (no init/started) ends the turn instead of holding again', () => {
    vi.useFakeTimers();
    const h = setup();
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(true);
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(false);
    expect(h.session._steerHold).toBeNull();
  });

  it('an interrupted turn still holds, and the turn-end clears the pending interrupt', () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const h = setup();
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.session.pendingInterrupt = { cancel };
    h.context.handleClaudeEvent(h.session, result());
    expect(h.session.busy).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.session.pendingInterrupt).toBeNull();
  });

  it('a backstop is a no-op once the session is gone', () => {
    vi.useFakeTimers();
    const h = setup();
    h.context.steerIntoRunningTurn(h.session, [{ type: 'text', text: 'steer' }]);
    h.context.handleClaudeEvent(h.session, result());
    h.session.alive = false;
    vi.advanceTimersByTime(steer.STEER_HOLD_BACKSTOP_MS);
    expect(h.context.flushPendingSessionQueue).not.toHaveBeenCalled();
  });

  it('command_lifecycle for an unknown uuid is ignored and never mirrored as output', () => {
    const h = setup();
    h.context.handleClaudeEvent(h.session, lifecycle('started', 'not-ours'));
    expect(h.session._steered ?? null).toBeNull();
    expect(h.context.flushResponse).not.toHaveBeenCalled();
    expect(h.context.journalPublishUserItem).not.toHaveBeenCalled();
    expect(h.session.busy).toBe(true);
    expect(h.session.responseBuffer).toBe('partial reply');
  });
});
