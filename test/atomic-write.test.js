import { describe, it, expect, vi } from 'vitest';
import { atomicWriteFileSync } from '../lib/atomic-write.js';

// In-memory fs fake (same shape as test/recent-folders.test.js) modelling
// POSIX atomic-rename semantics: writeFileSync lands the temp file, renameSync
// atomically replaces the target with it (and removes the temp).
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

const FILE = '/home/dan/.durable-store.json';

describe('atomicWriteFileSync', () => {
  it('writes a pid-tagged temp sibling, then renames it onto the target (never opens the target directly)', () => {
    const fs = fakeFs({ [FILE]: 'old' });
    atomicWriteFileSync(FILE, 'new', { fs });
    // The write went to a temp path, not the durable file.
    const writtenPaths = fs.writeFileSync.mock.calls.map(c => c[0]);
    expect(writtenPaths).toEqual([`${FILE}.${process.pid}.tmp`]);
    // Then a rename landed the complete file onto the target, temp gone.
    expect(fs.renameSync).toHaveBeenCalledWith(`${FILE}.${process.pid}.tmp`, FILE);
    expect(Object.keys(fs.files)).toEqual([FILE]);
    expect(fs.files[FILE]).toBe('new');
  });

  it('a write that fails mid-save (ENOSPC) retains the prior durable file and rethrows', () => {
    const prior = JSON.stringify({ keep: true });
    const fs = fakeFs({ [FILE]: prior });
    fs.writeFileSync.mockImplementation(() => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; });
    expect(() => atomicWriteFileSync(FILE, 'partial', { fs })).toThrow(/ENOSPC/);
    // The durable file is UNCHANGED — it was never opened, never truncated.
    expect(fs.files[FILE]).toBe(prior);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('a rename failure retains the prior durable file and cleans up the temp', () => {
    const prior = 'prior-contents';
    const fs = fakeFs({ [FILE]: prior });
    fs.renameSync.mockImplementation(() => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; });
    expect(() => atomicWriteFileSync(FILE, 'new', { fs })).toThrow(/EPERM/);
    expect(fs.files[FILE]).toBe(prior);
    // Best-effort cleanup removed the orphaned temp.
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${FILE}.${process.pid}.tmp`);
    expect(Object.keys(fs.files)).toEqual([FILE]);
  });

  it('tolerates an fs without unlinkSync during failure cleanup (original error still surfaces)', () => {
    const fs = fakeFs({ [FILE]: 'prior' });
    fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS'); });
    delete fs.unlinkSync;
    expect(() => atomicWriteFileSync(FILE, 'new', { fs })).toThrow(/EROFS/);
    expect(fs.files[FILE]).toBe('prior');
  });
});
