// Repair core for the session_state latch across a connection epoch.
//
// THE DEFECT (loop #575's residual; identical in class to the summary latch, #554 F3):
// index.js's journalSessionState records "already sent" on ENQUEUE, not on acceptance. It
// advances session._journalState and hands the frame to the durable queue — which drops the
// OLDEST frame on overflow (journal-publisher enqueue()). A terminal transition evicted during
// an outage backlog is therefore never retried, because the latch says it already went out, and
// the conversation's durable row stays `running` forever once that session goes quiet.
//
// WHY THE CLIENT CANNOT FIX IT: the web reconcile (Matronhq/matron-web#28) prunes a stale
// activity indicator against the durable session_state. When the durable state is itself wrong,
// the client keeps rendering "Thinking" — correctly, per the data it has. The repair has to
// happen where the state is minted.
//
// WHY THIS IS KEYED BY CONVO, NOT BY SESSION: the terminal paths delete the session from the
// live map BEFORE publishing `done` (index.js: `sessions.delete(roomId)` immediately precedes
// `journalSessionState(session, 'done')`). A repair that swept `sessions.values()` would
// therefore never see the very session whose `done` was evicted — the exact case this fixes. So
// transitions are tracked in a pending map keyed by convo id, entered before the publish and
// cleared only on CONFIRMED delivery, which outlives the session object itself.
//
// Kept as pure, injected functions (same discipline as subagent-reconcile.js) so this is
// unit-testable without a socket, a filesystem, or a live bridge: index.js starts a server at
// import time and cannot be imported into a test.

// Record an attempted transition. Called immediately BEFORE the publish, so an eviction that
// happens between enqueue and drain still leaves evidence to repair from. A newer transition for
// the same convo replaces an older pending one: only the latest state is worth re-offering, and
// re-offering a superseded one would move the row backwards.
export function notePendingState(pending, convoId, state) {
  if (!pending || typeof convoId !== 'string' || !convoId) return false;
  if (state === undefined || state === null) return false;
  pending.set(convoId, state);
  return true;
}

// Clear a convo's pending record once the server CONFIRMS the frame. Guarded on the state
// matching: if a newer transition superseded this one while the old frame was in flight, the
// old frame's confirmation must not erase the newer pending record.
export function settlePendingState(pending, convoId, state) {
  if (!pending || typeof convoId !== 'string' || !convoId) return false;
  if (!pending.has(convoId)) return false;
  if (pending.get(convoId) !== state) return false;
  pending.delete(convoId);
  return true;
}

// Re-offer every unconfirmed transition on a fresh connection epoch.
//
// `publish` is (convoId, state) => boolean — in production the NON-EVICTING best-effort path, so
// the repair itself cannot push the outage backlog out of a full queue (the ordinary enqueue
// drops the oldest frame, which at reconnect is real user traffic). A refused offer is RETAINED
// in the pending map to be retried on the next epoch rather than dropped.
//
// Idempotent: the server COALESCEs an unchanged session_state, so re-offering a state that did
// land is inert rather than a spurious transition. Returns { offered, refused }.
export function repairPendingStates(pending, publish) {
  let offered = 0;
  let refused = 0;
  if (!pending || typeof publish !== 'function') return { offered, refused };
  // Snapshot first: `publish` can settle an entry synchronously on an injected transport, and
  // mutating a Map while iterating it would skip entries.
  for (const [convoId, state] of [...pending.entries()]) {
    if (publish(convoId, state) === false) refused += 1;
    else offered += 1;
  }
  return { offered, refused };
}
