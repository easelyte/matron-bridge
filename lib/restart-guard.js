// Fork-only layer over the upstream bridge restart request
// (lib/bridge-restart.js, lib/code-update-restart.js). Upstream owns the
// request, the cancel, the preflight, the work holds and the exit; this adds
// what upstream does not carry and our restart client relies on:
//
//   * a sha pin: a request names the commit it was made for, and the restart
//     waits unless HEAD still descends from it with a clean tree. A request
//     without one is config-only and holds once HEAD has moved since boot;
//   * request_key idempotence that survives the restart it caused, so a
//     client retrying after the connection drops never restarts twice;
//   * the pre-restart notice: every live session is told once to leave a
//     resume note (lib/session-control.js createRestartNotices), and the
//     restart waits until they have been told;
//   * a stricter quiet rule for the in-memory parts upstream cannot see
//     (answers awaited, queued input, input being delivered);
//   * the bounded `restart` block published in box_status.
//
// Everything impure is injected, so the policy unit-tests without a checkout.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './atomic-write.js';
import { bridgeRestartResponse } from './bridge-restart.js';

const KEY_LIMIT = 200;
const KEY_TTL_MS = 7 * 24 * 3600_000;
const REASON_LIMIT = 200;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

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

// request_key -> time first seen, in one small file. A missing file is empty;
// an unreadable one is treated as empty and rewritten on the next key, since
// losing idempotence is better than refusing every restart.
export function createKeyStore({ fs = nodeFs, file = path.join(os.homedir(), '.matron-bridge-restart-keys.json'), now = Date.now } = {}) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* absent or unreadable: start empty */ }
    return {};
  }
  return {
    has(key) {
      const at = read()[key];
      return Number.isFinite(at) && now() - at < KEY_TTL_MS;
    },
    add(key) {
      const t = now();
      const live = Object.entries(read()).filter(([, at]) => Number.isFinite(at) && t - at < KEY_TTL_MS);
      live.push([key, t]);
      live.sort((a, b) => a[1] - b[1]);
      atomicWriteFileSync(file, JSON.stringify(Object.fromEntries(live.slice(-KEY_LIMIT))), { fs, mode: 0o600 });
    },
  };
}

// getWatcher()      the code-update watcher (null while it is off)
// holds()           upstream's sessionsHoldingRestart: { holders, unreadable }
// convoIdOf(s)      the journal conversation id of a session
// liveConvoIds()    conversation ids of the live sessions (for the notice)
// occupied()        [{ convoId, why }] for in-memory input holds upstream does
//                   not look at
// landedRef         a ref (e.g. origin/master) HEAD must descend from before a
//                   restart onto it; null = no such check
// commandGate       upstream's MATRON_RESTART_GATE_CMD gate (or null)
export function createRestartGuard({
  getWatcher, holds, repoDir, bootSha = null, convoIdOf = s => s.roomId,
  liveConvoIds = () => [], occupied = () => [], commandGate = null, landedRef = null,
  keys = createKeyStore(), git = args => runGit(repoDir, args),
  now = Date.now, onChange = () => {}, warn = () => {},
}) {
  let entries = [];
  let id = null;
  let since = null;
  const notified = new Map();
  let lastVerdict = null;

  const clear = () => { entries = []; id = null; since = null; notified.clear(); lastVerdict = null; };
  const pending = () => !!id && !!getWatcher()?.requested;

  // A ref that looks like an option fails closed rather than reaching git.
  const landed = head => !landedRef
    || (!landedRef.startsWith('-') && git(['merge-base', '--is-ancestor', head, landedRef]) === true);

  // The first reason HEAD does not match the pins, or null.
  function codeHold() {
    let head;
    try {
      head = String(git(['rev-parse', 'HEAD'])).trim();
      if (!head) throw new Error('no HEAD');
    } catch { return 'not a descendant'; }
    try {
      for (const e of entries) {
        if (e.sha) {
          if (git(['merge-base', '--is-ancestor', e.sha, head]) !== true) return 'not a descendant';
        } else if (bootSha == null || head !== bootSha) return 'head moved (config-only)';
      }
      if (String(git(['status', '--porcelain', '--untracked-files=no'])).trim()) return 'dirty tree';
      // Only code that has landed (is an ancestor of landedRef, e.g. the
      // remote default branch) may be restarted onto.
      if (!landed(head)) return 'head not landed';
    } catch { return 'not a descendant'; }
    return null;
  }

  function unwarned() {
    return liveConvoIds().filter(convo => convo && !notified.has(convo));
  }

  // The state shape createRestartNotices and buildRestartStatus read.
  function getState() {
    if (!pending()) return { id: null, state: null, requests: [], notified: {} };
    return {
      id, state: 'pending',
      requests: entries.map(e => ({ reason: e.reason, ...(e.sha ? { sha: e.sha } : {}) })),
      pending_since: since, first_request_at: since, expected_sha: null,
      notified: Object.fromEntries(notified),
    };
  }

  function evaluate() {
    const { holders, unreadable } = holds();
    const requested = getWatcher()?.requested;
    lastVerdict = {
      waiting_on: {
        quiet: {
          holders: [
            ...holders.map(h => ({ convoId: convoIdOf(h.session), why: h.reason })),
            ...occupied(),
          ],
          probe_error: unreadable ? 'process_table' : null,
        },
        code: codeHold(),
        preflight: requested?.error ? { error: 'preflight failed' } : null,
        collect: null,
        unwarned: unwarned(),
      },
    };
    return lastVerdict;
  }

  // The gate handed to the watcher: our holds first, then the operator's
  // command. Only the pinned and notice checks apply while a request is open.
  async function gate() {
    // The landed check also covers an update with no request behind it.
    const code = pending() || landedRef ? codeHold() : null;
    if (code) return { hold: true, reason: code };
    if (pending()) {
      const un = unwarned();
      if (un.length) return { hold: true, reason: `${un.length} session(s) not yet told to leave a resume note` };
    }
    const busy = occupied();
    if (busy.length) return { hold: true, reason: `${busy.length} session(s) with input pending (${busy[0].why})` };
    return commandGate ? commandGate() : { hold: false };
  }

  function admit(body) {
    const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const bad = (error) => ({ status: 400, body: { error } });
    if (typeof data.reason !== 'string' || !data.reason.trim()) return bad('Invalid restart request: reason is required');
    if (data.sha !== undefined && (typeof data.sha !== 'string' || !SHA_RE.test(data.sha))) return bad('Invalid restart request: sha must be a hex commit id');
    if (data.request_key !== undefined && (typeof data.request_key !== 'string' || !data.request_key || data.request_key.length > 200)) return bad('Invalid restart request: request_key');
    return null;
  }

  const refuse = (code) => ({ status: 409, body: { error: `restart refused: ${code}`, code } });

  // A pinned request only has to descend from its sha; a config-only one has
  // to be asked while HEAD is where this process booted.
  function admitCode(sha) {
    try {
      const head = String(git(['rev-parse', 'HEAD'])).trim();
      if (!landed(head)) return refuse('head not landed');
      if (sha) return git(['merge-base', '--is-ancestor', sha, head]) === true ? null : refuse('not a descendant');
      return bootSha != null && head === bootSha ? null : refuse('head moved (config-only)');
    } catch { return refuse('not a descendant'); }
  }

  async function handle({ method, body = null, by = 'operator' }) {
    const watcher = getWatcher();
    const post = method === 'POST' && watcher;
    let data = null;
    if (post) {
      const bad = admit(body);
      if (bad) return bad;
      data = { reason: body.reason.trim().slice(0, REASON_LIMIT), sha: body.sha, request_key: body.request_key };
      if (data.request_key && keys.has(data.request_key)) {
        return { status: 200, body: { idempotent: true, request_key: data.request_key, ...getState() } };
      }
      const refused = admitCode(data.sha);
      if (refused) return refused;
    }
    const r = await bridgeRestartResponse({
      method, body: post ? { reason: data.reason } : body, watcher, holds,
      gateHold: async () => watcher?.gateHoldReason ?? null, by,
    });
    if (post && r.status === 202) {
      entries.push({ reason: data.reason, sha: data.sha || null, request_key: data.request_key || null });
      id ??= randomUUID();
      since ??= now();
      if (data.request_key) {
        try { keys.add(data.request_key); } catch (e) { warn(`[restart] could not record the request key: ${e?.message ?? e}`); }
      }
      r.body = { ...r.body, id, requests: getState().requests };
      try { onChange(); } catch { /* the request is already made */ }
    } else if (method === 'DELETE' && r.status === 200 && r.body.cancelled) {
      clear();
      try { onChange(); } catch { /* the request is already withdrawn */ }
    } else if (method === 'GET' && r.status === 200) {
      r.body = { ...r.body, id, requests: getState().requests, waiting_on: evaluate().waiting_on };
    }
    return r;
  }

  return {
    handle, gate, getState, evaluate, pending,
    get lastVerdict() { return lastVerdict; },
    markNotified(restartId, convoId) {
      if (restartId !== id || !convoId || !pending()) return getState();
      if (!notified.has(convoId)) notified.set(convoId, { at: now(), turnEnded: false });
      return getState();
    },
    markNoticeTurnEnded(restartId, convoId) {
      const entry = notified.get(convoId);
      if (restartId === id && entry) entry.turnEnded = true;
      return getState();
    },
  };
}

// Inputs being delivered to a session right now. begin() returns the matching
// end(), which is safe to call twice.
export function createInputCounter() {
  let n = 0;
  return {
    begin() {
      n++;
      let done = false;
      return () => { if (!done) { done = true; n--; } };
    },
    get count() { return n; },
  };
}
