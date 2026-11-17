// Watch checkout updates after deployment settles. By default, submit a
// planned restart request; the planned gate owns readiness and shutdown.
// An explicit force interval retains the legacy preflight and exit path.
// File reads, requests, clock and shutdown are injected for isolated tests.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { preflightSupport } from './preflight-support.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { WORK_HOLD_MAX_MS } from './work-hold.js';

// What the process exits with when it restarts itself. Non-zero on purpose:
// launchd's KeepAlive { SuccessfulExit = false } relaunches only after an
// UNSUCCESSFUL exit (deploy.sh's kickstart -k is how a clean exit gets
// restarted there), systemd's Restart=always relaunches after any exit, and
// the Windows task restarts on failure. 75 is sysexits' EX_TEMPFAIL: "try
// again later", which is exactly the message.
export const RESTART_EXIT_CODE = 75;

export const DEFAULT_POLL_MS = 60_000;
// A pull is followed by npm install and a preflight; HEAD moves at the pull.
// Give the deploy this long to finish before trusting what is on disk.
export const DEFAULT_SETTLE_MS = 5 * 60_000;
// How often the watcher says it is still waiting for a running turn. Not a
// cap: nothing is forced by default (see FORCE_AFTER below).
export const DEFAULT_WARN_EVERY_MS = 30 * 60_000;
// Opt-in only (MATRON_CODE_UPDATE_FORCE_AFTER_MS): after this long, restart
// even mid-turn. 0 = never, the default.
export const DEFAULT_FORCE_AFTER_MS = 0;
export const PREFLIGHT_TIMEOUT_MS = 120_000;
// The restart gate (MATRON_RESTART_GATE_CMD) is asked at every poll, so it
// gets seconds, not minutes. It holds no longer than a work hold does.
export const GATE_TIMEOUT_MS = 5_000;
export const GATE_MAX_HOLD_MS = WORK_HOLD_MAX_MS;

// A forced restart (FORCE_AFTER, opt-in) cuts turns off. Those chats carry on
// by themselves — no tap — when MATRON_CODE_UPDATE_AUTO_CARRY_ON is on
// (the default): the exiting process leaves
// a stamp with its bootId, and the next boot resumes every inflight marker
// that carries that bootId with this text instead of publishing the card.
// Marked like the self-restart continuation so the journal reader can tell
// the bridge said it, not the user.
export const AUTO_CARRY_ON_TEXT = '[auto-continue after bridge update] The bridge restarted itself onto new code while this turn was running, so the turn was cut off where it was. Carry on with what you were doing.';
// Boot work first: the journal socket says hello and the carry-on cards
// for OTHER interruptions go out, then the resumes start.
export const AUTO_CARRY_ON_DELAY_MS = 15_000;

export function autoCarryOnEnabled(value) {
  return restartEnabled(value);
}

// The stamp the exiting process leaves for the next boot: { bootId, sha,
// at, busy }. Written atomically; a failed write is logged by the caller
// and simply means the interruptions get cards instead.
export function writeSelfRestartStamp(file, stamp, { write = atomicWriteFileSync } = {}) {
  write(file, JSON.stringify({ ...stamp, at: stamp.at ?? Date.now() }, null, 2));
}

// Read and remove the stamp. null when there is none or it is malformed —
// then nothing carries on by itself. Removed before use, like the
// markers, so a crashy boot cannot resume the same turns twice.
export function takeSelfRestartStamp(file, { readFileSync = fs.readFileSync, unlinkSync = fs.unlinkSync } = {}) {
  let raw;
  try { raw = String(readFileSync(file, 'utf8')); } catch { return null; }
  try { unlinkSync(file); } catch { return null; }
  try {
    const stamp = JSON.parse(raw);
    if (!stamp || typeof stamp !== 'object' || typeof stamp.bootId !== 'string' || !stamp.bootId) return null;
    return stamp;
  } catch {
    return null;
  }
}

// Split the previous boots' stale markers (lib/inflight-marker.js
// takeStale) into the ones the self-restart stamp owns — they carry on by
// themselves — and the rest, which get a card as before. Without a stamp,
// or with the option off, everything is a card: a crash two boots ago must
// not resume by itself just because the latest exit was a self-restart.
export function selectAutoCarryOn(stale, stamp, { enabled = true } = {}) {
  const auto = [];
  const card = [];
  for (const rec of stale || []) {
    if (enabled && stamp && rec && rec.bootId && rec.bootId === stamp.bootId) auto.push(rec);
    else card.push(rec);
  }
  return { auto, card };
}

// Positive-integer env setting with a fallback; "0" is allowed where the
// caller treats it as off (pollMs never: a zero poll would spin).
export function parseMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// Non-negative-integer env setting where 0 means off (FORCE_AFTER).
export function parseMsOrOff(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// MATRON_CODE_UPDATE_RESTART: unset or anything but "0"/"false"/"off" is on.
export function restartEnabled(value) {
  if (value == null) return true;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

// The git directory behind a checkout: `.git` itself, or the directory a
// worktree's `.git` FILE points at ("gitdir: <path>", relative to the
// checkout). null when the checkout has neither — nothing to watch. One
// read, no stat first: reading a directory fails with EISDIR, which IS the
// answer, and a check-then-read would race a checkout being rewritten.
export function resolveGitDir(checkoutDir, { readFileSync = fs.readFileSync } = {}) {
  const dotGit = path.join(checkoutDir, '.git');
  let text;
  try {
    text = String(readFileSync(dotGit, 'utf8'));
  } catch (e) {
    return e?.code === 'EISDIR' ? dotGit : null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  return path.resolve(checkoutDir, m[1]);
}

// The newest reflog entry of HEAD: { sha, at } (at in ms) from the last
// non-empty line of logs/HEAD, which git appends on every HEAD move (a
// fast-forward merge, a checkout, a reset). null when there is no reflog
// or the line does not parse — the watcher then does nothing, ever: this
// only ever adds a restart, never blocks one.
//
// Line shape: "<old-sha> <new-sha> <name> <email> <unix-ts> <tz>\t<message>"
export function readHeadReflog(gitDir, { readFileSync = fs.readFileSync } = {}) {
  let text;
  try { text = String(readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8')); } catch { return null; }
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return null;
  const head = lines[lines.length - 1].split('\t')[0];
  const m = /^[0-9a-f]{40} ([0-9a-f]{40}) .* (\d+) [+-]\d{4}$/.exec(head);
  if (!m) return null;
  return { sha: m[1], at: Number(m[2]) * 1000 };
}

// The same two checks update-bridges and deploy.sh run before they restart
// anything: index.js parses, and its whole static import chain (native
// bindings included — sharp was the one that bit) resolves, via
// MATRON_BRIDGE_PREFLIGHT=module, which exits before startup runs. This runs in
// the live bridge against whatever revision HEAD moved to, which can be an
// OLDER one (a revert, a rollback). An index.js without the marker ignores the
// env var and would boot a real bridge against the live config, so such a
// checkout gets the old import check instead. Resolves to
// { ok: true } or { ok: false, error }. Never throws. With mode=gate, verify
// protocol support first, then load the full entry point using the checkout's
// current .env and environment excluding boot dotenv keys, with startup effects suppressed.
export function defaultPreflight(checkoutDir, { exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS, mode, bootDotenvKeys = [], readFileSync = fs.readFileSync } = {}) {
  if (mode === 'gate' && preflightSupport(checkoutDir, 'HEAD') !== 'gate/1') {
    return Promise.resolve({ ok: false, error: 'mode unsupported at HEAD' });
  }
  const gateEnv = { ...process.env };
  for (const key of bootDotenvKeys) delete gateEnv[key];
  gateEnv.MATRON_BRIDGE_PREFLIGHT = 'gate';
  // `env`, when given, is the complete child environment.
  const run = (args, env) => new Promise(resolve => {
    try {
      exec(process.execPath, args, { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true,
        ...(env ? { env } : {}),
      }, (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const detail = String(stderr || err.message || err).trim().split('\n').slice(-3).join(' | ');
        resolve({ ok: false, error: `${args.join(' ')}: ${detail}` });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
  return (async () => {
    if (mode === 'gate') return run(['index.js'], gateEnv);
    const check = await run(['--check', 'index.js']);
    if (!check.ok) return check;
    let hasModuleMode = false;
    try { hasModuleMode = String(readFileSync(path.join(checkoutDir, 'index.js'), 'utf8')).includes('MATRON_BRIDGE_PREFLIGHT'); } catch { /* fall back */ }
    if (hasModuleMode) return run(['index.js'], { ...process.env, MATRON_BRIDGE_PREFLIGHT: 'module' });
    return run(['--input-type=module', '-e', "await import('sharp'); await import('./lib/inline-image.js')"]);
  })();
}

// The gate runs with a minimal environment: PATH, HOME and the
// MATRON_RESTART_GATE_* variables, never the bridge's tokens or other
// settings. (SystemRoot and PATHEXT are kept too, since Windows needs them to
// start a process at all.)
export function gateEnv(src = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (k === 'PATH' || k === 'HOME' || k === 'SystemRoot' || k === 'PATHEXT' || k.startsWith('MATRON_RESTART_GATE_')) out[k] = v;
  }
  return out;
}

// execFile with the one thing it cannot do: `detached` (a new process group).
// Same callback contract as execFile for what the gate reads: (err, stdout),
// err.code the exit code, err.killed set when the timeout fired.
function execDetached(file, args, { timeout, killSignal = 'SIGTERM', ...spawnOpts }, cb) {
  const child = spawn(file, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  let killed = false;
  let finished = false;
  let timer = null;
  const finish = (err) => { if (finished) return; finished = true; clearTimeout(timer); cb(err, out, ''); };
  if (timeout > 0) timer = setTimeout(() => { killed = true; try { child.kill(killSignal); } catch { /* gone */ } }, timeout);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
  child.on('error', (e) => finish(e));
  child.on('close', (code, signal) => {
    if (code === 0 && !killed) return finish(null);
    finish(Object.assign(new Error(`Command failed: ${file}`), { code, killed, signal }));
  });
  return child;
}

// An operator's advisory "is this a good moment?" hook, from
// MATRON_RESTART_GATE_CMD: a command line split on whitespace into an argv
// (no shell, no quoting), run with a short timeout at each poll once the
// update is otherwise ready. Exit 0 = safe to restart. Exit 1 = hold; the
// first line of stdout is the reason shown in the waiting warning. Any
// other exit code, a spawn failure or a timeout counts as safe, so a broken
// hook can never wedge updates. Returns null for an unset or blank command
// (the gate is off). The returned gate resolves to { hold, reason?, error? }
// and never throws.
export function createCommandGate(cmdLine, { exec = execDetached, timeoutMs = GATE_TIMEOUT_MS, env = process.env } = {}) {
  const argv = String(cmdLine ?? '').trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return null;
  const [file, ...args] = argv;
  return () => new Promise(resolveOnce => {
    // The child's own timeout only sends a signal; a hook that ignores it
    // would leave the callback pending forever. The deadline below settles
    // the gate regardless and force-kills the child.
    let done = false;
    let child;
    let deadline;
    // The hook runs in its own process group (POSIX), so a timeout takes the
    // hook's children down with it, not just the hook.
    const killGroup = () => {
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, 'SIGKILL');
        else child?.kill?.('SIGKILL');
      } catch { /* already gone */ }
    };
    const resolve = (v) => { if (done) return; done = true; clearTimeout(deadline); resolveOnce(v); };
    deadline = setTimeout(() => {
      killGroup();
      resolve({ hold: false, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs + 250);
    try {
      child = exec(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, env: gateEnv(env), detached: process.platform !== 'win32' }, (err, stdout) => {
        if (err?.killed) killGroup();
        if (!err) return resolve({ hold: false });
        if (err.code === 1 && !err.killed) {
          // eslint-disable-next-line no-control-regex
          const reason = String(stdout || '').split('\n')[0].replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
          return resolve({ hold: true, reason: reason || 'no reason given' });
        }
        resolve({ hold: false, error: err.killed ? `timed out after ${timeoutMs}ms` : (err.code != null ? `exit ${err.code}` : err.message || String(err)) });
      });
    } catch (e) {
      resolve({ hold: false, error: e?.message || String(e) });
    }
  });
}

// The policy, as one object with a tick(). Deps:
//   readHead()      -> { sha, at } | null   (the newest HEAD reflog entry)
//   busySessions()  -> number of sessions holding work right now (mid-turn,
//                      background job, running subagent)
//   preflight()     -> Promise<{ ok, error? }>
//   addRequest(request) -> committed request result | {busy: 'restarting'}
//   restart(info)   -> exit for the supervisor; info = { sha, forced, busy, waitedMs }
//                      (forced is only ever true with forceAfterMs > 0)
//   gate()          -> Promise<{ hold, reason?, error? }> | null (optional,
//                      createCommandGate). Asked only when no session holds
//                      work and the restart would otherwise go ahead. hold
//                      delays it, advisory: after gateMaxMs from the first
//                      hold the restart goes ahead (logged), and a gate that
//                      throws or reports an error counts as safe. A forced
//                      restart never asks it.
//   now()           -> ms
//   log / warn      -> console-ish
//   bootSha         -> the HEAD sha this process started on (default: read now)
export function createCodeUpdateWatcher({
  readHead,
  busySessions,
  preflight,
  restart,
  addRequest,
  gate = null,
  gateMaxMs = GATE_MAX_HOLD_MS,
  now = Date.now,
  log = () => {},
  warn = () => {},
  bootSha,
  settleMs = DEFAULT_SETTLE_MS,
  warnEveryMs = DEFAULT_WARN_EVERY_MS,
  forceAfterMs = DEFAULT_FORCE_AFTER_MS,
}) {
  const boot = bootSha ?? readHead()?.sha ?? null;
  // The update waiting for a quiet moment: { sha, since, warnedAt }.
  let pending = null;
  // A sha whose preflight failed, logged once; the deploy's own rollback
  // moves HEAD again, which clears it. Without this a broken tree would be
  // preflighted (and warned about) every poll.
  let refused = null;
  // A preflight in progress; a tick during it does nothing.
  let checking = null;
  let restarted = false;
  let requested = null;
  // The last gate failure warned about, so a hook that fails on every poll
  // is reported once, not once a minute.
  let lastGateError = null;

  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));
  const mins = (ms) => Math.round(ms / 60_000);

  async function tick() {
    if (restarted) return { action: 'restarted' };
    const head = readHead();
    if (!head) return { action: 'none', reason: 'no reflog' };
    if (!boot || head.sha === boot) {
      if (pending) {
        log(`[code-update] HEAD is back on ${short(boot)}; the pending restart is off`);
        pending = null;
      }
      return { action: 'none', reason: 'unchanged' };
    }
    const t = now();
    if (t - head.at < settleMs) return { action: 'settling', sha: head.sha };
    if (forceAfterMs === 0) {
      if (requested === head.sha) return { action: 'requested', sha: head.sha };
      const result = addRequest?.({ origin: 'watcher', reason: 'code update', sha: head.sha, request_key: `code-update:${head.sha}` });
      if (result?.busy === 'restarting') return { action: 'waiting', sha: head.sha, reason: 'restarting' };
      if (result?.id && result.state) {
        requested = head.sha;
        log(`[code-update] planned restart requested onto ${short(head.sha)}`);
        return { action: 'requested', sha: head.sha };
      }
    }
    if (head.sha === refused) return { action: 'refused', sha: head.sha };
    if (checking) return { action: 'checking', sha: head.sha };

    if (!pending || pending.sha !== head.sha) {
      checking = preflight();
      let result;
      try { result = await checking; } catch (e) { result = { ok: false, error: e?.message || String(e) }; } finally { checking = null; }
      if (!result || !result.ok) {
        refused = head.sha;
        pending = null;
        warn(`[code-update] new code on disk (${short(head.sha)}, running ${short(boot)}) failed its preflight — NOT restarting onto it: ${result?.error || 'unknown error'}`);
        return { action: 'refused', sha: head.sha, error: result?.error };
      }
      pending = { sha: head.sha, since: now(), warnedAt: now() };
      const until = forceAfterMs > 0 ? `, forced after ${mins(forceAfterMs)} min` : ', subject to the work-hold age cap';
      log(`[code-update] new code on disk: ${short(head.sha)} (running ${short(boot)}). Restarting when no session has work in flight${until}.`);
    }

    const busy = busySessions();
    const t2 = now();
    const waitedMs = t2 - pending.since;
    const forced = busy > 0;
    if (forced && !(forceAfterMs > 0 && waitedMs >= forceAfterMs)) {
      // A running turn is never cut off by default. Say so now and then,
      // so a bridge that has been waiting for hours is visible in its log.
      if (t2 - pending.warnedAt >= warnEveryMs) {
        pending.warnedAt = t2;
        warn(`[code-update] still waiting to restart onto ${short(head.sha)}: ${busy} session(s) with work in flight (a turn, background job or subagent) for ${mins(waitedMs)} min; work holds are age-capped`);
      }
      return { action: 'waiting', sha: head.sha, busy, waitedMs };
    }
    if (!forced && gate) {
      checking = (async () => {
        try { return (await gate()) || { hold: false }; } catch (e) { return { hold: false, error: e?.message || String(e) }; }
      })();
      let verdict;
      try { verdict = await checking; } finally { checking = null; }
      if (verdict.error && verdict.error !== lastGateError) warn(`[code-update] restart gate failed (${verdict.error}) — treating it as safe to restart`);
      lastGateError = verdict.error || null;
      if (verdict.hold) {
        const t3 = now();
        pending.gateSince ??= t3;
        const heldMs = t3 - pending.gateSince;
        if (heldMs < gateMaxMs) {
          pending.gateReason = verdict.reason;
          if (heldMs === 0) log(`[code-update] restart gate holds the update onto ${short(head.sha)}: ${verdict.reason}`);
          if (t3 - pending.warnedAt >= warnEveryMs) {
            pending.warnedAt = t3;
            warn(`[code-update] still waiting to restart onto ${short(head.sha)}: held by the restart gate for ${mins(heldMs)} min (${verdict.reason}); the hold expires after ${mins(gateMaxMs)} min`);
          }
          return { action: 'waiting', sha: head.sha, busy, waitedMs, gate: verdict.reason };
        }
        warn(`[code-update] restart gate has held the update onto ${short(head.sha)} for ${mins(heldMs)} min (${verdict.reason}) — past the ${mins(gateMaxMs)} min cap, restarting anyway`);
      }
    }
    // The gate yielded: a turn may have started or HEAD may have moved
    // meanwhile. Re-run the whole decision (no gate call is made while work
    // holds) rather than act on a stale count or an unchecked revision.
    if (gate && !forced && (readHead()?.sha !== head.sha || busySessions() > 0)) return tick();
    restarted = true;
    const info = { sha: head.sha, forced, busy, waitedMs };
    if (forced) {
      warn(`[code-update] ${busy} session(s) still with work in flight after ${mins(waitedMs)} min (MATRON_CODE_UPDATE_FORCE_AFTER_MS) — restarting onto ${short(head.sha)} anyway; interrupted chats carry on at boot`);
    } else {
      log(`[code-update] no session has work in flight — restarting onto ${short(head.sha)}`);
    }
    restart(info);
    return { action: 'restart', ...info };
  }

  return {
    tick,
    onBack: tick,
    get bootSha() { return boot; },
    get pending() { return pending; },
  };
}
