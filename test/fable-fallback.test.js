import { describe, it, expect } from 'vitest';
import { fableMaxed, isFableModel, spawnModelFallback, stallModelFallback, FABLE_MAXED_PERCENT } from '../lib/fable-fallback.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const FUTURE = '2026-10-09T05:00:00.000Z';
const PAST = '2026-10-01T05:00:00.000Z';
const fable = (percent, extra = {}) => ({ id: 'week_fable', label: 'Week (Fable)', percent, resets_at: FUTURE, ...extra });
const all = (percent, extra = {}) => ({ id: 'week_all', label: 'Week (all models)', percent, resets_at: FUTURE, ...extra });
const session = (percent) => ({ id: 'session', label: 'Session', percent, resets_at: FUTURE });

describe('fableMaxed', () => {
  it('true at the threshold and above while the all-models meter has room', () => {
    expect(FABLE_MAXED_PERCENT).toBe(99);
    expect(fableMaxed([session(10), all(60), fable(99)], NOW)).toBe(true);
    expect(fableMaxed([all(60), fable(100)], NOW)).toBe(true);
    expect(fableMaxed([all(60), fable(98)], NOW)).toBe(false);
  });

  it('false when the all-models meter is spent too — Opus would stall as well', () => {
    expect(fableMaxed([all(100), fable(100)], NOW)).toBe(false);
  });

  it('no all-models reading is no evidence of room; an absent Fable line is not maxed', () => {
    expect(fableMaxed([fable(100)], NOW)).toBe(false);
    expect(fableMaxed([all(10), session(100)], NOW)).toBe(false);
  });

  it('a meter whose reset has passed is not a reading of now', () => {
    expect(fableMaxed([all(60), fable(100, { resets_at: PAST })], NOW)).toBe(false);
    // An all-models line past its reset is no reading at all.
    expect(fableMaxed([all(10, { resets_at: PAST }), fable(100)], NOW)).toBe(false);
  });

  it('a relabelled Fable meter (week_fable_5) still counts; other weekly meters do not', () => {
    expect(fableMaxed([all(10), { id: 'week_fable_5', label: 'Week (Fable 5)', percent: 100 }], NOW)).toBe(true);
    expect(fableMaxed([all(10), { id: 'week_fableish', label: 'x', percent: 100 }], NOW)).toBe(false);
    expect(fableMaxed([all(10), { id: 'week_opus', label: 'Week (Opus)', percent: 100 }], NOW)).toBe(false);
  });

  it('a line with no reset time is taken at face value', () => {
    expect(fableMaxed([all(10), { id: 'week_fable', label: 'Week (Fable)', percent: 100 }], NOW)).toBe(true);
  });

  it('junk in, false out', () => {
    for (const lines of [null, undefined, 'x', {}, [null], [{ id: 'week_fable', percent: 'full' }]]) {
      expect(fableMaxed(lines, NOW)).toBe(false);
    }
  });
});

describe('isFableModel', () => {
  it('the alias and full fable names; nothing else', () => {
    for (const m of ['fable', 'Fable', 'claude-fable-5-1', 'fable[1m]']) expect(isFableModel(m)).toBe(true);
    for (const m of ['opus', 'sonnet', 'claude-opus-5-5', '', null, undefined]) expect(isFableModel(m)).toBe(false);
  });
});

describe('spawnModelFallback', () => {
  it('opus with reason fable_limit on a Fable-default box whose Fable meter is spent', () => {
    expect(spawnModelFallback({ defaultModel: 'fable', lines: [all(40), fable(100)], nowMs: NOW }))
      .toEqual({ model: 'opus', reason: 'fable_limit' });
  });

  it('null when the box default is not Fable — that default is not out', () => {
    expect(spawnModelFallback({ defaultModel: 'opus', lines: [all(40), fable(100)], nowMs: NOW })).toBeNull();
    expect(spawnModelFallback({ defaultModel: 'sonnet', lines: [all(40), fable(100)], nowMs: NOW })).toBeNull();
  });

  it('null when Fable has room or there is no reading', () => {
    expect(spawnModelFallback({ defaultModel: 'fable', lines: [all(40), fable(50)], nowMs: NOW })).toBeNull();
    expect(spawnModelFallback({ defaultModel: 'fable', lines: null, nowMs: NOW })).toBeNull();
  });
});

describe('stallModelFallback', () => {
  const STALL = { kind: 'usage_limit', model: 'claude-fable-5-1' };
  const H = 60 * 60 * 1000;
  const fableResets = (ms) => fable(100, { resets_at: new Date(NOW + ms).toISOString() });

  it('a Fable stall with the weekly reset days away switches to Opus', () => {
    expect(stallModelFallback({ stall: STALL, lines: [session(20), all(50), fable(100)], nowMs: NOW }))
      .toEqual({ model: 'opus', reason: 'fable_limit', resetsAt: FUTURE });
  });

  it('a reset under 12 h away waits instead', () => {
    expect(stallModelFallback({ stall: STALL, lines: [all(50), fableResets(11 * H)], nowMs: NOW })).toBeNull();
    expect(stallModelFallback({ stall: STALL, lines: [all(50), fableResets(13 * H)], nowMs: NOW })).not.toBeNull();
  });

  it('no reset time on a spent meter still switches', () => {
    expect(stallModelFallback({ stall: STALL, lines: [all(10), { id: 'week_fable', label: 'x', percent: 100 }], nowMs: NOW }))
      .toEqual({ model: 'opus', reason: 'fable_limit' });
  });

  it('not when the session meter (every model) is full, or all-models is spent', () => {
    expect(stallModelFallback({ stall: STALL, lines: [session(100), all(50), fable(100)], nowMs: NOW })).toBeNull();
    expect(stallModelFallback({ stall: STALL, lines: [all(100), fable(100)], nowMs: NOW })).toBeNull();
  });

  it('only a usage-limit stall on Fable; the session model stands in for a stall without one', () => {
    const lines = [all(50), fable(100)];
    expect(stallModelFallback({ stall: { kind: 'bad_model', model: 'fable' }, lines, nowMs: NOW })).toBeNull();
    expect(stallModelFallback({ stall: { kind: 'usage_limit', model: 'claude-opus-5-5' }, lines, nowMs: NOW })).toBeNull();
    expect(stallModelFallback({ stall: { kind: 'usage_limit' }, model: 'fable', lines, nowMs: NOW })).not.toBeNull();
    expect(stallModelFallback({ stall: { kind: 'usage_limit' }, model: 'opus', lines, nowMs: NOW })).toBeNull();
    expect(stallModelFallback({ stall: null, model: 'fable', lines, nowMs: NOW })).toBeNull();
  });

  it('a Fable meter with room is not a Fable stall to switch away from', () => {
    expect(stallModelFallback({ stall: STALL, lines: [all(50), fable(60)], nowMs: NOW })).toBeNull();
  });
});
