// Restart onto new code by itself — the fix for a bridge that never updates.
//
// A rollout (deploy.sh, or a fleet updater script) pulls the new code
// onto disk and then DEFERS the restart whenever the bridge hosts a live
// agent session, because the restart kills that session's process. The
// deferral is "picks up on the next natural restart" — and a bridge whose
// session is nearly always live (the Coordinator's box) has no natural
// restart. One such box once ran code from the morning all evening, with
// three newer commits on disk, and voice notes went through local whisper
// although the journal already had the Azure transcript.
//
// So the bridge watches its own checkout. When HEAD moves (the last line
// of .git/logs/HEAD, the same "newest reflog entry" test update-bridges
// uses to call a process stale), it waits for the deploy to settle
// (npm install runs after the pull — a restart in between boots onto half
// a node_modules), proves the new tree can boot (the same preflight the
// deploy scripts run), and then exits for the supervisor to relaunch it:
//
//   * at the first poll where no session holds work — a turn, background
//     job, or running subagent. Only background jobs and subagents use the
//     idle reaper's eight-hour age cap; running turns hold without a cap;
//   * while held, warns every WARN_EVERY (30 min). The age cap prevents a
//     long-lived background process from deferring updates forever.
//     A box that wants the old behaviour sets MATRON_CODE_UPDATE_FORCE_AFTER_MS:
//     then, after that long, the restart goes ahead mid-turn and the
//     interrupted chats carry on by themselves (the stamp below).
//
// Pure with every impure edge injected (file reads, clock, the session list,
// the preflight, the restart), the same shape as createInflightMarker, so the
// whole policy unit-tests without a checkout or a live bridge. index.js owns
// the timer and the gracefulShutdown.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
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
// With the gate made authoritative (no hold cap, or errors hold), nothing but
// the gate itself ends a hold, so a long one is reported once through notify()
// after this long (MATRON_RESTART_GATE_NOTICE_AFTER_MS), a gate that keeps
// failing included.
export const GATE_NOTICE_AFTER_MS = 30 * 60_000;

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
// { ok: true } or { ok: false, error }. Never throws.
export function defaultPreflight(checkoutDir, { exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS, readFileSync = fs.readFileSync } = {}) {
  const run = (args, env) => new Promise(resolve => {
    try {
      exec(process.execPath, args, { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true, ...(env && { env: { ...process.env, ...env } }) }, (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const detail = String(stderr || err.message || err).trim().split('\n').slice(-3).join(' | ');
        resolve({ ok: false, error: `${args.join(' ')}: ${detail}` });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
  return (async () => {
    const check = await run(['--check', 'index.js']);
    if (!check.ok) return check;
    let hasModuleMode = false;
    try { hasModuleMode = String(readFileSync(path.join(checkoutDir, 'index.js'), 'utf8')).includes('MATRON_BRIDGE_PREFLIGHT'); } catch { /* fall back */ }
    if (hasModuleMode) return run(['index.js'], { MATRON_BRIDGE_PREFLIGHT: 'module' });
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
//   restart(info)   -> exit for the supervisor; info = { sha, forced, busy, waitedMs }
//                      (forced is only ever true with forceAfterMs > 0)
//   gate()          -> Promise<{ hold, reason?, error? }> | null (optional,
//                      createCommandGate). Asked only when no session holds
//                      work and the restart would otherwise go ahead. hold
//                      delays it, advisory by default: after gateMaxMs from
//                      the first hold the restart goes ahead (logged), and a
//                      gate that throws or reports an error counts as safe.
//                      Two opt-in settings make it authoritative: gateMaxMs 0
//                      (a hold never lapses) and gateOnError 'hold' (an
//                      error, timeout or spawn failure holds, with the error
//                      as the reason). A forced restart never asks it, and
//                      neither does a request made with force (POST /restart
//                      { force: true }). notify(text) is called once when an
//                      authoritative gate's hold goes on long (see
//                      GATE_NOTICE_AFTER_MS).
//   now()           -> ms
//   log / warn      -> console-ish
//   request({reason, by}) / cancelRequest() / requested: a bridge restart on
//                      demand (see `requested` below)
//   bootSha         -> the HEAD sha this process started on (default: read now)
//   autoUpdate      -> fork: false = request-only. A HEAD move alone restarts
//                      nothing; only an explicit request() does (with the same
//                      preflight, holds and gate). Default true (upstream).
//   beforeRestart(info) -> fork: called synchronously right before the exit is committed. It
//                      may throw or return false to refuse for now (the restart
//                      then stays pending and is tried again at the next tick);
//                      the rollback state file is written there, and a restart
//                      that could not be recorded must not go ahead.
export function createCodeUpdateWatcher({
  readHead,
  busySessions,
  preflight,
  restart,
  gate = null,
  gateMaxMs = GATE_MAX_HOLD_MS,
  gateOnError = 'safe',
  notify = () => {},
  gateNoticeAfterMs = GATE_NOTICE_AFTER_MS,
  // How the long-hold notice says to skip the gate; '' where force is not offered.
  forceHint = ' To skip the gate for one restart: POST /restart with {"force": true}.',
  now = Date.now,
  log = () => {},
  warn = () => {},
  bootSha,
  settleMs = DEFAULT_SETTLE_MS,
  warnEveryMs = DEFAULT_WARN_EVERY_MS,
  forceAfterMs = DEFAULT_FORCE_AFTER_MS,
  autoUpdate = true,
  beforeRestart = null,
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
  // A bridge restart someone asked for: { reason, by, at } (POST /restart).
  // Separate from `pending` on purpose. An update waits on HEAD having moved
  // and is dropped when HEAD is back on the boot commit; a request is not
  // about HEAD at all, so it skips that check. It still goes through the
  // same preflight (on whatever HEAD is now), the holds, the 30-minute
  // warning and the exit below.
  let requested = null;
  // A sha a requested restart's preflight failed on; retried once HEAD moves
  // or the restart is asked for again.
  let requestRefused = null;
  // Bumped by every request() and cancelRequest(), so a preflight that was
  // started for one request is not applied to a later one, or to none.
  let requestGen = 0;
  // Set by a new request: preflight the current revision again.
  let recheck = false;
  // The last gate failure warned about, so a hook that fails on every poll
  // is reported once, not once a minute.
  let lastGateError = null;

  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));
  const mins = (ms) => Math.round(ms / 60_000);

  async function tick() {
    if (restarted) return { action: 'restarted' };
    const head = readHead();
    if (!head) return { action: 'none', reason: 'no reflog' };
    if (!requested && !autoUpdate) {
      if (pending && !checking) pending = null;
      return { action: 'none', reason: 'request-only' };
    }
    if (!requested && (!boot || head.sha === boot)) {
      // Not while a check runs: that tick still uses `pending`, and re-runs
      // the decision afterwards, which clears it then.
      if (pending && !checking) {
        log(`[code-update] HEAD is back on ${short(boot)}; the pending restart is off`);
        pending = null;
      }
      return { action: 'none', reason: 'unchanged' };
    }
    const t = now();
    // Nothing is being deployed for a requested restart: no settle wait.
    if (!requested && t - head.at < settleMs) return { action: 'settling', sha: head.sha };
    if (requested ? head.sha === requestRefused : head.sha === refused) return { action: 'refused', sha: head.sha, error: requested?.error };
    if (checking) return { action: 'checking', sha: head.sha };

    // `recheck` is set once a new request arrives: the installed tree may
    // have changed without HEAD moving, so the earlier preflight no longer
    // vouches for it.
    if (!pending || pending.sha !== head.sha || recheck) {
      const gen = requestGen;
      checking = preflight();
      let result;
      try { result = await checking; } catch (e) { result = { ok: false, error: e?.message || String(e) }; } finally { checking = null; }
      // The request was replaced or withdrawn during the check: drop this
      // result. The next tick checks again for whatever stands now (a new
      // request, or an update that is eligible on its own).
      if (gen !== requestGen) return { action: 'superseded', sha: head.sha };
      // HEAD moved while the check ran: the result does not cover the new
      // revision, so the next tick checks that one.
      if (readHead()?.sha !== head.sha) return { action: 'superseded', sha: head.sha };
      if (!result || !result.ok) {
        pending = null;
        if (requested) {
          requestRefused = head.sha;
          requested.error = result?.error || 'unknown error';
          warn(`[code-update] bridge restart requested (${requested.reason}) but ${short(head.sha)} failed its preflight — NOT restarting; the request stays pending: ${requested.error}`);
        } else {
          refused = head.sha;
          warn(`[code-update] new code on disk (${short(head.sha)}, running ${short(boot)}) failed its preflight — NOT restarting onto it: ${result?.error || 'unknown error'}`);
        }
        return { action: 'refused', sha: head.sha, error: result?.error };
      }
      if (requested) requested.error = null;
      // A re-check of the same revision keeps how long it has waited.
      recheck = false;
      if (pending?.sha !== head.sha) pending = { sha: head.sha, since: now(), warnedAt: now() };
      const until = forceAfterMs > 0 ? `, forced after ${mins(forceAfterMs)} min` : ', subject to the work-hold age cap';
      if (requested) log(`[code-update] bridge restart requested by ${requested.by} (${requested.reason}) onto ${short(head.sha)}. Restarting when no session has work in flight${until}.`);
      else log(`[code-update] new code on disk: ${short(head.sha)} (running ${short(boot)}). Restarting when no session has work in flight${until}.`);
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
        warn(`[code-update] still waiting to restart onto ${short(head.sha)}${requested ? ` (bridge restart requested: ${requested.reason})` : ''}: ${busy} session(s) with work in flight (a turn, background job or subagent) for ${mins(waitedMs)} min; work holds are age-capped`);
      }
      return { action: 'waiting', sha: head.sha, busy, waitedMs };
    }
    const genAtGate = requestGen;
    // A request made with force skips the gate (an operator's way past a gate
    // that is stuck or gone); sessions with work in flight still hold it.
    const useGate = !forced && gate && !requested?.force;
    if (useGate) {
      checking = (async () => {
        try { return (await gate()) || { hold: false }; } catch (e) { return { hold: false, error: e?.message || String(e) }; }
      })();
      let verdict;
      try { verdict = await checking; } finally { checking = null; }
      // A request made or withdrawn during the gate call: decide again.
      if (requestGen !== genAtGate) return tick();
      if (verdict.error && verdict.error !== lastGateError) warn(`[code-update] restart gate failed (${verdict.error}) — ${gateOnError === 'hold' ? 'holding the restart' : 'treating it as safe to restart'}`);
      lastGateError = verdict.error || null;
      // Fail closed (opt-in): a gate that could not answer is a hold.
      if (verdict.error && gateOnError === 'hold') verdict = { hold: true, reason: `gate error: ${verdict.error}`.slice(0, 200) };
      if (!verdict.hold) { pending.gateReason = null; pending.gateNoticed = false; }
      if (verdict.hold) {
        const t3 = now();
        pending.gateSince ??= t3;
        const heldMs = t3 - pending.gateSince;
        // Authoritative gate: tell someone once when the hold has gone on long.
        if ((gateMaxMs === 0 || gateOnError === 'hold') && !pending.gateNoticed
          && heldMs >= gateNoticeAfterMs) {
          pending.gateNoticed = true;
          try {
            notify(`The bridge restart onto ${short(head.sha)} has been held by the restart gate for ${mins(heldMs)} min (${verdict.reason}). Nothing restarts until the gate says go.${forceHint}`);
          } catch { /* a notice must never break the watcher */ }
        }
        // gateMaxMs 0: the hold never lapses.
        if (gateMaxMs === 0 || heldMs < gateMaxMs) {
          pending.gateReason = verdict.reason;
          if (heldMs === 0) log(`[code-update] restart gate holds the update onto ${short(head.sha)}: ${verdict.reason}`);
          if (t3 - pending.warnedAt >= warnEveryMs) {
            pending.warnedAt = t3;
            warn(`[code-update] still waiting to restart onto ${short(head.sha)}: held by the restart gate for ${mins(heldMs)} min (${verdict.reason}); ${gateMaxMs === 0 ? 'the hold never expires' : `the hold expires after ${mins(gateMaxMs)} min`}`);
          }
          return { action: 'waiting', sha: head.sha, busy, waitedMs, gate: verdict.reason };
        }
        warn(`[code-update] restart gate has held the update onto ${short(head.sha)} for ${mins(heldMs)} min (${verdict.reason}) — past the ${mins(gateMaxMs)} min cap, restarting anyway`);
      }
    }
    // The gate yielded: a turn may have started, HEAD may have moved, or a
    // restart request may have been made or withdrawn meanwhile. Re-run the
    // whole decision (no gate call is made while work holds) rather than act
    // on a stale count, an unchecked revision or a cancelled request.
    if (useGate && (requestGen !== genAtGate || readHead()?.sha !== head.sha || busySessions() > 0)) return tick();
    const info = { sha: head.sha, forced, busy, waitedMs, ...(requested && { requested: { ...requested } }) };
    if (beforeRestart) {
      let ok;
      try { ok = beforeRestart(info) !== false; } catch (e) {
        ok = false;
        warn(`[code-update] restart onto ${short(head.sha)} not started: ${e?.message ?? e}`);
      }
      if (!ok) return { action: 'waiting', sha: head.sha, busy, waitedMs, reason: 'before-restart refused' };
    }
    restarted = true;
    if (forced) {
      warn(`[code-update] ${busy} session(s) still with work in flight after ${mins(waitedMs)} min (MATRON_CODE_UPDATE_FORCE_AFTER_MS) — restarting onto ${short(head.sha)} anyway; interrupted chats carry on at boot`);
    } else {
      log(`[code-update] no session has work in flight — ${requested ? 'bridge restart' : 'restarting'} onto ${short(head.sha)}`);
    }
    restart(info);
    return { action: 'restart', ...info };
  }

  return {
    tick,
    get bootSha() { return boot; },
    get pending() { return pending; },
    // True once the exit has been committed: the request can no longer be
    // withdrawn (fork).
    get restarting() { return restarted; },
    get requested() { return requested ? { ...requested } : null; },
    // Why the restart gate is holding the pending restart, from its latest
    // verdict; null when nothing is pending or the gate last said go. The
    // gate is only asked once no session holds work, so this is null before.
    get gateHoldReason() { return pending?.gateReason || null; },
    // Ask for a bridge restart. Asking again keeps the first time and
    // updates the reason and who asked. { ok: false } once the process is
    // already exiting.
    request({ reason, by, force = false } = {}) {
      if (restarted) return { ok: false, error: 'the bridge is already restarting' };
      const cleanReason = String(reason || 'requested').slice(0, 200);
      const cleanBy = String(by || 'operator').slice(0, 80);
      requested = { reason: cleanReason, by: cleanBy, at: requested?.at ?? now(), error: null, ...(force === true && { force: true }) };
      requestRefused = null;
      requestGen++;
      recheck = true;
      log(`[code-update] bridge restart requested by ${cleanBy}: ${cleanReason}${force === true ? ' (force: the restart gate is skipped for this request)' : ''}`);
      return { ok: true, requested: { ...requested } };
    },
    // Withdraw a bridge restart request. true if there was one.
    cancelRequest() {
      if (restarted || !requested) return false;
      log(`[code-update] bridge restart request cancelled (was: ${requested.reason})`);
      requested = null;
      requestRefused = null;
      requestGen++;
      // Only a request asks for the re-check; with none left, an update that
      // already passed its preflight need not run it again.
      recheck = false;
      return true;
    },
  };
}
