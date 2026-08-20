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

  it('requests an fsync durability barrier via { flush: true } on the temp write, BEFORE the rename', () => {
    const order = [];
    const fs = fakeFs({ [FILE]: 'old' });
    fs.writeFileSync.mockImplementation((p, data) => { order.push(`write:${p}`); fs.files[p] = data; });
    fs.renameSync.mockImplementation((from, to) => { order.push(`rename:${from}->${to}`); fs.files[to] = fs.files[from]; delete fs.files[from]; });

    atomicWriteFileSync(FILE, 'new', { fs });

    const tmp = `${FILE}.${process.pid}.tmp`;
    // The barrier is the flush option on the temp write — writeFileSync fsyncs
    // the file through its own descriptor before closing it (Node >= 21), so the
    // rename can only publish fully-persisted bytes. No reopen (which would add a
    // read-permission requirement a restrictive umask could deny).
    expect(fs.writeFileSync).toHaveBeenCalledWith(tmp, 'new', { flush: true });
    // ...and the flushed write strictly precedes the rename.
    expect(order).toEqual([`write:${tmp}`, `rename:${tmp}->${FILE}`]);
    expect(fs.files[FILE]).toBe('new');
  });

  it('a writeback failure surfaced by the flush (EIO/ENOSPC) fails CLOSED — throws, no rename, prior target intact', () => {
    // With { flush: true } a real fsync error surfaces AS a writeFileSync throw,
    // before the rename — so the durable target is never touched.
    const prior = JSON.stringify({ keep: true });
    const fs = fakeFs({ [FILE]: prior });
    fs.writeFileSync.mockImplementation(() => { const e = new Error('EIO'); e.code = 'EIO'; throw e; });
    expect(() => atomicWriteFileSync(FILE, 'new', { fs })).toThrow(/EIO/);
    expect(fs.files[FILE]).toBe(prior);
    expect(fs.renameSync).not.toHaveBeenCalled();
    // The unconfirmed temp was cleaned up.
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${FILE}.${process.pid}.tmp`);
  });
});
