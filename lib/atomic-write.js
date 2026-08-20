// Atomic in-place file replacement for durable single-copy stores (PR #151).
//
// A plain fs.writeFileSync rewrite truncates the target before writing, so a
// kill / power loss / ENOSPC / short write mid-rewrite corrupts the ONLY copy
// — and every caller's parse-failure recovery then silently starts empty, so
// the next write overwrites the evidence. Write a temp sibling first, then
// atomically rename it onto the target: the target is only ever replaced by a
// complete file, and a failure mid-write leaves the prior file untouched. The
// temp is a sibling (same directory → same filesystem) so the rename is a
// true atomic rename, not a cross-device copy. The temp name carries the pid
// so two overlapping bridge processes can't clobber each other's in-flight
// temp between write and rename (last writer still wins on the final rename —
// callers that need stronger guarantees need a real lock, which none of the
// current stores warrant).
//
// On failure the partial temp is best-effort unlinked (the durable target was
// never opened) and the original error rethrown — callers keep their own
// logging/recovery policy, exactly as with a direct writeFileSync.
//
// fs is injectable in the style of the other lib factories (recent-folders
// passes its fake through for tests); default is the real module.

import nodeFs from 'fs';

export function atomicWriteFileSync(file, data, { fs = nodeFs } = {}) {
  const tmpFile = `${file}.${process.pid}.tmp`;
  try {
    // Durability barrier (`flush: true`): a plain writeFileSync only lands the
    // bytes in the page cache, so a crash/power-loss AFTER the rename can still
    // surface the target as a zero-length or partial file — the rename metadata
    // reaches disk while the file's own contents do not (the classic
    // rename-without-fsync data loss). `flush: true` fsyncs the temp file
    // THROUGH writeFileSync's own descriptor before it closes, so the rename can
    // only ever publish fully-persisted bytes. Doing it via the write's own fd
    // (rather than reopening the temp) is deliberate: reopening would add a
    // read-permission requirement that a restrictive umask can deny (EACCES on a
    // write-only temp) and would introduce a descriptor to manage/leak.
    //
    // Fails CLOSED: a real writeback error (EIO / ENOSPC) surfaces as a throw
    // from writeFileSync BEFORE the rename, so the catch cleans up the temp and
    // rethrows WITHOUT renaming — the prior target is left intact and the caller
    // learns the write did not commit, rather than believing an unconfirmed file
    // was published (V5 atomic state writes). An injected fs fake ignores the
    // option (its writeFileSync takes data only), so tests are unaffected; the
    // real fs (Node >= 21) honours it.
    //
    // Only the temp file's CONTENT is fsync'd — the half that actually prevents
    // the corruption above. A directory fsync (which would additionally make the
    // rename ENTRY durable) is deliberately NOT done: it is non-portable
    // (EINVAL/EPERM/EISDIR on some platforms/filesystems), and it can only run
    // AFTER the rename has already committed — so swallowing its real errors
    // would falsely acknowledge durability, while propagating them would report
    // failure for a write that already landed (an ambiguous commit our callers,
    // which just warn or arm-anyway, would mishandle as a hard failure). The
    // task's barrier is "fsync-before-rename", which `flush: true` satisfies;
    // the atomic rename still gives old-or-new consistency for the entry itself.
    fs.writeFileSync(tmpFile, data, { flush: true });
    fs.renameSync(tmpFile, file);
  } catch (e) {
    // Best-effort cleanup so a failed write doesn't litter temp files.
    try { fs.unlinkSync?.(tmpFile); } catch { /* nothing to clean up */ }
    throw e;
  }
}
