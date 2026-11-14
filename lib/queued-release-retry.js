// Queued-release durability: the transactional release seam (emitRelease),
// the in-process retry driver for unacked releases, and the one-shot boot
// reconcile with its quiet-period deferral timer (spec §3 and §5).
//
// Moved out of index.js as-is. The outbox (lib/queued-release-outbox.js) and the
// journal publisher are owned by index.js and injected; index.js also owns the
// triggers (onSendCapacity, the reconnect handler, the inbound-frame re-arm).
// The reconcile timer and its one-shot flag live together here.

export function createQueuedReleaseRetry({
  releaseOutbox,
  journalPublisher,
  env = process.env,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  // Transactional release seam (loop #536, spec §3). Order: write-ahead a durable
  // `pending` outbox record → (if a mutate thunk is supplied) run the irreversible
  // queue mutation → publish with a deterministic idem_key. FAIL-CLOSED: if the
  // write-ahead can't durably persist, ABORT before the mutation and the publish
  // (return false), leaving the card actionable — a failed durability prerequisite
  // must never let the irreversible mutation proceed with no recoverable record.
  // Returns true on a durable emit, false on a fail-closed abort.
  function emitRelease(convoId, { promptId, action, releasedIds }, { mutate } = {}) {
    const itemId = (Array.isArray(releasedIds) && releasedIds.length)
      ? releasedIds[0]
      : `${promptId}::0`;
    const at = Date.now();
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
      console.warn(`[queued-release-outbox] write-ahead failed for ${recordKey} — aborting release (card stays actionable)`);
      return false;
    }
    try { mutate?.(); }
    catch (e) { console.warn(`[emitRelease] mutate thunk threw for ${recordKey}: ${e?.message ?? String(e)}`); }
    journalPublisher.publishPromptReply(convoId, {
      kind: 'queued_release',
      prompt_id: promptId,
      action,
      released: releasedIds,
      at,
    }, { idemKey: `qr\0${promptId}\0${itemId}\0${action}` });
    return true;
  }

  // In-process retry driver (spec §3 step 6). Re-publishes every SAME-EPOCH
  // `pending` outbox record whose frame is not already in the outbound queue,
  // with its deterministic idem_key (so a re-publish of an already-journaled
  // release is a server-side dedup no-op). SKIPS `pending_inherited` (the state
  // gate — only boot reconcile touches those) and `acked`. Fired by two triggers
  // (onSendCapacity + onReconnect); the in-progress flag coalesces overlapping
  // fires into one pass.
  let _republishingReleases = false;
  function republishPendingReleases() {
    if (_republishingReleases) return;
    // O(1) fast path: this fires per confirmed frame on the hot output path
    // (onSendCapacity). With no retry-eligible records the pendingCount gate
    // avoids an O(all-releases-since-boot) list() allocation per streamed delta.
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

  // Boot reconciliation (spec §5). The SOLE toucher of `pending_inherited`. For
  // each inherited orphan (a release a prior process wrote but never got acked),
  // emit a terminal `expired` release via the normal write-ahead path — never
  // blind-re-publish the original send/cancel (device_id may differ post-restart,
  // so a re-publish could double-ink; expired is the conservative honest state).
  function reconcileReleaseOutbox() {
    for (const rec of releaseOutbox.list()) {
      if (rec.status !== 'pending_inherited') continue;
      const expiredKey = `${rec.promptId}\0${rec.itemId}\0expired`;
      // emitRelease write-aheads the expired-recovery record (key === expiredKey,
      // status `pending`) BEFORE publishing, then publishes the terminal `expired`
      // release. On a second boot where the inherited record IS the expired record
      // this relabels it back to `pending` in place under the same key. Returns
      // false (fail-closed) if the durable write-ahead can't persist.
      const emitted = emitRelease(rec.convoId, {
        promptId: rec.promptId,
        action: 'expired',
        releasedIds: [rec.itemId],
      });
      // F2: only remove the inherited original when the expired release was
      // durably emitted. If emitRelease fail-closed (disk fault), keep the
      // inherited record so a later boot retries — never delete with nothing
      // published, else `_releaseReconciled` would permanently orphan the card.
      // F1 self-delete guard: also require rec.key !== expiredKey — on an
      // expired-on-expired second boot the keys match, so we must NOT delete the
      // record we just re-wrote.
      if (emitted && rec.key !== expiredKey) releaseOutbox.remove(rec.key);
    }
    releaseOutbox.sweepAcked();
  }

  // --- Boot-reconcile deferral (F1 timing fix) ---
  // reconcileReleaseOutbox must NOT run before the reconnect replay that carries
  // the echo of a committed-but-unacked release (that echo flips the record
  // pending_inherited -> acked, so reconcile then correctly skips it). We defer
  // reconcile behind a quiet-period timer, re-armed by every replayed journal
  // frame, so it fires only once the replay stream has been quiet for the window.
  // One-shot: inherited records are a boot-only concern, so we reconcile exactly
  // once (the first hello_ok's replay); after that the timer is null forever.
  // Quiet window overridable via env (short by default — a boot replay burst is
  // bounded and steady-state single-convo traffic isn't sub-window-continuous).
  const RELEASE_RECONCILE_QUIET_MS = Number(env.MATRON_QUEUED_RELEASE_RECONCILE_QUIET_MS) || 750;
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
    if (_releaseReconcileTimer) clearTimeout(_releaseReconcileTimer);
    _releaseReconcileTimer = setTimeout(runReleaseReconcile, RELEASE_RECONCILE_QUIET_MS);
    if (_releaseReconcileTimer && typeof _releaseReconcileTimer.unref === 'function') {
      _releaseReconcileTimer.unref();
    }
  }

  // Whether a deferred boot reconcile is armed and not yet run (the inbound
  // frame re-arm in index.js checks this before pushing the timer out).
  function releaseReconcilePending() {
    return Boolean(_releaseReconcileTimer);
  }

  return {
    emitRelease,
    republishPendingReleases,
    reconcileReleaseOutbox,
    scheduleReleaseReconcile,
    releaseReconcilePending,
  };
}
