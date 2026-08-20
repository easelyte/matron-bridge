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

// fsync a FILE and PROPAGATE the error. A genuine EIO/ENOSPC from the data
// barrier means the bytes are NOT on stable storage — the caller must treat the
// write as failed rather than advertise a path to storage the fs couldn't
// persist (round-2 F4).
function fsyncFileStrict(fsImpl, p) {
  const fd = fsImpl.openSync(p, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* ignore close error — fsync result already decided */ }
  }
}

// Best-effort parent-directory fsync — a SECONDARY crash-durability barrier that
// runs AFTER the file is already fsync'd and installed. Never throws: a
// directory fsync is genuinely unsupported on many filesystems/platforms, and
// even a storage-class failure here does NOT compromise the file's data (its own
// barrier already ran) — it only weakens the crash-durability of the new
// directory entry. Propagating it would fail an upload whose bytes are safely on
// disk and leave the just-installed target orphaned behind a failure notice
// (round-3 F2), which is strictly worse than a slightly-less-durable dir entry.
function fsyncDirBestEffort(fsImpl, dir) {
  let fd = null;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch { /* non-fatal — file data is already durable; dir entry is secondary */ }
  finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Write `buffer` to `finalPath` durably and without replacing an existing file.
// Returns { path, identity, tmpPath }: `path` is the ACTUAL installed path (may
// differ from finalPath if a collision forced a reselect — callers must use it
// for the saved-to annotation), `identity` is { dev, ino } (or null if the
// post-install stat is unavailable), and `tmpPath` is the unguessable temp name
// so a later cleanup can also remove a residual temp link (see
// makeIdentityAwareCleanup; round-2 F5). Throws the underlying error (after
// cleaning the temp) on an unrecoverable write/install failure, so callers keep
// their existing [Upload failed] handling.
//
// `reselectPath` (optional) returns a fresh deduplicated path; called on an
// EEXIST collision at install, up to `maxAttempts` times. Without it a
// collision throws EEXIST rather than clobbering.
export function writeSavedMediaFile(finalPath, buffer, { fsImpl = fs, reselectPath = null, maxAttempts = 8 } = {}) {
  const dir = path.dirname(finalPath);
  // Unguessable, per-write temp name: safe to unlink by path (no name-reuse
  // risk) and never collides with a user-facing saved name.
  const tmpPath = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  // 1. Write the whole buffer to the private temp, then fsync it (propagating a
  //    real data-barrier failure). A partial write or fsync failure throws here;
  //    the target is never touched, and the temp is removed.
  try {
    fsImpl.writeFileSync(tmpPath, buffer);
    fsyncFileStrict(fsImpl, tmpPath);
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
  // Drop the temp name; the `target` hard link keeps the data. If this unlink
  // fails, the residual temp link is removed later by the cleanup closure, which
  // carries tmpPath (round-2 F5) — the returned tmpPath is that hand-off.
  try { fsImpl.unlinkSync(tmpPath); } catch { /* removed later via cleanup's tmpPath */ }
  // 3. Make the new directory entry crash-durable (secondary barrier).
  fsyncDirBestEffort(fsImpl, dir);
  let identity = null;
  try {
    const st = fsImpl.statSync(target);
    identity = { dev: st.dev, ino: st.ino };
  } catch { /* stat unavailable — cleanup will fail closed */ }
  return { path: target, identity, tmpPath };
}

// Build a best-effort cleanup closure that unlinks `filePath` only if it still
// refers to the exact file `identity` was captured for (dev+ino). FAILS CLOSED:
// with no identity it does NOT unlink the target (leaks the orphan rather than
// risk deleting a file it can't prove is ours). If `tmpPath` is supplied it is
// ALSO unlinked (unconditionally — the temp name is unguessable/per-write, so no
// name-reuse risk), sweeping a residual temp hard link the install couldn't
// remove (round-2 F5); normally the temp is already gone and this no-ops. Never
// throws; cleanup is disk hygiene.
//
// Note on the residual same-path inode-reuse race: in every invocation the
// cleanup runs on a DROP path where nothing else deletes the saved file, so it
// is still present and matches identity when cleanup fires (the "A removed, B
// recreated at A's path with A's reused inode" scenario is not reachable from
// this control flow). The dev+ino check is kept as defense-in-depth and is
// strictly stronger than the prior unconditional unlink-by-path.
export function makeIdentityAwareCleanup(filePath, identity, { fsImpl = fs, tmpPath = null } = {}) {
  return () => {
    // Sweep any residual temp link first (unguessable name → safe by path).
    if (tmpPath) { try { fsImpl.unlinkSync(tmpPath); } catch { /* already gone */ } }
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
