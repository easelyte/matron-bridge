// Shared in-flight-media refusal for the session-REPLACEMENT commands.
//
// /restart, /mode, and print-mode /model all tear the live session down and
// re-spawn it (see recreateSession in index.js). This is the SAME hazard the
// agent /switch gate guards (canSwitchAgent in agent-handoff.js): if a
// journal-media attachment for this conversation is still being prepared
// (fetch / transcribe / save-to-disk) when the session is replaced, the media
// router drops the in-flight file at its delivery-time canonicality guard and
// the upload is silently lost from the user's perspective.
//
// The router exposes hasInflightMedia(session) keyed by the STABLE journal
// conversation id and AGE-BOUNDED (a stalled prep stops gating past the window,
// so a replacement can never wedge forever). Each replacement command consults
// it and refuses while media is in flight, exactly like /switch — the operator
// retries a moment later, nothing lost.
//
// One shared message + predicate so the three call sites (two pure planners
// plus the inline /restart guard) stay in lockstep.

export const INFLIGHT_MEDIA_REPLACE_REFUSAL =
  'An attachment is still being processed. Try again in a moment.';

// Given whether media is in flight for this session's conversation, return the
// refusal decision for a session-replacement command. `{ refuse: false }` to
// proceed, `{ refuse: true, message }` to block.
export function inflightMediaReplaceRefusal(hasInflightMedia) {
  return hasInflightMedia
    ? { refuse: true, message: INFLIGHT_MEDIA_REPLACE_REFUSAL }
    : { refuse: false };
}
