// Durable queue releases: write ahead, mutate, publish, then retry until echoed.
export function createQueuedReleaseLifecycle({
  releaseOutbox, journalPublisher, now = () => Date.now(), log = console,
  quietMs = 750, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  // A failed write leaves the queue untouched and the card actionable.
  function emitRelease(convoId, { promptId, action, releasedIds }, { mutate } = {}) {
    const itemId = (Array.isArray(releasedIds) && releasedIds.length)
      ? releasedIds[0]
      : `${promptId}::0`;
    const at = now();
    const recordKey = `${promptId}\0${itemId}\0${action}`;
    const durable = releaseOutbox.put(recordKey, {
      convoId,
      promptId,
      itemId,
      action,
      releasedIds: Array.isArray(releasedIds) ? releasedIds : [itemId],
      status: 'pending',
      at,
    });
    if (!durable) {
      log.warn(`[queued-release-outbox] write-ahead failed for ${recordKey} — aborting release (card stays actionable)`);
      return false;
    }
    try { mutate?.(); }
    catch (e) { log.warn(`[emitRelease] mutate thunk threw for ${recordKey}: ${e?.message ?? String(e)}`); }
    journalPublisher.publishPromptReply(convoId, {
      kind: 'queued_release',
      prompt_id: promptId,
      action,
      released: releasedIds,
      at,
    }, { idemKey: `qr\0${promptId}\0${itemId}\0${action}` });
    return true;
  }

  let _republishingReleases = false;
  function republishPendingReleases() {
    if (_republishingReleases) return;
    if (releaseOutbox.pendingCount() === 0) return;
    _republishingReleases = true;
    try {
      for (const rec of releaseOutbox.list()) {
        if (rec.status !== 'pending') continue; // skip pending_inherited + acked
        const idemKey = `qr\0${rec.promptId}\0${rec.itemId}\0${rec.action}`;
        if (journalPublisher.hasQueuedIdem(idemKey)) continue; // frame still queued
        journalPublisher.publishPromptReply(rec.convoId, {
          kind: 'queued_release',
          prompt_id: rec.promptId,
          action: rec.action,
          released: rec.releasedIds,
          at: rec.at,
        }, { idemKey });
      }
    } finally {
      _republishingReleases = false;
    }
  }

  // Inherited releases expire after replay; an expired record must not delete itself.
  function reconcileReleaseOutbox() {
    for (const rec of releaseOutbox.list()) {
      if (rec.status !== 'pending_inherited') continue;
      const expiredKey = `${rec.promptId}\0${rec.itemId}\0expired`;
      const emitted = emitRelease(rec.convoId, {
        promptId: rec.promptId,
        action: 'expired',
        releasedIds: [rec.itemId],
      });
      if (emitted && rec.key !== expiredKey) releaseOutbox.remove(rec.key);
    }
    releaseOutbox.sweepAcked();
  }

  let _releaseReconciled = false;
  let _releaseReconcileTimer = null;
  function runReleaseReconcile() {
    _releaseReconcileTimer = null;
    if (_releaseReconciled) return;
    _releaseReconciled = true;
    reconcileReleaseOutbox();
  }
  function scheduleReleaseReconcile() {
    if (_releaseReconciled) return;
    if (_releaseReconcileTimer) clearTimer(_releaseReconcileTimer);
    _releaseReconcileTimer = setTimer(runReleaseReconcile, quietMs);
    if (_releaseReconcileTimer && typeof _releaseReconcileTimer.unref === 'function') {
      _releaseReconcileTimer.unref();
    }
  }
  function onInboundEvent() {
    if (_releaseReconcileTimer) scheduleReleaseReconcile();
  }
  return { emitRelease, republishPendingReleases, reconcileReleaseOutbox, scheduleReleaseReconcile, onInboundEvent };
}
