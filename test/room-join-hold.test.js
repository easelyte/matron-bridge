import { describe, it, expect } from 'vitest';
import { createJoinHold } from '../lib/room-join-hold.js';

const item = (seq, extra = {}) => ({ frame: { seq, type: 'text' }, ...extra });

describe('createJoinHold', () => {
  it('passes a room that is not being joined straight through', () => {
    const h = createJoinHold();
    const it1 = item(1);
    expect(h.offer('r1', it1)).toEqual([it1]);
    expect(h.isHeld('r1')).toBe(false);
  });

  it('holds a room\'s frames while it is joined and releases them in order', () => {
    const h = createJoinHold();
    h.hold('r1');
    expect(h.offer('r1', item(5))).toEqual([]);
    expect(h.offer('r1', item(6))).toEqual([]);
    // Another room is not affected.
    expect(h.offer('r2', item(7))).toEqual([item(7)]);
    expect(h.release('r1', [])).toEqual([item(5), item(6)]);
    expect(h.isHeld('r1')).toBe(false);
    expect(h.offer('r1', item(8))).toEqual([item(8)]);
  });

  it('drops on release what the join turn\'s backlog already showed', () => {
    const h = createJoinHold();
    h.hold('r1');
    h.offer('r1', item(5));
    h.offer('r1', item(6));
    h.offer('r1', { frame: { type: 'text' } }); // no seq: never dropped
    expect(h.release('r1', [{ seq: 4 }, { seq: 5 }])).toEqual([item(6), { frame: { type: 'text' } }]);
  });

  it('drops nothing when the backlog could not be read', () => {
    const h = createJoinHold();
    h.hold('r1');
    h.offer('r1', item(5));
    expect(h.release('r1', null)).toEqual([item(5)]);
  });

  it('lets go of a room whose join is past the deadline, held frames first', () => {
    let t = 1000;
    const h = createJoinHold({ maxMs: 100, now: () => t });
    h.hold('r1');
    h.offer('r1', item(1));
    t = 1200;
    expect(h.offer('r1', item(2))).toEqual([item(1), item(2)]);
    expect(h.isHeld('r1')).toBe(false);
    expect(h.release('r1', [])).toEqual([]);
  });

  it('a second hold keeps what is already held', () => {
    const h = createJoinHold();
    h.hold('r1');
    h.offer('r1', item(1));
    h.hold('r1');
    expect(h.release('r1', [])).toEqual([item(1)]);
  });
});
