// End a session's whole process tree.
//
// On POSIX a signal to the claude child is enough: the MCP servers and tool
// shells it started share its process group and die with it, and the
// SIGTERM/SIGKILL distinction is what the callers rely on. On Windows
// `ChildProcess.kill()` is TerminateProcess on ONE pid, whatever signal name
// is passed: the claude process dies and everything under it — ask-user.js,
// the Git Bash running a tool call, a background task — is orphaned and keeps
// running (and, for an agent mid-turn, keeps spending). `taskkill /T` walks
// the parent-pid tree first, so it has to run BEFORE the parent is gone: once
// the parent has exited the children's ppid points at a dead pid and the
// tree cannot be enumerated.
//
// `kill` is the POSIX action (a bound `proc.kill` / `pty.kill`); on Windows it
// runs after taskkill as well, whatever taskkill said: for a ChildProcess it
// is a no-op on a dead pid, and for node-pty it is what releases the ConPTY
// handles. `exec` is injected so the taskkill argv is unit-testable.
// Fire-and-forget: callers are synchronous and only need the tree to be going
// away, not gone.
import { execFile } from 'node:child_process';

export function taskkillArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

export function killProcessTree(pid, signal = 'SIGTERM', {
  kill,
  platform = process.platform,
  exec = execFile,
  log = () => {},
} = {}) {
  if (platform !== 'win32') {
    if (typeof kill === 'function') kill(signal);
    return Promise.resolve('signal');
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    if (typeof kill === 'function') kill(signal);
    return Promise.resolve('kill');
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (how) => { if (!settled) { settled = true; resolve(how); } };
    try {
      exec('taskkill', taskkillArgs(pid), { windowsHide: true, timeout: 10_000 }, (err) => {
        // taskkill missing or refused (e.g. the process already exited): the
        // direct kill is then all that ends the child itself.
        if (err) log(`taskkill /T failed for pid ${pid}: ${err.message}`);
        try { if (typeof kill === 'function') kill(signal); } catch { /* already gone */ }
        done(err ? 'kill' : 'taskkill');
      });
    } catch (e) {
      log(`taskkill spawn threw for pid ${pid}: ${e?.message ?? e}`);
      try { if (typeof kill === 'function') kill(signal); } catch { /* already gone */ }
      done('kill');
    }
  });
}
