// Restart the viewer onto new code by itself, the way the bridge does
// (lib/code-update-restart.js has the policy and the why).
//
// The two services share the code and the contract between them: the viewer
// forwards secret submissions, one-time reveals and queue actions to the
// bridge's loopback API, signed with a key both derive from HMAC_SECRET
// (lib/api-auth.js). The bridge restarts itself onto new code; the viewer used
// to keep whatever it booted with until the machine rebooted. When an update
// changed that contract, the bridge moved and the viewer did not: every
// forwarded call came back 401 "Missing or unknown bridge session token", and
// secret forms and one-time links failed for days on a box that did not
// reboot.
//
// The viewer has no turns to protect, so it restarts at the first poll after
// the update settles and the new tree passes its preflight. A request in
// flight at that moment fails; the next one reaches the new process a few
// seconds later.
import { execFile } from 'node:child_process';
import {
  createCodeUpdateWatcher, resolveGitDir, readHeadReflog, restartEnabled, parseMs,
  RESTART_EXIT_CODE, DEFAULT_POLL_MS, DEFAULT_SETTLE_MS, PREFLIGHT_TIMEOUT_MS,
} from '../lib/code-update-restart.js';

// The new tree must load the viewer before this process exits for it: a
// syntax error or a missing dependency would otherwise leave the box with no
// viewer at all until someone notices.
export function viewerPreflight(checkoutDir, { exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    try {
      exec(process.execPath, ['--input-type=module', '-e', "await import('./viewer/server.js')"],
        { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          const detail = String(stderr || err.message || err).trim().split('\n').slice(-3).join(' | ');
          resolve({ ok: false, error: `viewer import: ${detail}` });
        });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

// Start polling the checkout. Returns the timer, or null when the watcher is
// off (MATRON_CODE_UPDATE_RESTART, or no HEAD reflog to watch). exit is the
// restart: close the server, then leave with RESTART_EXIT_CODE so systemd,
// launchd and the Windows task all relaunch it.
export function startViewerCodeUpdateWatcher({
  checkoutDir,
  httpServer,
  env = process.env,
  exit = (code) => process.exit(code),
  preflight = () => viewerPreflight(checkoutDir),
  log = (m) => console.log(m),
  warn = (m) => console.warn(m),
  setIntervalImpl = setInterval,
} = {}) {
  if (!restartEnabled(env.MATRON_CODE_UPDATE_RESTART)) {
    log('[viewer code-update] restart onto new code: OFF (MATRON_CODE_UPDATE_RESTART)');
    return null;
  }
  const gitDir = resolveGitDir(checkoutDir);
  const boot = gitDir ? readHeadReflog(gitDir) : null;
  if (!boot) {
    log(`[viewer code-update] restart onto new code: OFF (no HEAD reflog under ${checkoutDir})`);
    return null;
  }
  const pollMs = parseMs(env.MATRON_CODE_UPDATE_POLL_MS, DEFAULT_POLL_MS);
  const watcher = createCodeUpdateWatcher({
    readHead: () => readHeadReflog(gitDir),
    busySessions: () => 0,
    preflight,
    restart: (info) => {
      log(`[viewer code-update] exiting ${RESTART_EXIT_CODE} for the supervisor to relaunch onto ${info.sha.slice(0, 7)}`);
      // close() waits for open connections (a live log tail can hold one for
      // hours), so the exit does not wait for it.
      try { httpServer?.close(); } catch { /* exiting anyway */ }
      exit(RESTART_EXIT_CODE);
    },
    log: (m) => log(m.replace('[code-update]', '[viewer code-update]')),
    warn: (m) => warn(m.replace('[code-update]', '[viewer code-update]')),
    bootSha: boot.sha,
    settleMs: parseMs(env.MATRON_CODE_UPDATE_SETTLE_MS, DEFAULT_SETTLE_MS),
  });
  log(`[viewer code-update] restart onto new code: ON (running ${boot.sha.slice(0, 7)}; poll ${pollMs}ms)`);
  const timer = setIntervalImpl(() => {
    watcher.tick().catch(e => { try { warn(`[viewer code-update] tick failed: ${e?.message ?? e}`); } catch { /* logging must never throw */ } });
  }, pollMs);
  if (typeof timer?.unref === 'function') timer.unref();
  return timer;
}
