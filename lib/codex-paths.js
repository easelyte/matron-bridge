import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRealCodex } from '../bin/codex-producer.mjs';

// The bridge-shipped producer shim launcher, resolved once. detectProducer
// compares each on-PATH `codex` realpath against this to recognise the shim.
export const SHIPPED_SHIM_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shim',
);
const SHIPPED_SHIM_PATH = path.join(SHIPPED_SHIM_DIR, 'codex');

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// The distinct "an external wrapper is the producer" signal. An external
// integration whose own codex launcher is a redaction-aware producer sets
// MATRON_CODEX_PRODUCER=wrapper to declare it. This is DELIBERATELY separate
// from MATRON_CODEX_REAL_BIN: the shim's own error text tells operators to set
// REAL_BIN so the shim can resolve the real codex (a shim-only deployment where
// stock codex isn't on PATH), so REAL_BIN being set does NOT mean a wrapper is
// producing. Keying the guard on REAL_BIN regressed that documented shim-only
// config into a silent empty view — the watcher started (REAL_BIN "looked like" a
// producer) while the shim PATH-prepend was suppressed, so nothing produced.
// detectProducer and configureCodexSinkEnv MUST share this one predicate so they
// can never disagree on whether the shim should be deployed.
function wrapperIsProducer(env) {
  return env.MATRON_CODEX_PRODUCER === 'wrapper';
}

// T-1.6: is there an event PRODUCER for the sessions this bridge launches?
// A producer exists when EITHER (return true on first match):
//   1. MATRON_CODEX_PRODUCER=wrapper — an external wrapper (an integration's
//      own redaction-aware codex launcher) has declared itself the producer.
//      The shim is deliberately NOT deployed in this mode (see
//      configureCodexSinkEnv), so the wrapper is the sole producer. This is the
//      key correctness point: the wrapper deployment (shim dir unset) has a valid
//      producer and MUST NOT be treated as "no producer".
//   2. `codex` resolves on env.PATH to the bridge shim (realpath equals the
//      shipped shim launcher) — the deployment half of the guard, or an operator
//      who put the shim on PATH by hand.
// Only when NEITHER holds (bare stock codex on PATH, no wrapper signal, no shim)
// is there truly no producer — the silent-empty-view condition.
export function detectProducer({ env = process.env, shimPath = SHIPPED_SHIM_PATH } = {}) {
  // A declared wrapper is the producer — the shim is not deployed alongside it.
  if (wrapperIsProducer(env)) {
    return true;
  }
  const shimReal = safeRealpath(shimPath);
  if (shimReal) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      if (safeRealpath(path.join(dir, 'codex')) === shimReal) return true;
    }
  }
  return false;
}

// Can this box start a Codex session at all? The bridge spawns a bare `codex`
// from its own PATH (lib/codex-app-session.js, lib/codex-session.js), so that
// is what is checked — the shipped viz shim excluded, because a shim with no
// real codex behind it forwards to nothing. This is a DIFFERENT question from
// the producer guard above (detectProducer keys on the MATRON_CODEX_PRODUCER=wrapper
// signal, never on MATRON_CODEX_REAL_BIN). It reuses the shim's own
// resolveRealCodex rather than an inline copy, so the bridge and the shim cannot
// disagree about what counts as a real codex: MATRON_CODEX_REAL_BIN only when it
// is absolute and resolves to an executable regular file that is not the shim,
// otherwise the first executable, non-shim `codex` on PATH. Feeds the New Chat
// agent switch: a box that answers false is offered as Claude-only rather than
// with a Codex option that can only ever spawn ENOENT.
export function detectCodexBinary({ env = process.env, shimPath = SHIPPED_SHIM_PATH, resolve = resolveRealCodex } = {}) {
  return resolve({ env, self: shimPath }) !== null;
}

// The codex-viz sink dir. It MUST live outside Claude Code's managed
// `~/.claude/projects/<encoded-cwd>/<sessionId>/` tree.
//
// Root cause: the sink used to be a sibling of the session's `subagents/` dir
// under the encoded-cwd project tree. When a session changes its cwd mid-flight
// — most commonly `EnterWorktree`, which moves the session from its launch dir
// into a `.../.claude/worktrees/<name>` checkout — Claude Code RE-HOMES the whole
// `projects/<encoded-cwd>/<sessionId>/` directory to the new cwd's encoding,
// carrying `codex-runs/` with it. But `MATRON_CODEX_SINK_DIR`
// is frozen in the child's environment at spawn time and cannot be updated in a
// running process, so the producer (codex_execute.sh) keeps writing to the old,
// now-vanished path and fails with "[codex-viz] meta write failed; viz off" —
// no sink lands where the watcher looks, no card renders.
//
// Anchoring the sink to the sessionId alone (never the cwd) makes producer-write
// == watcher-watch by construction and immune to any post-spawn cwd change:
// sessionIds are globally unique, so per-session isolation is preserved without
// the volatile encoded-cwd component. `workdir` is retained in the signature for
// call-site compatibility but is deliberately no longer part of the path.
export function codexRunsDirFor(workdir, sessionId) {
  // sessionId is a single path segment under the sinks root. Reject traversal /
  // separators / NUL so a `..` can't escape the root (session ids are UUIDs; an
  // absolute-looking segment stays under the root via path.join, so only these
  // matter). Throwing is safe: the watcher-setup + sink-env paths catch it.
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === '.' || sessionId === '..'
    || /[/\\\0]/.test(sessionId) || sessionId.includes('..')) {
    throw new Error(`[codex-paths] unsafe sessionId: ${JSON.stringify(sessionId)}`);
  }
  return path.join(os.homedir(), '.claude', 'matron', 'codex-sinks', sessionId, 'codex-runs') + path.sep;
}

// The root under which per-session sink dirs live. Exposed for retention.
export function codexSinksRoot() {
  return path.join(os.homedir(), '.claude', 'matron', 'codex-sinks');
}

const DEFAULT_SINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The newest activity mtime for a session sink dir. The `<sessionId>` dir mtime
// tracks CREATION, not last activity: producer writes land in
// `<sessionId>/codex-runs/`, so appends/new runs update the `codex-runs` subdir
// (and the files under it), never the parent session dir. Keying retention off
// the parent mtime would prune a long-lived-but-active session by age-since-
// start. Read through to the actual sink instead: the max of the session dir,
// its `codex-runs` subdir, and the newest entry under it. Best-effort — any
// stat/readdir failure is swallowed and the values gathered so far stand.
function newestSinkMtimeMs(sessionDir, fsImpl) {
  let newest = -Infinity;
  const consider = p => {
    try {
      const st = fsImpl.statSync(p);
      if (typeof st.mtimeMs === 'number' && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* best-effort; a missing/racing entry is ignored */ }
  };
  // Session dir itself — the creation-time floor and the fallback when the
  // session has no runs yet.
  consider(sessionDir);
  const runsDir = path.join(sessionDir, 'codex-runs');
  consider(runsDir);
  try {
    for (const entry of fsImpl.readdirSync(runsDir)) {
      const name = typeof entry === 'string' ? entry : entry.name;
      consider(path.join(runsDir, name));
    }
  } catch { /* codex-runs absent yet — the session-dir mtime stands */ }
  return newest === -Infinity ? null : newest;
}

// Best-effort retention sweep. The sink tree now lives OUTSIDE Claude Code's
// managed `projects/<cwd>/<sessionId>/` tree, so its unredacted codex JSONL is
// no longer pruned by Claude Code — it would otherwise accumulate forever.
// Removes per-session sink dirs whose newest activity mtime (see
// newestSinkMtimeMs) is older than the retention window. Never throws (viz + its
// cleanup are both optional).
export function pruneStaleCodexSinks({
  now = Date.now,
  maxAgeMs = Number(process.env.MATRON_CODEX_SINK_RETENTION_MS),
  root = codexSinksRoot(),
  fsImpl = fs,
  warn = console.warn,
} = {}) {
  // Accept only a finite, positive window. A negative/NaN/zero value (e.g.
  // MATRON_CODEX_SINK_RETENTION_MS=-1, which is truthy) would otherwise push the
  // cutoff into the FUTURE and delete every sink dir — including another bridge's
  // live transcript sources under the same OS user. Fall back to the default.
  const window = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_SINK_RETENTION_MS;
  let removed = 0;
  try {
    const cutoff = now() - window;
    let entries;
    try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); }
    catch { return 0; } // no sink root yet — nothing to prune
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        const mtime = newestSinkMtimeMs(dir, fsImpl);
        // A dir we can't stat at all (null) is left alone rather than removed.
        if (mtime === null || mtime >= cutoff) continue;
        fsImpl.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* skip an unreadable/racing dir */ }
    }
  } catch (error) {
    try { warn(`[codex-viz] sink retention sweep failed: ${error.message}`); } catch { /* noop */ }
  }
  return removed;
}

// Prepend the shipped shim dir to a PATH string, idempotently. Placing it first
// makes the spawned session's bare `codex` resolve to the redaction-aware
// producer shim (which then forwards to the real codex found later on PATH),
// so the live view has an actual producer — the deployment half of the
// activation guard. Only used in shim-producer mode; see configureCodexSinkEnv
// for why it must NOT run when a wrapper-producer (MATRON_CODEX_PRODUCER=wrapper)
// is deployed.
function prependShimToPath(existingPath) {
  const parts = String(existingPath || '').split(path.delimiter).filter(Boolean);
  if (parts[0] === SHIPPED_SHIM_DIR) return existingPath || SHIPPED_SHIM_DIR;
  return [SHIPPED_SHIM_DIR, ...parts].join(path.delimiter);
}

export function configureCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  env = process.env,
  mkdirSync = fs.mkdirSync,
  chmodSync = fs.chmodSync,
  warn = console.warn,
}) {
  try {
    if (env.MATRON_CODEX_VIZ === '1') {
      const dir = codexRunsDirFor(workdir, sessionId);
      // 0700: the sink holds unredacted codex JSONL; the bridge creates it
      // before any producer runs, so pin the mode here too (mkdir recursive
      // leaves a pre-existing dir's mode untouched — chmod to be sure).
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* best-effort; viz is optional */ }
      spawnEnv.MATRON_CODEX_SINK_DIR = dir;
      // Deploy the producer: the launched session must find the shim on PATH —
      // BUT NOT when an external wrapper is the declared producer
      // (MATRON_CODEX_PRODUCER=wrapper). There the wrapper is the sole producer,
      // and its own internal bare `codex exec` calls MUST resolve to the real
      // codex, not the shim. If the shim is prepended too, the wrapper's bare
      // `codex` resolves to the shim, which produces a SECOND card for the same
      // run (byte-identical duplicate + a phantom judge-pass card) — the
      // dual-producer bug. Enforce the either/or invariant detectProducer
      // documents: wrapper XOR shim, never both. Gate on the SAME predicate as
      // detectProducer (the distinct wrapper signal, NOT MATRON_CODEX_REAL_BIN —
      // which the shim itself uses to find the real codex, so a shim-only
      // deployment sets it too) so the watcher and the deployment can never
      // disagree. Keying this on REAL_BIN suppressed the shim in that documented
      // shim-only config while detectProducer still reported a producer — the
      // silent empty view this guard exists to prevent.
      if (!wrapperIsProducer(env)) {
        spawnEnv.PATH = prependShimToPath(spawnEnv.PATH ?? env.PATH);
      }
      return dir;
    }
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
  } catch (error) {
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
    try {
      warn(`[codex-viz] sink dir setup failed, viz disabled for this session: ${error.message}`);
    } catch { /* logging must never block the shared session spawn path */ }
  }
  return null;
}

export function launchWithCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  launch,
  configureOptions = {},
}) {
  configureCodexSinkEnv({
    ...configureOptions,
    spawnEnv,
    workdir,
    sessionId,
  });
  return launch(spawnEnv);
}

// Best-effort teardown of a single session's codex-viz sink dir (easelyte fork delta, #632). The sink
// tree lives OUTSIDE Claude Code's managed project dirs (see codexRunsDirFor's
// header), so per-session dirs otherwise linger until the boot-time age-based
// sweep (pruneStaleCodexSinks, which stays as the backstop). Removing the whole
// `<sessionId>` PARENT dir (not just its `codex-runs` child) on session teardown
// reclaims it promptly. Mirrors the swallow-all style of pruneStaleCodexSinks:
// never throws — viz and its cleanup are both optional, and an absent dir is a
// no-op under rmSync's force:true. The traversal guard matches codexRunsDirFor
// so a crafted sessionId can't rm outside the sinks root; a rejected id is a
// silent no-op rather than a throw.
export function removeCodexSinkForSession(sessionId, { root = codexSinksRoot(), fsImpl = fs } = {}) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId === '.' || sessionId === '..'
      || /[/\\\0]/.test(sessionId) || sessionId.includes('..')) {
      return;
    }
    fsImpl.rmSync(path.join(root, sessionId), { recursive: true, force: true });
  } catch { /* best-effort; teardown cleanup must never throw */ }
}
