import { describe, it, expect, vi } from 'vitest';
import { buildInterruptRequest, sendPrintInterrupt, INTERRUPT_FALLBACK_MS } from '../lib/print-interrupt.js';

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
