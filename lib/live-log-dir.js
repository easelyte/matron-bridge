// Where the live Bash-output logs (`matron-cmd-<tool_use_id>.log`) live.
//
// The bridge (index.js) predicts the path from the tool_use_id, and the
// PreToolUse tee hook writes it, so both must agree on the directory. POSIX
// keeps the historical literal `/tmp` (the bridge and its sessions may have
// different TMPDIRs, and `/tmp` is the one place they are known to share).
// Windows has no /tmp: the user's temp dir (`os.tmpdir()`, from %TEMP%) is
// shared by the bridge, the Claude child and the hook, which all run as the
// same user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function liveLogDir({ platform = process.platform, tmpdir = os.tmpdir } = {}) {
  return platform === 'win32' ? tmpdir() : '/tmp';
}

export function liveLogPath(toolUseId, opts = {}) {
  return path.join(liveLogDir(opts), `matron-cmd-${toolUseId}.log`);
}

// Reading a live log back. The tee creates it exclusively and owner-only,
// but the directory is shared, so before trusting what is at the predicted
// name the reader checks it is that file: the name itself (not followed) is a
// regular file with one link, owned by this user, and the file opened is that
// same file (device and inode match, so a swap between the two checks is
// caught). Anything else is not the command's output and is not read (the
// stream simply shows nothing). Windows has no uid; there the temp dir is
// per-user anyway.
export function isOwnLiveLog(st, { getuid = process.getuid } = {}) {
  if (!st || !st.isFile()) return false;
  if (typeof getuid !== 'function') return true;
  return st.nlink === 1 && st.uid === getuid();
}

// Windows reports a path's dev as 0 but a handle's as the volume serial, so
// the match is only made where there are uids (POSIX); the per-user temp dir
// is the boundary there.
function sameFile(a, b, { getuid = process.getuid } = {}) {
  if (typeof getuid !== 'function') return true;
  return a.dev === b.dev && a.ino === b.ino;
}

// -> fd, or null when there is no log yet or it is not this user's own file.
export function openOwnLiveLogSync(logPath, opts = {}) {
  let named;
  try { named = fs.lstatSync(logPath); } catch { return null; }
  if (!isOwnLiveLog(named, opts)) return null;
  let fd;
  try { fd = fs.openSync(logPath, 'r'); } catch { return null; }
  let ok;
  try { ok = sameFile(named, fs.fstatSync(fd), opts); } catch { ok = false; }
  if (ok) return fd;
  try { fs.closeSync(fd); } catch { /* best effort */ }
  return null;
}

// -> FileHandle, or null; same checks as openOwnLiveLogSync.
export async function openOwnLiveLog(logPath, opts = {}) {
  let named;
  try { named = await fs.promises.lstat(logPath); } catch { return null; }
  if (!isOwnLiveLog(named, opts)) return null;
  let handle;
  try { handle = await fs.promises.open(logPath, 'r'); } catch { return null; }
  let ok;
  try { ok = sameFile(named, await handle.stat(), opts); } catch { ok = false; }
  if (ok) return handle;
  try { await handle.close(); } catch { /* best effort */ }
  return null;
}
