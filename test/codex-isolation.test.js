import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION,
  createCodexConvoTracker,
} from '../lib/codex-convos.js';
import {
  DEFAULT_CODEX_BREAKER_THRESHOLD,
  createCodexWatcherIsolation,
} from '../lib/codex-watcher.js';

const RUN_1 = '1722600000000-1234-abcd';
const RUN_2 = '1722600000001-1234-beef';

function runId(index) {
  return `${String(1722600000000 + index)}-1234-${index.toString(16).padStart(4, '0')}`;
}

function makeHarness(sessionId = 'session-1', options = {}) {
  const calls = { upsertConvo: [], publishText: [] };
  const publisher = {
    upsertConvo(convoId, opts) { calls.upsertConvo.push({ convoId, opts }); },
    publishText(convoId, payload) { calls.publishText.push({ convoId, payload }); },
  };
  const tracker = createCodexConvoTracker({
    publisher,
    getParentConvoId: () => `parent-${sessionId}`,
    log: { warn() {} },
    ...options,
  });
  const audits = [];
  const log = {
    info(_message, record) { audits.push(record); },
    warn() {},
  };
  const isolation = createCodexWatcherIsolation({
    sessionId,
    publisher,
    getParentConvoId: () => `parent-${sessionId}`,
    terminalize: (id, outcome) => tracker.terminalize(id, outcome),
    terminalizeAll: () => tracker.interruptAll(),
    log,
  });
  return { calls, tracker, isolation, audits };
}

describe('codex watcher isolation', () => {
  it('contains a decoder throw and terminalizes only the abandoned run', () => {
    const { calls, tracker, isolation } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });
    tracker.ensureChild({ runId: RUN_2 });
    calls.upsertConvo.length = 0;

    expect(() => isolation.guardRun(RUN_1, 'decoder', () => {
      throw new Error('bad event');
    })).not.toThrow();
    isolation.guardRun(RUN_2, 'decoder', () => 'healthy');
    tracker.terminalize(RUN_2, 'completed');

    expect(calls.upsertConvo.map(call => ({
      runId: call.convoId.split(':').at(-1),
      outcome: call.opts.sessionOutcome,
    }))).toEqual([
      { runId: RUN_1, outcome: 'interrupted' },
      { runId: RUN_2, outcome: 'completed' },
    ]);
    expect(isolation.isDisabled()).toBe(false);
  });

  it('trips at five throws, posts one durable note, and is per session', () => {
    const first = makeHarness('first');
    const second = makeHarness('second');

    for (let index = 0; index < DEFAULT_CODEX_BREAKER_THRESHOLD; index += 1) {
      const id = runId(index);
      first.tracker.ensureChild({ runId: id });
      first.isolation.guardRun(id, 'decoder', () => { throw new Error('bad event'); });
    }

    expect(first.isolation.isDisabled()).toBe(true);
    expect(first.calls.publishText).toEqual([{
      convoId: 'parent-first',
      payload: {
        body: '⚙ codex live-view disabled after repeated errors — reviews unaffected',
        from: 'assistant',
      },
    }]);
    expect(first.isolation.guardSession('poll', () => 'not run')).toBeUndefined();
    expect(first.calls.publishText).toHaveLength(1);
    expect(second.isolation.guardSession('poll', () => 'still running')).toBe('still running');
    expect(second.isolation.isDisabled()).toBe(false);
  });

  it('interrupts other in-flight runs only when the breaker trips', () => {
    const { tracker, isolation } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });
    tracker.ensureChild({ runId: RUN_2 });

    for (let index = 0; index < DEFAULT_CODEX_BREAKER_THRESHOLD - 1; index += 1) {
      isolation.guardSession('poll', () => { throw new Error('scan failed'); });
    }
    expect(tracker.childFor(RUN_1)?.terminal).toBe(false);
    expect(tracker.childFor(RUN_2)?.terminal).toBe(false);

    isolation.guardSession('poll', () => { throw new Error('scan failed'); });
    expect(tracker.childFor(RUN_1)?.outcome).toBe('interrupted');
    expect(tracker.childFor(RUN_2)?.outcome).toBe('interrupted');
  });

  it('emits at most one structured start and terminal audit record per run', () => {
    const { isolation, audits } = makeHarness();
    isolation.auditStart({
      runId: RUN_1,
      label: 'Review',
      deadlineTs: 1722600100000,
    });
    isolation.auditStart({ runId: RUN_1, label: 'duplicate' });
    isolation.auditTerminal(RUN_1, {
      winningSignal: 'clean-exit',
      livenessEvidence: { pidAlive: false },
      durableEventCount: 7,
      droppedEventCount: 2,
      redactionDropCount: 1,
      finalPostLanded: true,
    });
    isolation.auditTerminal(RUN_1, {
      winningSignal: 'duplicate',
      finalPostLanded: false,
    });

    expect(audits).toEqual([
      {
        event: 'codex_run_start',
        runId: RUN_1,
        sessionId: 'session-1',
        label: null,
        deadlineTs: 1722600100000,
      },
      {
        event: 'codex_run_terminal',
        runId: RUN_1,
        sessionId: 'session-1',
        winningSignal: 'clean-exit',
        livenessEvidence: { pidAlive: false },
        durableEventCount: 7,
        droppedEventCount: 2,
        redactionDropCount: 1,
        breakerState: { disabled: false, errorCount: 0 },
        finalPostLanded: true,
      },
    ]);
  });

  it('does not copy descendant-controlled labels or error messages into logs', () => {
    const warnings = [];
    const auditRecords = [];
    const isolation = createCodexWatcherIsolation({
      sessionId: 'session-secret-test',
      terminalize() {},
      log: {
        info(_message, record) { auditRecords.push(record); },
        warn(message) { warnings.push(message); },
      },
    });

    isolation.auditStart({ runId: RUN_1, label: 'secret-bearing-label' });
    isolation.guardRun(RUN_1, 'decoder', () => {
      throw new Error('secret-bearing-error');
    });

    expect(JSON.stringify({ warnings, auditRecords })).not.toContain('secret-bearing');
  });

  it('contains rejected async entry points and records the run as interrupted', async () => {
    const { tracker, isolation } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });

    await expect(isolation.guardRun(
      RUN_1,
      'publish',
      async () => { throw new Error('journal failed'); },
    )).resolves.toBeUndefined();
    expect(tracker.childFor(RUN_1)).toMatchObject({ terminal: true, outcome: 'interrupted' });
  });
});

describe('per-session codex child creation cap', () => {
  it('bounds distinct children, posts one note, and does not affect another session', () => {
    const first = makeHarness('first');
    const second = makeHarness('second');

    for (let index = 0; index < DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION + 3; index += 1) {
      first.tracker.ensureChild({ runId: runId(index) });
    }
    second.tracker.ensureChild({ runId: RUN_1 });

    const firstCreates = first.calls.upsertConvo.filter(call => call.opts.sessionState === 'running');
    expect(firstCreates).toHaveLength(DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION);
    expect(first.calls.publishText).toEqual([{
      convoId: 'parent-first',
      payload: {
        body: '⚙ codex live-view child limit reached — additional reviews are not shown',
        from: 'assistant',
      },
    }]);
    expect(second.calls.upsertConvo).toHaveLength(1);
    expect(second.calls.publishText).toHaveLength(0);
  });

  it('does not consume capacity when child publication fails', () => {
    const publisher = {
      upsertConvo: vi.fn()
        .mockImplementationOnce(() => { throw new Error('offline'); })
        .mockImplementation(() => {}),
      publishText() {},
    };
    const tracker = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => 'parent',
      maxChildren: 1,
      log: { warn() {} },
    });

    expect(tracker.ensureChild({ runId: RUN_1 })).toBeNull();
    expect(tracker.ensureChild({ runId: RUN_2 })).not.toBeNull();
  });
});
