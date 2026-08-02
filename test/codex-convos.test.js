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
      publisher: { upsertConvo() { throw new Error('journal unavailable'); } },
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    expect(() => throwing.ensureChild({ runId: 'run-2', label: 'Review' })).not.toThrow();
    expect(() => throwing.terminalize('run-2', 'failed')).not.toThrow();
  });
});
