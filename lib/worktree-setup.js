// The optional `.matron/worktree-setup` script of a repository: run inside a
// fresh worktree (install dependencies, copy local config, ...).
//
// Running repository code on the user's box is gated hard:
//   - never for a fork (an `upstream` remote that is not origin);
//   - never for an origin that is not on the box's allowlist
//     (MATRON_WORKTREE_SETUP_ORIGINS, comma separated `host/owner/repo` or
//     `host/owner/*`; empty means none);
//   - only after the user approved this repository's script on a consent
//     card, and only while the script still has the approved sha256: a
//     changed script asks again.
// The script gets a 10 minute timeout and its output is logged. A failure
// never stops the session; the caller turns it into a notice. The script
// inherits the bridge's environment minus the journal and bridge-only
// secrets, so it holds no secret beyond what the user's own shell has.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteFileSync } from './atomic-write.js';
import { stripJournalCreds } from './journal-cred-scope.js';
import { gitRun } from './worktree.js';

export const SETUP_SCRIPT = '.matron/worktree-setup';
export const NOTICE_FILE_NAME = 'matron-worktree-notice.txt';
export const NOTICE_MAX_CHARS = 2000;
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_TAIL_CHARS = 1500;

export function setupTimeoutMs(env = process.env) {
  const n = Number.parseInt(env.MATRON_WORKTREE_SETUP_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SETUP_TIMEOUT_MS;
}

// `git@example.com:Owner/Repo.git`, `https://example.com/Owner/Repo`,
// `ssh://git@host:22/Owner/Repo.git` -> `example.com/owner/repo`.
export function normalizeOrigin(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  let host;
  let rest;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scp[1];
    rest = scp[2];
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      rest = u.pathname;
    } catch { return null; }
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !rest) return null;
  return `${host}/${rest}`.toLowerCase();
}

export function parseAllowlist(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function originAllowed(normalized, allowlist) {
  if (!normalized) return false;
  return allowlist.some((entry) => entry === normalized
    || (entry.endsWith('/*') && normalized.startsWith(entry.slice(0, -1)) && !normalized.slice(entry.length - 1).includes('/')));
}

// A fork is a clone whose `upstream` remote points somewhere other than origin.
export async function isFork(root, originNormalized, run = gitRun) {
  const up = await run(['config', '--get', 'remote.upstream.url'], { cwd: root });
  if (up.code !== 0 || !up.stdout) return false;
  const upNorm = normalizeOrigin(up.stdout);
  return !upNorm || upNorm !== originNormalized;
}

export function createConsentStore({ file, fs = nodeFs, log = console } = {}) {
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch { /* none yet */ }
  return {
    get: (key) => (typeof data[key]?.sha256 === 'string' ? data[key].sha256 : null),
    set(key, sha256) {
      data[key] = { sha256, at: Date.now() };
      try { atomicWriteFileSync(file, JSON.stringify(data, null, 2), { fs }); } catch (e) { log.warn?.(`[worktree-consent] save failed: ${e?.message || e}`); }
    },
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Decide what to do about the setup script of a fresh worktree.
// state: 'none' (no script) | 'refused' (policy) | 'needs_consent' | 'ready'.
// `buffer` is the exact bytes that were hashed: runSetup executes those
// bytes, never the file on disk, so what runs is what was approved.
export async function planSetup({
  worktree, root, origin, allowlist, consent, run = gitRun, fs = nodeFs, platform = process.platform,
}) {
  const script = path.join(worktree, SETUP_SCRIPT);
  let st;
  try { st = fs.lstatSync(script); } catch { return { state: 'none' }; }
  if (platform === 'win32') return { state: 'refused', reason: 'worktree setup scripts are not supported on Windows' };
  if (!st.isFile()) return { state: 'refused', reason: `${SETUP_SCRIPT} is not a regular file` };
  // A committed `.matron` that is a symlink to a folder elsewhere passes the
  // lstat above; the real path must still be inside the worktree.
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(script);
    realRoot = fs.realpathSync(worktree);
  } catch (e) { return { state: 'refused', reason: `${SETUP_SCRIPT} cannot be resolved (${e.code || 'error'})` }; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { state: 'refused', reason: `${SETUP_SCRIPT} resolves outside the worktree` };
  const key = normalizeOrigin(origin);
  if (!key) return { state: 'refused', reason: 'origin URL not recognised' };
  if (await isFork(root, key, run)) return { state: 'refused', reason: 'this clone is a fork (it has an upstream remote), so its setup script is not run' };
  if (!originAllowed(key, allowlist)) return { state: 'refused', reason: `origin ${key} is not on this box's setup-script allowlist (MATRON_WORKTREE_SETUP_ORIGINS)` };
  let buffer;
  try { buffer = fs.readFileSync(real); } catch (e) { return { state: 'refused', reason: `${SETUP_SCRIPT} could not be read (${e.code || 'error'})` }; }
  const digest = sha256(buffer);
  const approved = consent.get(key);
  if (approved === digest) return { state: 'ready', key, sha256: digest, script, buffer };
  return { state: 'needs_consent', key, sha256: digest, script, buffer, changed: !!approved, content: buffer.toString('utf-8') };
}

// Run the approved script. Resolves {ok, code, timedOut, durationMs, logFile,
// tail}. Never rejects.
export function runSetup({
  buffer, worktree, root, name, gitDir, logFile, timeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
  env = process.env, fs = nodeFs, spawnFn = spawn, platform = process.platform,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (platform === 'win32') {
      resolve({ ok: false, code: null, timedOut: false, error: 'not supported on Windows', durationMs: 0, logFile, tail: '' });
      return;
    }
    const noticeFile = gitDir ? path.join(gitDir, NOTICE_FILE_NAME) : null;
    let out = null;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      out = fs.openSync(logFile, 'a', 0o600);
      fs.writeSync(out, `--- ${new Date().toISOString()} running the approved setup script, staged copy (timeout ${timeoutMs} ms)\n`);
    } catch { out = null; }
    const childEnv = {
      ...stripJournalCreds(env, { keepProviderKeys: true }),
      MATRON_MAIN_CHECKOUT: root,
      MATRON_WORKTREE_PATH: worktree,
      MATRON_WORKTREE_NAME: name,
      ...(noticeFile ? { MATRON_WORKTREE_NOTICE_FILE: noticeFile } : {}),
    };
    if (noticeFile) { try { fs.rmSync(noticeFile, { force: true }); } catch { /* best effort */ } }
    let tail = '';
    let finished = false;
    let timedOut = false;
    let child;
    // The approved bytes go to a private (0700) temp dir outside the worktree
    // and that copy is what runs; the repository's file is never executed.
    let tmpDir = null;
    let scriptPath;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wt-setup-'));
      scriptPath = path.join(tmpDir, 'worktree-setup');
      fs.writeFileSync(scriptPath, buffer, { mode: 0o700 });
    } catch (e) {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
      if (out !== null) { try { fs.closeSync(out); } catch { /* ignore */ } }
      resolve({ ok: false, code: null, timedOut: false, error: `could not stage the script: ${e?.message || e}`, durationMs: Date.now() - started, logFile, tail: '' });
      return;
    }
    const done = (res) => {
      if (finished) return;
      finished = true;
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
      if (out !== null) { try { fs.closeSync(out); } catch { /* ignore */ } }
      resolve({ ...res, durationMs: Date.now() - started, logFile, tail: tail.slice(-LOG_TAIL_CHARS) });
    };
    try {
      // A shebang means the script names its own interpreter; without one it is sh.
      const shebang = buffer.subarray(0, 2).toString('latin1') === '#!';
      child = spawnFn(shebang ? scriptPath : 'sh', shebang ? [] : [scriptPath], {
        cwd: worktree, env: childEnv, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done({ ok: false, code: null, timedOut: false, error: e?.message || String(e) });
      return;
    }
    const sink = (chunk) => {
      const text = chunk.toString('utf-8');
      tail = (tail + text).slice(-LOG_TAIL_CHARS * 2);
      if (out !== null) { try { fs.writeSync(out, text); } catch { /* log is best effort */ } }
    };
    child.stdout?.on('data', sink);
    child.stderr?.on('data', sink);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: null, timedOut, error: e?.message || String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

// What the script asked to tell the agent (the file named by
// MATRON_WORKTREE_NOTICE_FILE), capped.
export function readNoticeExtra(gitDir, { fs = nodeFs } = {}) {
  if (!gitDir) return '';
  // The script wrote this file, so it may be a symlink to something else:
  // only a regular file is read, and only through the descriptor that was checked.
  const file = path.join(gitDir, NOTICE_FILE_NAME);
  let fd = null;
  try {
    // O_NOFOLLOW refuses a symlink at open time; fstat then checks the file
    // actually opened, so nothing can change between the check and the read.
    fd = fs.openSync(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return '';
    return fs.readFileSync(fd, 'utf-8').trim().slice(0, NOTICE_MAX_CHARS);
  } catch { return ''; } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// One line for the agent and the user about how setup went.
export function setupSummary(setup) {
  switch (setup?.state) {
    case 'ok': return 'The repository\'s worktree setup script ran successfully.';
    case 'failed': return `The repository's worktree setup script failed (${setup.timedOut ? 'timed out' : `exit ${setup.code ?? '?'}`}), so the environment may be incomplete.`;
    case 'running': return 'The repository\'s worktree setup script is still running; the environment may not be ready yet.';
    case 'pending': return 'The repository\'s worktree setup script has not run: it is waiting for the user\'s approval.';
    case 'refused': return `The repository's worktree setup script did not run: ${setup.reason}.`;
    default: return '';
  }
}
