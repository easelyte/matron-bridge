// Fork-only preflight for a restart: after upstream's check that the new tree
// parses and its imports resolve, load the whole entry point against the
// checkout's CURRENT .env (MATRON_BRIDGE_PREFLIGHT=gate: config is validated,
// startup effects are suppressed). A restart onto a tree whose .env no longer
// loads would leave the bridge down, and the module-only check cannot see
// that. A tree without gate support (lib/preflight-support.js) gets upstream's
// check alone. Resolves { ok } or { ok: false, error }; never throws.
import { execFile } from 'node:child_process';
import { defaultPreflight, PREFLIGHT_TIMEOUT_MS } from './code-update-restart.js';
import { preflightSupport } from './preflight-support.js';

export function createRestartPreflight(checkoutDir, {
  bootDotenvKeys = [], base = defaultPreflight, support = preflightSupport,
  exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS, env = process.env,
} = {}) {
  return async () => {
    const first = await base(checkoutDir);
    if (!first.ok) return first;
    let supported = false;
    try { supported = support(checkoutDir, 'HEAD') === 'gate/1'; } catch { /* treat as unsupported */ }
    if (!supported) return first;
    // Keys the boot .env set are dropped so the new checkout's own .env wins.
    const childEnv = { ...env };
    for (const key of bootDotenvKeys) delete childEnv[key];
    childEnv.MATRON_BRIDGE_PREFLIGHT = 'gate';
    return new Promise(resolve => {
      try {
        // The child's stderr can carry configuration values, so the error is
        // a fixed message and nothing of it reaches the log.
        exec(process.execPath, ['index.js'], { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true, env: childEnv }, (err) => {
          resolve(err ? { ok: false, error: 'gate preflight failed: the new checkout does not load with its current config' } : { ok: true });
        });
      } catch {
        resolve({ ok: false, error: 'gate preflight could not start' });
      }
    });
  };
}
