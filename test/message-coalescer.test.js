import { describe, it, expect } from 'vitest';
import { createCoalesceWindow, mergeContentBlockGroups } from '../lib/message-coalescer.js';

function fakeTimers() {
  let t = 0;
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const k = ++id;
      timers.set(k, { fn, at: t + ms });
      return k;
    },
    clearTimer: (k) => timers.delete(k),
    advance: (ms) => {
      t += ms;
      for (const [k, v] of [...timers]) {
        if (v.at <= t) {
          timers.delete(k);
          v.fn();
        }
      }
    },
  };
}

describe('mergeContentBlockGroups', () => {
  it('passes a single text group through', () => {
    expect(mergeContentBlockGroups([[{ type: 'text', text: 'hi' }]]))
      .toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('joins consecutive text groups with double newline', () => {
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
    ])).toEqual([{ type: 'text', text: 'a\n\nb' }]);
  });

  it('splices media groups in arrival order, flushing text runs around them', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'before' }],
      [{ type: 'text', text: 'saved' }, img],
      [{ type: 'text', text: 'after' }],
    ])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'saved' }, img,
      { type: 'text', text: 'after' },
    ]);
  });

  it('skips empty groups', () => {
    expect(mergeContentBlockGroups([[], [{ type: 'text', text: 'x' }], []]))
      .toEqual([{ type: 'text', text: 'x' }]);
  });
});

describe('createCoalesceWindow', () => {
  it('flushes one batch after quiet elapses', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a');
    clk.advance(799);
    expect(flushed).toEqual([]);
    clk.advance(1);
    expect(flushed).toEqual([['a']]);
  });

  it('resets the quiet timer on each push and flushes once', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a');
    clk.advance(700);
    w.push('b');
    clk.advance(700);
    expect(flushed).toEqual([]);
    clk.advance(100);
    expect(flushed).toEqual([['a', 'b']]);
  });

  it('hard-cap fires even under a never-quiet stream and clears the quiet timer', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 2000, ...clk, onFlush: (e) => flushed.push(e) });
    for (let i = 0; i < 10; i++) {
      w.push(i);
      clk.advance(300);
    }
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBeLessThanOrEqual(7);
  });

  it('flush-then-late-arrival opens a fresh window', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a');
    clk.advance(800);
    w.push('b');
    clk.advance(800);
    expect(flushed).toEqual([['a'], ['b']]);
  });

  it('flush force-fires immediately', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a');
    w.flush();
    expect(flushed).toEqual([['a']]);
  });

  it('clear drops entries and timers without flushing', () => {
    const clk = fakeTimers();
    const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a');
    w.clear();
    clk.advance(12000);
    expect(flushed).toEqual([]);
  });
});
