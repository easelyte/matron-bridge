// Dispatch detached batches while preserving queue order and durable release records.
import { AGENT_CODEX } from './agent-backend.js';
import { compactBatchSize, hasQueuedCompact } from './compact-priority.js';
import { planQueueFlush } from './queue-flush.js';
import { pendingMediaMirror } from './media-mirror.js';

export function createQueuedDispatcher(deps) {
  const {
    emitRelease, journalConvoIdFor, dispatchMergedFlush, journalPublishNotice,
    runQueuedCleanup, sessions, commitDispatchedUserTurn, journalPublishUserItem,
    journalMirrorUserMedia, dispatchDeferredCommand, flushPendingSessionQueue,
    maybeFlushRoomDelivery, log = console,
  } = deps;
  function queuedReleaseItemIds(session, queued) {
    const batchSize = Array.isArray(queued) ? queued.length : 0;
    return new Set(
      (session.queueNotifications || [])
        .slice(0, batchSize)
        .map(notification => notification?.id)
        .filter(Boolean),
    );
  }

  function liveQueuedReleaseEntries(convoId, itemIds) {
    return deps.queueRelease.listLive(convoId)
      .filter(entry => itemIds.has(entry.itemId));
  }

  function snapshotQueuedReleaseBatch(session, queued) {
    const convoId = journalConvoIdFor(session);
    return {
      convoId,
      entries: liveQueuedReleaseEntries(
        convoId,
        queuedReleaseItemIds(session, queued),
      ),
    };
  }

  function pendingFlushBatch(session) {
    const queue = session.queuedMessages || [];
    return queue.slice(0, compactBatchSize(queue));
  }

  function queueReleaseForBatch(session, queued) {
    const itemIds = queuedReleaseItemIds(session, queued);
    return {
      listLive: (convoId) => liveQueuedReleaseEntries(convoId, itemIds),
      dropItem: (convoId, itemId) => {
        deps.queueRelease.dropItem(convoId, itemId);
      },
    };
  }

  function finalizeSentQueue(convoId, flushedSnapshot, action = 'send') {
    const liveByItemId = new Map(
      deps.queueRelease.listLive(convoId)
        .map(entry => [entry.itemId, entry]),
    );
    for (const { itemId } of flushedSnapshot || []) {
      const liveEntry = liveByItemId.get(itemId);
      if (!liveEntry) continue;
      // Keep the live entry if the release could not be durably recorded.
      if (emitRelease(convoId, {
        promptId: liveEntry.promptId,
        action,
        releasedIds: [itemId],
      })) {
        deps.queueRelease.dropItem(convoId, itemId);
        liveByItemId.delete(itemId);
      }
    }
  }

  function restoreQueuedBatch(session, queued) {
    const pending = session.queuedMessages || [];
    if (pending === queued) return;
    session.queuedMessages = [...queued, ...pending];
  }

  function flushQueue(session, queued, releaseSnapshot = null) {
    const finishInput = deps.restartLatch?.beginInput();
    let steering = false;
    try {
      const snapshot = releaseSnapshot || snapshotQueuedReleaseBatch(session, queued);
      const restore = () => {
        restoreQueuedBatch(session, queued);
        if (snapshot.notifications) {
          const current = session.queueNotifications || [];
          session.queueNotifications = [...snapshot.notifications.filter(n => !current.includes(n)), ...current];
        }
      };
      if (typeof session._deferredCommandText === 'string' && session._deferredCommandText.startsWith('!restart')) {
        restore();
        journalPublishNotice(journalConvoIdFor(session), '⏳ A restart is pending for this session — queued messages go to the restarted session instead.');
        return false;
      }
      session._codexUncertainSteer = false; // an explicit retry may release held input
      if (session.codex?.transport === 'app-server' && session.busy && !hasQueuedCompact(queued)) {
        if (session._codexSteerPending) { restore(); return false; }
        const { blocks, mirrorText } = planQueueFlush(queued);
        const notifications = snapshot.notifications || (session.queueNotifications || []).slice(0, queued.length);
        session._codexSteerPending = { queued };
        const pending = session.codex.steer(blocks);
        steering = true;
        void pending.then(sent => {
          session._codexSteerPending = false;
          if (!session.alive || sessions.get(session.roomId) !== session) return;
          if (sent) {
            commitDispatchedUserTurn(session, blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n'), null);
            if (mirrorText) journalPublishUserItem(session, 'publishText', { body: mirrorText, from: 'user' });
            for (const entry of queued) for (const payload of pendingMediaMirror(entry)) journalMirrorUserMedia(session, payload);
            finalizeSentQueue(snapshot.convoId, snapshot.entries);
            session.queueNotifications = (session.queueNotifications || []).filter(n => !notifications.includes(n));
          } else {
            restore();
            session._codexUncertainSteer = session.codex.steerUncertain === true;
            journalPublishNotice(snapshot.convoId, session._codexUncertainSteer
              ? 'Codex did not confirm delivery. Your messages are retained, but will not resend automatically. Check the response before choosing Send or Cancel.'
              : 'Codex could not steer this turn. Your messages are still queued for its end.');
          }
          if (!session.busy && !session._codexUncertainSteer) {
            if (!dispatchDeferredCommand(session) && !flushPendingSessionQueue(session)) maybeFlushRoomDelivery(session);
          }
        }).catch(() => {
          session._codexSteerPending = false;
          if (!session.alive) return;
          restore();
          session._codexUncertainSteer = true;
          journalPublishNotice(snapshot.convoId, 'Could not confirm Codex delivery. Messages retained; check before resending.');
        }).finally(() => finishInput?.());
        return 'deferred';
      }
      if (session.agent === AGENT_CODEX && session.busy) {
        restore();
        session._codexInterrupted = true;
        if (session.codex?.interrupt('SIGINT')) return 'deferred';
        session._codexInterrupted = false;
        log.log(`[QUEUE] could not interrupt active Codex turn; kept ${queued.length} queued message(s)`);
        return false;
      }
      let delivered;
      try {
        delivered = dispatchMergedFlush(session, queued);
      } catch (e) {
        restore();
        log.log(`[QUEUE] dispatch threw; kept ${queued.length} queued message(s) for retry (room ${session.roomId}): ${e?.message ?? String(e)}`);
        return false;
      }
      if (!delivered) {
        if (!session.alive || session._autoStopped) {
          log.log(`[QUEUE] dropped queued message(s) (room ${session.roomId})`);
          if (Array.isArray(queued)) for (const entry of queued) runQueuedCleanup(entry);
          finalizeSentQueue(snapshot.convoId, snapshot.entries, 'expired');
          const count = Array.isArray(queued) ? queued.length : 0;
          journalPublishNotice(journalConvoIdFor(session), count > 1
            ? `⚠️ Couldn't deliver ${count} queued messages — the session ended before they were sent.`
            : "⚠️ Couldn't deliver your queued message — the session ended before it was sent.");
          return false;
        }
        restore();
        log.log(`[QUEUE] could not send queued message(s); kept ${queued.length} queued message(s) for retry (room ${session.roomId})`);
        return false;
      }
      // Delivery precedes the release; a failed release write keeps its registry entry.
      finalizeSentQueue(snapshot.convoId, snapshot.entries);
      return true;
    } finally { if (!steering) finishInput?.(); }
  }
  return { flushQueue, finalizeSentQueue, snapshotQueuedReleaseBatch, pendingFlushBatch, queueReleaseForBatch, restoreQueuedBatch };
}
