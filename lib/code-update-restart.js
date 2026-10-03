// Restart onto new code by itself — the fix for a bridge that never updates.
//
// A rollout (deploy.sh, yearbook-infra's update-bridges) pulls the new code
// onto disk and then DEFERS the restart whenever the bridge hosts a live
// agent session, because the restart kills that session's process. The
// deferral is "picks up on the next natural restart" — and a bridge whose
// session is nearly always live (the Coordinator's box) has no natural
// restart. On 2026-10-02 bev ran code from the morning all evening, with
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
//   * at the first poll where no session is mid-turn — an idle session is
//     killed and resumes with its history on its next turn, which is how a
//     bridge restart has always worked for it;
//   * NEVER while a turn is running. The first version forced the restart
//     after a 30 min cap; on 2026-10-03 that killed deploy-1's production
//     deploy shell mid-`cap` (exit 137). A turn is a turn — the watcher
//     waits, and warns every WARN_EVERY (30 min) that it is still waiting.
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
import { execFile } from 'node:child_process';
import { atomicWriteFileSync } from './atomic-write.js';

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

// A forced restart (FORCE_AFTER, opt-in) cuts turns off. Those chats carry on
// by themselves — no tap — when MATRON_CODE_UPDATE_AUTO_CARRY_ON is on
// (the default; Dan asked for it on 2026-10-02): the exiting process leaves
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
// anything: index.js parses, and the import chain (native bindings
// included — sharp was the one that bit) resolves. Resolves to
// { ok: true } or { ok: false, error }. Never throws.
export function defaultPreflight(checkoutDir, { exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  const run = (args) => new Promise(resolve => {
    try {
      exec(process.execPath, args, { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
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
    return run(['--input-type=module', '-e', "await import('sharp'); await import('./lib/inline-image.js')"]);
  })();
}

// The policy, as one object with a tick(). Deps:
//   readHead()      -> { sha, at } | null   (the newest HEAD reflog entry)
//   busySessions()  -> number of sessions mid-turn right now
//   preflight()     -> Promise<{ ok, error? }>
//   restart(info)   -> exit for the supervisor; info = { sha, forced, busy, waitedMs }
//                      (forced is only ever true with forceAfterMs > 0)
//   now()           -> ms
//   log / warn      -> console-ish
//   bootSha         -> the HEAD sha this process started on (default: read now)
export function createCodeUpdateWatcher({
  readHead,
  busySessions,
  preflight,
  restart,
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
      const until = forceAfterMs > 0 ? `, forced after ${mins(forceAfterMs)} min` : ', never mid-turn';
      log(`[code-update] new code on disk: ${short(head.sha)} (running ${short(boot)}). Restarting when no session is mid-turn${until}.`);
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
        warn(`[code-update] still waiting to restart onto ${short(head.sha)}: ${busy} session(s) mid-turn for ${mins(waitedMs)} min; a running turn is never cut off`);
      }
      return { action: 'waiting', sha: head.sha, busy, waitedMs };
    }
    restarted = true;
    const info = { sha: head.sha, forced, busy, waitedMs };
    if (forced) {
      warn(`[code-update] ${busy} session(s) still mid-turn after ${mins(waitedMs)} min (MATRON_CODE_UPDATE_FORCE_AFTER_MS) — restarting onto ${short(head.sha)} anyway; interrupted chats carry on at boot`);
    } else {
      log(`[code-update] no session mid-turn — restarting onto ${short(head.sha)}`);
    }
    restart(info);
    return { action: 'restart', ...info };
  }

  return {
    tick,
    get bootSha() { return boot; },
    get pending() { return pending; },
  };
}
