// Fork layer over upstream's restart request (lib/bridge-restart.js and the
// code-update watcher in lib/code-update-restart.js). Upstream owns the
// request, the cancel, the preflight, the work holds and the exit. This adds
// the three things a rollout and the crash-rollback tooling rely on that
// upstream does not carry, and nothing else:
//
//   * a sha pin: a request may name a commit, and the restart waits until HEAD
//     is that commit or contains it (a request without one is config-only: it
//     is refused once HEAD has moved since boot, and held if HEAD moves later);
//   * a request key: the same key always returns the same request, also after
//     the restart the request caused, so a client that retried over a dropped
//     connection never restarts the bridge twice. The keys are the ones in the
//     state file (the open request) and in the history file (every restart that
//     happened); there is no second store to fall out of step with them;
//   * a durable pending request: upstream keeps it in memory only. Here it is
//     written to the state file before the request is accepted, restored after
//     a crash, and the state file keeps the shape the crash-rollback readers
//     expect (id, state, sha and boot_sha fields, restarting_at, booted_at).
//
// It also provides the gate handed to the watcher (code holds, the fork's
// in-memory quiet rule, the operator's gate command, a preflight against the
// checkout's own .env) and the `waiting_on` verdict published to the journal.
// The pinned watcher options at the bottom make sure a planned restart is
// never forced.
//
// Everything impure is injected, so the policy unit-tests without a checkout.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './atomic-write.js';
import { bridgeRestartResponse } from './bridge-restart.js';

export const DEFAULT_STATE_FILE = path.join(os.homedir(), '.matron-bridge-restart-state.json');
export const DEFAULT_HISTORY_FILE = path.join(os.homedir(), '.matron-bridge-restart-history.jsonl');

// A planned restart is never forced and its gate hold never lapses: upstream's
// gate gives up after eight hours and restarts anyway, and a forced restart
// cuts turns off. Both stay off for every restart this bridge makes.
export const PINNED_WATCHER_OPTIONS = Object.freeze({ gateMaxMs: Infinity, forceAfterMs: 0 });

const REASON_LIMIT = 200;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PREFLIGHT_CACHE_MS = 5 * 60_000;
const short = (sha) => String(sha).slice(0, 7);

// The runner returns text, except --is-ancestor, which returns a boolean.
function runGit(repoDir, args) {
  try {
    const out = execFileSync('git', args, {
      cwd: repoDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return args[0] === 'merge-base' ? true : out;
  } catch (e) {
    if (args[0] === 'merge-base' && e.status === 1) return false;
    throw e;
  }
}

// The state file shape the crash-rollback readers expect.
export function emptyRestartState() {
  return {
    id: null, state: null, requests: [], pending_since: null,
    first_request_at: null, last_request_at: null, boot_sha: null,
    previous_sha: null, expected_sha: null, participants: [], notified: {},
    verdicts: {}, history_appended: false, stamp_written: false,
  };
}

// getWatcher()     the code-update watcher (null while it is off)
// holds()          upstream's sessionsHoldingRestart: { holders, unreadable }
// quiet            { peek(), count() } -> evaluateQuiet result. count() is the
//                  only call that may count a quiet reading and the gate is the
//                  only caller (see createQuietReader in lib/restart-quiet.js)
// inputsInFlight() inputs being delivered to a session right now (a count)
// preflight()      async { ok } run right before a restart goes ahead, with
//                  preflightKey() -> { sha, env_hash, deps_stamp } deciding
//                  whether a result under five minutes old still stands
// landedRef        a ref (e.g. origin/master) HEAD must descend from before a
//                  restart onto it; null = no such check
// commandGate      upstream's MATRON_RESTART_GATE_CMD gate (or null)
export function createRestartRequests({
  getWatcher, holds, repoDir, bootSha: bootShaArg = null, bootId = null,
  quiet = null, inputsInFlight = () => 0, preflight = null, preflightKey = () => null,
  landedRef = null, commandGate = null,
  fs = nodeFs, stateFile = DEFAULT_STATE_FILE, historyFile = DEFAULT_HISTORY_FILE,
  git = args => runGit(repoDir, args),
  now = Date.now, makeId = randomUUID, onChange = () => {}, warn = () => {}, log = () => {},
}) {
  // The sha this process booted on. Without it a restart is refused: a later
  // reading of HEAD is not the revision that is running.
  const bootSha = bootShaArg;
  // The request bodies of the open request, mirrored from the state file.
  let entries = [];
  let lastVerdict = null;
  let preflightCache = null;
  let cached = emptyRestartState();

  function readState() {
    let raw;
    try { raw = fs.readFileSync(stateFile, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return emptyRestartState();
      throw e;
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.requests)) throw new Error('Invalid restart state');
    return data;
  }
  // Throws on failure: a request is never acknowledged before it is durable.
  function writeState(state) {
    atomicWriteFileSync(stateFile, JSON.stringify(state), { fs, mode: 0o600 });
    cached = state;
    return state;
  }

  const publicRequests = (list) => list.map(r => ({ reason: r.reason, ...(r.sha ? { sha: r.sha } : {}), request_key: r.request_key }));
  const pending = () => cached.state === 'pending' && !!getWatcher()?.requested;

  // The first reason the checkout is not ready, or null.
  function codeHold() {
    let head;
    try {
      head = String(git(['rev-parse', 'HEAD'])).trim();
      if (!head) throw new Error('no HEAD');
    } catch { return 'head unreadable'; }
    try {
      for (const e of entries) {
        if (e.sha) {
          if (git(['merge-base', '--is-ancestor', e.sha, head]) !== true) return `waiting for HEAD to contain ${short(e.sha)}`;
        } else if (bootSha == null || head !== bootSha) return 'head moved (config-only)';
      }
      if (String(git(['status', '--porcelain', '--untracked-files=no'])).trim()) return 'dirty tree';
      // A ref that looks like an option fails closed rather than reaching git.
      if (landedRef && (landedRef.startsWith('-') || git(['merge-base', '--is-ancestor', head, landedRef]) !== true)) return 'head not landed';
    } catch { return 'head unreadable'; }
    return null;
  }

  const holdersOf = (observed) => [
    ...(inputsInFlight() > 0 ? [{ convoId: null, why: 'input_in_flight' }] : []),
    ...(observed?.holders || []).map(h => ({ convoId: h.convoId ?? null, why: h.why })),
    ...(observed?.probe_error ? [{ convoId: null, why: `probe_${observed.probe_error}` }] : []),
  ];

  // The verdict for GET /restart and box_status. No side effects: it never
  // counts a quiet reading.
  function evaluate() {
    const { holders, unreadable } = holds();
    const peeked = quiet ? quiet.peek() : { holders: [], probe_error: null };
    const watcher = getWatcher();
    lastVerdict = {
      waiting_on: {
        quiet: {
          holders: [
            ...holders.map(h => ({ convoId: h.session?.journalConvoId || h.session?.claudeSessionId || null, why: h.reason })),
            ...holdersOf({ holders: peeked.holders }),
          ],
          probe_error: unreadable ? 'process_table' : (peeked.probe_error ?? null),
        },
        code: codeHold(),
        preflight: watcher?.requested?.error ? { error: 'preflight failed' } : null,
        gate: watcher?.gateHoldReason ?? null,
        collect: null,
        unwarned: [],
      },
    };
    return lastVerdict;
  }

  // The gate handed to the watcher, asked once nothing upstream holds. Only
  // here may a quiet reading be counted.
  async function gate() {
    const generation = quiet?.generation;
    const code = codeHold();
    if (code) return { hold: true, reason: code };
    const observed = quiet ? quiet.count() : { holders: [], probe_error: null, quiet: true };
    const held = holdersOf(observed);
    if (held.length) return { hold: true, reason: `session(s) with work pending (${held[0].why})` };
    if (!observed.quiet) return { hold: true, reason: 'settling: waiting for a second quiet reading' };
    const verdict = commandGate ? await commandGate() : { hold: false };
    if (verdict?.hold) return verdict;
    // Everything else says go: prove the tree still boots with the config as it
    // is now, not as it was when the request was checked hours ago.
    const failed = await preflightHold();
    if (failed) return { hold: true, reason: failed };
    // Work seen by a peek while the command gate and the preflight were
    // running voids the readings this approval rests on.
    if (quiet && quiet.generation !== generation) return { hold: true, reason: 'work seen while the gate ran' };
    return verdict;
  }

  async function preflightHold() {
    if (!preflight) return null;
    let key;
    try { key = preflightKey(); } catch { key = null; }
    const same = k => !!k && !!key && k.sha === key.sha && k.env_hash === key.env_hash && k.deps_stamp === key.deps_stamp;
    const c = preflightCache;
    if (c && same(c.key) && now() - c.at >= 0 && now() - c.at < PREFLIGHT_CACHE_MS) return c.error;
    let result;
    try { result = await preflight(); } catch { result = { ok: false }; }
    const error = result?.ok === true ? null : 'preflight failed';
    preflightCache = { key, at: now(), error };
    if (error) warn('[restart] preflight failed right before the restart; holding');
    return error;
  }

  function admit(body) {
    const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const bad = (error) => ({ status: 400, body: { error } });
    if (typeof data.reason !== 'string' || !data.reason.trim()) return bad('Invalid restart request: reason is required');
    if (data.sha !== undefined && (typeof data.sha !== 'string' || !SHA_RE.test(data.sha))) return bad('Invalid restart request: sha must be a hex commit id');
    if (data.request_key !== undefined && (typeof data.request_key !== 'string' || !data.request_key || data.request_key.length > 200)) return bad('Invalid restart request: request_key');
    return { reason: data.reason.trim().slice(0, REASON_LIMIT), sha: data.sha, request_key: data.request_key };
  }

  const unavailable = () => ({ status: 503, body: { error: 'restart state unavailable' } });

  function readHistory() {
    let raw = '';
    try { raw = fs.readFileSync(historyFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return raw.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try { const entry = JSON.parse(line); return entry && typeof entry === 'object' ? [entry] : []; } catch { return []; }
    });
  }

  // The request a key was used for: the open one, or one that was restarted
  // for. Cancelled requests are forgotten. Throws when the history cannot be
  // read, which refuses the request rather than risk a second restart.
  function findKey(key) {
    if (cached.id && cached.state !== 'cancelled' && cached.requests.some(r => r.request_key === key)) {
      return { id: cached.id, state: cached.state, requests: publicRequests(cached.requests) };
    }
    for (const line of readHistory()) {
      if (Array.isArray(line.requests) && line.requests.some(r => r?.request_key === key)) {
        return { id: line.id, state: line.state || 'back', requests: publicRequests(line.requests) };
      }
    }
    return null;
  }

  async function post({ body, by, watcher }) {
    const data = admit(body);
    if (data.status) return data;
    // The same key is the same request, whatever has happened to it since.
    if (data.request_key) {
      let hit;
      try { hit = findKey(data.request_key); } catch { return unavailable(); }
      if (hit) return { status: 200, body: { idempotent: true, request_key: data.request_key, ...hit, requested: watcher.requested } };
    }
    // A config-only request has to be asked while HEAD is where this process
    // booted; once HEAD moved it would stay pending for good.
    if (!data.sha) {
      let head = null;
      try { head = String(git(['rev-parse', 'HEAD'])).trim(); } catch { /* refused below */ }
      if (bootSha == null || head !== bootSha) {
        return { status: 409, body: { error: 'restart refused: head moved (config-only)', code: 'head moved (config-only)' } };
      }
    }
    let previous;
    try {
      previous = readState();
      // A restart this boot has not reconciled is not ours to replace.
      if (previous.state === 'restarting') return unavailable();
      // The restart that finished is about to be replaced in the state file:
      // its keys must already be in the history.
      if (previous.state === 'back' && !previous.history_appended) appendHistory({ ...previous, abandoned: false });
    } catch { return unavailable(); }
    const t = now();
    const entry = { reason: data.reason, ...(data.sha ? { sha: data.sha } : {}), request_key: data.request_key ?? makeId(), at: t, by };
    const open = previous.state === 'pending' && previous.id;
    const next = open
      ? { ...previous, requests: [...previous.requests, entry], last_request_at: t, boot_sha: previous.boot_sha ?? bootSha }
      : { ...emptyRestartState(), id: makeId(), state: 'pending', boot_sha: bootSha, pending_since: t, first_request_at: t, last_request_at: t, requests: [entry] };
    try { writeState(next); } catch { return unavailable(); }
    const r = await bridgeRestartResponse({
      method: 'POST', body: { reason: data.reason }, watcher, holds, by,
      gateHold: async () => watcher.gateHoldReason ?? null,
    });
    if (r.status !== 202) {
      try { writeState(previous); } catch { /* the entry is dropped at the next restore */ }
      return r;
    }
    entries = next.requests;
    try { onChange(); } catch { /* the request is already made */ }
    return { status: 202, body: { ...r.body, id: next.id, request_key: entry.request_key, requests: publicRequests(next.requests) } };
  }

  async function del({ by, watcher }) {
    // The cancellation is made durable first: a cancel that is acknowledged
    // but not on disk would be undone by the restore after a crash.
    const before = cached;
    if (before.state === 'pending') {
      try { writeState({ ...before, state: 'cancelled', requests: [] }); } catch { return unavailable(); }
    }
    const r = await bridgeRestartResponse({ method: 'DELETE', watcher, holds, by });
    if (!r.body.cancelled) {
      if (before.state === 'pending') { try { writeState(before); } catch { /* the next write corrects it */ } }
      return r;
    }
    entries = [];
    try { onChange(); } catch { /* the request is already withdrawn */ }
    return { status: 200, body: { cancelled: true, id: before.id, state: 'cancelled' } };
  }

  async function handle({ method, body = null, by = 'operator' }) {
    const watcher = getWatcher();
    if (!watcher) return bridgeRestartResponse({ method, body, watcher, holds, by });
    // 503 means "retry after the bridge is back" to the restart client.
    if (watcher.restarting) {
      return method === 'DELETE'
        ? { status: 409, body: { error: 'restarting' } }
        : { status: 503, body: { error: 'restarting', id: cached.id } };
    }
    if (method === 'POST') return post({ body, by, watcher });
    if (method === 'DELETE') return del({ by, watcher });
    const r = await bridgeRestartResponse({ method, body, watcher, holds, by, gateHold: async () => watcher.gateHoldReason ?? null });
    if (method === 'GET' && r.status === 200) {
      r.body = { ...r.body, id: pending() ? cached.id : null, requests: pending() ? publicRequests(entries) : [], waiting_on: evaluate().waiting_on };
    }
    return r;
  }

  // beforeRestart for the watcher: the restart is recorded durably, in the
  // shape the crash rollback reads, BEFORE the process exits. Throws when it
  // cannot be written, which makes the watcher hold the restart.
  function commitRestart(info) {
    // The holds were checked before the gate and the preflight yielded; the
    // checkout may have changed under them. Check again, synchronously.
    const hold = codeHold();
    if (hold) throw new Error(`held: ${hold}`);
    if (typeof bootSha !== 'string' || !bootSha || typeof info.sha !== 'string' || !info.sha) {
      throw new Error('no verified boot sha: the rollback target is unknown');
    }
    const t = now();
    let state = readState();
    // A finished record is replaced below: archive it first, or refuse.
    if (state.state === 'restarting') throw new Error('the previous restart was not reconciled');
    if (state.state === 'back' && !state.history_appended) appendHistory({ ...state, abandoned: false });
    if (state.state !== 'pending' || !state.id) {
      // An update the watcher found by itself: no request behind it.
      state = {
        ...emptyRestartState(), id: makeId(), state: 'pending', boot_sha: bootSha, pending_since: t,
        first_request_at: t, last_request_at: t,
        requests: [{ reason: 'code update', sha: info.sha, request_key: `code-update:${info.sha}`, at: t, by: 'watcher' }],
      };
    }
    writeState({
      ...state, state: 'restarting', restarting_at: t, expected_sha: info.sha,
      previous_sha: bootSha, boot_sha: state.boot_sha ?? bootSha, boot_id: bootId,
      participants: [], stamp_written: false, shutdown_committed_at: t,
    });
    return true;
  }

  function appendHistory(line) {
    let raw = '';
    try { raw = fs.readFileSync(historyFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const seen = raw.split('\n').some((s) => {
      if (!s.trim()) return false;
      try { return JSON.parse(s).id === line.id; } catch { return false; }
    });
    if (seen) return;
    const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(historyFile, `${prefix}${JSON.stringify(line)}\n`, { mode: 0o600, flush: true });
  }

  // At boot, before anything else reads the state: the restart the previous
  // process committed is over (this process is the one it asked for), and this
  // process's own boot sha is recorded for the config-only checks.
  function reconcileBoot() {
    const state = readState();
    let next = { ...state, boot_sha: bootSha, stamp_written: false };
    if (state.state === 'restarting') {
      next = {
        ...next, state: 'back', booted_at: now(),
        results: { code_mismatch: state.expected_sha != null && bootSha !== state.expected_sha },
      };
    } else if (state.state === 'cancelling') {
      next = { ...next, state: 'cancelled', requests: [] };
    }
    // Keep what was loaded even if the rewrite fails: restore() must still see
    // an acknowledged pending request.
    cached = next;
    writeState(next);
    // The history line waits for the resume notes to settle (settleNotes), so
    // it carries what happened to them; a restart that ends before that is
    // archived as it is when its record is replaced.
    return next;
  }

  // Once every resume note has been delivered, retried to the end or dropped:
  // the outcomes become the restart's results (the journal's `restart` block,
  // the state file) and its history line, which the rollback tooling reads
  // (a failed or possibly delivered note revokes autonomy there). Idempotent.
  function settleNotes(outcomes = {}) {
    const state = cached;
    if (state.state !== 'back' || !state.id || state.history_appended) return state;
    const ids = (kind) => Object.entries(outcomes).filter(([, o]) => o.outcome === kind).map(([id]) => id);
    const results = {
      ...(state.results || {}),
      resumed: ids('resumed'), failed: ids('failed'), possibly_delivered: ids('possibly_delivered'),
      verdicts: outcomes,
    };
    let next = { ...state, results };
    try {
      appendHistory({ ...next, abandoned: false });
      next = { ...next, history_appended: true };
    } catch (e) { warn(`[restart] history line not written: ${e?.message ?? e}`); }
    try { writeState(next); } catch (e) { warn(`[restart] resume outcomes not recorded: ${e?.message ?? e}`); cached = next; }
    try { onChange(); } catch { /* status only */ }
    return next;
  }

  // After the watcher exists: a request that was pending when the previous
  // process went away without restarting (a crash) is asked for again. One
  // pinned to a sha this boot already contains is satisfied and dropped.
  function restore() {
    const watcher = getWatcher();
    const state = cached;
    if (!watcher || state.state !== 'pending' || !state.id) return 0;
    const open = [];
    entries = state.requests;
    for (const e of state.requests) {
      let satisfied = false;
      if (e.sha && bootSha) { try { satisfied = git(['merge-base', '--is-ancestor', e.sha, bootSha]) === true; } catch { /* keep it */ } }
      if (!satisfied) open.push(e);
    }
    if (!open.length) {
      writeState({ ...state, state: 'cancelled', requests: [] });
      log('[restart] pending request was already satisfied by this boot; dropped');
      return 0;
    }
    if (open.length !== state.requests.length) writeState({ ...state, requests: open });
    entries = open;
    const last = open[open.length - 1];
    watcher.request({ reason: last.reason, by: 'restored after restart of the bridge process' });
    log(`[restart] restored ${open.length} pending request(s) from the state file`);
    try { onChange(); } catch { /* status only */ }
    return open.length;
  }

  return {
    handle, gate, evaluate, commitRestart, reconcileBoot, restore, pending, settleNotes,
    // What upstream's holds cannot see, from a read that counts nothing: the
    // watcher adds it to its busy count so a request waits while it is held.
    occupiedNow: () => holdersOf(quiet ? quiet.peek() : null),
    get lastVerdict() { return lastVerdict; },
    // The state as buildRestartStatus reads it (the state file's own shape).
    getState: () => cached,
    PINNED_WATCHER_OPTIONS,
  };
}
