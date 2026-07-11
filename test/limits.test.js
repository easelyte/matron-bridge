import { describe, it, expect, vi } from 'vitest';
import { parseThresholds, parseIntEnv, DEFAULT_THRESHOLDS } from '../lib/limits.js';

const noLog = { warn: () => {} };

describe('parseThresholds', () => {
  it('parses a valid list sorted + deduped', () => {
    expect(parseThresholds('95,50,85,50', noLog)).toEqual([50, 85, 95]);
  });
  it('falls back to defaults on any malformed entry', () => {
    const log = { warn: vi.fn() };
    expect(parseThresholds('50,x,95', log)).toEqual(DEFAULT_THRESHOLDS);
    expect(log.warn).toHaveBeenCalled();
  });
  it('rejects out-of-range and empty', () => {
    expect(parseThresholds('0,120', noLog)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('', noLog)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds(undefined, noLog)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('parseIntEnv', () => {
  it('returns a finite value for valid input', () => {
    expect(parseIntEnv('60000', { name: 'X', def: 300000, min: 1 }, noLog)).toBe(60000);
  });
  it('non-finite garbage warns + returns default', () => {
    const log = { warn: vi.fn() };
    expect(parseIntEnv('abc', { name: 'X', def: 300000, min: 1 }, log)).toBe(300000);
    expect(log.warn).toHaveBeenCalled();
  });
  it('below-min warns + returns default (non-sentinel knob)', () => {
    expect(parseIntEnv('0', { name: 'X', def: 3, min: 1 }, noLog)).toBe(3);
  });
  it('POLL_MS carve-out: non-finite -> default, but <=0 preserved as disable sentinel', () => {
    expect(parseIntEnv('abc', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(300000);
    expect(parseIntEnv('0', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(0);
    expect(parseIntEnv('-5', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(0);
  });
});
