import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDir } from './header-files.js';

// A large instruction block can exceed the OS limit for one argv string,
// even when argv + env are well below ARG_MAX. Give Claude the complete text
// through its file flag instead. This also keeps private instructions out of
// the process list and spawn-argument debug logs.
//
// runDir is the bridge's existing private 0700 state/run directory, not /tmp:
// an age-based temp cleaner must not remove a live session's instructions.
// Each spawn owns a 0600 snapshot until its process closes (or the interactive
// session emits exit). Bridge shutdown and the next boot's dead-run sweep
// handle files left after a bridge crash, via lib/header-files.js.
export function launchWithClaudePromptFile({
  prompt,
  args,
  runDir,
  launch,
  exitEvent = 'close',
  fsImpl = fs,
  onError = error => { throw error; },
}) {
  let file;
  const cleanup = () => {
    if (!file) return;
    try { fsImpl.rmSync(file, { force: true }); } catch { /* the run-directory sweep retries */ }
  };
  try {
    // Retry a failed boot-time allocation and recreate a vanished directory,
    // using the same ownership/symlink checks as the session header files.
    const dir = typeof runDir === 'function' ? runDir() : runDir;
    if (!dir) throw new Error('Claude prompt requires a private bridge run directory');
    ensurePrivateDir(dir, fsImpl);
    file = path.resolve(dir, `claude-prompt-${randomUUID()}.txt`);
    // Exclusive creation: never follow or overwrite an existing file. Do not
    // trim, truncate, normalize newlines or otherwise change the instructions.
    fsImpl.writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const child = launch([...args, '--append-system-prompt-file', file]);
    // ChildProcess emits close after an asynchronous spawn error as well.
    // Keep the file until then: a successful spawn event doesn't prove the
    // child has read it, and the interactive CLI may read it later.
    child.once(exitEvent, cleanup);
    return child;
  } catch (error) {
    cleanup();
    return onError(error);
  }
}
