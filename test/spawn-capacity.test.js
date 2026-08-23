import { describe, it, expect } from 'vitest';
import { buildActivity, buildLimits, buildDisk } from '../lib/spawn-capacity.js';

const NOW = 1_754_800_000_000;
const mkSession = (roomId, workdir, extra = {}) => ({ roomId, workdir, alive: true, lastActivityAt: NOW, ...extra });

describe('buildActivity', () => {
  it('counts live sessions and groups the last hour by workdir', () => {
    const sessions = new Map([
      ['r1', mkSession('r1', '/w/app')],
      ['r2', mkSession('r2', '/w/app')],
      ['r3', mkSession('r3', '/w/other')],
    ]);
    const out = buildActivity({ sessions, persisted: {}, now: NOW });
    expect(out.live_sessions).toBe(3);
    expect(out.last_hour).toEqual([
      { path: '/w/app', sessions: 2 },
      { path: '/w/other', sessions: 1 },
    ]);
  });

  it('excludes dead and auto-stopped sessions from the live count', () => {
    const sessions = new Map([
      ['r1', mkSession('r1', '/w/app', { alive: false })],
      ['r2', mkSession('r2', '/w/app', { _autoStopped: true })],
    ]);
    const out = buildActivity({ sessions, persisted: {}, now: NOW });
    expect(out.live_sessions).toBe(0);
  });

  it('includes persisted records used within the hour and dedupes against live sessions by key', () => {
    const sessions = new Map([['r1', mkSession('r1', '/w/app')]]);
    const persisted = {
      r1: { workdir: '/w/app', lastUsed: NOW - 1000 },           // same session as live r1 — once
      r2: { workdir: '/w/app', lastUsed: NOW - 30 * 60_000 },     // in window
      r3: { workdir: '/w/app', lastUsed: NOW - 2 * 3_600_000 },   // stale — out
      r4: { workdir: '/w/other', lastUsed: NOW - 10 * 60_000 },
    };
    const out = buildActivity({ sessions, persisted, now: NOW });
    expect(out.last_hour).toEqual([
      { path: '/w/app', sessions: 2 },
      { path: '/w/other', sessions: 1 },
    ]);
    expect(out.live_sessions).toBe(1);
  });

  it('a live session counts toward its workdir even with a stale persisted record', () => {
    const sessions = new Map([['r1', mkSession('r1', '/w/app', { lastActivityAt: NOW })]]);
    const persisted = { r1: { workdir: '/w/app', lastUsed: NOW - 2 * 3_600_000 } };
    const out = buildActivity({ sessions, persisted, now: NOW });
    expect(out.last_hour).toEqual([{ path: '/w/app', sessions: 1 }]);
  });

  it('caps last_hour at 20 entries, most recently used first', () => {
    const persisted = {};
    for (let i = 0; i < 25; i++) persisted[`r${i}`] = { workdir: `/w/${i}`, lastUsed: NOW - i * 60_000 };
    const out = buildActivity({ sessions: new Map(), persisted, now: NOW });
    expect(out.last_hour).toHaveLength(20);
    expect(out.last_hour[0].path).toBe('/w/0');
  });

  it('skips records with missing workdir or bad lastUsed without throwing', () => {
    const persisted = { a: null, b: { lastUsed: NOW }, c: { workdir: '/w/x', lastUsed: 'soon' } };
    const out = buildActivity({ sessions: new Map(), persisted, now: NOW });
    expect(out).toEqual({ live_sessions: 0, last_hour: [] });
  });

  it('omits an over-long path (>1024 chars) from last_hour while keeping other entries — the journal rejects the whole block otherwise', () => {
    const overlong = '/w/' + 'x'.repeat(1025);
    const sessions = new Map([
      ['r1', mkSession('r1', overlong)],
      ['r2', mkSession('r2', '/w/fine')],
    ]);
    const out = buildActivity({ sessions, persisted: {}, now: NOW });
    // live_sessions still counts both — only last_hour grouping skips the bad path.
    expect(out.live_sessions).toBe(2);
    expect(out.last_hour).toEqual([{ path: '/w/fine', sessions: 1 }]);
  });
});

describe('buildLimits', () => {
  it('returns as_of + lines verbatim from a warm cache', () => {
    const lines = [{ id: 'session', label: 'Session', percent: 39, resets_at: '2026-08-11T01:00:00.000Z' }];
    expect(buildLimits({ lines, fetchedAt: 123 })).toEqual({ as_of: 123, lines });
  });
  it('returns null for a cold or empty cache', () => {
    expect(buildLimits({ lines: null, fetchedAt: 0 })).toBeNull();
    expect(buildLimits({ lines: [], fetchedAt: 123 })).toBeNull();
    expect(buildLimits({ lines: [{ id: 'x' }], fetchedAt: 0 })).toBeNull();
    expect(buildLimits(null)).toBeNull();
  });
});

describe('buildDisk', () => {
  it('multiplies bavail (not bfree) by bsize for free, blocks by bsize for total', () => {
    const statfs = () => ({ bavail: 100, bfree: 120, bsize: 4096, blocks: 1000 });
    expect(buildDisk({ path: '/w', statfs })).toEqual({ free_bytes: 409_600, total_bytes: 4_096_000 });
  });
  it('returns null when statfs throws (missing path, unsupported fs)', () => {
    expect(buildDisk({ path: '/gone', statfs: () => { throw new Error('ENOENT'); } })).toBeNull();
  });
  it('returns null for nonsense figures rather than relaying them', () => {
    // free > total (inconsistent snapshot)
    expect(buildDisk({ path: '/w', statfs: () => ({ bavail: 2000, bsize: 4096, blocks: 1000 }) })).toBeNull();
    // zero-block filesystem
    expect(buildDisk({ path: '/w', statfs: () => ({ bavail: 0, bsize: 4096, blocks: 0 }) })).toBeNull();
    // product overflows past MAX_SAFE_INTEGER
    expect(buildDisk({ path: '/w', statfs: () => ({ bavail: 2 ** 40, bsize: 2 ** 20, blocks: 2 ** 40 }) })).toBeNull();
    // non-numeric fields (a bigint-mode statfs would stringify oddly through Number())
    expect(buildDisk({ path: '/w', statfs: () => ({ bavail: NaN, bsize: 4096, blocks: 1000 }) })).toBeNull();
  });
  it('accepts a completely empty volume (free == total)', () => {
    const statfs = () => ({ bavail: 1000, bsize: 4096, blocks: 1000 });
    expect(buildDisk({ path: '/w', statfs })).toEqual({ free_bytes: 4_096_000, total_bytes: 4_096_000 });
  });
});
