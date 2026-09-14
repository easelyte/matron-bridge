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
// Kept as a pure predicate (same discipline as subagent-reconcile.js) so it is unit-testable
// without a socket, a filesystem, or a live bridge: index.js starts a server at import time and
// cannot be imported into a test. Durability lives in run-state-outbox.js; this module only
// decides what to DO with the records it holds.

// Decide what to do with each unconfirmed transition on a fresh connection epoch, given which
// convos a LIVE session currently owns.
//
// Three cases, and the middle one is the whole point of persisting across a restart:
//   - a convo a live session owns        -> RE-OFFER its recorded state; the session is running
//                                           and the recorded state is current.
//   - no live session, state `running`   -> RETIRE it: publish `done`. Nothing owns the convo, so
//                                           the process that was running it is gone. This is the
//                                           permanently-stranded case — the row says running, no
//                                           session exists to ever flip it, and every client shows
//                                           a "Thinking" that can never clear.
//   - no live session, terminal state    -> RE-OFFER it. The session ended and its terminal frame
//                                           simply never landed; re-sending it is the repair.
//
// Same TERMINAL-OWNER signal the subagent reconcile uses, and it is why this runs on socket
// connect rather than at process init: by the time the journal socket is up, sessions that are
// going to resume have resumed, so a resumed convo is live and is re-offered rather than retired.
// A convo genuinely resumed later was NOT running at this moment, so retiring it was correct.
//
// Each entry carries its outbox `token` (the revision it was read at) straight through, so the
// caller settles the exact revision it acted on rather than whatever the record says later.
//
// Returns { reoffer: [{convoId, state, token}], retire: [{convoId, token}] }.
export function selectEpochRepairs(entries, liveConvoIds) {
  const live = liveConvoIds instanceof Set ? liveConvoIds : new Set(liveConvoIds || []);
  const reoffer = [];
  const retire = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.convoId !== 'string' || !entry.convoId) continue;
    const { convoId, state } = entry;
    if (!live.has(convoId) && state === 'running') retire.push({ convoId, token: entry.token });
    else if (typeof state === 'string' && state) reoffer.push({ convoId, state, token: entry.token });
  }
  return { reoffer, retire };
}
