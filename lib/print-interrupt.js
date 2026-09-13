// Print-mode turn interrupt: builds and writes a `control_request` /
// `interrupt` line to the claude CLI's stream-json stdin. Same control
// protocol the Agent SDK uses; verified against claude 2.1.207 — the CLI
// answers with a control_response, ends the in-flight turn with a `result`
// event (is_error: true, subtype: 'error_during_execution'), and keeps the
// process alive for subsequent turns.
//
// Fail-open contract (same stance as lib/journal-publisher.js): nothing here
// may throw into a transport handler — a write failure reports through
// onError and arms no fallback timer.
import { randomUUID } from 'node:crypto';

// If the CLI never delivers the turn-ending `result` (wedged process, a
// version that ignores control_request), the caller's onWedge fires after
// this long so the bridge can clear busy state instead of queueing messages
// forever.
export const INTERRUPT_FALLBACK_MS = 10000;

// Loop #701. The CLI answers our control_request with a control_response
// carrying OUR request_id — measured at ~17ms against claude 2.1.207, with the
// aborted turn's `result` 112ms behind it. An ack therefore proves the CLI is
// responsive, which is the exact condition INTERRUPT_FALLBACK_MS exists to
// test for ("wedged process, a version that ignores control_request").
//
// On ack the wedge is pushed out to this backstop rather than CANCELLED: a CLI
// version could acknowledge the interrupt and then never deliver a result, and
// the session must still unstick itself instead of queueing the operator's
// messages behind a busy flag nothing will ever clear. Cancelling outright
// would trade one rare failure for a worse one.
export const INTERRUPT_ACK_BACKSTOP_MS = 60000;

export function buildInterruptRequest(requestId = randomUUID()) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

// True when `event` is the CLI's control_response for OUR interrupt.
//
// The request_id match is load-bearing, not decoration: the control channel is
// shared, so a control_response for some other request must never disarm a live
// wedge. The measured shape nests the id under `response`; the top-level form is
// accepted as a defensive fallback for CLI versions that flatten it. Both are
// compared against a uuid we minted ourselves, so neither can collide.
//
// Deliberately NOT gated on `response.subtype === 'success'`: the wedge tests
// for an UNRESPONSIVE CLI, and a response of any subtype disproves that. A
// refused interrupt still leaves the turn running to its own `result`, and the
// backstop covers the case where it never comes. The subtype is surfaced by
// `interruptAckSubtype` so the caller can log it if an error subtype ever shows
// up in the wild.
export function isInterruptAck(event, requestId) {
  if (!event || typeof requestId !== 'string' || !requestId) return false;
  if (event.type !== 'control_response') return false;
  const id = event.response?.request_id ?? event.request_id;
  return typeof id === 'string' && id === requestId;
}

// The response subtype ('success' | 'error' | ...), for logging only.
export function interruptAckSubtype(event) {
  return event?.response?.subtype ?? event?.subtype ?? 'unknown';
}

// Wiring helper for the bridge's control_response seam: returns true only when
// `event` is `handle`'s own ack AND the handle actually moved to its backstop
// as a result. Keeping the decision here (rather than inline at the call site)
// keeps the request_id match and the already-fired / already-cancelled /
// already-acked guards in one tested place.
export function applyInterruptAck(handle, event) {
  if (!handle || typeof handle.ack !== 'function') return false;
  if (!isInterruptAck(event, handle.requestId)) return false;
  return handle.ack();
}

// Writes one interrupt line to `stdin` and arms the fallback timer. Returns
// { requestId, cancel } — callers MUST cancel when the turn's `result`
// arrives so a completed interrupt can't fire a stale onWedge into a later
// turn. Returns null when the write fails (onError already called, no timer
// armed). setTimeoutFn/clearTimeoutFn are injection seams for tests.
//
// shouldFireWedge (loop #688 R3 F1): an optional turn-generation correlation
// gate, evaluated at FIRE time (not arm time). The wedge is armed for ONE
// specific turn; cancel() covers the clean case (the turn's `result` arrives),
// but several bridge seams clear busy WITHOUT cancelling (a prompt surfaces,
// esc-cancel) after which a NEWER turn can start inside the 10s window. Without
// correlation the stale timer would then clear the newer turn's busy — a
// robustness gap that #44 made peer-triggerable (a priority peer could arm a
// wedge that later false-clears a higher-tier turn). When shouldFireWedge is
// supplied and returns false at fire time, the wedge ACTION (onWedge) is
// suppressed. Omitting it preserves the original always-fire behaviour
// (operator !esc, older callers).
//
// onSettle (optional): invoked once when the timer fires, BEFORE the
// shouldFireWedge gate, whether or not onWedge runs. The timer has fired and
// will never fire again, so the caller must retire its handle here even when
// the wedge is suppressed — otherwise a stale pending-interrupt handle lingers
// and a later interrupt on the current turn is wrongly rejected as
// already-in-flight (Codex R1 F1). cancel() does NOT call onSettle: the caller
// that cancels already owns the handle and retires it itself.
//
// ack() (loop #701): called when the CLI's control_response for THIS request
// arrives — see applyInterruptAck. It replaces the armed timeoutMs timer with a
// single backstopMs one measured from the ack, and returns true only if it
// actually did so. It is a no-op (returns false) once the handle has settled
// (fired or been cancelled) or has already been acked; a duplicate ack must not
// restart the backstop clock, or a chatty CLI could defer the unstick forever.
export function sendPrintInterrupt({
  stdin,
  onWedge,
  onError,
  timeoutMs = INTERRUPT_FALLBACK_MS,
  backstopMs = INTERRUPT_ACK_BACKSTOP_MS,
  shouldFireWedge = null,
  onSettle = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const req = buildInterruptRequest();
  try {
    stdin.write(JSON.stringify(req) + '\n');
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
  let settled = false;
  let acked = false;
  const fire = () => {
    settled = true;
    // Retire the handle first (see onSettle above): unconditional, so a
    // suppressed wedge still releases it.
    if (onSettle) onSettle();
    // Suppress the wedge action if the turn it was armed for has ended and a
    // newer turn is running now — clearing busy here would falsely end that turn.
    if (shouldFireWedge && !shouldFireWedge()) return;
    onWedge();
  };
  let timer = setTimeoutFn(fire, timeoutMs);
  return {
    requestId: req.request_id,
    get acknowledged() { return acked; },
    cancel: () => {
      settled = true;
      clearTimeoutFn(timer);
    },
    ack: () => {
      if (settled || acked) return false;
      acked = true;
      clearTimeoutFn(timer);
      timer = setTimeoutFn(fire, backstopMs);
      return true;
    },
  };
}
