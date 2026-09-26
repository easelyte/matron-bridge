import { describe, it, expect, vi } from 'vitest';
import { buildLimits } from '../lib/spawn-capacity.js';
import {
  buildBoxVitals, createCodexLimitsRefresher, isWireLimitLine, BOX_LIMIT_LINES_MAX, BOX_STATUS_REPUBLISH_MS,
} from '../lib/box-status.js';

const claude = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Claude ${i}`, percent: i }));
const codex = (n) => Array.from({ length: n }, (_, i) => ({
  id: `codex:codex:${i}`, label: `Codex · ${i}`, percent: 10 + i, resets_at: '2026-09-27T00:00:00.000Z', resets: '9/27 00:00 UTC',
}));

describe('buildLimits with codex lines (contract §1)', () => {
  it('keeps the legacy one-argument behaviour', () => {
    const lines = claude(2);
    expect(buildLimits({ lines, fetchedAt: 5 })).toEqual({ as_of: 5, lines });
  });

  it('puts Claude lines first, then Codex lines', () => {
    const out = buildLimits({ lines: claude(2), fetchedAt: 5 }, { lines: codex(2), fetchedAt: 9 });
    expect(out.as_of).toBe(5);
    expect(out.lines.map((l) => l.id)).toEqual(['c0', 'c1', 'codex:codex:0', 'codex:codex:1']);
  });

  it('caps the merged list at 12, dropping Codex lines past the cap', () => {
    const out = buildLimits({ lines: claude(10), fetchedAt: 5 }, { lines: codex(4), fetchedAt: 9 });
    expect(BOX_LIMIT_LINES_MAX).toBe(12);
    expect(out.lines).toHaveLength(12);
    expect(out.lines.slice(0, 10).map((l) => l.id)).toEqual(claude(10).map((l) => l.id));
    expect(out.lines.slice(10).map((l) => l.id)).toEqual(['codex:codex:0', 'codex:codex:1']);
  });

  it('reports Codex lines alone (as_of from the codex cache) while the Claude cache is cold', () => {
    const out = buildLimits({ lines: null, fetchedAt: 0 }, { lines: codex(1), fetchedAt: 9 });
    expect(out).toEqual({ as_of: 9, lines: codex(1) });
  });

  it('drops Codex lines the journal would reject rather than invalidating the whole block', () => {
    const bad = [
      { id: 'codex:x', label: 'x'.repeat(101), percent: 1 },
      { id: 'codex:y', label: 'ok', percent: 1.5 },
      { id: 'codex:z', label: 'ok', percent: 5, resets_at: 'x'.repeat(41) },
      null,
    ];
    const out = buildLimits({ lines: claude(1), fetchedAt: 5 }, { lines: [...bad, ...codex(1)], fetchedAt: 9 });
    expect(out.lines.map((l) => l.id)).toEqual(['c0', 'codex:codex:0']);
  });

  it('null when both caches are cold or empty', () => {
    expect(buildLimits({ lines: null, fetchedAt: 0 }, { lines: null, fetchedAt: 0 })).toBeNull();
    expect(buildLimits({ lines: [], fetchedAt: 3 }, { lines: [], fetchedAt: 3 })).toBeNull();
    expect(buildLimits(null, null)).toBeNull();
  });
});

describe('isWireLimitLine', () => {
  it('accepts a codexLimitLines-shaped line', () => {
    expect(isWireLimitLine(codex(1)[0])).toBe(true);
  });
  it('rejects wrong types / out-of-range percent', () => {
    expect(isWireLimitLine({ id: '', label: 'a', percent: 1 })).toBe(false);
    expect(isWireLimitLine({ id: 'a', label: 'a', percent: 101 })).toBe(false);
    expect(isWireLimitLine({ id: 'a', label: 'a', percent: -1 })).toBe(false);
    expect(isWireLimitLine({ id: 'a', label: 'a', percent: 5, resets: 7 })).toBe(false);
    expect(isWireLimitLine([])).toBe(false);
  });
});

describe('buildBoxVitals (contract §1 vitals block)', () => {
  it('copies the three keys, rounding percentages to 1 dp', () => {
    expect(buildBoxVitals({ cpu_pct: 12.345, ram_pct: 50, sampled_at_ms: 1_700_000_000_000, extra: 1 }))
      .toEqual({ cpu_pct: 12.3, ram_pct: 50, sampled_at_ms: 1_700_000_000_000 });
  });
  it('omits the block (null) until both CPU and RAM have a sample', () => {
    expect(buildBoxVitals(null)).toBeNull();
    expect(buildBoxVitals({ cpu_pct: null, ram_pct: 40, sampled_at_ms: 1 })).toBeNull();
  });
  it('rejects out-of-range or non-finite values instead of sending something the journal drops', () => {
    expect(buildBoxVitals({ cpu_pct: 101, ram_pct: 40, sampled_at_ms: 1 })).toBeNull();
    expect(buildBoxVitals({ cpu_pct: NaN, ram_pct: 40, sampled_at_ms: 1 })).toBeNull();
    expect(buildBoxVitals({ cpu_pct: 1, ram_pct: 40, sampled_at_ms: 0 })).toBeNull();
    expect(buildBoxVitals({ cpu_pct: 1, ram_pct: 40, sampled_at_ms: 1.5 })).toBeNull();
    expect(buildBoxVitals({ cpu_pct: 1, ram_pct: 40, sampled_at_ms: 9e15 })).toBeNull();
  });
});

describe('BOX_STATUS_REPUBLISH_MS', () => {
  it('is five minutes', () => { expect(BOX_STATUS_REPUBLISH_MS).toBe(300_000); });
});

describe('createCodexLimitsRefresher', () => {
  const mk = (over = {}) => {
    let t = 1_000_000;
    const onFresh = vi.fn();
    const read = vi.fn(async () => ({ limits: codex(2), limitsError: null }));
    const r = createCodexLimitsRefresher({
      read, available: () => true, refreshMs: 300_000, now: () => t, onFresh, ...over,
    });
    return { r, read, onFresh, advance: (ms) => { t += ms; } };
  };

  it('fetches, caches the lines, and fires onFresh', async () => {
    const { r, read, onFresh } = mk();
    await expect(r.refresh()).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(r.cache.lines).toEqual(codex(2));
    expect(r.cache.fetchedAt).toBe(1_000_000);
    expect(onFresh).toHaveBeenCalledTimes(1);
  });

  it('throttles to refreshMs and coalesces concurrent calls', async () => {
    const { r, read, advance } = mk();
    const a = r.refresh();
    const b = r.refresh();
    expect(a).toBe(b);
    await a;
    expect(r.refresh()).toBeNull();
    advance(299_999);
    expect(r.refresh()).toBeNull();
    advance(1);
    await r.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never runs when the box cannot run Codex (and holds no lines)', () => {
    const { r, read } = mk({ available: () => false });
    expect(r.refresh()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(r.cache.lines).toBeNull();
  });

  it('treats a throwing availability probe as unavailable', () => {
    const { r, read } = mk({ available: () => { throw new Error('x'); } });
    expect(r.refresh()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('a failed read keeps the previous lines and their sample time, throttles, and does not fire onFresh', async () => {
    const { r, read, onFresh, advance } = mk();
    await r.refresh();
    advance(300_000);
    read.mockResolvedValueOnce({ limits: [], limitsError: 'Codex app server is unavailable.' });
    await expect(r.refresh()).resolves.toBe(false);
    expect(r.cache.lines).toEqual(codex(2));
    // as_of stays the time the lines were measured (review round 2 F2)...
    expect(r.cache.fetchedAt).toBe(1_000_000);
    expect(buildLimits(null, r.cache).as_of).toBe(1_000_000);
    // ...while the failed attempt still counts for the throttle.
    expect(r.refresh()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onFresh).toHaveBeenCalledTimes(1);
    advance(300_000);
    read.mockRejectedValueOnce(new Error('boom'));
    await expect(r.refresh()).resolves.toBe(false);
    expect(r.cache.lines).toEqual(codex(2));
  });

  it('an onFresh throw does not poison the cache', async () => {
    const { r } = mk({ onFresh: () => { throw new Error('publish failed'); } });
    await expect(r.refresh()).resolves.toBe(true);
    expect(r.cache.lines).toEqual(codex(2));
    expect(r.cache.inflight).toBeNull();
  });
});
