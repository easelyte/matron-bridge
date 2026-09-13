import { describe, it, expect, vi } from 'vitest';
import {
  buildInterruptRequest,
  sendPrintInterrupt,
  isInterruptAck,
  applyInterruptAck,
  INTERRUPT_FALLBACK_MS,
  INTERRUPT_ACK_BACKSTOP_MS,
} from '../lib/print-interrupt.js';

describe('buildInterruptRequest', () => {
  it('builds the control_request shape with a uuid request_id', () => {
    const req = buildInterruptRequest();
    expect(req.type).toBe('control_request');
    expect(req.request).toEqual({ subtype: 'interrupt' });
    expect(req.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses an explicit requestId when given', () => {
    expect(buildInterruptRequest('fixed-id').request_id).toBe('fixed-id');
  });

  it('generates a fresh request_id per call', () => {
    expect(buildInterruptRequest().request_id).not.toBe(buildInterruptRequest().request_id);
  });
});

describe('sendPrintInterrupt', () => {
  const collect = () => {
    const writes = [];
    return { writes, stdin: { write: (s) => { writes.push(s); return true; } } };
  };

  it('writes one newline-terminated control_request line', () => {
    const { writes, stdin } = collect();
    const handle = sendPrintInterrupt({ stdin, onWedge: () => {}, onError: () => {} });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]);
    expect(parsed).toEqual({
      type: 'control_request',
      request_id: handle.requestId,
      request: { subtype: 'interrupt' },
    });
  });

  it('fires onWedge after timeoutMs', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      vi.advanceTimersByTime(4999);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the timeout to INTERRUPT_FALLBACK_MS (10s)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {} });
      vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS - 1);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() prevents onWedge from firing', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      handle.cancel();
      vi.advanceTimersByTime(10000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a write failure via onError, returns null, arms no timer', () => {
    vi.useFakeTimers();
    try {
      const boom = new Error('EPIPE');
      const stdin = { write: () => { throw boom; } };
      const onWedge = vi.fn();
      const onError = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError, timeoutMs: 5000 });
      expect(handle).toBeNull();
      expect(onError).toHaveBeenCalledWith(boom);
      vi.advanceTimersByTime(60000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when onError is omitted', () => {
    const stdin = { write: () => { throw new Error('EPIPE'); } };
    expect(sendPrintInterrupt({ stdin, onWedge: () => {} })).toBeNull();
  });

  // Turn-generation correlation (loop #688 R3 F1). The wedge timer is armed for
  // one specific turn; if that turn has ended and a newer turn is now running
  // when the timer fires, the wedge must be SUPPRESSED — clearing busy then
  // would falsely end the newer (possibly operator or higher-priority) turn.
  describe('shouldFireWedge generation guard', () => {
    it('suppresses onWedge when shouldFireWedge returns false (turn changed under us)', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onWedge = vi.fn();
        // Simulate the armed turn ending and a newer turn starting before the
        // timer fires: the generation the interrupt was armed for no longer matches.
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000, shouldFireWedge: () => false });
        vi.advanceTimersByTime(5000);
        expect(onWedge).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires onWedge when shouldFireWedge returns true (still the armed turn)', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onWedge = vi.fn();
        // Same turn still running (genuinely wedged): the defensive unstick must
        // still fire so busy is cleared instead of queueing messages forever.
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000, shouldFireWedge: () => true });
        vi.advanceTimersByTime(5000);
        expect(onWedge).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('evaluates shouldFireWedge at fire time, not arm time', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onWedge = vi.fn();
        let sameGeneration = true;
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000, shouldFireWedge: () => sameGeneration });
        // The armed turn ends and a newer turn starts after arming but before the timeout.
        sameGeneration = false;
        vi.advanceTimersByTime(5000);
        expect(onWedge).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires onWedge when shouldFireWedge is omitted (operator !esc path / backward compat unchanged)', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onWedge = vi.fn();
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
        vi.advanceTimersByTime(5000);
        expect(onWedge).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // onSettle retires the caller's handle at fire time (Codex R1 F1). A
  // suppressed wedge must still release session.pendingInterrupt, or the next
  // interrupt on the current turn is rejected as already-in-flight.
  describe('onSettle handle retirement', () => {
    it('calls onSettle before onWedge when the wedge fires', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const order = [];
        const onSettle = vi.fn(() => order.push('settle'));
        const onWedge = vi.fn(() => order.push('wedge'));
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000, onSettle, shouldFireWedge: () => true });
        vi.advanceTimersByTime(5000);
        expect(onSettle).toHaveBeenCalledTimes(1);
        expect(onWedge).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['settle', 'wedge']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls onSettle even when the wedge is suppressed (stale-handle retirement)', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onSettle = vi.fn();
        const onWedge = vi.fn();
        sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000, onSettle, shouldFireWedge: () => false });
        vi.advanceTimersByTime(5000);
        expect(onSettle).toHaveBeenCalledTimes(1);
        expect(onWedge).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not call onSettle when cancelled (the canceller retires its own handle)', () => {
      vi.useFakeTimers();
      try {
        const { stdin } = collect();
        const onSettle = vi.fn();
        const handle = sendPrintInterrupt({ stdin, onWedge: () => {}, onError: () => {}, timeoutMs: 5000, onSettle });
        handle.cancel();
        vi.advanceTimersByTime(10000);
        expect(onSettle).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Interrupt acknowledgement backstop (loop #701).
//
// The CLI answers our control_request with a control_response carrying OUR
// request_id in ~17ms. The bridge used to drop that line on the floor, so the
// only signal it had was "did a `result` arrive within 10s" — and the 10s wedge
// is the single door into the turn-overlap window (busy cleared while the CLI
// is still running the turn, next operator message silently folded into it and
// potentially lost with the abort).
//
// Consuming the ack proves the CLI is responsive, so the 10s unstick is
// replaced with a much longer backstop. It is deliberately NOT cancelled: a CLI
// version could ack and then never deliver a result, and the session must still
// recover. The no-ack path keeps today's exact 10s behaviour, which is the case
// the wedge was designed for.
describe('isInterruptAck', () => {
  const ack = (requestId, subtype = 'success') => ({
    type: 'control_response',
    response: { subtype, request_id: requestId, still_queued: [] },
  });

  it('matches a control_response carrying our request_id', () => {
    expect(isInterruptAck(ack('abc'), 'abc')).toBe(true);
  });

  it('does NOT match a control_response for some other request', () => {
    expect(isInterruptAck(ack('someone-else'), 'abc')).toBe(false);
  });

  it('does NOT match non-control_response events', () => {
    expect(isInterruptAck({ type: 'result', request_id: 'abc' }, 'abc')).toBe(false);
    expect(isInterruptAck({ type: 'system', subtype: 'init' }, 'abc')).toBe(false);
  });

  it('is null/garbage safe', () => {
    expect(isInterruptAck(null, 'abc')).toBe(false);
    expect(isInterruptAck(undefined, 'abc')).toBe(false);
    expect(isInterruptAck({ type: 'control_response' }, 'abc')).toBe(false);
    expect(isInterruptAck(ack('abc'), null)).toBe(false);
    expect(isInterruptAck(ack('abc'), undefined)).toBe(false);
  });

  it('tolerates a top-level request_id shape as well as the nested one', () => {
    expect(isInterruptAck({ type: 'control_response', request_id: 'abc' }, 'abc')).toBe(true);
  });
});

describe('interrupt ack backstop', () => {
  const collect = () => {
    const writes = [];
    return { writes, stdin: { write: (s) => { writes.push(s); return true; } } };
  };
  const ackFor = (handle) => ({
    type: 'control_response',
    response: { subtype: 'success', request_id: handle.requestId, still_queued: [] },
  });

  it('exports a backstop materially longer than the 10s fallback', () => {
    expect(INTERRUPT_ACK_BACKSTOP_MS).toBeGreaterThan(INTERRUPT_FALLBACK_MS);
    expect(INTERRUPT_ACK_BACKSTOP_MS).toBe(60000);
  });

  // Requirement 1: acked -> no fire at 10s, but the backstop still fires.
  it('ack: the 10s wedge does not fire, and the backstop fires if no result ever arrives', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const onSettle = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onSettle, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      // The CLI acks ~17ms in.
      vi.advanceTimersByTime(20);
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(true);
      expect(handle.acknowledged).toBe(true);

      // The original 10s deadline passes with the turn still unsettled.
      vi.advanceTimersByTime(10_000);
      expect(onWedge).not.toHaveBeenCalled();
      expect(onSettle).not.toHaveBeenCalled();

      // ...but the backstop is real: a CLI that acks and then never delivers a
      // result must still unstick the session.
      vi.advanceTimersByTime(49_980);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(onWedge).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 2: the no-ack regression guard. This is the behaviour the wedge
  // was designed for and #701 must not weaken it.
  it('no ack: the 10s wedge fires exactly as it does today', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const onSettle = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onSettle, onError: () => {},
        timeoutMs: INTERRUPT_FALLBACK_MS, shouldFireWedge: () => true,
      });
      expect(handle.acknowledged).toBe(false);
      vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS - 1);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 3: a control_response for somebody else's request must not
  // disarm our wedge.
  it('non-matching request_id: the wedge is unaffected and still fires at 10s', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      const foreign = {
        type: 'control_response',
        response: { subtype: 'success', request_id: 'not-ours', still_queued: [] },
      };
      expect(applyInterruptAck(handle, foreign)).toBe(false);
      expect(handle.acknowledged).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 4: ack then a normal `result` -> clean turn end, nothing left
  // behind. clearPendingInterrupt() calls cancel().
  it('ack then result: cancel() retires the backstop, no residue and no leaked timer', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const onSettle = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onSettle, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      vi.advanceTimersByTime(20);
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(true);
      // The aborted turn's `result` lands ~112ms after the ack.
      vi.advanceTimersByTime(112);
      handle.cancel();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(600_000);
      expect(onWedge).not.toHaveBeenCalled();
      // cancel() never calls onSettle: the canceller owns the handle.
      expect(onSettle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second ack is a no-op and does not re-arm a fresh backstop', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(true);
      vi.advanceTimersByTime(30_000);
      // A duplicate ack must NOT restart the 60s clock — the backstop deadline
      // is measured from the first ack, otherwise a chatty CLI could defer the
      // unstick indefinitely.
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ack after the wedge already fired is a no-op (no timer resurrection)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      vi.advanceTimersByTime(10_000);
      expect(onWedge).toHaveBeenCalledTimes(1);
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(600_000);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ack after cancel is a no-op (a settled interrupt cannot be revived)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({
        stdin, onWedge, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => true,
      });
      handle.cancel();
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(600_000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the backstop still honours the generation guard (a newer turn suppresses it)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const onSettle = vi.fn();
      let sameGeneration = true;
      const handle = sendPrintInterrupt({
        stdin, onWedge, onSettle, onError: () => {},
        timeoutMs: 10000, backstopMs: 60000, shouldFireWedge: () => sameGeneration,
      });
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(true);
      sameGeneration = false;
      vi.advanceTimersByTime(60_000);
      expect(onWedge).not.toHaveBeenCalled();
      // ...but the handle is still retired, so the next interrupt is not
      // rejected as already-in-flight (Codex R1 F1 on #688).
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applyInterruptAck is safe when there is no pending interrupt', () => {
    expect(applyInterruptAck(null, { type: 'control_response', response: { request_id: 'x' } })).toBe(false);
    expect(applyInterruptAck(undefined, { type: 'control_response', response: { request_id: 'x' } })).toBe(false);
  });

  it('defaults backstopMs to INTERRUPT_ACK_BACKSTOP_MS', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError: () => {}, shouldFireWedge: () => true });
      expect(applyInterruptAck(handle, ackFor(handle))).toBe(true);
      vi.advanceTimersByTime(INTERRUPT_ACK_BACKSTOP_MS - 1);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
