import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { evaluateQuiet } from './restart-quiet.js';
import { preflightSupport } from './preflight-support.js';
import { defaultPreflight } from './code-update-restart.js';

const CACHE_MS = 5 * 60_000;
const CAP_MS = 30 * 60_000;
const WARN_MS = 30 * 60_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameKey = (a, b) => !!a && !!b && a.sha === b.sha
  && a.env_hash === b.env_hash && a.deps_stamp === b.deps_stamp;

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

// evaluate only reads restart state. Preflight results live in a separate
// in-memory cache; dry runs may populate it without recording a request.
export function createPlannedRestart({
  repoDir, stateStore, git = args => runGit(repoDir, args), fs = nodeFs,
  now = Date.now, quietEvaluator = evaluateQuiet, quietOptions = () => ({}),
  sessions = () => [], support = preflightSupport,
  preflight = defaultPreflight, warn = () => {}, onReady = () => {},
  landedRef = process.env.MATRON_RESTART_LANDED_REF || null, collectMs = 60_000,
} = {}) {
  if (!Number.isSafeInteger(collectMs) || collectMs < 0) throw new Error('Invalid collect duration');
  let cache = { status: 'unknown' };
  let priorQuiet;
  let observation;
  let delivered;
  let pendingWarning;

  function cacheKey(sha) {
    let envHash;
    try { envHash = hash(fs.readFileSync(path.join(repoDir, '.env'))); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      envHash = 'none';
    }
    const lock = fs.readFileSync(path.join(repoDir, 'package-lock.json'));
    const stat = fs.statSync(path.join(repoDir, 'node_modules', '.package-lock.json'));
    if (!Number.isFinite(stat.ino) || !Number.isFinite(stat.mtimeMs)) throw new Error('Invalid dependency stamp');
    const stamp = `${stat.mtimeMs}:${stat.ino}`;
    return { sha, env_hash: envHash, deps_stamp: hash(Buffer.concat([Buffer.from(lock), Buffer.from(`\n${stamp}`)])) };
  }

  function codeCheck(requests, bootSha) {
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
      if (bootSha == null && requests.some(request => request.sha == null)) return { sha, code: 'head moved (config-only)' };
      if (landedRef) {
        if (landedRef.startsWith('-') || probe(['merge-base', '--is-ancestor', sha, landedRef]) !== true) return { sha, code: 'head not landed' };
        if (requests.some(request => request.sha == null) && sha !== bootSha) return { sha, code: 'head moved (config-only)' };
      }
      return { sha, code: null };
    } catch {
      return { sha, code: 'not a descendant' };
    }
  }

  function fresh(key) {
    const age = now() - cache.at;
    return sameKey(cache.key, key) && age >= 0 && age < CACHE_MS;
  }

  function failed(entry, error) {
    entry.status = 'error';
    entry.error = error;
    entry.at = now();
    // Never log runner stderr: it can contain configuration values.
    if (!entry.warned) {
      entry.warned = true;
      warn('Planned restart preflight failed');
    }
  }

  function checkPreflight(key) {
    if (fresh(key) && cache.status !== 'unknown') {
      return cache.status === 'ok' ? null : { error: cache.error };
    }
    if (sameKey(cache.key, key) && cache.running) return { unknown: true };
    const entry = cache = { status: 'unknown', key, running: true };
    let supported = false;
    try { supported = support(repoDir, key.sha) === 'gate/1'; } catch { /* Refuse unknown support. */ }
    if (!supported) {
      entry.running = false;
      failed(entry, 'mode unsupported at HEAD');
      return { error: entry.error };
    }
    let run;
    try { run = preflight(repoDir, { mode: 'gate' }); }
    catch { run = Promise.resolve({ ok: false, error: 'preflight failed' }); }
    Promise.resolve(run).then(result => {
      entry.running = false;
      entry.at = now();
      if (result?.ok === true) entry.status = 'ok';
      else failed(entry, typeof result?.error === 'string' ? result.error : 'preflight failed');
    }, () => {
      entry.running = false;
      failed(entry, 'preflight failed');
    });
    return { unknown: true };
  }

  function evaluate({ dryRun = false, request } = {}) {
    const waiting_on = { quiet: { holders: [], probe_error: null }, code: null,
      preflight: { unknown: true }, collect: null, unwarned: [] };
    let quiet;
    try {
      quiet = quietEvaluator({ ...quietOptions(), prev: priorQuiet });
      if (!Array.isArray(quiet?.holders) || !(quiet.probe_error === null || typeof quiet.probe_error === 'string')) throw new Error('Unavailable quiet probe');
      waiting_on.quiet = { holders: quiet.holders, probe_error: quiet.probe_error };
    } catch {
      quiet = { quiet: false };
      waiting_on.quiet.probe_error = 'quiet';
    }
    if (!dryRun) priorQuiet = quiet;
    let state;
    let requests;
    let key;
    try {
      state = stateStore.getState();
      if (!state || !Array.isArray(state.requests)) throw new Error('Unavailable restart state');
      requests = state.state === 'pending' ? [...state.requests] : [];
      if (request !== undefined) requests.push(request);
      const checked = codeCheck(requests, state.boot_sha);
      waiting_on.code = checked.code;
      if (state.state === 'pending') {
        if (!Number.isFinite(state.first_request_at) || !Number.isFinite(state.last_request_at)) throw new Error('Invalid collect timestamps');
        const remaining = Math.min(state.last_request_at + collectMs, state.first_request_at + CAP_MS) - now();
        waiting_on.collect = remaining > 0 ? { remaining_ms: remaining } : null;
        for (const session of sessions().values()) {
          const id = session.journalConvoId || session.claudeSessionId;
          if (session.alive && id && !Object.hasOwn(state.notified || {}, id)) waiting_on.unwarned.push(id);
        }
      }
      if (checked.code === null) {
        try { key = cacheKey(checked.sha); waiting_on.preflight = checkPreflight(key); }
        catch { waiting_on.preflight = { error: 'preflight inputs unavailable' }; }
      } else if (!dryRun) {
        cache = { status: 'unknown' };
      }
    } catch {
      waiting_on.quiet.probe_error ||= 'restart_state';
    }
    const would_pass = waiting_on.quiet.holders.length === 0 && waiting_on.quiet.probe_error === null
      && waiting_on.code === null && waiting_on.preflight === null;
    observation = { state, requests, key, quiet };
    return { would_pass, waiting_on };
  }

  function tick() {
    const result = evaluate();
    const { state, key, quiet } = observation;
    function finish() {
      if (state?.state !== 'pending') { pendingWarning = undefined; return result; }
      if (pendingWarning?.id !== state.id) pendingWarning = { id: state.id, at: state.first_request_at };
      const blocked = !result.would_pass || !quiet.quiet
        || result.waiting_on.collect !== null || result.waiting_on.unwarned.length > 0;
      const time = now();
      if (blocked && Number.isFinite(pendingWarning.at) && time - pendingWarning.at >= WARN_MS) {
        pendingWarning.at = time;
        warn('Planned restart still pending; waiting for restart gates to pass; never forcing');
      }
      return result;
    }
    if (!result.would_pass || state?.state !== 'pending' || !quiet.quiet
      || result.waiting_on.collect !== null || result.waiting_on.unwarned.length) return finish();
    // The latch owns the synchronous re-read of code and preflight inputs.
    if (delivered !== state.id) {
      if (onReady({ sha: key.sha, key, state })?.latched === true) delivered = state.id;
    }
    return finish();
  }

  return { evaluate, tick, readCode: codeCheck, cacheKey,
    getPreflight: () => cache,
    recheckQuiet: () => quietEvaluator({ ...quietOptions(), prev: priorQuiet }),
  };
}
