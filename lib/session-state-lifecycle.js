// Compose durable transitions with the eviction latch and non-evicting repair offers.
import { planTransition, selectEpochRepairs } from './session-state-repair.js';

export function createSessionStateLifecycle({
  runStateOutbox, sessionStateLatch, journalConvoIdFor, journalPublisher,
  sessions, enabled = () => true, log = console,
}) {
  let _runStateRepairRunning = false;
  function journalSessionState(session, state) {
    const convoId = journalConvoIdFor(session);
    const { publish, latch } = planTransition(
      session._journalState,
      state,
      () => (convoId ? runStateOutbox.note(convoId, state) : undefined),
    );
    if (!publish) {
      session._journalState = latch;
      return;
    }
    // The eviction latch must offer even though the durable gate already decided.
    session._journalState = undefined;
    sessionStateLatch.offer(session, state);
    session._journalState = latch;
  }

  function republishSessionStates() {
    if (!enabled()) return;
    if (_runStateRepairRunning) return;
    _runStateRepairRunning = true;
    try {
      const liveConvoIds = new Set();
      for (const session of sessions.values()) {
        if (!session?.alive) continue;
        const convoId = journalConvoIdFor(session);
        if (convoId) liveConvoIds.add(convoId);
      }
      const { reoffer, retire } = selectEpochRepairs(runStateOutbox.list(), liveConvoIds);

      // Initial sends do not settle records. Only this revision-specific repair does.
      const offer = (convoId, token, publish) =>
        journalPublisher.upsertConvoBestEffort(convoId, { sessionState: publish }, {
          retain: false,
          onLocalSendComplete: () => runStateOutbox.settle(convoId, token),
        });

      let refused = 0;
      let queued = 0;
      for (const { convoId, state, token } of reoffer) {
        if (offer(convoId, token, state) === false) refused += 1;
        else queued += 1;
      }
      let retireQueued = 0;
      for (const { convoId, token } of retire) {
        if (offer(convoId, token, 'done') === false) refused += 1;
        else { queued += 1; retireQueued += 1; }
      }
      if (retireQueued) {
        log.log(`[run-state-repair] queued done for ${retireQueued} stranded running convo(s) with no live session`);
      }
      if (refused) {
        log.warn(`[run-state-repair] ${refused} of ${queued + refused} run-state re-offer(s) refused (queue full) — retained for the next capacity window`);
      }
    } finally {
      _runStateRepairRunning = false;
    }
  }

  function retryRunStateRepairs() {
    if (runStateOutbox.size() > 0) republishSessionStates();
  }
  return { journalSessionState, republishSessionStates, retryRunStateRepairs };
}
