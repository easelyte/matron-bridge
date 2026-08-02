import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHILD_STATE_FINISHED,
  CHILD_STATE_RUNNING,
  childConvoId,
  createCodexConvoTracker,
} from '../lib/codex-convos.js';

function makePublisher() {
  const calls = { upsertConvo: [] };
  return {
    calls,
    upsertConvo(convoId, opts) { calls.upsertConvo.push({ convoId, opts }); },
  };
}

describe('childConvoId', () => {
  it('is deterministic for a parent conversation and Codex run', () => {
    expect(childConvoId('parent-uuid', 'run-1')).toBe('parent-uuid:codex:run-1');
    expect(childConvoId('parent-uuid', 'run-1')).toBe(childConvoId('parent-uuid', 'run-1'));
    expect(childConvoId('parent-uuid', 'run-2')).not.toBe(childConvoId('parent-uuid', 'run-1'));
  });
});

describe('createCodexConvoTracker', () => {
  let publisher;
  let tracker;

  beforeEach(() => {
    publisher = makePublisher();
    tracker = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
  });

  it('creates a running child linked to the parent using the meta label', () => {
    const child = tracker.ensureChild({ runId: 'run-1', label: 'Plan review' });

    expect(child).toMatchObject({
      runId: 'run-1',
      parentConvoId: 'parent-uuid',
      convoId: 'parent-uuid:codex:run-1',
      title: 'Plan review',
      state: CHILD_STATE_RUNNING,
    });
    expect(publisher.calls.upsertConvo).toEqual([{
      convoId: 'parent-uuid:codex:run-1',
      opts: {
        parentConvoId: 'parent-uuid',
        title: 'Plan review',
        sessionState: CHILD_STATE_RUNNING,
      },
    }]);
  });

  it('re-ensuring the same run is idempotent', () => {
    const first = tracker.ensureChild({ runId: 'run-1', label: 'Plan review' });
    const second = tracker.ensureChild({ runId: 'run-1', label: 'Plan review' });

    expect(second).toBe(first);
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('terminalizes a known run with a durable outcome', () => {
    tracker.ensureChild({ runId: 'run-1', label: 'Plan review' });
    publisher.calls.upsertConvo.length = 0;

    tracker.terminalize('run-1', 'interrupted');

    expect(publisher.calls.upsertConvo).toEqual([{
      convoId: 'parent-uuid:codex:run-1',
      opts: { sessionState: CHILD_STATE_FINISHED, sessionOutcome: 'interrupted' },
    }]);

    tracker.terminalize('run-1', 'completed');
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('fails open when the parent conversation is unavailable', () => {
    const unavailable = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => null,
      log: { warn() {} },
    });

    expect(() => unavailable.ensureChild({ runId: 'run-1', label: 'Plan review' })).not.toThrow();
    expect(unavailable.ensureChild({ runId: 'run-1' })).toBeNull();
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it('fails open for malformed meta and publisher errors', () => {
    expect(() => tracker.ensureChild(null)).not.toThrow();

    const throwing = createCodexConvoTracker({
      publisher: { upsertConvo() { throw null; } },
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    expect(() => throwing.ensureChild({ runId: 'run-2', label: 'Review' })).not.toThrow();

    let throwOnPublish = false;
    const terminalThrowing = createCodexConvoTracker({
      publisher: {
        upsertConvo() {
          if (throwOnPublish) throw 'journal unavailable';
        },
      },
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    terminalThrowing.ensureChild({ runId: 'run-3', label: 'Review' });
    throwOnPublish = true;
    expect(() => terminalThrowing.terminalize('run-3', 'failed')).not.toThrow();
  });

  it('retries child creation after a publication failure', () => {
    let attempts = 0;
    const recoveringPublisher = makePublisher();
    const upsertConvo = recoveringPublisher.upsertConvo;
    recoveringPublisher.upsertConvo = (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('journal unavailable');
      upsertConvo(...args);
    };
    const recovering = createCodexConvoTracker({
      publisher: recoveringPublisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });

    expect(recovering.ensureChild({ runId: 'run-2', label: 'Review' })).toBeNull();
    expect(recovering.convoIdFor('run-2')).toBeNull();

    const child = recovering.ensureChild({ runId: 'run-2', label: 'Review' });
    expect(child?.convoId).toBe('parent-uuid:codex:run-2');
    expect(attempts).toBe(2);
    expect(recoveringPublisher.calls.upsertConvo).toHaveLength(1);
  });

  it('retries terminalization after a publication failure', () => {
    let terminalAttempts = 0;
    const recoveringPublisher = makePublisher();
    const upsertConvo = recoveringPublisher.upsertConvo;
    const recovering = createCodexConvoTracker({
      publisher: recoveringPublisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    recovering.ensureChild({ runId: 'run-2', label: 'Review' });
    recoveringPublisher.calls.upsertConvo.length = 0;
    recoveringPublisher.upsertConvo = (...args) => {
      terminalAttempts += 1;
      if (terminalAttempts === 1) throw new Error('journal unavailable');
      upsertConvo(...args);
    };

    recovering.terminalize('run-2', 'failed');
    recovering.terminalize('run-2', 'failed');
    recovering.terminalize('run-2', 'completed');

    expect(terminalAttempts).toBe(2);
    expect(recoveringPublisher.calls.upsertConvo).toEqual([{
      convoId: 'parent-uuid:codex:run-2',
      opts: { sessionState: CHILD_STATE_FINISHED, sessionOutcome: 'failed' },
    }]);
  });
});
