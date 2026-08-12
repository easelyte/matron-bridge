import { describe, it, expect, vi } from 'vitest';
import { createRoomReplyWaiters } from '../lib/room-reply-waiters.js';

// Injectable-timer harness: capture the timeout callbacks so tests fire them
// deterministically without fake timers.
function makeFixture() {
  const timers = [];
  const cleared = [];
  const waiters = createRoomReplyWaiters({
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => cleared.push(t),
  });
  return { waiters, timers, cleared };
}

describe('createRoomReplyWaiters', () => {
  it('resolves the waiter with the reply and clears its timer', async () => {
    const { waiters, timers, cleared } = makeFixture();
    const p = waiters.await('room-1', 5000);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(5000);
    expect(waiters.resolve('room-1', { from: 'dev-2 (agent)', body: 'yo' })).toBe(true);
    await expect(p).resolves.toEqual({ from: 'dev-2 (agent)', body: 'yo' });
    expect(cleared).toEqual([timers[0]]);
  });

  it('resolves null on timeout and unhooks (map-key cleanup on the timeout path)', async () => {
    const { waiters, timers } = makeFixture();
    const p = waiters.await('room-1', 1000);
    expect(waiters.waiterCount('room-1')).toBe(1);
    timers[0].fn();
    await expect(p).resolves.toBeNull();
    expect(waiters.waiterCount('room-1')).toBe(0);
    // Fully unhooked: a later reply finds nobody waiting.
    expect(waiters.resolve('room-1', { from: 'x', body: 'late' })).toBe(false);
  });

  it('returns false from resolve when nobody is waiting on that room', () => {
    const { waiters } = makeFixture();
    expect(waiters.resolve('room-ghost', { from: 'x', body: 'y' })).toBe(false);
  });

  it('is keyed strictly by room id — a reply in one room never settles another', async () => {
    const { waiters, timers } = makeFixture();
    const p1 = waiters.await('room-1', 1000);
    waiters.await('room-2', 1000);
    expect(waiters.resolve('room-1', { from: 'a', body: 'b' })).toBe(true);
    await expect(p1).resolves.toEqual({ from: 'a', body: 'b' });
    expect(waiters.waiterCount('room-2')).toBe(1);
    timers[1].fn(); // drain room-2's timer so nothing dangles
  });

  it('never double-resolves: a second reply after consumption finds no waiter', async () => {
    const { waiters } = makeFixture();
    const p = waiters.await('room-1', 1000);
    expect(waiters.resolve('room-1', { from: 'a', body: 'first' })).toBe(true);
    expect(waiters.resolve('room-1', { from: 'a', body: 'second' })).toBe(false);
    await expect(p).resolves.toEqual({ from: 'a', body: 'first' });
  });

  it('a late timeout callback after resolution is a harmless no-op', async () => {
    const { waiters, timers } = makeFixture();
    const p = waiters.await('room-1', 1000);
    waiters.resolve('room-1', { from: 'a', body: 'b' });
    expect(() => timers[0].fn()).not.toThrow();
    await expect(p).resolves.toEqual({ from: 'a', body: 'b' });
  });

  it('multiple concurrent waiters on one room all settle on the first reply', async () => {
    const { waiters } = makeFixture();
    const p1 = waiters.await('room-1', 1000);
    const p2 = waiters.await('room-1', 2000);
    expect(waiters.waiterCount('room-1')).toBe(2);
    expect(waiters.resolve('room-1', { from: 'a', body: 'b' })).toBe(true);
    await expect(p1).resolves.toEqual({ from: 'a', body: 'b' });
    await expect(p2).resolves.toEqual({ from: 'a', body: 'b' });
    expect(waiters.waiterCount('room-1')).toBe(0);
  });

  it('defaults to the real timers when none are injected', async () => {
    vi.useFakeTimers();
    try {
      const waiters = createRoomReplyWaiters();
      const p = waiters.await('room-1', 50);
      vi.advanceTimersByTime(60);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
