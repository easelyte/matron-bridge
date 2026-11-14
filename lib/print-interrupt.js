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

// A responsive CLI gets more time to finish the interrupted turn, but must
// still release busy state if its result never arrives.
export const INTERRUPT_ACK_BACKSTOP_MS = 60000;

export function buildInterruptRequest(requestId = randomUUID()) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

export function applyInterruptAck(handle, event) {
  if (!handle || event?.type !== 'control_response') return false;
  const requestId = event.response?.request_id ?? event.request_id;
  if (typeof requestId !== 'string' || requestId !== handle.requestId) return false;
  // An error response is the CLI refusing the interrupt, not acknowledging it.
  if (event.response?.subtype !== 'success') return false;
  return handle.ack();
}

// Writes one interrupt line to `stdin` and arms the fallback timer. Returns
// { requestId, cancel, ack, acknowledged } — callers MUST cancel when the turn's `result`
// arrives so a completed interrupt can't fire a stale onWedge into a later
// turn. Returns null when the write fails (onError already called, no timer
// armed). setTimeoutFn/clearTimeoutFn are injection seams for tests.
// ack() replaces the fallback once, measured from the matching response.
// Pre-init receipts do not prove a turn was interrupted: snapshot ackTrusted
// when sending. onSettle retires the handle even when shouldFireWedge rejects
// an expired timer belonging to an older turn.
export function sendPrintInterrupt({
  stdin,
  onWedge,
  onError,
  timeoutMs = INTERRUPT_FALLBACK_MS,
  backstopMs = INTERRUPT_ACK_BACKSTOP_MS,
  ackTrusted = true,
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
    if (settled) return;
    settled = true;
    onSettle?.();
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
      if (!ackTrusted || settled || acked) return false;
      acked = true;
      clearTimeoutFn(timer);
      timer = setTimeoutFn(fire, backstopMs);
      return true;
    },
  };
}
