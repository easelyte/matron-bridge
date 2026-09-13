import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldAnnounceOnline, recordOnlineAnnounced } from '../lib/announce-once.js';

// In-memory fs fake (same shape as test/atomic-write.test.js) — covers the
// readFileSync used by shouldAnnounceOnline and the write/rename/unlink trio
// atomicWriteFileSync needs under recordOnlineAnnounced.
function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    writeFileSync: vi.fn((p, data) => { files[p] = data; }),
    renameSync: vi.fn((from, to) => {
      if (!(from in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files[to] = files[from];
      delete files[from];
    }),
    unlinkSync: vi.fn((p) => { delete files[p]; }),
  };
}

const MARKER = '/home/dan/.claude-matrix-announced.json';
const CONVO = 'bridge-henry';

describe('announce-once', () => {
  it('announces on first boot (no marker file)', () => {
    const fs = fakeFs();
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(true);
  });

  it('stays silent on later boots once the marker records this convo', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(false);
  });

  it('re-announces when the control convo id changes (new convo never saw the intro)', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    expect(shouldAnnounceOnline(MARKER, 'bridge-renamed', { fs })).toBe(true);
  });

  it('treats a corrupt marker as first boot (one repeat beats never announcing)', () => {
    const fs = fakeFs({ [MARKER]: '{not json' });
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(true);
  });

  it('swallows and logs a failed marker write (fail-open: worst case is one repeat announcement, never a dead bridge)', () => {
    const fs = fakeFs();
    fs.writeFileSync = vi.fn(() => { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; });
    const log = { warn: vi.fn() };
    // Runs during top-level module evaluation in index.js — a rethrow here
    // would abort boot before main() ever runs.
    expect(() => recordOnlineAnnounced(MARKER, CONVO, { fs, log })).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/announce-once/);
    // With no marker on disk, the next boot simply announces again.
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(true);
  });

  it('records the marker atomically (temp sibling + rename, target never opened directly)', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    const writtenPaths = fs.writeFileSync.mock.calls.map(c => c[0]);
    expect(writtenPaths).toEqual([`${MARKER}.${process.pid}.tmp`]);
    expect(fs.renameSync).toHaveBeenCalledWith(`${MARKER}.${process.pid}.tmp`, MARKER);
    const marker = JSON.parse(fs.files[MARKER]);
    expect(marker.convoId).toBe(CONVO);
    expect(typeof marker.announcedAt).toBe('string');
  });
});

// index.js cannot be imported (it boots a bridge), so the wiring is pinned by
// source inspection, as the other *-wiring tests do.
describe('index.js boot announcement wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('shouldAnnounceOnline(ANNOUNCE_MARKER_FILE');
  const block = src.slice(start, src.indexOf('\n  }\n', start));

  it('gates the announcement on the marker', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('records the marker only when the publish was accepted, so a refused one is retried next boot', () => {
    // publishText returns enqueue acceptance (false when the frame was
    // evicted). Recording unconditionally would silence every later boot
    // for a message that never left the bridge.
    expect(block).toMatch(/const accepted = journalPublisher\.publishText\(/);
    expect(block).toMatch(/if \(accepted\) recordOnlineAnnounced\(/);
    expect(block.match(/recordOnlineAnnounced\(/g)).toHaveLength(1);
  });
});
