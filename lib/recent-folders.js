// Durable record of every workdir ever used through the bridge, for the
// folder picker (`recent_folders` RPC). The picker used to derive folders
// from the persisted session store alone — but session records are deleted
// when a native session goes stale (index.js's resume cleanup), taking their
// folder with them. This store is append-only: folders are only ever added
// or freshened, never removed, so the suggestion list survives session
// churn. Directories that stop existing are filtered at listing time by the
// RPC handler, not deleted here — a worktree that comes back gets its
// history back.
//
// File format: a flat JSON map of absolute path -> lastUsed epoch ms.
// Injectable fs/log in the style of the other lib factories; all I/O fails
// open (a folder list is a convenience, never worth crashing the bridge).

import nodeFs from 'fs';

// persistSession fires on every message; rewriting the file that often buys
// nothing (freshness only drives sort order). Skip touches until the stored
// timestamp is this stale.
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function createRecentFolders({
  file,
  fs = nodeFs,
  minTouchIntervalMs = DEFAULT_TOUCH_INTERVAL_MS,
  log = console,
} = {}) {
  let folders = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [p, ts] of Object.entries(parsed)) {
        if (typeof p === 'string' && p && typeof ts === 'number') folders[p] = ts;
      }
    }
  } catch { /* missing or corrupt file — start empty, first touch recreates it */ }

  // Atomic write (#460): this is the SOLE durable copy of the folder history,
  // so a truncating in-place rewrite is unsafe — a kill / power loss / ENOSPC /
  // short write after truncation corrupts the only file, and the constructor's
  // parse-failure recovery then silently starts empty and the next touch
  // overwrites the evidence, losing every remembered folder. Write a temp
  // sibling first, then atomically rename it onto the target: the target is
  // only ever replaced by a complete file, and a failure mid-write leaves the
  // prior file untouched. The temp is a sibling (same directory → same
  // filesystem) so the rename is a true atomic rename, not a cross-device copy.
  // The temp name carries the pid so two overlapping bridge processes can't
  // clobber each other's in-flight temp between write and rename (last writer
  // still wins on the final rename — acceptable for an append-only convenience
  // cache; a full read-merge-write lock would be disproportionate here).
  const tmpFile = `${file}.${process.pid}.tmp`;
  const save = () => {
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(folders, null, 2));
      fs.renameSync(tmpFile, file);
    } catch (e) {
      log.warn?.(`[recent-folders] save failed: ${e?.message || e}`);
      // Best-effort cleanup of a partial temp file so a failed write doesn't
      // litter — the durable `file` is untouched either way (never opened).
      try { fs.unlinkSync?.(tmpFile); } catch { /* nothing to clean up */ }
    }
  };

  // Record (or freshen) one folder in memory; returns whether anything
  // changed. Timestamps never regress, and a touch within the debounce
  // interval of the stored value is dropped.
  const touchInMemory = (workdir, ts) => {
    if (typeof workdir !== 'string' || !workdir) return false;
    const stamp = typeof ts === 'number' && ts >= 0 ? ts : 0;
    const prev = folders[workdir];
    if (prev !== undefined && stamp - prev < minTouchIntervalMs) return false;
    folders[workdir] = stamp;
    return true;
  };

  return {
    touch(workdir, ts) {
      if (!touchInMemory(workdir, ts)) return false;
      save();
      return true;
    },

    // Bulk import (startup seeding from the persisted session store): one
    // write for the whole batch, same never-regress rule per entry.
    seedFrom(entries) {
      let changed = false;
      for (const e of Array.isArray(entries) ? entries : []) {
        if (touchInMemory(e?.path, e?.lastUsed)) changed = true;
      }
      if (changed) save();
      return changed;
    },

    list() {
      return Object.entries(folders)
        .map(([p, ts]) => ({ path: p, lastUsed: ts }))
        .sort((a, b) => b.lastUsed - a.lastUsed);
    },
  };
}
