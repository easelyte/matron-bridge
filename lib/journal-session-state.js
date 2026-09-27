// Session-state latch for the journal mirror (index.js journalSessionState).
//
// A conversation's session_state ('running' | 'waiting' | 'done') is mirrored
// to the journal as a convo_upsert on every transition, and only on a real
// transition: busy/prompt/turn-end seams fire far more often than the state
// flips, so the last state offered to the publisher is latched on
// session._journalState and an identical offer is suppressed.
//
// The latch used to mean "sent". It actually means "handed to the publisher's
// bounded queue", and during a journal outage that queue overflows and drops
// its oldest frames. A dropped session_state frame left the latch claiming the
// state was out, so the next identical publish was suppressed too, the server
// row stayed at whatever it last heard (`running`), and every client showed a
// permanent "Thinking" for that conversation.
//
// Fix, and the whole of this module: each offer carries the publisher's
// per-frame onEvicted hook. When the publisher evicts a session_state frame,
// the hook releases the latch (only if it still holds that exact state — a
// newer state offered since has its own frame in the queue) and remembers the
// convo as pending. The publisher's send-capacity hook then re-offers ONE
// pending convo per tick (headroom is guaranteed for one frame, and a
// re-offer that overflowed would only evict something else): the live
// session's current state, or `done` straight to the publisher when the
// session is gone, so the row cannot stay `running`. No sweeps, no disk, no
// steady-state traffic — the only new frames are re-offers after an actual
// eviction.
//
// Dependencies (all injected so the logic is testable without index.js):
//   publish(session, state, options)            — index.js journalUpsertConvo
//   upsertConvoDirect(convoId, state, options)   — publisher.upsertConvo, for a
//                                                  session that no longer exists
//   resolveSession(convoId) -> session | null    — live session for a convo id
//   warn(msg)
export function createSessionStateLatch({ publish, upsertConvoDirect, resolveSession, warn = () => {} }) {
  // convoId -> the session_state whose frame was evicted and not yet re-offered.
  const pending = new Map();

  function onEvicted(frame) {
    const convoId = frame?.convo_id;
    const state = frame?.session_state;
    if (!convoId || state === undefined) return;
    // Release on the LIVE object: index.js restarts copy _journalState onto a
    // replacement session under the same convo id, so the object that offered
    // the frame may no longer be the one that matters.
    const live = resolveSession(convoId);
    if (live && live._journalState === state) live._journalState = undefined;
    pending.set(convoId, state);
  }

  // Offer a state for a session: suppressed when it matches the latched
  // state, otherwise latched and published with the eviction hook attached.
  // Returns whether a publish was issued.
  function offer(session, state) {
    if (!session || session._journalState === state) return false;
    session._journalState = state;
    try {
      publish(session, state, { onEvicted });
    } catch (e) {
      warn(`[journal-session-state] publish failed: ${e?.message ?? String(e)}`);
    }
    return true;
  }

  // Called from the publisher's onSendCapacity hook (a send confirmed, queue
  // below its limit). Re-offers at most one pending convo; returns whether it
  // did. The rest wait for the next confirmation, which is guaranteed to come
  // while the queue still holds frames.
  function onCapacity() {
    for (const [convoId, evictedState] of pending) {
      pending.delete(convoId);
      const live = resolveSession(convoId);
      if (live) {
        // A newer state offered after the release has its own frame queued
        // (or evicted, which re-armed pending itself): nothing to repeat.
        if (live._journalState !== undefined) continue;
        warn(`[journal-session-state] re-offering session_state=${evictedState} for ${convoId} after queue eviction`);
        offer(live, evictedState);
      } else {
        warn(`[journal-session-state] session for ${convoId} is gone; re-offering session_state=done after queue eviction`);
        try { upsertConvoDirect(convoId, 'done', { onEvicted }); }
        catch (e) { warn(`[journal-session-state] direct upsert failed: ${e?.message ?? String(e)}`); }
      }
      return true;
    }
    return false;
  }

  return { offer, onCapacity, pendingCount: () => pending.size };
}
