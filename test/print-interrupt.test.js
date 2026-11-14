import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildInterruptRequest, sendPrintInterrupt, applyInterruptAck, INTERRUPT_FALLBACK_MS, INTERRUPT_ACK_BACKSTOP_MS } from '../lib/print-interrupt.js';

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
    handle.cancel();
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
});

describe('interrupt acknowledgments', () => {
  afterEach(() => vi.useRealTimers());

  function setup(options = {}) {
    vi.useFakeTimers();
    const onWedge = vi.fn();
    const onSettle = vi.fn();
    const handle = sendPrintInterrupt({ stdin: { write() {} }, onWedge, onSettle, ...options });
    const ack = (requestId = handle.requestId) => ({
      type: 'control_response', response: { request_id: requestId, subtype: 'success' },
    });
    return { handle, onWedge, onSettle, ack };
  }

  it('keeps the 10s fallback for a matching error response', () => {
    const h = setup();
    const error = { ...h.ack(), response: { ...h.ack().response, subtype: 'error' } };
    expect(applyInterruptAck(h.handle, error)).toBe(false);
    expect(h.handle.acknowledged).toBe(false);
    vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS);
    expect(h.onWedge).toHaveBeenCalledTimes(1);
  });

  it('uses a 60s backstop from the matching success response', () => {
    const h = setup();
    vi.advanceTimersByTime(9000);
    expect(applyInterruptAck(h.handle, h.ack())).toBe(true);
    expect(h.handle.acknowledged).toBe(true);
    vi.advanceTimersByTime(INTERRUPT_ACK_BACKSTOP_MS - 1);
    expect(h.onWedge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.onWedge).toHaveBeenCalledTimes(1);
    expect(h.onSettle).toHaveBeenCalledTimes(1);
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
  });

  it('accepts a top-level request id and ignores duplicate receipts', () => {
    const h = setup();
    expect(applyInterruptAck(h.handle, { type: 'control_response', request_id: h.handle.requestId, response: { subtype: 'success' } })).toBe(true);
    vi.advanceTimersByTime(50000);
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
    vi.advanceTimersByTime(10000);
    expect(h.onWedge).toHaveBeenCalledTimes(1);
  });

  it('keeps the 10s fallback for unrelated or malformed events', () => {
    const h = setup();
    for (const event of [null, {}, { type: 'result', request_id: h.handle.requestId },
      h.ack('other-request'), { type: 'control_response', response: {} },
      { ...h.ack('other-request'), request_id: h.handle.requestId }]) {
      expect(applyInterruptAck(h.handle, event)).toBe(false);
    }
    expect(applyInterruptAck(null, h.ack())).toBe(false);
    vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS);
    expect(h.onWedge).toHaveBeenCalledTimes(1);
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
  });

  it('keeps the original deadline for a pre-init receipt', () => {
    const h = setup({ ackTrusted: false });
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
    vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS);
    expect(h.onWedge).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('cancel disarms the timer and rejects later acks (acked: %s)', (acked) => {
    const h = setup();
    if (acked) applyInterruptAck(h.handle, h.ack());
    h.handle.cancel();
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
    vi.advanceTimersByTime(120000);
    expect(h.onWedge).not.toHaveBeenCalled();
    expect(h.onSettle).not.toHaveBeenCalled();
  });

  it('retires a stale timer without running its wedge action', () => {
    const h = setup({ shouldFireWedge: () => false });
    vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS);
    expect(h.onSettle).toHaveBeenCalledTimes(1);
    expect(h.onWedge).not.toHaveBeenCalled();
    expect(applyInterruptAck(h.handle, h.ack())).toBe(false);
  });
});
