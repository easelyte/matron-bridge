import { randomUUID } from 'crypto';

// Pure helper for assistant-text streaming wiring (index.js -> journalPublisher
// .stream / .endStream), in the same style as lib/journal-activity.js: no
// session, no I/O, so the per-message ref minting is unit-testable without a
// live session or a journal connection. index.js owns the per-session fields
// (session._journalStreamRef, session._journalStreamMsgId) and calls this
// around them, exactly the way journalActivity owns session._journalActivityState.

// Mint or reuse the streaming ref for the assistant message currently being
// streamed. A message's own id is a stable, globally-unique handle and the
// value the client keys its overlay off, so it IS the ref; only when the id is
// absent (defensive — Claude's partial events always carry one) do we fall back
// to a random uuid. The ref is reused while the SAME message keeps streaming so
// all of that message's deltas coalesce under one overlay (both bridge-side and
// in the server hub, whose coalescing key includes message_ref); a new message
// id yields a fresh ref (the caller ends the previous overlay first). The same
// ref is later threaded into the durable publish of that message so the client
// retires the overlay by ref rather than the body-match fallback.
export function streamRefFor(prevRef, prevMsgId, messageId, mkId = randomUUID) {
  if (prevRef && prevMsgId != null && prevMsgId === messageId) return prevRef;
  return messageId || mkId();
}

// --- The ref a flushed reply is published under ---
//
// Unlike streamRefFor these two touch the session's fields directly, because
// the question they answer ("did the text event actually take the ref?") can
// only be read off the session after the send. index.js's flushResponse calls
// armReplyRef, sends the reply's chunks, then calls settleReplyRef.
//
// Why every reply gets a ref: the turn-end summary pass publishes a spoken
// version of the agent's last reply (voice mode), and names that reply by the
// message_ref on its text event (`spoken_ref`). A streamed reply already
// carries its overlay's ref. A reply that was never streamed (iv-mode reads
// whole messages from the transcript; Codex exec has no deltas) carried none,
// so there was nothing to point at. Those now get a fresh uuid. To a client a
// ref with no overlay open is a no-op: it retires an overlay that isn't there.

// Arm the ref for the reply about to be sent. index.js's sendToRoom moves
// session._journalDurableRef onto the first text event it publishes for the
// session and nulls it, in the same synchronous step as the send. Only armed
// when a sendCallback will drive that send; returns null otherwise.
export function armReplyRef(session, mkId = randomUUID) {
  if (!session.sendCallback) return null;
  const minted = !session._journalStreamRef;
  const ref = session._journalStreamRef || mkId();
  session._journalDurableRef = ref;
  return { ref, minted };
}

// After the send: record whether the reply's text event took the ref.
// session._lastReplyRef is the ref of the newest flushed reply, or null when
// that reply went out without one (no callback, or a callback that did not
// publish through sendToRoom for this session) — never an older reply's ref.
// A minted ref nobody took is disarmed here so it cannot ride a later,
// unrelated publish. An overlay ref nobody took is left armed, exactly as
// before this helper existed; journalStreamClear retires it at turn end.
//
// `summarised: false` is a reply the summary pass will never see (flushResponse
// keeps code-only replies out of chatHistory). Its text event still carries
// the ref, but it is not remembered: the spoken lines the next pass writes
// would be about an earlier reply, and must not be hung on this one.
export function settleReplyRef(session, armed, { summarised = true } = {}) {
  const carried = Boolean(armed) && session._journalDurableRef !== armed.ref;
  if (armed && !carried && armed.minted) session._journalDurableRef = null;
  session._lastReplyRef = carried && summarised ? armed.ref : null;
  return session._lastReplyRef;
}
