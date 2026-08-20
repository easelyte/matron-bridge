// Durable, no-replace disk write + identity-aware cleanup for saved-media files.
//
// journal-media saves an inbound attachment to the session uploads dir as a
// side effect of building the prompt blocks (index.js buildSavedMediaBlocks).
// The plain fs.writeFileSync(path, buffer) + fs.unlinkSync(path) it used to do
// has three defense-in-depth gaps this module closes:
//
//   1. PARTIAL WRITE. An ENOSPC/EIO mid-write would leave a truncated file at
//      the FINAL path — claude then Reads a corrupt attachment. Fix: write to a
//      private sibling temp first; the target is never touched until the temp
//      holds the whole buffer.
//
//   2. CLOBBER. deduplicateFilename() picks a free name, but there is a window
//      before the file is installed in which another writer (a busy claude tool
//      in the same uploads dir) could create that name. renameSync REPLACES it
//      silently — the unrelated file is lost. Fix: install with linkSync, which
//      fails EEXIST instead of replacing; on collision reselect a fresh
//      deduplicated name and retry.
//
//   3. NAME REUSE on cleanup. The drop-path cleanup unlinks by pathname; the
//      path could be recycled for a DIFFERENT, legitimate file before cleanup
//      fires. Fix: capture the saved file's identity (dev+ino) and unlink only
//      when the on-disk file still matches — and FAIL CLOSED (leak, never
//      delete) when identity can't be established, so cleanup can never remove
//      the wrong file. A same-path inode-reuse + stat/unlink TOCTOU is a
//      narrower residual than baseline (which deleted whatever was at the path
//      unconditionally); closing it fully would need never-reused unguessable
//      names, which would corrupt the user-facing "saved to <path>" annotation.
//
// Best-effort durability: the temp is fsync'd before install and the parent dir
// is fsync'd after, so a crash after the write returns can't surface a
// zero/partial attachment referenced by already-queued blocks. fsImpl is
// injectable so tests can drive ENOSPC / collisions deterministically.

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';

// Best-effort fsync of a path (file or directory). Never throws — some
// filesystems/platforms reject a directory fsync, and durability here is a
// belt-and-suspenders barrier, not a correctness precondition.
function fsyncPathBestEffort(fsImpl, p) {
  let fd = null;
  try {
    fd = fsImpl.openSync(p, 'r');
    fsImpl.fsyncSync(fd);
  } catch { /* fsync unsupported here — skip */ }
  finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Write `buffer` to `finalPath` durably and without replacing an existing file.
// Returns { path, identity }: `path` is the ACTUAL installed path (may differ
// from finalPath if a collision forced a reselect — callers must use it for the
// saved-to annotation), `identity` is { dev, ino } (or null if the post-install
// stat is unavailable). Throws the underlying error (after cleaning the temp)
// on an unrecoverable write/install failure, so callers keep their existing
// [Upload failed] handling.
//
// `reselectPath` (optional) returns a fresh deduplicated path; called on an
// EEXIST collision at install, up to `maxAttempts` times. Without it a
// collision throws EEXIST rather than clobbering.
export function writeSavedMediaFile(finalPath, buffer, { fsImpl = fs, reselectPath = null, maxAttempts = 8 } = {}) {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  // 1. Write the whole buffer to the private temp, then fsync it. A partial
  //    write throws here; the target is never touched, and the temp is removed.
  try {
    fsImpl.writeFileSync(tmpPath, buffer);
    fsyncPathBestEffort(fsImpl, tmpPath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* nothing to remove */ }
    throw err;
  }
  // 2. Install with no-replace semantics. linkSync fails EEXIST rather than
  //    silently replacing a file that raced onto the target after dedup.
  let target = finalPath;
  let attempt = 0;
  for (;;) {
    try {
      fsImpl.linkSync(tmpPath, target);
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST' && reselectPath && ++attempt < maxAttempts) {
        target = reselectPath();
        continue;
      }
      try { fsImpl.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
  // Drop the temp name; the `target` hard link keeps the data.
  try { fsImpl.unlinkSync(tmpPath); } catch { /* ignore */ }
  // 3. Make the new directory entry crash-durable.
  fsyncPathBestEffort(fsImpl, dir);
  let identity = null;
  try {
    const st = fsImpl.statSync(target);
    identity = { dev: st.dev, ino: st.ino };
  } catch { /* stat unavailable — cleanup will fail closed */ }
  return { path: target, identity };
}

// Build a best-effort cleanup closure that unlinks `filePath` only if it still
// refers to the exact file `identity` was captured for (dev+ino). FAILS CLOSED:
// with no identity it does NOT unlink (leaks the orphan rather than risk
// deleting a file it can't prove is ours). Never throws; cleanup is disk hygiene.
export function makeIdentityAwareCleanup(filePath, identity, { fsImpl = fs } = {}) {
  return () => {
    if (!filePath || !identity) return; // fail closed on missing target/identity
    try {
      const st = fsImpl.statSync(filePath);
      if (st.dev !== identity.dev || st.ino !== identity.ino) {
        // The path now points at a different file than the one we saved — the
        // name was recycled. Leave it; unlinking would clobber an unrelated
        // legitimate upload.
        return;
      }
      fsImpl.unlinkSync(filePath);
    } catch { /* already gone / never written / stat failed — nothing to do */ }
  };
}
