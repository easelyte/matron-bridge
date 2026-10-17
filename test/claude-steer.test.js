import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STEER_HOLD_BACKSTOP_MS, applySteerLifecycle, beginSteerHold, buildSteerLine, canSteerClaude,
  claudeSteerEnabled, dropUnstartedSteers, endSteerHold, noteSteerWritten, resetClaudeSteer, steerPendingTurn,
} from '../lib/claude-steer.js';

function steerable(overrides = {}) {
  return {
    agent: 'claude', alive: true, busy: true, turnGeneration: 4, _cliInitGeneration: 4,
    proc: { stdin: { write: vi.fn(), writable: true } }, queuedMessages: null,
    ...overrides,
  };
}
const ctx = (overrides = {}) => ({ enabled: true, origin: 'user', text: 'also check the tests', ...overrides });

describe('claudeSteerEnabled', () => {
  it('defaults on and turns off only for 0/false/off', () => {
    expect(claudeSteerEnabled({})).toBe(true);
    expect(claudeSteerEnabled({ MATRON_CLAUDE_STEER: '1' })).toBe(true);
    expect(claudeSteerEnabled({ MATRON_CLAUDE_STEER: 'yes' })).toBe(true);
    for (const v of ['0', 'false', 'off', 'OFF', ' False ']) {
      expect(claudeSteerEnabled({ MATRON_CLAUDE_STEER: v })).toBe(false);
    }
  });
});

describe('canSteerClaude', () => {
  it('accepts plain user text into a running, initialised print-mode turn', () => {
    expect(canSteerClaude(steerable(), ctx())).toEqual({ ok: true });
  });

  const cases = [
    ['disabled', s => s, { enabled: false }],
    ['not-user-text', s => s, { origin: 'reminder' }],
    ['not-user-text', s => s, { origin: undefined }],
    ['codex', s => { s.agent = 'codex'; }, {}],
    ['codex', s => { s.codex = { transport: 'app-server' }; }, {}],
    ['interactive', s => { s.iv = { alive: true }; }, {}],
    ['idle', s => { s.busy = false; }, {}],
    ['no-process', s => { s.alive = false; }, {}],
    ['no-process', s => { s.proc = null; }, {}],
    ['no-process', s => { s.proc.stdin.destroyed = true; }, {}],
    ['no-process', s => { s.proc.stdin.writable = false; }, {}],
    ['no-process', s => { s._autoStopped = true; }, {}],
    ['input-held', s => s, { inputHeld: true }],
    ['pre-init', s => { s._cliInitGeneration = 3; }, {}],
    ['pre-init', s => { delete s._cliInitGeneration; }, {}],
    ['interrupt-pending', s => { s.pendingInterrupt = { cancel() {} }; }, {}],
    ['compact-running', s => { s._operatorCompactPending = true; }, {}],
    ['deferred-command', s => { s._deferredCommandText = '!restart'; }, {}],
    ['deferred-control', s => { s._deferredControls = { turn: { id: 'x' } }; }, {}],
    ['restart-pending', s => { s._selfRestartPending = true; }, {}],
    ['foreign-turn', s => { s.foreignTurn = { person: 'someone' }; }, {}],
    ['awaiting-answer', s => { s.waitingForAnswer = true; }, {}],
    ['awaiting-answer', s => { s.pendingQuestions = [{ question: 'q' }]; }, {}],
    ['awaiting-answer', s => { s.pendingPlan = 'plan'; }, {}],
    ['queue-not-empty', s => { s.queuedMessages = [[{ type: 'text', text: 'earlier' }]]; }, {}],
    ['queue-not-empty', s => { s.queuedMessages = [[{ type: 'text', text: '/compact' }]]; }, {}],
    ['empty', s => s, { text: '   ' }],
    ['command', s => s, { text: '/compact' }],
    ['command', s => s, { text: '//literal' }],
    ['command', s => s, { text: '!esc' }],
    ['magic-word', s => s, { text: 'send' }],
    ['magic-word', s => s, { text: 'Cancel' }],
    ['magic-word', s => s, { text: 'interrupt' }],
  ];
  it.each(cases)('refuses with %s', (reason, mutate, ctxOverrides) => {
    const session = steerable();
    mutate(session);
    expect(canSteerClaude(session, ctx(ctxOverrides))).toEqual({ ok: false, reason });
  });

  it('treats an empty parked-controls object as nothing parked', () => {
    expect(canSteerClaude(steerable({ _deferredControls: {} }), ctx())).toEqual({ ok: true });
  });
});

describe('buildSteerLine', () => {
  it('writes the normal user message plus the lifecycle fields', () => {
    const line = buildSteerLine([{ type: 'text', text: 'hi' }], 'u-1');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user', uuid: 'u-1', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
  });
});

describe('lifecycle bookkeeping', () => {
  afterEach(() => vi.useRealTimers());

  it('tracks state per uuid, never backwards, and deletes on completed', () => {
    const s = {};
    noteSteerWritten(s, 'a', 1);
    expect(steerPendingTurn(s)).toBe(true);
    expect(applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'a', state: 'queued' })).toBe(true);
    expect(s._steered.get('a').state).toBe('queued');
    expect(steerPendingTurn(s)).toBe(true);
    applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'a', state: 'started' });
    applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'a', state: 'queued' });
    expect(s._steered.get('a').state).toBe('started');
    expect(steerPendingTurn(s)).toBe(false);
    applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'a', state: 'completed' });
    expect(s._steered.has('a')).toBe(false);
  });

  it('ignores unknown uuids and non-lifecycle events', () => {
    const s = {};
    noteSteerWritten(s, 'a');
    expect(applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'other', state: 'started' })).toBe(true);
    expect(s._steered.get('a').state).toBe('written');
    expect(applySteerLifecycle({}, { type: 'command_lifecycle', command_uuid: 'x', state: 'queued' })).toBe(true);
    expect(applySteerLifecycle(s, { type: 'assistant' })).toBe(false);
  });

  it('a started event ends an armed hold before the backstop', () => {
    vi.useFakeTimers();
    const s = {};
    noteSteerWritten(s, 'a');
    const onBackstop = vi.fn();
    beginSteerHold(s, { onBackstop });
    applySteerLifecycle(s, { type: 'command_lifecycle', command_uuid: 'a', state: 'started' });
    expect(s._steerHold).toBeNull();
    vi.advanceTimersByTime(STEER_HOLD_BACKSTOP_MS * 2);
    expect(onBackstop).not.toHaveBeenCalled();
  });

  it('the backstop drops unstarted entries and then calls back', () => {
    vi.useFakeTimers();
    const s = {};
    noteSteerWritten(s, 'a');
    noteSteerWritten(s, 'b');
    s._steered.get('b').state = 'started';
    const onBackstop = vi.fn(() => {
      expect(steerPendingTurn(s)).toBe(false);
    });
    beginSteerHold(s, { onBackstop });
    vi.advanceTimersByTime(STEER_HOLD_BACKSTOP_MS - 1);
    expect(onBackstop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onBackstop).toHaveBeenCalledTimes(1);
    expect(s._steered.has('a')).toBe(false);
    expect(s._steered.has('b')).toBe(true);
    expect(s._steerHold).toBeNull();
  });

  it('endSteerHold and resetClaudeSteer cancel the timer', () => {
    vi.useFakeTimers();
    const s = {};
    const onBackstop = vi.fn();
    beginSteerHold(s, { onBackstop });
    endSteerHold(s);
    beginSteerHold(s, { onBackstop });
    noteSteerWritten(s, 'a');
    resetClaudeSteer(s);
    expect(s._steered).toBeNull();
    expect(s._steerHold).toBeNull();
    vi.advanceTimersByTime(STEER_HOLD_BACKSTOP_MS * 2);
    expect(onBackstop).not.toHaveBeenCalled();
  });

  it('dropUnstartedSteers keeps started entries', () => {
    const s = {};
    noteSteerWritten(s, 'a');
    noteSteerWritten(s, 'b');
    s._steered.get('b').state = 'started';
    dropUnstartedSteers(s);
    expect([...s._steered.keys()]).toEqual(['b']);
  });
});
