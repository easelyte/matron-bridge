// Where the bridge keeps the header files its children read credentials from
// (the per-session API tokens of lib/api-auth.js and the journal read-proxy
// capability): a private 0700 directory per bridge process under the user's
// state directory, ${XDG_STATE_HOME:-$HOME/.local/state}/matron-bridge/run/.
//
// Not the temp folder: OS temp cleaners delete files by age. macOS's daily
// dirhelper run removes $TMPDIR files whose access time is over three days
// old, and on APFS reading a file does not move its access time on, so a
// session's token file vanished under a bridge that had been up for days.
// systemd-tmpfiles ages out /tmp the same way on Linux (30 days on Ubuntu).
//
// Each directory is named for the process that made it (bridge-<pid>-XXXXXX)
// and removed on exit. A bridge that died without cleaning up leaves its
// directory behind, so every start sweeps the ones whose process is gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// ${XDG_STATE_HOME:-$HOME/.local/state}/matron-bridge
export function bridgeStateDir(env = process.env, home = os.homedir()) {
  const base = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'matron-bridge');
}

export function headerRunRoot(env = process.env, home = os.homedir()) {
  return path.join(bridgeStateDir(env, home), 'run');
}

const RUN_DIR_RE = /^bridge-(\d+)-[A-Za-z0-9]+$/;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Make `d` (and its parents) and check it is a real directory of ours,
// tightened to 0700.
function ensurePrivateDir(d, fsImpl) {
  fsImpl.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fsImpl.lstatSync(d);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${d} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${d} is not ours`);
  try { fsImpl.chmodSync(d, 0o700); } catch { /* best effort (Windows) */ }
}

// Remove the run directories left by bridge processes that are gone. Returns
// the names removed.
export function sweepDeadRunDirs(root, { fsImpl = fs, alive = pidAlive, selfPid = process.pid } = {}) {
  let names;
  try { names = fsImpl.readdirSync(root); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = RUN_DIR_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid || alive(pid)) continue;
    try { fsImpl.rmSync(path.join(root, name), { recursive: true, force: true }); removed.push(name); } catch { /* best effort */ }
  }
  return removed;
}

// This process's private run directory under `root`, after sweeping dead
// processes' leftovers.
export function createRunDir(root, { fsImpl = fs, pid = process.pid, alive = pidAlive } = {}) {
  ensurePrivateDir(root, fsImpl);
  sweepDeadRunDirs(root, { fsImpl, alive, selfPid: pid });
  const dir = fsImpl.mkdtempSync(path.join(root, `bridge-${pid}-`));
  try { fsImpl.chmodSync(dir, 0o700); } catch { /* best effort (Windows) */ }
  return dir;
}

// Write a one-line header file, owner-only, under a fresh name renamed into
// place: a child reading it mid-write sees the old file or the new one, never
// a half-written one. Recreates the directory if something removed it.
export function writeHeaderFile(file, line, { fsImpl = fs } = {}) {
  ensurePrivateDir(path.dirname(file), fsImpl);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tmp, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return file;
}

// Rewrite the file if it is missing, unreadable or no longer holds `line`
// (emptied, truncated). Returns true when it wrote it.
export function healHeaderFile(file, line, { fsImpl = fs } = {}) {
  if (!file) return false;
  const want = line.endsWith('\n') ? line : `${line}\n`;
  try { if (fsImpl.readFileSync(file, 'utf8') === want) return false; } catch { /* missing or unreadable: rewrite */ }
  writeHeaderFile(file, line, { fsImpl });
  return true;
}
