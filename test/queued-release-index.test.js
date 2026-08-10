import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createJournalInputConsumer } from '../lib/journal-input-router.js';

// Extract the queued-release seam (emitRelease + republishPendingReleases +
// reconcileReleaseOutbox) from index.js and eval it in a sandbox with injected
// `releaseOutbox` + `journalPublisher` stubs. This mirrors the source-extraction
// pattern already used by busy-queue.test.js for emitRelease.
function loadSeam({ releaseOutbox, journalPublisher }) {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('function emitRelease(convoId, { promptId, action, releasedIds }');
  const end = src.indexOf('\nfunction journalUpsertConvo', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const sandbox = { releaseOutbox, journalPublisher, console, Date };
  runInNewContext(src.slice(start, end), sandbox);
  return sandbox; // exposes emitRelease, republishPendingReleases, reconcileReleaseOutbox
}

const EXPIRED_IDEM = 'qr\0pr_1\0expired';

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
      hasQueuedIdem: (idem) => idem === 'qr\0pr_4\0cancel', // pr_4 frame still queued
    };
    const seam = loadSeam({ releaseOutbox: { list: () => records }, journalPublisher });

    seam.republishPendingReleases();

    expect(publishPromptReply).toHaveBeenCalledTimes(1);
    expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({
      kind: 'queued_release', prompt_id: 'pr_1', action: 'send',
    }), { idemKey: 'qr\0pr_1\0send' });
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
    seam = loadSeam({ releaseOutbox: { list: () => records }, journalPublisher });

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
      releaseOutbox: { list: () => [inherited], put, remove, sweepAcked },
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
      releaseOutbox: { list: () => [inheritedExpired], put, remove, sweepAcked },
      journalPublisher: { publishPromptReply, hasQueuedIdem: () => false },
    });

    seam.reconcileReleaseOutbox();

    expect(put).toHaveBeenCalledWith('pr_1\0pr_1::0\0expired', expect.objectContaining({ action: 'expired', status: 'pending' }));
    expect(publishPromptReply).toHaveBeenCalledWith('c', expect.objectContaining({ action: 'expired' }), { idemKey: EXPIRED_IDEM });
    expect(remove).not.toHaveBeenCalled(); // key === expiredKey -> skip removal
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
