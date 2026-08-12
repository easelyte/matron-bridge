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
    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, file);
  } catch (e) {
    // Best-effort cleanup so a failed write doesn't litter temp files.
    try { fs.unlinkSync?.(tmpFile); } catch { /* nothing to clean up */ }
    throw e;
  }
}
