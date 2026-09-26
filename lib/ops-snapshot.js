// `ops_snapshot` agent RPC backend (loop #542 phase B, wire contract §2): the
// Matron web Ops page asks a box for one section at a time over the existing
// client -> journal -> agent relay. Read-only by construction — nothing here
// writes, signals, or accepts any parameter beyond the section name.
//
//   host                         computed here from Linux /proc (§2.1)
//   timers|alerts|usage|posture  MATRON_OPS_SNAPSHOT_CMD --section <s> (§2.2)
//
// Every successful result is wrapped in {section, generated_at_ms, truncated,
// data} and held to OPS_RESULT_MAX_BYTES of JSON (the relay's frame cap is
// 16 KiB whole-frame), trimming trailing array elements when needed.
//
// All I/O is injectable; index.js wires the real fs/spawn, tests stub them.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripJournalCreds } from './journal-cred-scope.js';

export const OPS_SECTIONS = ['host', 'timers', 'alerts', 'usage', 'posture'];
const EXTRAS_SECTIONS = new Set(['timers', 'alerts', 'usage', 'posture']);
export const OPS_RESULT_MAX_BYTES = 12_000;
export const OPS_CMD_TIMEOUT_MS = 10_000;
export const OPS_CMD_STDOUT_MAX = 256 * 1024;
export const OPS_CACHE_MS = 15_000;
const CPU_SAMPLE_MS = 300;
const PROCESS_LIMIT = 12;
const SMALL_RSS_BYTES = 5 * 1024 * 1024;
const NAME_MAX = 48;
const CMDLINE_READ_MAX = 4096;

export class OpsError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Process naming. argv routinely carries secrets (tokens in flags, whole
// prompts, `bash -c` scripts), so a name is NEVER the command line: the
// argv0 basename, plus — for interpreters only — the basename of the script
// they run. Inline-code flags stop the scan outright.

const INTERPRETER = /^(node|nodejs|python[0-9.]*|bash|sh|dash|zsh|bun|deno)$/;
// Flags whose argument is inline program text, per interpreter family. Once
// one appears the scan stops: whatever follows is code, not a script path.
// (Shell `-e` is errexit and python `-u` is unbuffered — harmless — so the
// sets differ per family.) A false positive only drops the script name.
function isInlineCodeFlag(base, a) {
  if (/^(bash|sh|dash|zsh)$/.test(base)) return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a);
  if (base.startsWith('python')) return /^-[a-zA-Z]*c/.test(a);
  return /^(-[a-zA-Z]*[ep][a-zA-Z]*|--eval(=.*)?|--print(=.*)?)$/.test(a);
}
const RUNNER_SUBCOMMANDS = new Set(['run']);

// eslint-disable-next-line no-control-regex
const stripControl = (s) => s.replace(/[\u0000-\u001f\u007f]/g, '');

function baseToken(s) {
  // setproctitle-style argv0 ("sshd: root@pts/0", "postgres: checkpointer")
  // is cut at the first space/colon so the decoration never ships.
  const first = String(s).split(/[\s:]/)[0];
  return stripControl(path.basename(first));
}

export function processName(argv, comm = null) {
  const args = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  const base = args.length > 0 && args[0] ? baseToken(args[0]) : '';
  if (!base) {
    const fallback = typeof comm === 'string' && comm ? stripControl(comm) : '?';
    return fallback.slice(0, NAME_MAX) || '?';
  }
  let name = base;
  if (INTERPRETER.test(base)) {
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (isInlineCodeFlag(base, a)) break;
      if (a.startsWith('-')) continue;
      if ((base === 'bun' || base === 'deno') && RUNNER_SUBCOMMANDS.has(a)) continue;
      // A script path has no '=' and no whitespace; anything else is data.
      if (a.includes('=') || /\s/.test(a) || !a) break;
      const script = stripControl(path.basename(a));
      if (script) name = `${base} ${script}`;
      break;
    }
  }
  return name.slice(0, NAME_MAX);
}

// No shell: the operator's MATRON_OPS_SNAPSHOT_CMD is split on whitespace and
// every token is a literal argv entry (paths with spaces are unsupported).
export function splitCommand(cmd) {
  if (typeof cmd !== 'string') return [];
  return cmd.trim().split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// /proc parsers (pure).

// Aggregate `cpu` line: user nice system idle iowait irq softirq steal.
// guest/guest_nice are already inside user/nice, so they are not re-added.
export function parseCpuLine(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const total = f.reduce((a, b) => a + b, 0);
  const idle = f[3] + (f[4] || 0);
  return { total, idle };
}

// /proc/<pid>/stat. comm is parenthesised and may itself contain spaces and
// parens, so split at the LAST ')'. utime/stime are fields 14/15, rss 24.
export function parseProcPidStat(text) {
  const s = String(text);
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const comm = s.slice(open + 1, close);
  const rest = s.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state); field N is rest[N - 3].
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (![utime, stime, rssPages].every(Number.isFinite)) return null;
  return { comm, ticks: utime + stime, rssPages };
}

export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

export function parsePasswd(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const f = line.split(':');
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    if (Number.isInteger(uid) && f[0]) map.set(uid, f[0]);
  }
  return map;
}

function parseStatus(text) {
  const s = String(text);
  const uid = s.match(/^Uid:\s+(\d+)/m);
  const rss = s.match(/^VmRSS:\s+(\d+)\s*kB/m);
  return { uid: uid ? Number(uid[1]) : null, rssBytes: rss ? Number(rss[1]) * 1024 : null };
}

// ---------------------------------------------------------------------------
// Host section (§2.1).

async function defaultReadText(file, maxBytes = null) {
  if (!maxBytes) return fsp.readFile(file, 'utf8');
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function defaultListPids() {
  const entries = await fsp.readdir('/proc');
  return entries.filter((e) => /^\d+$/.test(e));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sampleProcesses(pids, readText) {
  const out = new Map();
  await Promise.all(pids.map(async (pid) => {
    try {
      const st = parseProcPidStat(await readText(`/proc/${pid}/stat`));
      if (st) out.set(Number(pid), st);
    } catch { /* exited between listing and reading */ }
  }));
  return out;
}

export async function readHostSection({
  readText = defaultReadText,
  listPids = defaultListPids,
  sleep = defaultSleep,
  sampleMs = CPU_SAMPLE_MS,
  hostname = () => os.hostname(),
  cpuCores = () => os.cpus()?.length || 1,
  getDisk = () => null,
  getLiveSessions = () => 0,
  pageSize = 4096,
} = {}) {
  // Two-point sample local to THIS call: no module-global baseline, so
  // concurrent or back-to-back calls can never read each other's window.
  let cpu0;
  try { cpu0 = parseCpuLine(await readText('/proc/stat')); } catch { cpu0 = null; }
  if (!cpu0) throw new OpsError('unavailable', 'no /proc on this platform');
  const procs0 = await sampleProcesses(await listPids(), readText);
  await sleep(sampleMs);
  const cpu1 = parseCpuLine(await readText('/proc/stat'));
  const procs1 = await sampleProcesses(await listPids(), readText);
  if (!cpu1) throw new OpsError('unavailable', 'could not read /proc/stat');

  const cores = Math.max(1, Number(cpuCores()) || 1);
  const dTotal = cpu1.total - cpu0.total;
  const dIdle = cpu1.idle - cpu0.idle;
  const cpuPct = dTotal > 0 ? round1(Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))) : 0;

  const [uptimeText, loadText, memText, passwdText] = await Promise.all([
    readText('/proc/uptime').catch(() => ''),
    readText('/proc/loadavg').catch(() => ''),
    readText('/proc/meminfo').catch(() => ''),
    readText('/etc/passwd').catch(() => ''),
  ]);
  const uptime = Math.floor(Number(String(uptimeText).split(/\s+/)[0]));
  const load = String(loadText).trim().split(/\s+/).slice(0, 3).map(Number);
  const mem = parseMeminfo(memText);
  const users = parsePasswd(passwdText);

  // argv for every live process (bounded read: a Claude session's argv holds
  // its whole system prompt). Used ONLY for agent counts and processName —
  // raw argv never leaves this function.
  const argvByPid = new Map();
  await Promise.all([...procs1.keys()].map(async (pid) => {
    try {
      const raw = await readText(`/proc/${pid}/cmdline`, CMDLINE_READ_MAX);
      argvByPid.set(pid, String(raw).split('\0').filter((a, i, arr) => a !== '' || i < arr.length - 1));
    } catch { argvByPid.set(pid, []); }
  }));

  const agents = { claude: 0, codex: 0 };
  const rows = [];
  for (const [pid, st] of procs1) {
    const argv = argvByPid.get(pid) || [];
    const argv0 = argv[0] ? baseToken(argv[0]) : '';
    if (argv0 === 'claude') agents.claude += 1;
    else if (argv0 === 'codex') agents.codex += 1;
    const prev = procs0.get(pid);
    const dProc = prev ? Math.max(0, st.ticks - prev.ticks) : 0;
    // Per-process %, top-style (100 = one full core), over the same window.
    const pct = dTotal > 0 ? round1((dProc / dTotal) * cores * 100) : 0;
    rows.push({ pid, st, argv, rssEstimate: st.rssPages * pageSize, cpu_pct: pct });
  }
  const candidates = rows
    .filter((r) => !(r.rssEstimate < SMALL_RSS_BYTES && r.cpu_pct < 1))
    .sort((a, b) => b.rssEstimate - a.rssEstimate || a.pid - b.pid)
    .slice(0, PROCESS_LIMIT);
  const processes = await Promise.all(candidates.map(async (r) => {
    let status = { uid: null, rssBytes: null };
    try { status = parseStatus(await readText(`/proc/${r.pid}/status`)); } catch { /* exited */ }
    return {
      pid: r.pid,
      name: processName(r.argv, r.st.comm),
      rss_bytes: status.rssBytes ?? r.rssEstimate,
      cpu_pct: r.cpu_pct,
      user: status.uid !== null && users.has(status.uid) ? users.get(status.uid) : null,
    };
  }));
  processes.sort((a, b) => b.rss_bytes - a.rss_bytes || a.pid - b.pid);

  let disk;
  try { disk = getDisk() || null; } catch { disk = null; }
  let live;
  try {
    const n = getLiveSessions();
    live = Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { live = 0; }

  return {
    hostname: String(hostname()).slice(0, 200),
    cpu_cores: cores,
    uptime_s: Number.isFinite(uptime) ? uptime : 0,
    load: load.length === 3 && load.every(Number.isFinite) ? load : [0, 0, 0],
    cpu_pct: cpuPct,
    memory: { total_bytes: mem.MemTotal ?? 0, available_bytes: mem.MemAvailable ?? 0 },
    swap: { total_bytes: mem.SwapTotal ?? 0, free_bytes: mem.SwapFree ?? 0 },
    disk,
    agents,
    live_sessions: live,
    processes,
  };
}

// ---------------------------------------------------------------------------
// Extras sections (§2.2): run the son-of-anton script. No shell, journal
// credentials stripped from the child env, stderr discarded (never relayed),
// bounded by time and output size. Resolves to the `data` object.

export function runOpsCommand({
  argv, section, cwd, env = process.env, spawnImpl = spawn,
  timeoutMs = OPS_CMD_TIMEOUT_MS, maxBytes = OPS_CMD_STDOUT_MAX,
}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      reject(new OpsError('not_configured', 'MATRON_OPS_SNAPSHOT_CMD is not set'));
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    let child;
    try {
      child = spawnImpl(argv[0], [...argv.slice(1), '--section', section], {
        cwd, env: stripJournalCreds(env), shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(new OpsError('unavailable', 'command failed to start'));
      return;
    }
    const chunks = [];
    let bytes = 0;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    timer = setTimeout(() => { kill(); finish(new OpsError('unavailable', 'timed out')); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        kill();
        finish(new OpsError('unavailable', 'output too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on('error', () => finish(new OpsError('unavailable', 'command failed to start')));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new OpsError('unavailable', code === null ? `command killed (${signal || 'signal'})` : `command exited ${code}`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        finish(new OpsError('unavailable', 'invalid JSON'));
        return;
      }
      if (!isPlainObject(parsed) || parsed.section !== section || !isPlainObject(parsed.data)) {
        finish(new OpsError('unavailable', 'unexpected output shape'));
        return;
      }
      finish(null, parsed.data);
    });
  });
}

// ---------------------------------------------------------------------------
// Byte budget. Generic: while the JSON is over budget, find the longest
// array anywhere under `data` and drop trailing elements from it. Drops in
// proportion to the overshoot so a 256 KiB script output converges in a few
// passes instead of one element per re-serialisation.

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function longestArray(node, best = null) {
  if (Array.isArray(node)) {
    if (node.length > 0 && (!best || node.length > best.length)) best = node;
    for (const el of node) best = longestArray(el, best);
  } else if (isPlainObject(node)) {
    for (const v of Object.values(node)) best = longestArray(v, best);
  }
  return best;
}

export function fitToBudget(result, maxBytes = OPS_RESULT_MAX_BYTES) {
  let size = jsonBytes(result);
  if (size <= maxBytes) return result;
  const out = JSON.parse(JSON.stringify(result));
  out.truncated = true;
  size = jsonBytes(out);
  while (size > maxBytes) {
    const arr = longestArray(out.data);
    if (!arr) return null;
    const drop = Math.max(1, Math.floor(arr.length * ((size - maxBytes) / size)));
    arr.length = Math.max(0, arr.length - drop);
    size = jsonBytes(out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The RPC-facing entry point: (section) -> {ok:true, result} |
// {ok:false, error:{code, detail}}. Never throws. Successful results are
// cached per section for cacheMs (page reloads hit the cache); concurrent
// callers for one section share a single computation; failures are not
// cached, so a fixed script works on the next click.

export function createOpsSnapshot({
  command,
  cwd,
  env = process.env,
  readHost = () => readHostSection(),
  runCommand = runOpsCommand,
  spawnImpl = spawn,
  now = Date.now,
  cacheMs = OPS_CACHE_MS,
  maxBytes = OPS_RESULT_MAX_BYTES,
  log = console,
} = {}) {
  const argv = splitCommand(command);
  const cache = new Map(); // section -> { at, value } | { inflight }

  async function compute(section) {
    let data;
    try {
      if (section === 'host') {
        data = await readHost();
      } else {
        if (argv.length === 0) return { ok: false, error: { code: 'not_configured', detail: 'MATRON_OPS_SNAPSHOT_CMD is not set' } };
        data = await runCommand({ argv, section, cwd, env, spawnImpl });
      }
    } catch (e) {
      if (e instanceof OpsError) return { ok: false, error: { code: e.code, detail: e.detail } };
      log.warn?.(`[ops-snapshot] ${section} failed: ${e?.message ?? String(e)}`);
      return { ok: false, error: { code: 'unavailable', detail: 'snapshot failed' } };
    }
    const fitted = fitToBudget({ section, generated_at_ms: now(), truncated: false, data }, maxBytes);
    if (!fitted) return { ok: false, error: { code: 'too_large', detail: `result exceeds ${maxBytes} bytes` } };
    return { ok: true, result: fitted };
  }

  return async function opsSnapshot(section) {
    if (typeof section !== 'string' || !OPS_SECTIONS.includes(section)) {
      return { ok: false, error: { code: 'bad_request', detail: 'unknown section' } };
    }
    const hit = cache.get(section);
    if (hit?.inflight) return hit.inflight;
    if (hit && now() - hit.at < cacheMs) return hit.value;
    const inflight = compute(section).then((value) => {
      if (value.ok) cache.set(section, { at: now(), value });
      else cache.delete(section);
      return value;
    }, () => {
      cache.delete(section);
      return { ok: false, error: { code: 'unavailable', detail: 'snapshot failed' } };
    });
    cache.set(section, { inflight });
    return inflight;
  };
}

export { EXTRAS_SECTIONS };
