// The gate of a planned restart: when may the bridge exit onto the code on
// disk? It passes only when every one of these holds at the same poll:
//   - the collect window since the last request has passed (requests that land
//     minutes apart ride one restart);
//   - the code is pinned: every requested sha is HEAD or an ancestor of it and
//     the tree has no tracked changes;
//   - HEAD has passed a preflight (the same check the code-update watcher
//     runs), no more than 5 minutes ago;
//   - no session holds work (a turn, a background child, a running subagent)
//     and none did at the previous poll either.
// Nothing here ever forces: a restart waits for as long as the work runs.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CACHE_MS = 5 * 60_000;
// Requests keep resetting the collect window, up to this long after the first.
const COLLECT_CAP_MS = 30 * 60_000;
const WARN_MS = 30 * 60_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameKey = (a, b) => !!a && !!b && a.sha === b.sha && a.deps_stamp === b.deps_stamp;

// The runner returns text, except --is-ancestor, which returns a boolean.
function runGit(repoDir, args) {
  try {
    const result = execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'pipe' });
    return args[0] === 'merge-base' ? true : result;
  } catch (e) {
    if (args[0] === 'merge-base' && e.status === 1) return false;
    throw e;
  }
}

// `quiet()` returns { holders: [{ convoId, why }], probe_error: string|null }.
// `preflight()` resolves to { ok, error? } and never throws. `notBefore` (epoch
// ms) holds every restart until a boot settle time has passed.
export function createPlannedRestart({
  repoDir, stateStore, quiet, preflight, onReady = () => {}, warn = () => {},
  git = args => runGit(repoDir, args), fs = nodeFs, now = Date.now, collectMs = 60_000, notBefore = 0,
} = {}) {
  if (!Number.isSafeInteger(collectMs) || collectMs < 0) throw new Error('Invalid collect duration');
  let cache = { status: 'unknown' };
  let consecutiveQuiet = 0;
  let delivered;
  let warnedAt;

  // What a preflight result depends on besides the sha: the installed modules.
  function cacheKey(sha) {
    const lock = fs.readFileSync(path.join(repoDir, 'package-lock.json'));
    const stat = fs.statSync(path.join(repoDir, 'node_modules', '.package-lock.json'));
    if (!Number.isFinite(stat.ino) || !Number.isFinite(stat.mtimeMs)) throw new Error('Invalid dependency stamp');
    return { sha, deps_stamp: hash(Buffer.concat([Buffer.from(lock), Buffer.from(`\n${stat.mtimeMs}:${stat.ino}`)])) };
  }

  // Pins the code. Returns { sha, code }: `code` is null when the restart may
  // boot onto `sha`, else the reason it may not.
  function readCode(requests, bootSha) {
    const results = new Map();
    const probe = args => {
      const key = JSON.stringify(args);
      if (!results.has(key)) results.set(key, git(args));
      return results.get(key);
    };
    let sha;
    try {
      const head = probe(['rev-parse', 'HEAD']);
      if (typeof head !== 'string') throw new Error('Missing HEAD');
      sha = head.trim();
      if (!sha || sha.startsWith('-')) throw new Error('Missing HEAD');
      for (const request of requests) {
        if (!request || typeof request !== 'object') throw new Error('Invalid request');
        if (request.sha != null && (typeof request.sha !== 'string' || !request.sha || request.sha.startsWith('-')
          || probe(['merge-base', '--is-ancestor', request.sha, sha]) !== true)) return { sha, code: 'not a descendant' };
      }
      if (String(probe(['status', '--porcelain', '--untracked-files=no'])).trim()) return { sha, code: 'dirty tree' };
      // A request without a sha asks only for a config reload: the code must be
      // what this process already runs.
      if (requests.some(request => request.sha == null) && (bootSha == null || sha !== bootSha)) {
        return { sha, code: 'head moved (config-only)' };
      }
      return { sha, code: null };
    } catch {
      return { sha, code: 'not a descendant' };
    }
  }

  function checkPreflight(key) {
    const age = now() - cache.at;
    if (sameKey(cache.key, key) && cache.status !== 'unknown' && age >= 0 && age < CACHE_MS) {
      return cache.status === 'ok' ? null : { error: cache.error };
    }
    if (sameKey(cache.key, key) && cache.running) return { unknown: true };
    const entry = cache = { status: 'unknown', key, running: true };
    let run;
    try { run = preflight(); } catch { run = Promise.resolve({ ok: false, error: 'preflight failed' }); }
    Promise.resolve(run).then(result => {
      entry.running = false;
      entry.at = now();
      if (result?.ok === true) { entry.status = 'ok'; return; }
      entry.status = 'error';
      entry.error = 'preflight failed';
      // Never log the runner's stderr: it can carry configuration values.
      warn('Planned restart preflight failed');
    }, () => {
      entry.running = false;
      entry.at = now();
      entry.status = 'error';
      entry.error = 'preflight failed';
    });
    return { unknown: true };
  }

  function evaluate() {
    const waiting_on = { quiet: { holders: [], probe_error: null }, code: null, preflight: { unknown: true }, collect: null };
    try {
      const q = quiet();
      if (!Array.isArray(q?.holders) || !(q.probe_error === null || typeof q.probe_error === 'string')) throw new Error('Unavailable quiet probe');
      waiting_on.quiet = { holders: q.holders, probe_error: q.probe_error };
    } catch {
      waiting_on.quiet.probe_error = 'quiet';
    }
    // Unknown is not quiet: a failed probe never counts toward the two polls.
    const quietNow = waiting_on.quiet.holders.length === 0 && waiting_on.quiet.probe_error === null;
    consecutiveQuiet = quietNow ? consecutiveQuiet + 1 : 0;
    let state;
    let key;
    try {
      state = stateStore.getState();
      if (!Array.isArray(state?.requests)) throw new Error('Unavailable restart state');
      if (state.state === 'pending') {
        const checked = readCode(state.requests, state.boot_sha);
        waiting_on.code = checked.code;
        if (!Number.isFinite(state.first_request_at) || !Number.isFinite(state.last_request_at)) throw new Error('Invalid collect timestamps');
        // `notBefore` is a settle time after boot: a restart that was pending
        // when the process came up must not fire before the sessions the boot
        // resumes, and the carry-ons it schedules, have had their turn.
        const remaining = Math.max(Math.min(state.last_request_at + collectMs, state.first_request_at + COLLECT_CAP_MS) - now(),
          notBefore - now());
        waiting_on.collect = remaining > 0 ? { remaining_ms: remaining } : null;
        if (checked.code === null) {
          try { key = cacheKey(checked.sha); waiting_on.preflight = checkPreflight(key); }
          catch { waiting_on.preflight = { error: 'preflight inputs unavailable' }; }
        } else {
          cache = { status: 'unknown' };
        }
      }
    } catch {
      waiting_on.quiet.probe_error ||= 'restart_state';
    }
    const would_pass = quietNow && waiting_on.code === null && waiting_on.preflight === null
      && waiting_on.collect === null && state?.state === 'pending';
    return { would_pass, waiting_on, state, key, quiet_polls: consecutiveQuiet };
  }

  // One poll. The latch re-reads quiet, code and preflight itself.
  function tick() {
    const result = evaluate();
    const { state } = result;
    if (state?.state !== 'pending') { warnedAt = undefined; return result; }
    if (result.would_pass && result.quiet_polls >= 2 && delivered !== state.id) {
      if (onReady({ sha: result.key.sha, key: result.key, state })?.latched === true) delivered = state.id;
    } else if (!result.would_pass) {
      warnedAt ??= state.first_request_at;
      if (now() - warnedAt >= WARN_MS) {
        warnedAt = now();
        warn('Planned restart still pending; waiting for the restart gate to pass; never forcing');
      }
    }
    return result;
  }

  return { evaluate, tick, readCode, cacheKey, getPreflight: () => cache };
}
