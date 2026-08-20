import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSavedMediaFile, makeIdentityAwareCleanup } from '../lib/saved-media-file.js';

describe('writeSavedMediaFile — temp-then-rename durability', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smf-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the full buffer to the final path and captures dev+ino identity', () => {
    const finalPath = path.join(dir, 'report.pdf');
    const buf = Buffer.from('the whole file');
    const { path: p, identity } = writeSavedMediaFile(finalPath, buf);

    expect(p).toBe(finalPath);
    expect(fs.readFileSync(finalPath)).toEqual(buf);
    const st = fs.statSync(finalPath);
    expect(identity).toEqual({ dev: st.dev, ino: st.ino });
    // No leftover temp files in the directory.
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('leaves NO corrupt file at the final path when the write fails mid-way (ENOSPC)', () => {
    const finalPath = path.join(dir, 'big.bin');
    // fs stub: the write to the temp throws ENOSPC after a partial write would
    // have happened; the real fs handles rename/unlink so a leaked temp is
    // observable on disk if the helper forgets to clean it.
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    let attemptedTmp = null;
    const fsImpl = {
      writeFileSync: (p, _buf) => { attemptedTmp = p; throw enospc; },
      renameSync: fs.renameSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs),
      statSync: fs.statSync.bind(fs),
    };

    expect(() => writeSavedMediaFile(finalPath, Buffer.from('x'.repeat(1000)), { fsImpl }))
      .toThrow(/no space left/);
    // The FINAL path never exists — no truncated/corrupt file for claude to Read.
    expect(fs.existsSync(finalPath)).toBe(false);
    // The temp path the helper chose was a sibling, not the final path.
    expect(attemptedTmp).not.toBe(finalPath);
    // No stray temp files left in the dir either (helper unlinked on failure —
    // here the stub threw before creating one, but the dir must still be clean).
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes the temp file and rethrows when the install (link) fails non-recoverably', () => {
    const finalPath = path.join(dir, 'x.bin');
    const failLink = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    const real = fs;
    const fsImpl = {
      writeFileSync: real.writeFileSync.bind(real),
      openSync: real.openSync.bind(real),
      fsyncSync: real.fsyncSync.bind(real),
      closeSync: real.closeSync.bind(real),
      linkSync: () => { throw failLink; },
      unlinkSync: real.unlinkSync.bind(real),
      statSync: real.statSync.bind(real),
    };
    expect(() => writeSavedMediaFile(finalPath, Buffer.from('data'), { fsImpl })).toThrow(/cross-device/);
    expect(fs.existsSync(finalPath)).toBe(false);
    // Temp cleaned — directory empty (only the temp existed and was removed).
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does NOT clobber a file that raced onto the target — reselects a fresh name (no-replace install)', () => {
    // The whole point of no-replace: another writer created `wanted` after
    // dedup chose it. linkSync must NOT replace it; instead the helper asks for
    // a fresh path and installs there, leaving the racer's file intact.
    const wanted = path.join(dir, 'race.txt');
    fs.writeFileSync(wanted, 'the racer — an unrelated legitimate file');
    const reselected = path.join(dir, 'race-1.txt');
    let reselectCalls = 0;
    const { path: installed } = writeSavedMediaFile(wanted, Buffer.from('our upload'), {
      reselectPath: () => { reselectCalls += 1; return reselected; },
    });
    expect(reselectCalls).toBe(1);
    expect(installed).toBe(reselected);
    // Racer's file is untouched…
    expect(fs.readFileSync(wanted).toString()).toContain('the racer');
    // …and our upload landed at the reselected path.
    expect(fs.readFileSync(reselected).toString()).toBe('our upload');
    // No leftover temp files.
    expect(fs.readdirSync(dir).sort()).toEqual(['race-1.txt', 'race.txt']);
  });

  it('throws EEXIST on collision when no reselect is provided (never clobbers)', () => {
    const wanted = path.join(dir, 'c.txt');
    fs.writeFileSync(wanted, 'existing');
    expect(() => writeSavedMediaFile(wanted, Buffer.from('new'))).toThrow(/EEXIST|exist/i);
    expect(fs.readFileSync(wanted).toString()).toBe('existing'); // untouched
  });
});

describe('makeIdentityAwareCleanup — name-reuse race', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smf-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('unlinks the file it saved', () => {
    const finalPath = path.join(dir, 'a.txt');
    const { identity } = writeSavedMediaFile(finalPath, Buffer.from('a'));
    const cleanup = makeIdentityAwareCleanup(finalPath, identity);
    cleanup();
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it('does NOT unlink when the path was recycled for a different file (dev+ino changed)', () => {
    // A real unlink+recreate on the same fs frequently REUSES the freed inode,
    // so force the recycled-identity case deterministically with a stub fs: the
    // path on disk now reports a different inode than the one A captured.
    const finalPath = path.join(dir, 'shared-name.txt');
    const idA = { dev: 1, ino: 100 };
    let unlinked = false;
    const fsImpl = {
      statSync: () => ({ dev: 1, ino: 999 }), // B — a different file at the same path
      unlinkSync: () => { unlinked = true; },
    };
    const cleanupForA = makeIdentityAwareCleanup(finalPath, idA, { fsImpl });
    cleanupForA();
    expect(unlinked).toBe(false); // must not clobber the recycled name's file
  });

  it('DOES unlink when the on-disk identity still matches (stubbed)', () => {
    const idA = { dev: 1, ino: 100 };
    let unlinkedPath = null;
    const fsImpl = {
      statSync: () => ({ dev: 1, ino: 100 }), // same file A saved
      unlinkSync: (p) => { unlinkedPath = p; },
    };
    makeIdentityAwareCleanup('/u/a.txt', idA, { fsImpl })();
    expect(unlinkedPath).toBe('/u/a.txt');
  });

  it('never throws when the file is already gone', () => {
    const cleanup = makeIdentityAwareCleanup(path.join(dir, 'missing.txt'), { dev: 1, ino: 2 });
    expect(() => cleanup()).not.toThrow();
  });

  it('FAILS CLOSED when no identity was captured (leaks rather than delete the wrong file)', () => {
    // With no captured identity the cleanup can't prove the on-disk file is the
    // one it saved, so it must NOT unlink — leaking an orphan is safer than
    // risking deletion of an unrelated legitimate file.
    const finalPath = path.join(dir, 'noid.txt');
    fs.writeFileSync(finalPath, 'x');
    makeIdentityAwareCleanup(finalPath, null)();
    expect(fs.existsSync(finalPath)).toBe(true);
    makeIdentityAwareCleanup(finalPath, undefined)();
    expect(fs.existsSync(finalPath)).toBe(true);
  });
});
