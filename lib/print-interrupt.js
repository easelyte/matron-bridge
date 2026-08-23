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

export function buildInterruptRequest(requestId = randomUUID()) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
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
export function sendPrintInterrupt({
  stdin,
  onWedge,
  onError,
  timeoutMs = INTERRUPT_FALLBACK_MS,
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
  const fire = () => {
    // Retire the handle first (see onSettle above): unconditional, so a
    // suppressed wedge still releases it.
    if (onSettle) onSettle();
    // Suppress the wedge action if the turn it was armed for has ended and a
    // newer turn is running now — clearing busy here would falsely end that turn.
    if (shouldFireWedge && !shouldFireWedge()) return;
    onWedge();
  };
  const timer = setTimeoutFn(fire, timeoutMs);
  return {
    requestId: req.request_id,
    cancel: () => clearTimeoutFn(timer),
  };
}
