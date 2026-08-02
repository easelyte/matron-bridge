import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHILD_STATE_FINISHED,
  CHILD_STATE_RUNNING,
  childConvoId,
  createCodexConvoTracker,
} from '../lib/codex-convos.js';

const RUN_1 = '1722600000000-1234-abcd';
const RUN_2 = '1722600000001-1234-1234';
const RUN_3 = '1722600000002-1234-beef';

function makePublisher() {
  const calls = { upsertConvo: [] };
  return {
    calls,
    upsertConvo(convoId, opts) {
      calls.upsertConvo.push({ convoId, opts });
      return true;
    },
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

  it('creates a running child linked to the parent without publishing the unredacted label', () => {
    const child = tracker.ensureChild({ runId: RUN_1, label: 'Plan review' });

    expect(child).toMatchObject({
      runId: RUN_1,
      parentConvoId: 'parent-uuid',
      convoId: `parent-uuid:codex:${RUN_1}`,
      state: CHILD_STATE_RUNNING,
    });
    expect(child).not.toHaveProperty('title');
    expect(publisher.calls.upsertConvo).toEqual([{
      convoId: `parent-uuid:codex:${RUN_1}`,
      opts: {
        parentConvoId: 'parent-uuid',
        sessionState: CHILD_STATE_RUNNING,
      },
    }]);
  });

  it('re-ensuring the same run is idempotent', () => {
    const first = tracker.ensureChild({ runId: RUN_1, label: 'Plan review' });
    const second = tracker.ensureChild({ runId: RUN_1, label: 'Plan review' });

    expect(second).toBe(first);
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('terminalizes a known run with a durable outcome', () => {
    tracker.ensureChild({ runId: RUN_1, label: 'Plan review' });
    publisher.calls.upsertConvo.length = 0;

    tracker.terminalize(RUN_1, 'interrupted');

    expect(publisher.calls.upsertConvo).toEqual([{
      convoId: `parent-uuid:codex:${RUN_1}`,
      opts: {
        parentConvoId: 'parent-uuid',
        sessionState: CHILD_STATE_FINISHED,
        sessionOutcome: 'interrupted',
      },
    }]);

    tracker.terminalize(RUN_1, 'completed');
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('fails open when the parent conversation is unavailable', () => {
    const unavailable = createCodexConvoTracker({
      publisher,
      getParentConvoId: () => null,
      log: { warn() {} },
    });

    expect(() => unavailable.ensureChild({ runId: RUN_1, label: 'Plan review' })).not.toThrow();
    expect(unavailable.ensureChild({ runId: RUN_1 })).toBeNull();
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it('fails open for malformed meta and publisher errors', () => {
    expect(() => tracker.ensureChild(null)).not.toThrow();

    const throwing = createCodexConvoTracker({
      publisher: { upsertConvo() { throw null; } },
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    expect(() => throwing.ensureChild({ runId: RUN_2, label: 'Review' })).not.toThrow();

    let throwOnPublish = false;
    const terminalThrowing = createCodexConvoTracker({
      publisher: {
        upsertConvo() {
          if (throwOnPublish) throw 'journal unavailable';
          return true;
        },
      },
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
    terminalThrowing.ensureChild({ runId: RUN_3, label: 'Review' });
    throwOnPublish = true;
    expect(() => terminalThrowing.terminalize(RUN_3, 'failed')).not.toThrow();
  });

  it('retries child creation after a publication failure', () => {
    let attempts = 0;
    const recoveringPublisher = makePublisher();
    const upsertConvo = recoveringPublisher.upsertConvo;
    recoveringPublisher.upsertConvo = (...args) => {
      attempts += 1;
      if (attempts === 1) return false;
      return upsertConvo(...args);
    };
    const recovering = createCodexConvoTracker({
      publisher: recoveringPublisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });

    expect(recovering.ensureChild({ runId: RUN_2, label: 'Review' })).toBeNull();
    expect(recovering.convoIdFor(RUN_2)).toBeNull();

    const child = recovering.ensureChild({ runId: RUN_2, label: 'Review' });
    expect(child?.convoId).toBe(`parent-uuid:codex:${RUN_2}`);
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
    recovering.ensureChild({ runId: RUN_2, label: 'Review' });
    recoveringPublisher.calls.upsertConvo.length = 0;
    recoveringPublisher.upsertConvo = (...args) => {
      terminalAttempts += 1;
      if (terminalAttempts === 1) return false;
      return upsertConvo(...args);
    };

    recovering.terminalize(RUN_2, 'failed');
    recovering.terminalize(RUN_2, 'failed');
    recovering.terminalize(RUN_2, 'completed');

    expect(terminalAttempts).toBe(2);
    expect(recoveringPublisher.calls.upsertConvo).toEqual([{
      convoId: `parent-uuid:codex:${RUN_2}`,
      opts: {
        parentConvoId: 'parent-uuid',
        sessionState: CHILD_STATE_FINISHED,
        sessionOutcome: 'failed',
      },
    }]);
  });

  it('rejects forged sidecar identity metadata', () => {
    const invalidMeta = [
      { runId: 'run-1', label: 'Review' },
      { runId: '1722600000000-1234-zzzz', label: 'Review' },
      { runId: `1722600000000-${'1'.repeat(20)}-abcd`, label: 'Review' },
    ];

    for (const meta of invalidMeta) expect(tracker.ensureChild(meta)).toBe(false);
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it.each([
    'xoxb-LABELEXAMPLENOTAREALTOKEN',
    'ya29.a0AfH6SMB-secret-bearing-google-token',
  ])('creates the child but omits forgeable or secret-bearing label %s', label => {
    const child = tracker.ensureChild({
      runId: RUN_1,
      label,
    });

    expect(child?.convoId).toBe(`parent-uuid:codex:${RUN_1}`);
    expect(child).not.toHaveProperty('title');
    expect(publisher.calls.upsertConvo[0].opts).not.toHaveProperty('title');
  });

  it.each([
    'review/path [round 3] 🚀 — final',
    'x'.repeat(121),
  ])('creates the child independently of label display validity: %s', label => {
    const child = tracker.ensureChild({ runId: RUN_1, label });

    expect(child?.convoId).toBe(`parent-uuid:codex:${RUN_1}`);
    expect(publisher.calls.upsertConvo).toHaveLength(1);
    expect(publisher.calls.upsertConvo[0].opts).not.toHaveProperty('title');
  });

  it.each([undefined, null, 'done', 'complete', 'FAILED'])(
    'rejects invalid terminal outcome %s without latching the child',
    outcome => {
      const warnings = [];
      const validating = createCodexConvoTracker({
        publisher,
        getParentConvoId: () => 'parent-uuid',
        log: { warn(message) { warnings.push(message); } },
      });
      validating.ensureChild({ runId: RUN_1, label: 'Review' });
      publisher.calls.upsertConvo.length = 0;

      validating.terminalize(RUN_1, outcome);

      expect(publisher.calls.upsertConvo).toHaveLength(0);
      expect(warnings).toEqual([
        `[codex-convos] invalid terminal outcome; skipping child terminalization for ${RUN_1}`,
      ]);

      validating.terminalize(RUN_1, 'completed');
      expect(publisher.calls.upsertConvo).toHaveLength(1);
      expect(publisher.calls.upsertConvo[0].opts.sessionOutcome).toBe('completed');
    },
  );

  it('terminal frame is self-sufficient when the creation frame was dropped', () => {
    tracker.ensureChild({ runId: RUN_1, label: 'Quality review' });
    publisher.calls.upsertConvo.length = 0; // model queue eviction of creation

    tracker.terminalize(RUN_1, 'completed');

    expect(publisher.calls.upsertConvo).toEqual([{
      convoId: `parent-uuid:codex:${RUN_1}`,
      opts: {
        parentConvoId: 'parent-uuid',
        sessionState: CHILD_STATE_FINISHED,
        sessionOutcome: 'completed',
      },
    }]);
  });
});
