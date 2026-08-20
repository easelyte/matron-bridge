// Durable disk write + identity-aware cleanup for saved-media files.
//
// journal-media saves an inbound attachment to the session uploads dir as a
// side effect of building the prompt blocks (index.js buildSavedMediaBlocks).
// Two failure modes need defense-in-depth beyond the plain
// fs.writeFileSync(path, buffer) + fs.unlinkSync(path) it used to do:
//
//   1. A partial write (ENOSPC / EIO mid-write) would leave a truncated file at
//      the FINAL path — claude then Reads a corrupt attachment. Fix: write to a
//      sibling temp file first and rename into place. Rename within the same
//      directory is atomic on POSIX, so a reader/cleanup sees either no file or
//      the complete file, never a half-written one; a failed write leaves only
//      the temp, which we unlink.
//
//   2. The drop-path cleanup unlinks by PATHNAME. Between the save and the
//      cleanup the path could be recycled for a DIFFERENT, legitimate file
//      (dedup collision after a restart, a later upload reusing a freed name),
//      and a blind unlink-by-path would delete the wrong file. Fix: capture the
//      saved file's identity (dev+ino) and unlink only when the on-disk file
//      still matches it.
//
// fsImpl is injectable so tests can drive ENOSPC deterministically; it defaults
// to the real fs.

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';

// Write `buffer` to `finalPath` via a temp-then-rename so a partial write can't
// leave a corrupt file at finalPath. Returns { path, identity } where identity
// is { dev, ino } (or null if the post-write stat is unavailable — cleanup then
// falls back to unlink-by-path). Throws the underlying write/rename error after
// cleaning the temp, so callers keep their existing [Upload failed] handling.
export function writeSavedMediaFile(finalPath, buffer, { fsImpl = fs } = {}) {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    fsImpl.writeFileSync(tmpPath, buffer);
  } catch (err) {
    // ENOSPC/EIO mid-write: the temp may exist truncated. Remove it and rethrow
    // — finalPath was never touched, so nothing corrupt is left behind.
    try { fsImpl.unlinkSync(tmpPath); } catch { /* nothing to remove */ }
    throw err;
  }
  try {
    fsImpl.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  let identity = null;
  try {
    const st = fsImpl.statSync(finalPath);
    identity = { dev: st.dev, ino: st.ino };
  } catch { /* stat unavailable — cleanup degrades to unlink-by-path */ }
  return { path: finalPath, identity };
}

// Build a best-effort cleanup closure that unlinks `filePath` only if it still
// refers to the exact file `identity` was captured for (dev+ino). Guards the
// name-reuse TOCTOU above. With no identity it degrades to unlink-by-path (the
// old behavior — best available). Never throws; cleanup is disk hygiene.
export function makeIdentityAwareCleanup(filePath, identity, { fsImpl = fs } = {}) {
  return () => {
    if (!filePath) return;
    try {
      if (identity) {
        const st = fsImpl.statSync(filePath);
        if (st.dev !== identity.dev || st.ino !== identity.ino) {
          // The path now points at a different file than the one we saved — the
          // name was recycled. Leave it alone; unlinking would clobber an
          // unrelated legitimate upload.
          return;
        }
      }
      fsImpl.unlinkSync(filePath);
    } catch { /* already gone / never written / stat failed — nothing to do */ }
  };
}
