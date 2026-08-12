#!/usr/bin/env node
// Codex-viz PRODUCER SHIM (loop #616 / PR #177).
//
// Placed on the session PATH ahead of stock codex under the name `codex`, this
// shim intercepts non-interactive `codex exec` runs and populates the private
// sink the bridge CodexWatcher consumes: an atomic `codex-<runId>.meta.json`
// sidecar + a verbatim tee of stock `codex exec --json` stdout into
// `codex-<runId>.jsonl`. It changes NOTHING the caller sees — stdout is teed,
// not redirected — and is a pure passthrough for any non-`exec` subcommand or
// when MATRON_CODEX_SINK_DIR is unset.
//
// R500: the JSONL sink is verbatim stock stdout (may contain raw tool I/O), so
// meta + jsonl are created 0600 and the sink dir 0700 — a local single-principal
// artifact. Redaction stays at the bridge egress boundary (the watcher redacts
// every event before publish); the shim never redacts (avoids allowlist drift).
//
// The token below lets other modules recognise a copy of this shim without
// spawning it (see resolveRealCodex / detectProducer).
// codex-producer-shim sentinel: matron-codex-producer-shim-v1

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIM_SENTINEL_FLAG = '--matron-shim-check';
export const SHIM_SENTINEL_TOKEN = 'matron-codex-producer-shim-v1';

// Must stay identical to CODEX_RUN_ID_RE in lib/codex-convos.js — a drift here
// would mint runIds the watcher rejects, silently disabling the feature.
const CODEX_RUN_ID_RE = /^\d{13}-[1-9]\d{0,9}-[0-9a-f]{4}$/;

const DEFAULT_MAX_RUN_MS = 24 * 60 * 60 * 1000;
const SENTINEL_SNIFF_BYTES = 4096;

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isExecutableFile(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// A cheap, spawn-free "is this our shim?" check: sniff the file head for the
// sentinel token. Covers a second on-PATH copy of the shim at a different path.
function looksLikeShim(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(SENTINEL_SNIFF_BYTES);
      const n = fs.readSync(fd, buf, 0, SENTINEL_SNIFF_BYTES, 0);
      return buf.subarray(0, n).includes(SHIM_SENTINEL_TOKEN);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// T-1.1: resolve the real (stock) codex binary NON-recursively. Never returns
// the shim itself. Order: (a) an absolute, executable, non-self, non-shim
// MATRON_CODEX_REAL_BIN; else (b) the first PATH `codex` that is not in the
// shim's own dir, not the shim path, and not a shim copy.
export function resolveRealCodex({ env = process.env, self = process.argv[1] } = {}) {
  const selfReal = self ? safeRealpath(self) : null;
  const selfDir = selfReal ? path.dirname(selfReal) : null;

  const explicit = env.MATRON_CODEX_REAL_BIN;
  if (typeof explicit === 'string' && explicit && path.isAbsolute(explicit)) {
    const real = safeRealpath(explicit);
    if (real && real !== selfReal && isExecutableFile(real) && !looksLikeShim(real)) {
      return real;
    }
    // else: points back at the shim / missing → treat as unset, fall to (b).
  }

  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'codex');
    const real = safeRealpath(candidate);
    if (!real) continue;
    if (selfDir && path.dirname(real) === selfDir) continue;
    if (real === selfReal) continue;
    if (looksLikeShim(real)) continue;
    if (isExecutableFile(real)) return real;
  }
  return null;
}

// T-1.2: mint <epoch_ms>-<pid>-<4 hex>, asserting the watcher's contract.
export function mintRunId({ pid = process.pid, now = Date.now } = {}) {
  const runId = `${now()}-${pid}-${crypto.randomBytes(2).toString('hex')}`;
  if (!CODEX_RUN_ID_RE.test(runId)) {
    throw new Error(`[codex-shim] minted runId violates the watcher contract: ${runId}`);
  }
  return runId;
}

// Both resolve probes run the resolved binary synchronously ON the bridge's
// startup path, so they must be bounded: a hung `codex` would otherwise stall
// the shim before it spawns anything, and a verbose one could blow the default
// stdout buffer (ENOBUFS) and get misread as "no JSON flag". Bound both by time
// and buffer, and surface a spawn-level error (timeout / ENOBUFS) as a distinct
// loud failure rather than letting it fall through to the not-found paths.
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 1024 * 1024;

function runProbe(runner, realbin, args) {
  const res = runner(realbin, args, {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER,
  });
  if (res.error) {
    const error = new Error(`[codex-shim] probe '${realbin} ${args.join(' ')}' failed: ${res.error.message}`);
    error.code = 'PROBE_FAILED';
    throw error;
  }
  return `${res.stdout || ''}${res.stderr || ''}`;
}

// T-1.2: resolve the JSON event-stream flag against the resolved binary; fail
// loud rather than launch a run that produces no transcript.
export function resolveJsonFlag(realbin, { runner = spawnSync } = {}) {
  const text = runProbe(runner, realbin, ['exec', '--help']);
  if (/(^|\s)--json(\s|$|=)/.test(text)) return '--json';
  if (/(^|\s)--experimental-json(\s|$|=)/.test(text)) return '--experimental-json';
  const error = new Error('[codex-shim] resolved codex has no JSON event stream');
  error.code = 'NO_JSON_FLAG';
  throw error;
}

// T-1.2: schemaVersion string 'codex-cli X.Y.Z' from `<realbin> --version`.
export function resolveSchemaVersion(realbin, { runner = spawnSync } = {}) {
  const text = runProbe(runner, realbin, ['--version']);
  const match = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!match) {
    const error = new Error('[codex-shim] codex --version did not yield "codex-cli X.Y.Z"');
    error.code = 'NO_SCHEMA_VERSION';
    throw error;
  }
  return `codex-cli ${match[1]}`;
}

// Linux: /proc/self/stat field 22 (starttime), the exact value isWrapperAlive
// compares (field index 19 after the last ')'-split). Non-linux: a best-effort
// non-empty token (the non-linux liveness path ignores it — F2).
export function readStartTicks({ platform = process.platform, pid = process.pid } = {}) {
  if (platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ticks = after[19];
      if (ticks !== undefined && ticks.length > 0) return ticks;
    } catch { /* fall through to the platform token */ }
  }
  return `nonlinux-${Date.now()}`;
}

export function ensureSinkDir(sinkDir, { mkdirSync = fs.mkdirSync, chmodSync = fs.chmodSync } = {}) {
  mkdirSync(sinkDir, { recursive: true, mode: 0o700 });
  // A pre-existing dir keeps its old mode after mkdir(recursive); pin 0700.
  try { chmodSync(sinkDir, 0o700); } catch { /* best-effort; viz is optional */ }
}

// T-1.3: atomic meta write (tmp-in-same-dir + fsync + fchmod 0600 + rename +
// dir fsync). Mirrors codex_meta_write.py._write_atomic, plus the chmod G4
// showed missing there.
export function writeMetaAtomic(sinkDir, runId, obj) {
  const finalPath = path.join(sinkDir, `codex-${runId}.meta.json`);
  const tmpPath = path.join(
    sinkDir, `codex-${runId}.meta.json.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closing */ }
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmpPath, finalPath);
  let dirFd;
  try { dirFd = fs.openSync(sinkDir, fs.constants.O_RDONLY); fs.fsyncSync(dirFd); }
  catch { /* dir fsync is best-effort */ }
  finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
  return finalPath;
}

function buildInitialMeta({ runId, env, platform, now }) {
  const meta = {
    runId,
    wrapperPid: process.pid,
    wrapperStartTicks: readStartTicks({ platform }),
    deadlineTs: now() + resolveMaxRunMs(env),
  };
  if (typeof env.MATRON_CODEX_LABEL === 'string' && env.MATRON_CODEX_LABEL) {
    meta.label = env.MATRON_CODEX_LABEL;
  }
  return meta;
}

function resolveMaxRunMs(env) {
  const raw = Number(env.MATRON_CODEX_MAX_RUN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RUN_MS;
}

// Non-producer path (non-`exec` subcommand, or no sink configured). It must own
// the child's process group and forward catchable signals exactly like
// runProducer: with the shim on PATH, the bridge's own Codex backend runs
// through here, and an interrupt mid-turn (`session.codex.interrupt('SIGINT')`)
// otherwise kills the shim only — the real `codex` keeps the inherited stdio and
// the turn wedges until the orphan exits. Resolve on 'close' (all stdio ended),
// not 'exit'.
function passthrough(realbin, args, { spawnFn, env }) {
  return new Promise(resolve => {
    const child = spawnFn(realbin, args, {
      stdio: 'inherit',
      detached: true, // lead its own process group so we can signal the subtree
      // TRADEOFF: detached (POSIX setsid) puts the child in its own session with
      // NO controlling terminal. For the piped `codex exec` producer path this is
      // irrelevant (non-interactive, no TUI). But a genuinely interactive `codex`
      // TUI reaching this passthrough won't receive kernel-delivered SIGWINCH on
      // terminal resize (SIGWINCH is delivered to the controlling terminal's
      // foreground process group, which the detached child has left), so its
      // layout won't reflow until the next redraw. Accepted: owning the process
      // group is required to forward SIGINT/SIGTERM/SIGHUP to the whole subtree
      // (an un-forwarded interrupt wedges the turn), and the interactive-TUI-
      // through-the-shim case is not a path the bridge drives.
      env,
    });

    let signalled = null;
    const onSignal = sig => {
      signalled = sig;
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* child already gone */ } }
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) process.on(sig, onSignal);
    const cleanupSignals = () => { for (const sig of signals) process.removeListener(sig, onSignal); };

    child.on('error', () => { cleanupSignals(); resolve(127); });
    child.on('close', (code, signal) => {
      cleanupSignals();
      const term = signal || signalled;
      resolve(term ? 128 + osSignalNumber(term) : (code ?? 0));
    });
  });
}

function osSignalNumber(signal) {
  const table = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 };
  return table[signal] ?? 0;
}

// T-1.4/T-1.5: producer path. Writes the meta BEFORE spawning, tees child
// stdout verbatim into the 0600 JSONL sink while forwarding it unchanged to the
// caller, owns the child's process group, forwards catchable signals, reaps the
// child, and re-writes the terminal meta (exitCode, or an interrupted marker).
async function runProducer(realbin, argv, ctx) {
  const { env, sinkDir, stdout, stderr, spawnFn, syncRunner, platform, now } = ctx;

  let jsonFlag;
  let schemaVersion;
  try {
    jsonFlag = resolveJsonFlag(realbin, { runner: syncRunner });
    schemaVersion = resolveSchemaVersion(realbin, { runner: syncRunner });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  const runId = mintRunId({ now });
  ensureSinkDir(sinkDir);
  const meta = buildInitialMeta({ runId, env, platform, now });
  meta.schemaVersion = schemaVersion;
  writeMetaAtomic(sinkDir, runId, meta);

  const jsonlPath = path.join(sinkDir, `codex-${runId}.jsonl`);
  const jsonlFd = fs.openSync(jsonlPath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND, 0o600);

  // exec <jsonFlag> <original exec args...> (argv[0] === 'exec').
  // Insert the JSON flag only when the caller didn't already pass one: on
  // argv shapes like `exec resume --json <id>` an unconditional prepend both
  // duplicates the flag and misplaces it ahead of the `resume` subcommand.
  const rest = argv.slice(1);
  const hasJsonFlag = rest.some(a => a === jsonFlag || a === '--json' || a === '--experimental-json');
  const childArgs = hasJsonFlag ? ['exec', ...rest] : ['exec', jsonFlag, ...rest];
  const child = spawnFn(realbin, childArgs, {
    stdio: ['inherit', 'pipe', 'inherit'],
    detached: true, // lead its own process group so we can signal the subtree
    env,
  });

  let settled = false;
  const finish = (resolve, code) => {
    if (settled) return;
    settled = true;
    try { fs.closeSync(jsonlFd); } catch { /* already closed */ }
    resolve(code);
  };

  return new Promise(resolve => {
    // An EPIPE on either pipe (the caller closed the read end mid-turn) would
    // otherwise surface as an uncaught 'error' and kill the shim before the
    // terminal meta is written. Note the write below is guarded by try/catch, but
    // a stream write error is delivered ASYNCHRONOUSLY via 'error', not thrown
    // synchronously — so the guard alone is insufficient. Listen on BOTH the
    // child's stdout and the caller's stdout; 'close' still settles the run.
    child.stdout.on('error', () => {});
    if (typeof stdout.on === 'function') stdout.on('error', () => {});
    child.stdout.on('data', chunk => {
      // Verbatim tee: JSONL sink (append) + caller stdout, byte-identical.
      try { fs.writeSync(jsonlFd, chunk); } catch { /* sink loss must not break the run */ }
      try { stdout.write(chunk); } catch { /* caller stdout gone; sink already has it */ }
    });

    let signalled = null;
    const onSignal = sig => {
      signalled = sig;
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* child already gone */ } }
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) process.on(sig, onSignal);
    const cleanupSignals = () => { for (const sig of signals) process.removeListener(sig, onSignal); };

    child.on('error', error => {
      cleanupSignals();
      stderr.write(`[codex-shim] failed to spawn codex: ${error.message}\n`);
      try { writeMetaAtomic(sinkDir, runId, { ...meta, interrupted: true }); } catch { /* best-effort */ }
      finish(resolve, 127);
    });

    // 'close' (not 'exit'): 'exit' can fire while child.stdout is still open —
    // e.g. a descendant inherited the pipe — and later tee'd chunks would then
    // reach stdout.write() after finish() closed the sink fd, diverging the sink
    // from the caller's stdout. 'close' fires only once all stdio has ended.
    child.on('close', (code, signal) => {
      cleanupSignals();
      const terminal = { ...meta };
      if (signal || signalled) {
        terminal.interrupted = true; // no exitCode → watcher terminalizes via liveness/deadline
      } else {
        terminal.exitCode = code ?? 0;
      }
      try { writeMetaAtomic(sinkDir, runId, terminal); }
      catch (error) { stderr.write(`[codex-shim] terminal meta write failed: ${error.message}\n`); }
      const exitCode = (signal || signalled)
        ? 128 + osSignalNumber(signal || signalled)
        : (code ?? 0);
      finish(resolve, exitCode);
    });
  });
}

// T-1.2 passthrough gate + orchestration. argv = process.argv.slice(2).
export async function runShim(argv, {
  env = process.env,
  self = process.argv[1],
  stdout = process.stdout,
  stderr = process.stderr,
  spawnFn = spawn,
  syncRunner = spawnSync,
  platform = process.platform,
  now = Date.now,
} = {}) {
  if (argv[0] === SHIM_SENTINEL_FLAG) {
    stdout.write(`${SHIM_SENTINEL_TOKEN}\n`);
    return 0;
  }

  const realbin = resolveRealCodex({ env, self });
  if (!realbin) {
    stderr.write('[codex-shim] no real codex resolvable (set MATRON_CODEX_REAL_BIN)\n');
    return 127;
  }

  const sinkDir = env.MATRON_CODEX_SINK_DIR;
  const isExec = argv[0] === 'exec';
  // Pure passthrough: non-exec subcommand or no sink configured → zero change.
  if (!sinkDir || !isExec) {
    return passthrough(realbin, argv, { spawnFn, env });
  }

  return runProducer(realbin, argv, { env, sinkDir, stdout, stderr, spawnFn, syncRunner, platform, now });
}

// CLI entrypoint (only when executed directly, not when imported by tests).
const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === safeRealpath(process.argv[1]); }
  catch { return false; }
})();

if (isMain) {
  // Set exitCode and let the event loop drain rather than process.exit(): with a
  // piped stdout Node flushes asynchronously, and process.exit() would terminate
  // before that queue drains, dropping the final teed bytes even though the
  // synchronous JSONL sink kept them. The shim holds no handles after finish()
  // closes the sink fd, so the process exits on its own once stdout drains.
  runShim(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      try { process.stderr.write(`[codex-shim] fatal: ${error?.message ?? error}\n`); } catch { /* noop */ }
      process.exitCode = 1;
    });
}
