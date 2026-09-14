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
// Kept as a pure, injected-publisher function (same discipline as subagent-reconcile.js) so it
// is unit-testable without a socket, a filesystem, or a live bridge: index.js starts a server at
// import time and cannot be imported into a test.

// Re-offer each live session's current run-state, clearing the dedup latch first so the
// change-gate in journalSessionState cannot swallow the re-offer as a no-op.
//
// `sessions`  — iterable of session objects carrying `_journalState`.
// `publish`   — (session, state) => void; in production, journalSessionState.
//
// Sessions with no recorded state are skipped: nothing was ever latched for them, so there is
// nothing an eviction could have swallowed. Returns the number of sessions re-offered.
//
// Idempotent by construction: the server COALESCEs an unchanged session_state, so a re-offer of
// a state that DID land is inert rather than a spurious transition.
export function repairSessionStates(sessions, publish) {
  let reoffered = 0;
  for (const session of sessions || []) {
    if (!session) continue;
    const state = session._journalState;
    if (state === undefined || state === null) continue;
    // Clear BEFORE publishing, not after: journalSessionState returns early when the latch
    // already equals the state being set, so leaving it in place would make every re-offer a
    // no-op and the repair a silent no-op too.
    session._journalState = undefined;
    publish(session, state);
    reoffered += 1;
  }
  return reoffered;
}
