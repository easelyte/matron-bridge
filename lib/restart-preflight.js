// Fork-only preflight for a restart: after upstream's check that the new tree
// parses and its imports resolve, load the whole entry point against the
// checkout's CURRENT .env (MATRON_BRIDGE_PREFLIGHT=gate: config is validated,
// startup effects are suppressed). A restart onto a tree whose .env no longer
// loads would leave the bridge down, and the module-only check cannot see
// that. A tree without gate support (lib/preflight-support.js) gets upstream's
// check alone. Resolves { ok } or { ok: false, error }; never throws.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
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
    if (!supported) return { ok: false, error: 'mode unsupported at HEAD' };
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

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// What a preflight result depends on: the commit, the .env as it is now, and
// the installed dependencies (the lockfile and the stamp npm leaves in
// node_modules). The same inputs mean the same result, so a restart does not
// run the preflight again within a few minutes. Throws when an input cannot be
// read; the caller then runs the preflight.
export function restartPreflightKey(checkoutDir, { fs = nodeFs, git = args => execFileSync('git', args, {
  cwd: checkoutDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
}) } = {}) {
  const sha = String(git(['rev-parse', 'HEAD'])).trim();
  if (!sha) throw new Error('no HEAD');
  let envHash;
  try { envHash = hash(fs.readFileSync(path.join(checkoutDir, '.env'))); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    envHash = 'none';
  }
  const lock = fs.readFileSync(path.join(checkoutDir, 'package-lock.json'));
  const stat = fs.statSync(path.join(checkoutDir, 'node_modules', '.package-lock.json'));
  if (!Number.isFinite(stat.ino) || !Number.isFinite(stat.mtimeMs)) throw new Error('invalid dependency stamp');
  return { sha, env_hash: envHash, deps_stamp: hash(Buffer.concat([Buffer.from(lock), Buffer.from(`\n${stat.mtimeMs}:${stat.ino}`)])) };
}
