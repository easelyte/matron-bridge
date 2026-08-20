import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// flushQueue's SEND path must be fail-closed the same way the cancel path is:
// the durable release write-ahead has to precede the point where
// dispatchMergedFlush commits delivery to the agent. If the write-ahead faults
// (ENOSPC etc.) the batch must stay queued and its cards actionable — nothing
// delivered — rather than delivering the messages and then stranding a
// stale-actionable card whose release was never persisted.
//
// flushQueue lives in index.js and can't be imported, so it's extracted and
// evaluated in a sandbox with every module-level dependency injected as a stub
// (the same source-extraction pattern queued-release-index.test.js already uses
// for emitRelease / finalizeSentQueue).
function loadFlushQueue(overrides = {}) {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('function flushQueue(session, queued, releaseSnapshot');
  const end = src.indexOf('\nfunction splitMessage', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const sandbox = {
    console: { log() {}, warn() {} },
    Array,
    AGENT_CODEX: 'codex',
    snapshotQueuedReleaseBatch: () => ({ convoId: 'c', entries: [] }),
    restoreQueuedBatch: () => {},
    dispatchMergedFlush: () => true,
    // Post-delivery seam retained only so the CURRENT (pre-fix) source still
    // evaluates; the fixed source never references it.
    finalizeSentQueue: () => {},
    writeAheadRelease: () => ({}),
    publishReleaseRecord: () => {},
    releaseOutbox: { abort: () => {} },
    journalInputConsumer: { queueRelease: { dropItem: () => {} } },
    journalConvoIdFor: () => 'c',
    journalPublishNotice: () => {},
    // Orphan-media cleanup dep introduced by the media-teardown work; the
    // drop path sweeps queued entries through it. No-op here — this suite
    // asserts fail-closed rollback/no-publish, not media cleanup.
    runQueuedCleanup: () => {},
    ...overrides,
  };
  runInNewContext(src.slice(start, end), sandbox);
  return sandbox; // exposes flushQueue
}

describe('index.js flushQueue — SEND fail-closed ordering (write-ahead before delivery)', () => {
  const twoItemSnapshot = {
    convoId: 'c',
    entries: [
      { promptId: 'pr_1', itemId: 'pr_1::0' },
      { promptId: 'pr_2', itemId: 'pr_2::0' },
    ],
  };

  it('does NOT commit delivery when a durable write-ahead faults; rolls back the partial write and restores the batch', () => {
    const dispatchMergedFlush = vi.fn(() => true);
    const restoreQueuedBatch = vi.fn();
    const abort = vi.fn();
    const dropItem = vi.fn();
    // First item write-aheads fine; the second faults (returns null).
    const writeAheadRelease = vi.fn((convoId, spec) =>
      spec.releasedIds[0] === 'pr_1::0'
        ? { recordKey: 'k1', convoId, itemId: 'pr_1::0', promptId: 'pr_1' }
        : null,
    );
    const seam = loadFlushQueue({
      snapshotQueuedReleaseBatch: () => twoItemSnapshot,
      dispatchMergedFlush,
      restoreQueuedBatch,
      writeAheadRelease,
      releaseOutbox: { abort },
      journalInputConsumer: { queueRelease: { dropItem } },
    });

    const session = { agent: 'claude', busy: false, alive: true };
    const result = seam.flushQueue(session, ['m1', 'm2']);

    // The whole point: delivery is never committed on a write-ahead fault.
    expect(dispatchMergedFlush).not.toHaveBeenCalled();
    // The successful partial write-ahead is rolled back (abort = in-memory
    // authoritative) so the retry driver can never republish a `send` for an
    // undelivered batch — even if the removal's persist also fails.
    expect(abort).toHaveBeenCalledWith('k1');
    // The batch is restored to the queue and no card is retired.
    expect(restoreQueuedBatch).toHaveBeenCalledWith(session, ['m1', 'm2']);
    expect(dropItem).not.toHaveBeenCalled();
    expect(result).not.toBe(true);
  });

  it('write-aheads the whole batch BEFORE delivery, then publishes + retires cards only after delivery commits', () => {
    const order = [];
    const dispatchMergedFlush = vi.fn(() => { order.push('deliver'); return true; });
    const writeAheadRelease = vi.fn((convoId, spec) => {
      order.push(`writeahead:${spec.releasedIds[0]}`);
      return { recordKey: `k:${spec.releasedIds[0]}`, convoId, itemId: spec.releasedIds[0], promptId: spec.promptId };
    });
    const publishReleaseRecord = vi.fn((rec) => order.push(`publish:${rec.itemId}`));
    const dropItem = vi.fn((convoId, itemId) => order.push(`drop:${itemId}`));
    const seam = loadFlushQueue({
      snapshotQueuedReleaseBatch: () => twoItemSnapshot,
      dispatchMergedFlush,
      writeAheadRelease,
      publishReleaseRecord,
      journalInputConsumer: { queueRelease: { dropItem } },
    });

    const session = { agent: 'claude', busy: false, alive: true };
    const result = seam.flushQueue(session, ['m1', 'm2']);

    expect(result).toBe(true);
    // Both write-aheads precede delivery; both publishes/retires follow it.
    expect(order).toEqual([
      'writeahead:pr_1::0',
      'writeahead:pr_2::0',
      'deliver',
      'publish:pr_1::0',
      'drop:pr_1::0',
      'publish:pr_2::0',
      'drop:pr_2::0',
    ]);
  });

  it('aborts every write-ahead, restores the batch, and does not throw when dispatch throws', () => {
    const abort = vi.fn();
    const restoreQueuedBatch = vi.fn();
    const publishReleaseRecord = vi.fn();
    const dropItem = vi.fn();
    const writeAheadRelease = vi.fn((convoId, spec) => ({
      recordKey: `k:${spec.releasedIds[0]}`, convoId, itemId: spec.releasedIds[0], promptId: spec.promptId,
    }));
    const seam = loadFlushQueue({
      snapshotQueuedReleaseBatch: () => twoItemSnapshot,
      // A PTY/stdin write error surfaces as a THROW, not a false return. Because
      // the send write-aheads now precede dispatch, a throw must still roll them
      // back or the retry driver would republish a false `send`.
      dispatchMergedFlush: () => { throw new Error('EPIPE'); },
      writeAheadRelease,
      publishReleaseRecord,
      restoreQueuedBatch,
      releaseOutbox: { abort },
      journalInputConsumer: { queueRelease: { dropItem } },
    });

    const session = { agent: 'claude', busy: false, alive: true, roomId: 'r' };
    let result;
    expect(() => { result = seam.flushQueue(session, ['m1', 'm2']); }).not.toThrow();
    expect(result).toBe(false);
    expect(abort).toHaveBeenCalledWith('k:pr_1::0');
    expect(abort).toHaveBeenCalledWith('k:pr_2::0');
    expect(restoreQueuedBatch).toHaveBeenCalledWith(session, ['m1', 'm2']);
    expect(publishReleaseRecord).not.toHaveBeenCalled();
    expect(dropItem).not.toHaveBeenCalled();
  });

  it('rolls back every write-ahead and never publishes when delivery is refused (session dead → notify + drop)', () => {
    const abort = vi.fn();
    const publishReleaseRecord = vi.fn();
    const dropItem = vi.fn();
    const journalPublishNotice = vi.fn();
    const writeAheadRelease = vi.fn((convoId, spec) => ({
      recordKey: `k:${spec.releasedIds[0]}`, convoId, itemId: spec.releasedIds[0], promptId: spec.promptId,
    }));
    const seam = loadFlushQueue({
      snapshotQueuedReleaseBatch: () => twoItemSnapshot,
      dispatchMergedFlush: () => false, // delivery refused
      writeAheadRelease,
      publishReleaseRecord,
      releaseOutbox: { abort },
      journalInputConsumer: { queueRelease: { dropItem } },
      journalPublishNotice,
    });

    const session = { agent: 'claude', busy: false, alive: false, roomId: 'r' };
    const result = seam.flushQueue(session, ['m1', 'm2']);

    expect(result).toBe(false);
    // No release survives for the undelivered batch.
    expect(abort).toHaveBeenCalledWith('k:pr_1::0');
    expect(abort).toHaveBeenCalledWith('k:pr_2::0');
    expect(publishReleaseRecord).not.toHaveBeenCalled();
    expect(dropItem).not.toHaveBeenCalled();
    expect(journalPublishNotice).toHaveBeenCalled();
  });
});
