import { describe, expect, it, vi } from 'vitest';
import {
  CHILD_STATE_TERMINAL_PENDING,
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
    publishText(convoId, payload, publishOptions) {
      calls.publishText.push({ convoId, payload, options: publishOptions });
    },
  };
  const tracker = createCodexConvoTracker({
    sessionId,
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
    isAdmittedRun: id => tracker.hasChild(id),
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

  it('disables a failed run without counting later callbacks or affecting a sibling', () => {
    const { tracker, isolation } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });
    tracker.ensureChild({ runId: RUN_2 });
    const repeatedOperation = vi.fn(() => { throw new Error('still malformed'); });
    const siblingOperation = vi.fn(() => 'healthy');

    isolation.guardRun(RUN_1, 'decoder', () => { throw new Error('bad event'); });
    for (let index = 0; index < DEFAULT_CODEX_BREAKER_THRESHOLD + 1; index += 1) {
      isolation.guardRun(RUN_1, 'decoder', repeatedOperation);
    }

    expect(isolation.guardRun(RUN_2, 'decoder', siblingOperation)).toBe('healthy');
    expect(repeatedOperation).not.toHaveBeenCalled();
    expect(siblingOperation).toHaveBeenCalledOnce();
    expect(isolation.breakerState()).toEqual({ disabled: false, errorCount: 1 });
    expect(tracker.childFor(RUN_2)?.terminal).toBe(false);
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
      options: { idemKey: 'first:breaker' },
    }]);
    expect(first.isolation.guardSession('poll', () => 'not run')).toBeUndefined();
    expect(first.calls.publishText).toHaveLength(1);
    expect(second.isolation.guardSession('poll', () => 'still running')).toBe('still running');
    expect(second.isolation.isDisabled()).toBe(false);
  });

  it('retries the breaker note independently after its first publication fails', () => {
    let publishAttempts = 0;
    const successfulNotes = [];
    const attemptedOptions = [];
    const publisher = {
      publishText(convoId, payload, options) {
        publishAttempts += 1;
        attemptedOptions.push(options);
        if (publishAttempts === 1) throw new Error('journal unavailable');
        successfulNotes.push({ convoId, payload, options });
      },
    };
    const isolation = createCodexWatcherIsolation({
      sessionId: 'breaker-retry',
      publisher,
      getParentConvoId: () => 'parent-breaker-retry',
      terminalize: () => false,
      isAdmittedRun: () => false,
      breakerThreshold: 1,
      log: { info() {}, warn() {} },
    });

    isolation.guardSession('poll', () => { throw new Error('scan failed'); });
    expect(isolation.isDisabled()).toBe(true);
    expect(successfulNotes).toHaveLength(0);

    isolation.retryPending();
    isolation.retryPending();

    expect(publishAttempts).toBe(2);
    expect(attemptedOptions).toEqual([
      { idemKey: 'breaker-retry:breaker' },
      { idemKey: 'breaker-retry:breaker' },
    ]);
    expect(successfulNotes).toHaveLength(1);
    expect(successfulNotes[0].payload).toMatchObject({
      body: '⚙ codex live-view disabled after repeated errors — reviews unaffected',
    });
  });

  it('disables, terminalizes every child, then posts the breaker note', () => {
    const order = [];
    let isolation;
    isolation = createCodexWatcherIsolation({
      sessionId: 'ordered-breaker',
      publisher: { publishText() { order.push('note'); } },
      getParentConvoId: () => 'parent-ordered-breaker',
      terminalizeAll() {
        order.push(`terminalize-all-disabled-${isolation.isDisabled()}`);
        return [];
      },
      isAdmittedRun: () => false,
      breakerThreshold: 1,
      log: { info() {}, warn() {} },
    });

    isolation.guardSession('poll', () => { throw new Error('scan failed'); });

    expect(order).toEqual(['terminalize-all-disabled-true', 'note']);
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

  it('preserves and audits a pending terminal outcome when the breaker retries it', () => {
    let failCompletedUpsert = true;
    const publisher = {
      upsertConvo(_convoId, opts) {
        if (opts.sessionOutcome === 'completed' && failCompletedUpsert) {
          failCompletedUpsert = false;
          throw new Error('journal unavailable');
        }
      },
      publishText() {},
    };
    const tracker = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => 'parent-outcome-fidelity',
      log: { warn() {} },
    });
    const audits = [];
    let breakerTerminalizations;
    const isolation = createCodexWatcherIsolation({
      sessionId: 'outcome-fidelity',
      publisher,
      getParentConvoId: () => 'parent-outcome-fidelity',
      terminalizeAll: () => {
        breakerTerminalizations = tracker.interruptAll();
        return breakerTerminalizations;
      },
      isAdmittedRun: id => tracker.hasChild(id),
      breakerThreshold: 1,
      log: { info(_message, record) { audits.push(record); }, warn() {} },
    });
    tracker.ensureChild({ runId: RUN_1 });

    expect(tracker.terminalize(RUN_1, 'completed')).toBe(false);
    isolation.guardSession('poll', () => { throw new Error('scan failed'); });

    expect(tracker.childFor(RUN_1)).toMatchObject({
      terminal: true,
      outcome: 'completed',
    });
    expect(breakerTerminalizations).toEqual([{ runId: RUN_1, outcome: 'completed' }]);
    expect(audits).toContainEqual(expect.objectContaining({
      runId: RUN_1,
      outcome: 'completed',
      winningSignal: 'completed',
      finalPostLanded: null,
    }));
  });

  it('emits at most one structured start and terminal audit record per run', () => {
    const { tracker, isolation, audits } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });
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
        outcome: null,
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

  it('latches audit records only after the logger accepts them', () => {
    const audits = [];
    let startAttempts = 0;
    let terminalAttempts = 0;
    const isolation = createCodexWatcherIsolation({
      sessionId: 'audit-retry',
      log: {
        info(_message, record) {
          if (record.event === 'codex_run_start' && startAttempts++ === 0) {
            throw new Error('logger unavailable');
          }
          if (record.event === 'codex_run_terminal' && terminalAttempts++ === 0) {
            throw new Error('logger unavailable');
          }
          audits.push(record);
        },
        warn() {},
      },
      isAdmittedRun: runId => runId === RUN_1,
    });
    const meta = { runId: RUN_1, deadlineTs: 1722600100000 };

    isolation.auditStart(meta);
    isolation.auditStart(meta);
    isolation.auditStart(meta);
    isolation.auditTerminal(RUN_1);
    isolation.auditTerminal(RUN_1);
    isolation.auditTerminal(RUN_1);

    expect(startAttempts).toBe(2);
    expect(terminalAttempts).toBe(2);
    expect(audits.map(record => record.event)).toEqual([
      'codex_run_start',
      'codex_run_terminal',
    ]);
  });

  it('rejects unadmitted audit run IDs and non-finite or non-numeric deadlines', () => {
    const auditRecords = [];
    const isolation = createCodexWatcherIsolation({
      sessionId: 'audit-validation',
      log: {
        info(_message, record) { auditRecords.push(record); },
        warn() {},
      },
      isAdmittedRun: runId => runId === RUN_1,
    });

    isolation.auditStart({ runId: 'forged-secret-run-id', deadlineTs: 1 });
    isolation.auditTerminal('forged-secret-run-id');
    isolation.auditStart({ runId: RUN_1, deadlineTs: 'secret-deadline' });
    isolation.auditStart({ runId: RUN_1, deadlineTs: { secret: true } });
    isolation.auditStart({ runId: RUN_1, deadlineTs: Number.POSITIVE_INFINITY });
    isolation.auditStart({ runId: RUN_1, deadlineTs: 1722600100000 });

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      event: 'codex_run_start',
      runId: RUN_1,
      deadlineTs: 1722600100000,
    });
    expect(JSON.stringify(auditRecords)).not.toContain('secret');
  });

  it('ignores regex-valid run IDs that child creation never admitted', () => {
    const operation = vi.fn(() => { throw new Error('must not run'); });
    const terminalize = vi.fn();
    const auditRecords = [];
    const isolation = createCodexWatcherIsolation({
      sessionId: 'admission-gate',
      terminalize,
      isAdmittedRun: runId => runId === RUN_1,
      log: {
        info(_message, record) { auditRecords.push(record); },
        warn() {},
      },
    });

    isolation.auditStart({ runId: RUN_2, deadlineTs: 1722600100000 });
    isolation.auditTerminal(RUN_2);
    expect(isolation.guardRun(RUN_2, 'decoder', operation)).toBeUndefined();

    expect(operation).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
    expect(auditRecords).toHaveLength(0);
    expect(isolation.breakerState()).toEqual({ disabled: false, errorCount: 0 });
  });

  it('does not copy descendant-controlled labels or error messages into logs', () => {
    const warnings = [];
    const auditRecords = [];
    const isolation = createCodexWatcherIsolation({
      sessionId: 'session-secret-test',
      terminalize() {},
      isAdmittedRun: runId => runId === RUN_1,
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

  it('retries a failed terminal upsert without another stream callback', () => {
    let failTerminalUpsert = true;
    const calls = [];
    const publisher = {
      upsertConvo(convoId, opts) {
        calls.push({ convoId, opts });
        if (opts.sessionOutcome && failTerminalUpsert) {
          failTerminalUpsert = false;
          throw new Error('journal unavailable');
        }
      },
      publishText() {},
    };
    const tracker = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => 'parent-terminal-retry',
      log: { warn() {} },
    });
    const audits = [];
    const isolation = createCodexWatcherIsolation({
      sessionId: 'terminal-retry',
      publisher,
      getParentConvoId: () => 'parent-terminal-retry',
      terminalize: (id, outcome) => tracker.terminalize(id, outcome),
      terminalizeAll: () => tracker.interruptAll(),
      isAdmittedRun: id => tracker.hasChild(id),
      log: { info(_message, record) { audits.push(record); }, warn() {} },
    });
    tracker.ensureChild({ runId: RUN_1 });
    isolation.guardRun(RUN_1, 'publish', () => { throw new Error('event failed'); });

    expect(tracker.childFor(RUN_1)).toMatchObject({
      state: CHILD_STATE_TERMINAL_PENDING,
      terminal: false,
      pendingOutcome: 'interrupted',
    });
    expect(audits).toHaveLength(0);

    isolation.retryPending();

    expect(tracker.childFor(RUN_1)).toMatchObject({
      state: 'done',
      terminal: true,
      outcome: 'interrupted',
    });
    expect(audits).toHaveLength(1);
    expect(calls.filter(call => call.opts.sessionOutcome)).toHaveLength(2);
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
      options: { idemKey: 'first:childcap' },
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

  it('retries the child-limit note after publication fails', () => {
    let publishAttempts = 0;
    const attemptedOptions = [];
    const publishText = vi.fn((_convoId, _payload, options) => {
      publishAttempts += 1;
      attemptedOptions.push(options);
      if (publishAttempts === 1) throw new Error('journal unavailable');
    });
    const tracker = createCodexConvoTracker({
      publisher: { upsertConvo() {}, publishText },
      getParentConvoId: () => 'parent',
      maxChildren: 0,
      log: { warn() {} },
    });

    expect(tracker.ensureChild({ runId: RUN_1 })).toBeNull();
    expect(tracker.ensureChild({ runId: RUN_2 })).toBeNull();
    expect(tracker.ensureChild({ runId: runId(3) })).toBeNull();

    expect(publishText).toHaveBeenCalledTimes(2);
    expect(attemptedOptions).toEqual([
      { idemKey: 'parent:childcap' },
      { idemKey: 'parent:childcap' },
    ]);
  });

  it('returns a snapshot when inspecting a child', () => {
    const { tracker } = makeHarness();
    tracker.ensureChild({ runId: RUN_1 });

    const inspected = tracker.childFor(RUN_1);
    inspected.terminal = true;
    inspected.state = 'tampered';

    expect(tracker.childFor(RUN_1)).toMatchObject({
      terminal: false,
      state: 'running',
    });
  });
});
