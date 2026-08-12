import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createJournalInputConsumer } from '../lib/journal-input-router.js';
import { createQueuedReleaseOutbox } from '../lib/queued-release-outbox.js';

// Extract the queued-release seam (emitRelease + republishPendingReleases +
// reconcileReleaseOutbox + the boot-reconcile quiet-timer helpers) from index.js
// and eval it in a sandbox with injected `releaseOutbox` + `journalPublisher`
// stubs. This mirrors the source-extraction pattern already used by
// busy-queue.test.js for emitRelease.
//
// The seam now reads process.env (RELEASE_RECONCILE_QUIET_MS) and arms a
// setTimeout, so the sandbox provides a controllable process/timer surface:
// setTimeout captures the callback (fire it via seam.__timers.fire()) and counts
// arms, clearTimeout resets it.
function loadSeam({ releaseOutbox, journalPublisher, env = {} }) {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('function emitRelease(convoId, { promptId, action, releasedIds }');
  const end = src.indexOf('\nfunction journalUpsertConvo', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const timers = {
    cb: null,
    arms: 0,
    cleared: 0,
    fire() { const cb = this.cb; this.cb = null; if (cb) cb(); },
  };
  const sandbox = {
    releaseOutbox,
    journalPublisher,
    console,
    Date,
    process: { env },
    setTimeout: (cb) => { timers.cb = cb; timers.arms += 1; return { unref() {} }; },
    clearTimeout: () => { timers.cleared += 1; timers.cb = null; },
  };
  runInNewContext(src.slice(start, end), sandbox);
  sandbox.__timers = timers;
  return sandbox; // exposes emitRelease, republishPendingReleases, reconcileReleaseOutbox, scheduleReleaseReconcile
}

// finalizeSentQueue lives outside the emitRelease seam; extract it on its own.
function loadFinalize({ emitRelease, journalInputConsumer }) {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('function finalizeSentQueue(convoId, flushedSnapshot)');
  const end = src.indexOf('\nfunction restoreQueuedBatch', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const sandbox = { emitRelease, journalInputConsumer, Map, console };
  runInNewContext(src.slice(start, end), sandbox);
  return sandbox;
}

const SEND_IDEM = 'qr\0pr_1\0pr_1::0\0send';
const EXPIRED_IDEM = 'qr\0pr_1\0pr_1::0\0expired';

describe('index.js queued-release retry driver', () => {
  it('re-publishes only same-epoch pending records; skips pending_inherited, acked, and already-queued idem', () => {
    const records = [
      { key: 'pr_1\0pr_1::0\0send', status: 'pending', convoId: 'c', promptId: 'pr_1', itemId: 'pr_1::0', action: 'send', releasedIds: ['pr_1::0'], at: 1 },
      { key: 'pr_2\0pr_2::0\0cancel', status: 'pending_inherited', convoId: 'c', promptId: 'pr_2', itemId: 'pr_2::0', action: 'cancel', releasedIds: ['pr_2::0'], at: 1 },
      { key: 'pr_3\0pr_3::0\0send', status: 'acked', convoId: 'c', promptId: 'pr_3', itemId: 'pr_3::0', action: 'send', releasedIds: ['pr_3::0'], at: 1 },
      { key: 'pr_4\0pr_4::0\0cancel', status: 'pending', convoId: 'c', promptId: 'pr_4', itemId: 'pr_4::0', action: 'cancel', releasedIds: ['pr_4::0'], at: 1 },
    ];
    const publishPromptReply = vi.fn();
    const journalPublisher = {
      publishPromptReply,
      hasQueuedIdem: (idem) => idem === 'qr\0pr_4\0pr_4::0\0cancel', // pr_4 frame still queued
    };
    const seam = loadSeam({ releaseOutbox: { list: () => records, pendingCount: () => 2 }, journalPublisher });

    seam.republishPendingReleases();

    expect(publishPromptReply).toHaveBeenCalledTimes(1);
    expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({
      kind: 'queued_release', prompt_id: 'pr_1', action: 'send',
    }), { idemKey: SEND_IDEM });
  });

  it('early-returns via pendingCount() without allocating list() when nothing is pending', () => {
    const list = vi.fn(() => []);
    const publishPromptReply = vi.fn();
    const seam = loadSeam({
      releaseOutbox: { list, pendingCount: () => 0 },
      journalPublisher: { publishPromptReply, hasQueuedIdem: () => false },
    });

    seam.republishPendingReleases();

    expect(list).not.toHaveBeenCalled(); // O(1) fast path: no list() allocation
    expect(publishPromptReply).not.toHaveBeenCalled();
  });

  it('coalesces overlapping triggers via the in-progress flag (no re-entrant double publish)', () => {
    const records = [
      { key: 'pr_1\0pr_1::0\0send', status: 'pending', convoId: 'c', promptId: 'pr_1', itemId: 'pr_1::0', action: 'send', releasedIds: ['pr_1::0'], at: 1 },
    ];
    let seam;
    const publishPromptReply = vi.fn(() => {
      // Re-enter while a pass is in progress — must be a no-op.
      seam.republishPendingReleases();
    });
    const journalPublisher = { publishPromptReply, hasQueuedIdem: () => false };
    seam = loadSeam({ releaseOutbox: { list: () => records, pendingCount: () => 1 }, journalPublisher });

    seam.republishPendingReleases();
    expect(publishPromptReply).toHaveBeenCalledTimes(1); // not 2+
  });
});

describe('index.js reconcileReleaseOutbox', () => {
  it('expires an inherited send: persists expiredKey before publish, publishes expired, removes the different-keyed original, never re-publishes send', () => {
    const inherited = { key: 'pr_1\0pr_1::0\0send', status: 'pending_inherited', convoId: 'c', promptId: 'pr_1', itemId: 'pr_1::0', action: 'send', releasedIds: ['pr_1::0'], at: 1 };
    const put = vi.fn(() => true);
    const remove = vi.fn(() => true);
    const sweepAcked = vi.fn();
    const publishPromptReply = vi.fn();
    const seam = loadSeam({
      releaseOutbox: { list: () => [inherited], put, remove, sweepAcked, pendingCount: () => 0 },
      journalPublisher: { publishPromptReply, hasQueuedIdem: () => false },
    });

    seam.reconcileReleaseOutbox();

    // expired-recovery record persisted under expiredKey (reconcile step2 +
    // emitRelease's write-ahead both target it — >=1 put with expired status).
    expect(put).toHaveBeenCalledWith('pr_1\0pr_1::0\0expired', expect.objectContaining({ action: 'expired', status: 'pending' }));
    // terminal expired release published with the deterministic idem_key…
    expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'expired', prompt_id: 'pr_1' }), { idemKey: EXPIRED_IDEM });
    // …and NEVER the original send action.
    for (const call of publishPromptReply.mock.calls) {
      expect(call[1].action).not.toBe('send');
    }
    // the different-keyed original is removed.
    expect(remove).toHaveBeenCalledWith('pr_1\0pr_1::0\0send');
    expect(sweepAcked).toHaveBeenCalled();
  });

  it('F1 self-delete guard: a second boot (inherited key == expiredKey) does NOT remove the record it just re-wrote', () => {
    const inheritedExpired = { key: 'pr_1\0pr_1::0\0expired', status: 'pending_inherited', convoId: 'c', promptId: 'pr_1', itemId: 'pr_1::0', action: 'expired', releasedIds: ['pr_1::0'], at: 1 };
    const put = vi.fn(() => true);
    const remove = vi.fn(() => true);
    const sweepAcked = vi.fn();
    const publishPromptReply = vi.fn();
    const seam = loadSeam({
      releaseOutbox: { list: () => [inheritedExpired], put, remove, sweepAcked, pendingCount: () => 0 },
      journalPublisher: { publishPromptReply, hasQueuedIdem: () => false },
    });

    seam.reconcileReleaseOutbox();

    expect(put).toHaveBeenCalledWith('pr_1\0pr_1::0\0expired', expect.objectContaining({ action: 'expired', status: 'pending' }));
    expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'expired' }), { idemKey: EXPIRED_IDEM });
    expect(remove).not.toHaveBeenCalled(); // key === expiredKey -> skip removal
  });
});

// F1 CRITICAL: boot reconcile must be deferred behind a quiet-period timer,
// re-armed by each replayed journal frame, so a replayed `send` echo flips the
// inherited record acked BEFORE reconcile could stamp it `expired`. Uses a REAL
// outbox (so markAcked's pending_inherited -> acked flip is exercised end to
// end) with a controllable timer.
describe('index.js boot-reconcile deferral (F1 timing fix)', () => {
  let dir;
  function outboxWithInheritedSend() {
    dir = mkdtempSync(join(tmpdir(), 'qr-reconcile-'));
    const file = join(dir, 'outbox.json');
    writeFileSync(file, JSON.stringify({
      'pr_1\0pr_1::0\0send': { convoId: 'c', promptId: 'pr_1', itemId: 'pr_1::0', action: 'send', releasedIds: ['pr_1::0'], status: 'pending', at: 1 },
    }));
    // Reopen: the on-disk `pending` is relabelled to `pending_inherited`.
    const outbox = createQueuedReleaseOutbox({ file, log: { warn() {} } });
    expect(outbox.list()[0].status).toBe('pending_inherited');
    return outbox;
  }
  function cleanup() { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = null; } }

  it('does NOT run reconcile synchronously on arm; a replayed send ack lands first so the record is NEVER expired', () => {
    const outbox = outboxWithInheritedSend();
    try {
      const publishPromptReply = vi.fn();
      const seam = loadSeam({ releaseOutbox: outbox, journalPublisher: { publishPromptReply, hasQueuedIdem: () => false } });

      // hello_ok arms the deferred reconcile — reconcile must NOT have run yet.
      seam.scheduleReleaseReconcile();
      expect(seam.__timers.arms).toBe(1);
      expect(publishPromptReply).not.toHaveBeenCalled();

      // The reconnect replay carries the echo of the prior process's `send`.
      // markAcked flips pending_inherited -> acked; the frame re-arms the timer.
      outbox.markAcked('pr_1', 'send');
      seam.scheduleReleaseReconcile();
      expect(seam.__timers.arms).toBe(2); // re-armed, still not run
      expect(outbox.list()[0].status).toBe('acked');

      // Replay goes quiet -> the timer fires -> reconcile sees `acked`, skips it.
      seam.__timers.fire();
      expect(publishPromptReply).not.toHaveBeenCalled();
      expect(outbox.list().some(r => r.action === 'expired')).toBe(false);
      expect(outbox.list()[0].status).toBe('acked');
    } finally {
      cleanup();
    }
  });

  it('expires a still-inherited orphan once replay is quiet (no ack arrived)', () => {
    const outbox = outboxWithInheritedSend();
    try {
      const publishPromptReply = vi.fn();
      const seam = loadSeam({ releaseOutbox: outbox, journalPublisher: { publishPromptReply, hasQueuedIdem: () => false } });

      seam.scheduleReleaseReconcile();
      seam.__timers.fire(); // no ack ever arrived -> reconcile expires the orphan

      expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'expired', prompt_id: 'pr_1' }), { idemKey: EXPIRED_IDEM });
    } finally {
      cleanup();
    }
  });

  it('is one-shot: after the timer fires once, a later arm re-schedules nothing', () => {
    const outbox = outboxWithInheritedSend();
    try {
      const seam = loadSeam({ releaseOutbox: outbox, journalPublisher: { publishPromptReply: vi.fn(), hasQueuedIdem: () => false } });

      seam.scheduleReleaseReconcile();
      seam.__timers.fire(); // reconciled once
      const armsAfter = seam.__timers.arms;

      seam.scheduleReleaseReconcile(); // already reconciled -> early return
      expect(seam.__timers.arms).toBe(armsAfter); // no new arm
    } finally {
      cleanup();
    }
  });
});

// F2 CRITICAL: the SEND path must fail-closed like the cancel paths — never drop
// the live entry when the durable write-ahead failed.
describe('index.js finalizeSentQueue (F2 fail-closed send path)', () => {
  function consumerStub(dropItem) {
    return {
      queueRelease: {
        listLive: () => [{ itemId: 'i1', promptId: 'pr_1' }],
        dropItem,
      },
    };
  }

  it('keeps the live entry (dropItem NOT called) when the write-ahead fails', () => {
    const dropItem = vi.fn();
    const emitRelease = vi.fn(() => false); // write-ahead failed (ENOSPC etc.)
    const seam = loadFinalize({ emitRelease, journalInputConsumer: consumerStub(dropItem) });

    seam.finalizeSentQueue('c', [{ itemId: 'i1' }]);

    expect(emitRelease).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'send', promptId: 'pr_1' }));
    expect(dropItem).not.toHaveBeenCalled(); // live entry survives for reconcile
  });

  it('drops the live entry on a durable emit', () => {
    const dropItem = vi.fn();
    const emitRelease = vi.fn(() => true);
    const seam = loadFinalize({ emitRelease, journalInputConsumer: consumerStub(dropItem) });

    seam.finalizeSentQueue('c', [{ itemId: 'i1' }]);

    expect(dropItem).toHaveBeenCalledWith('c', 'i1');
  });
});

describe('journal-input-router — release echo-ack wiring', () => {
  function consumer(onReleaseEcho) {
    return createJournalInputConsumer({
      isControlConvo: () => false,
      handleControlCommand: () => {},
      findSessionByConvoId: () => null,
      routeTextToSession: () => {},
      routePromptReply: () => {},
      onReleaseEcho,
      log: { warn() {} },
    });
  }

  it('fires onReleaseEcho on the agent echo of a prompt_reply release (matched by prompt_id, action)', () => {
    const onReleaseEcho = vi.fn();
    const onJournalEvent = consumer(onReleaseEcho);
    onJournalEvent({
      type: 'prompt_reply',
      sender: 'agent:dev1',
      convo_id: 'c',
      seq: 42,
      payload: { kind: 'queued_release', prompt_id: 'pr_1', action: 'cancel', released: ['pr_1::0'] },
    });
    expect(onReleaseEcho).toHaveBeenCalledWith('c', { promptId: 'pr_1', action: 'cancel' });
  });

  it('does NOT fire onReleaseEcho for a non-queued_release prompt_reply or a user-authored one', () => {
    const onReleaseEcho = vi.fn();
    const onJournalEvent = consumer(onReleaseEcho);
    onJournalEvent({ type: 'prompt_reply', sender: 'agent:dev1', convo_id: 'c', payload: { kind: 'other', action: 'cancel' } });
    onJournalEvent({ type: 'prompt_reply', sender: 'user:fantin', convo_id: 'c', payload: { kind: 'queued_release', action: 'cancel' } });
    expect(onReleaseEcho).not.toHaveBeenCalled();
  });
});

// F2 CRITICAL: evictConvo (cancel path) must keep live state + skip the
// wholesale registry cleanup when a cancel emit fail-closed.
describe('journal-input-router — evictConvo fail-closed (F2)', () => {
  function consumer(emitRelease) {
    return createJournalInputConsumer({
      isControlConvo: () => false,
      handleControlCommand: () => {},
      findSessionByConvoId: () => null,
      routeTextToSession: () => {},
      routePromptReply: () => {},
      emitRelease,
      log: { warn() {} },
    });
  }

  it('keeps the live entry + skips clearQueue when a cancel emit fails', () => {
    const emitRelease = vi.fn(() => false); // write-ahead failed
    const clearQueue = vi.fn();
    const c = consumer(emitRelease);
    c.queueRelease.noteQueued('c', { promptId: 'pr_1', itemId: 'i1' });
    expect(c.queueRelease.listLive('c')).toHaveLength(1);

    c.evictConvo('c', { clearQueue });

    expect(emitRelease).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'cancel', promptId: 'pr_1' }));
    expect(clearQueue).not.toHaveBeenCalled();       // fail-closed: queue not cleared
    expect(c.queueRelease.listLive('c')).toHaveLength(1); // live entry survives
  });

  it('drops entries + clears the queue when all cancel emits succeed', () => {
    const emitRelease = vi.fn(() => true);
    const clearQueue = vi.fn();
    const c = consumer(emitRelease);
    c.queueRelease.noteQueued('c', { promptId: 'pr_1', itemId: 'i1' });

    c.evictConvo('c', { clearQueue });

    expect(clearQueue).toHaveBeenCalled();
    expect(c.queueRelease.listLive('c')).toHaveLength(0); // registry evicted
  });
});
