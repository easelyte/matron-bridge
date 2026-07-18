import { describe, it, expect, vi } from 'vitest';
import { createRecentFolders } from '../lib/recent-folders.js';

// In-memory fs fake shared across store instances so persistence round-trips
// can be asserted without touching the real disk.
function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    writeFileSync: vi.fn((p, data) => { files[p] = data; }),
  };
}

const FILE = '/home/dan/.matron-bridge-folders.json';

describe('createRecentFolders', () => {
  it('starts empty when the file is missing and never throws', () => {
    const store = createRecentFolders({ file: FILE, fs: fakeFs(), log: { warn: () => {} } });
    expect(store.list()).toEqual([]);
  });

  it('tolerates a corrupt file by starting empty', () => {
    const store = createRecentFolders({
      file: FILE,
      fs: fakeFs({ [FILE]: '{not json' }),
      log: { warn: () => {} },
    });
    expect(store.list()).toEqual([]);
    expect(store.touch('/w/a', 1000)).toBe(true);
  });

  it('touch records a folder durably — a new store instance over the same fs sees it', () => {
    const fs = fakeFs();
    const store = createRecentFolders({ file: FILE, fs });
    expect(store.touch('/w/a', 1000)).toBe(true);
    const reloaded = createRecentFolders({ file: FILE, fs });
    expect(reloaded.list()).toEqual([{ path: '/w/a', lastUsed: 1000 }]);
  });

  it('debounces rewrites: a touch within the interval neither writes nor regresses', () => {
    const fs = fakeFs();
    const store = createRecentFolders({ file: FILE, fs, minTouchIntervalMs: 60_000 });
    store.touch('/w/a', 100_000);
    expect(store.touch('/w/a', 130_000)).toBe(false); // fresh enough — skipped
    expect(store.touch('/w/a', 50_000)).toBe(false);  // older — never regress
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(store.touch('/w/a', 161_000)).toBe(true);  // past the interval — advances
    expect(store.list()).toEqual([{ path: '/w/a', lastUsed: 161_000 }]);
  });

  it('ignores junk paths', () => {
    const fs = fakeFs();
    const store = createRecentFolders({ file: FILE, fs });
    expect(store.touch('', 1)).toBe(false);
    expect(store.touch(null, 1)).toBe(false);
    expect(store.touch(42, 1)).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('lists newest-first', () => {
    const store = createRecentFolders({ file: FILE, fs: fakeFs() });
    store.touch('/w/old', 1000);
    store.touch('/w/new', 3000);
    store.touch('/w/mid', 2000);
    expect(store.list().map((f) => f.path)).toEqual(['/w/new', '/w/mid', '/w/old']);
  });

  it('seedFrom imports session records in one write without regressing newer entries', () => {
    const fs = fakeFs();
    const store = createRecentFolders({ file: FILE, fs });
    store.touch('/w/live', 9000);
    fs.writeFileSync.mockClear();
    store.seedFrom([
      { path: '/w/live', lastUsed: 100 },   // older than the live touch — kept at 9000
      { path: '/w/hist1', lastUsed: 2000 },
      { path: '/w/hist2', lastUsed: 3000 },
      { path: '', lastUsed: 1 },            // junk — skipped
      { path: '/w/hist1' },                 // no timestamp — lands as 0, still remembered
    ]);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([
      { path: '/w/live', lastUsed: 9000 },
      { path: '/w/hist2', lastUsed: 3000 },
      { path: '/w/hist1', lastUsed: 2000 },
    ]);
  });

  it('a failed write keeps the in-memory state and does not throw', () => {
    const fs = fakeFs();
    fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS'); });
    const store = createRecentFolders({ file: FILE, fs, log: { warn: () => {} } });
    expect(store.touch('/w/a', 1000)).toBe(true);
    expect(store.list()).toEqual([{ path: '/w/a', lastUsed: 1000 }]);
  });
});
