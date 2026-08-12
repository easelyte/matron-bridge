import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHIM_SENTINEL_TOKEN,
  mintRunId,
  resolveJsonFlag,
  resolveRealCodex,
  resolveSchemaVersion,
} from '../bin/codex-producer.mjs';
import { formatAndRoute } from '../lib/codex-event-format.js';

const SHIM = fileURLToPath(new URL('../bin/codex-producer.mjs', import.meta.url));
const RUN_ID_RE = /^\d{13}-[1-9]\d{0,9}-[0-9a-f]{4}$/;

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = 'codex-producer-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A fake stock codex: --version → codex-cli X.Y.Z; exec --help → advertises
// --json; exec → drains stdin and emits a canned stock-schema thread stream.
function writeFakeCodex(dir, { name = 'codex', version = '0.147.0', body } = {}) {
  const p = path.join(dir, name);
  const exec = body ?? [
    '  cat >/dev/null',
    "  printf '%s\\n' '{\"type\":\"thread.started\"}'",
    "  printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"i1\",\"type\":\"command_execution\",\"command\":\"echo hi\",\"aggregated_output\":\"hi\",\"exit_code\":0,\"status\":\"completed\"}}'",
    "  printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"i2\",\"type\":\"agent_message\",\"text\":\"OK\"}}'",
    "  printf '%s\\n' '{\"type\":\"turn.completed\"}'",
  ].join('\n');
  fs.writeFileSync(p, [
    '#!/usr/bin/env bash',
    `if [[ "$1" == "--version" ]]; then echo "codex-cli ${version}"; exit 0; fi`,
    'if [[ "$1" == "exec" && "$2" == "--help" ]]; then echo "  --json    Print events to stdout as JSONL"; exit 0; fi',
    'if [[ "$1" == "exec" ]]; then',
    exec,
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(p, 0o755);
  return p;
}

function runShimSubprocess(args, { env = {}, input = '' } = {}) {
  const res = spawnSync(process.execPath, [SHIM, ...args], {
    env: { PATH: process.env.PATH, ...env },
    input,
    encoding: 'utf8',
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('producer shim — resolveRealCodex (T-1.1 / T-6.3 recursion guard)', () => {
  function fixture() {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    fs.mkdirSync(path.join(dir, 'shim'));
    const real = writeFakeCodex(path.join(dir, 'real'));
    // A shim copy carries the sentinel token so it is recognised without spawning.
    const shim = path.join(dir, 'shim', 'codex');
    fs.writeFileSync(shim, `#!/usr/bin/env node\n// ${SHIM_SENTINEL_TOKEN}\n`);
    fs.chmodSync(shim, 0o755);
    return { dir, real, shim };
  }

  it('never selects the shim when a real codex is elsewhere on PATH', () => {
    const { dir, real, shim } = fixture();
    const resolved = resolveRealCodex({
      env: { PATH: `${path.join(dir, 'shim')}${path.delimiter}${path.join(dir, 'real')}` },
      self: shim,
    });
    expect(resolved).toBe(fs.realpathSync(real));
    expect(resolved).not.toBe(fs.realpathSync(shim));
  });

  it('honours an explicit absolute MATRON_CODEX_REAL_BIN', () => {
    const { real, shim } = fixture();
    const resolved = resolveRealCodex({
      env: { MATRON_CODEX_REAL_BIN: real, PATH: '' },
      self: shim,
    });
    expect(resolved).toBe(fs.realpathSync(real));
  });

  it('treats a MATRON_CODEX_REAL_BIN pointing back at the shim as unset', () => {
    const { dir, real, shim } = fixture();
    const resolved = resolveRealCodex({
      env: { MATRON_CODEX_REAL_BIN: shim, PATH: path.join(dir, 'real') },
      self: shim,
    });
    expect(resolved).toBe(fs.realpathSync(real)); // fell through to PATH, not the shim
  });

  it('returns null when no real codex is resolvable', () => {
    const { dir, shim } = fixture();
    expect(resolveRealCodex({ env: { PATH: path.join(dir, 'shim') }, self: shim })).toBeNull();
  });
});

describe('producer shim — pure helpers', () => {
  it('mints a runId matching the watcher contract', () => {
    expect(mintRunId()).toMatch(RUN_ID_RE);
  });

  it('resolves --json, then --experimental-json, else fails loud (T-1.2)', () => {
    const json = resolveJsonFlag('/bin/true', { runner: () => ({ stdout: '  --json  events', stderr: '' }) });
    expect(json).toBe('--json');
    const exp = resolveJsonFlag('/bin/true', { runner: () => ({ stdout: '  --experimental-json', stderr: '' }) });
    expect(exp).toBe('--experimental-json');
    expect(() => resolveJsonFlag('/bin/true', { runner: () => ({ stdout: 'no json here', stderr: '' }) }))
      .toThrow(/no JSON event stream/);
  });

  it('parses schemaVersion or fails loud', () => {
    expect(resolveSchemaVersion('/bin/true', { runner: () => ({ stdout: 'codex-cli 0.147.0\n', stderr: '' }) }))
      .toBe('codex-cli 0.147.0');
    expect(() => resolveSchemaVersion('/bin/true', { runner: () => ({ stdout: 'nope', stderr: '' }) }))
      .toThrow(/codex-cli X\.Y\.Z/);
  });
});

describe('producer shim — passthrough + fail-loud (T-6.3)', () => {
  it('is a byte-identical passthrough for a non-exec subcommand and writes no sidecars', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const real = writeFakeCodex(path.join(dir, 'real'), {
      body: 'true', // exec branch unused
    });
    const sink = path.join(dir, 'sink');
    fs.mkdirSync(sink);
    // `login` is not `exec` → passthrough even with a sink configured.
    const { code } = runShimSubprocess(['login'], {
      env: { MATRON_CODEX_REAL_BIN: real, MATRON_CODEX_SINK_DIR: sink },
    });
    expect(code).toBe(0);
    expect(fs.readdirSync(sink)).toEqual([]);
  });

  it('passes through exec when MATRON_CODEX_SINK_DIR is unset (no sidecars)', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const real = writeFakeCodex(path.join(dir, 'real'));
    const { code, stdout } = runShimSubprocess(['exec', '-'], {
      env: { MATRON_CODEX_REAL_BIN: real },
      input: 'hi\n',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('"type":"turn.completed"');
  });

  it('exits 127 with a loud stderr line when no real codex is resolvable', () => {
    const dir = makeDir();
    const { code, stderr } = runShimSubprocess(['exec', '-'], {
      env: { PATH: dir, MATRON_CODEX_REAL_BIN: '' },
      input: 'hi\n',
    });
    expect(code).toBe(127);
    expect(stderr).toMatch(/no real codex resolvable/);
  });
});

describe('producer shim — producer round-trip (T-6.1)', () => {
  it('writes a 0600 meta + 0600 jsonl (dir 0700), tees stdout verbatim, and the bytes decode through formatAndRoute', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const real = writeFakeCodex(path.join(dir, 'real'));
    const sink = path.join(dir, 'sink');
    const { code, stdout } = runShimSubprocess(['exec', '--sandbox', 'read-only', '-'], {
      env: { MATRON_CODEX_REAL_BIN: real, MATRON_CODEX_SINK_DIR: sink, MATRON_CODEX_LABEL: 'Codex test' },
      input: 'prompt\n',
    });
    expect(code).toBe(0);

    const metaName = fs.readdirSync(sink).find(n => n.endsWith('.meta.json'));
    const jsonlName = fs.readdirSync(sink).find(n => n.endsWith('.jsonl'));
    expect(metaName).toBeDefined();
    expect(jsonlName).toBeDefined();

    // R500 mode bits (G4 P1 residual).
    expect(fs.statSync(sink).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(sink, metaName)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(sink, jsonlName)).mode & 0o777).toBe(0o600);

    const meta = JSON.parse(fs.readFileSync(path.join(sink, metaName), 'utf8'));
    expect(meta.runId).toMatch(RUN_ID_RE);
    expect(`codex-${meta.runId}.meta.json`).toBe(metaName);
    expect(meta.wrapperPid).toBeGreaterThan(0);
    expect(typeof meta.wrapperStartTicks).toBe('string');
    expect(meta.wrapperStartTicks.length).toBeGreaterThan(0);
    expect(Number.isFinite(meta.deadlineTs)).toBe(true);
    expect(meta.schemaVersion).toBe('codex-cli 0.147.0');
    expect(meta.exitCode).toBe(0); // terminal meta re-written after child exit

    // Verbatim tee: sink jsonl === caller stdout.
    const jsonl = fs.readFileSync(path.join(sink, jsonlName), 'utf8');
    expect(stdout).toBe(jsonl);

    // The producer's bytes decode through the real formatter → child activity +
    // final answer, under the produced schemaVersion (pins the wire contract).
    const calls = [];
    // Record every publisher method the formatter may invoke (publishText,
    // publishActivity, publishFile, publishStatus, ...) without enumerating them.
    const publisher = new Proxy({}, {
      get: (_t, method) => (convoId, payload) => {
        if (method === 'publishText') calls.push(['text', payload?.body]);
        else if (method === 'publishActivity') calls.push(['activity', payload]); // payload === kind here
        return true;
      },
    });
    let state;
    for (const line of jsonl.split('\n').filter(Boolean)) {
      state = formatAndRoute(JSON.parse(line), {
        publisher, convoId: 'child', runId: meta.runId, meta, state,
        retainFinalAnswer: () => true, markFinalAnswerDelivered: () => true,
      });
    }
    expect(calls).toContainEqual(['text', 'OK']); // final answer flushed on turn.completed
    expect(calls.some(c => c[0] === 'activity')).toBe(true); // stream produced activity events
  });
});

describe('producer shim — signal forwarding + no orphan (T-6.4)', () => {
  it('forwards SIGTERM to the child group, reaps it, and writes an interrupted terminal meta', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const pidFile = path.join(dir, 'child.pid');
    // A long-lived fake codex: record pid, emit a line, then sleep. It has no
    // trap, so the group SIGTERM terminates it.
    const real = writeFakeCodex(path.join(dir, 'real'), {
      body: [
        `  echo $$ > ${JSON.stringify(pidFile)}`,
        "  printf '%s\\n' '{\"type\":\"thread.started\"}'",
        '  sleep 30',
      ].join('\n'),
    });
    const sink = path.join(dir, 'sink');

    const child = spawn(process.execPath, [SHIM, 'exec', '-'], {
      env: { PATH: process.env.PATH, MATRON_CODEX_REAL_BIN: real, MATRON_CODEX_SINK_DIR: sink },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('prompt\n');

    // Wait for the child fake-codex pid and the first sink line.
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => fs.readdirSync(sink).some(n => n.endsWith('.jsonl')));

    const exitCode = await new Promise(resolve => {
      child.on('exit', (code, signal) => resolve(signal ? `sig:${signal}` : code));
      child.kill('SIGTERM');
    });
    // The shim exited on the signal (128+15) rather than hanging.
    expect(exitCode === 143 || exitCode === 'sig:SIGTERM').toBe(true);

    // No orphan: the fake-codex child is gone.
    await waitFor(() => !isAlive(childPid));
    expect(isAlive(childPid)).toBe(false);

    // Terminal meta carries an interrupted marker and NO exitCode.
    const metaName = fs.readdirSync(sink).find(n => n.endsWith('.meta.json'));
    const meta = JSON.parse(fs.readFileSync(path.join(sink, metaName), 'utf8'));
    expect(meta.interrupted).toBe(true);
    expect(Object.hasOwn(meta, 'exitCode')).toBe(false);
  }, 20000); // 3x waitFor (5s each) + a subprocess spawn exceed the 5s default;
  // give the real failure room to surface instead of a framework-timeout abort.
});

describe('producer shim — JSON flag insertion (no duplicate/misplaced)', () => {
  it('does not re-insert --json when the caller already passed it (exec resume --json)', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const argvFile = path.join(dir, 'argv.txt');
    // Record the child's argv, then emit a minimal completed stream.
    const real = writeFakeCodex(path.join(dir, 'real'), {
      body: [
        '  cat >/dev/null',
        `  printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
        "  printf '%s\\n' '{\"type\":\"turn.completed\"}'",
      ].join('\n'),
    });
    const sink = path.join(dir, 'sink');
    const { code } = runShimSubprocess(['exec', 'resume', '--json', '-'], {
      env: { MATRON_CODEX_REAL_BIN: real, MATRON_CODEX_SINK_DIR: sink },
      input: 'hi\n',
    });
    expect(code).toBe(0);
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    // Exactly one --json, and `resume` still immediately follows `exec`.
    expect(argv.filter(a => a === '--json')).toHaveLength(1);
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('resume');
  });

  it('inserts --json exactly once when the caller omitted it (exec -)', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const argvFile = path.join(dir, 'argv.txt');
    const real = writeFakeCodex(path.join(dir, 'real'), {
      body: [
        '  cat >/dev/null',
        `  printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
        "  printf '%s\\n' '{\"type\":\"turn.completed\"}'",
      ].join('\n'),
    });
    const sink = path.join(dir, 'sink');
    const { code } = runShimSubprocess(['exec', '-'], {
      env: { MATRON_CODEX_REAL_BIN: real, MATRON_CODEX_SINK_DIR: sink },
      input: 'hi\n',
    });
    expect(code).toBe(0);
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    expect(argv.filter(a => a === '--json')).toHaveLength(1);
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('--json');
  });
});

describe('producer shim — passthrough forwards signals + no orphan', () => {
  it('forwards SIGTERM to the passthrough child group and reaps it (non-exec subcommand)', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    const pidFile = path.join(dir, 'child.pid');
    // A non-exec subcommand routes through passthrough(); make it long-lived so
    // an unforwarded signal would orphan it (the wedge Dan flagged).
    const realPath = path.join(dir, 'real', 'codex');
    fs.writeFileSync(realPath, [
      '#!/usr/bin/env bash',
      `if [[ "$1" != "exec" ]]; then echo $$ > ${JSON.stringify(pidFile)}; sleep 30; exit 0; fi`,
      'exit 0',
      '',
    ].join('\n'));
    fs.chmodSync(realPath, 0o755);

    const child = spawn(process.execPath, [SHIM, 'login'], {
      env: { PATH: process.env.PATH, MATRON_CODEX_REAL_BIN: realPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());

    const exitCode = await new Promise(resolve => {
      child.on('exit', (code, signal) => resolve(signal ? `sig:${signal}` : code));
      child.kill('SIGTERM');
    });
    expect(exitCode === 143 || exitCode === 'sig:SIGTERM').toBe(true);

    await waitFor(() => !isAlive(childPid));
    expect(isAlive(childPid)).toBe(false);
  }, 20000);
});

// T-1.7: live smoke against a REAL codex (flat-rate CLI). Skipped where no
// stock codex is installed. Catches flag/schema drift the fake cannot.
const REAL_CODEX = (() => {
  const which = spawnSync('command', ['-v', 'codex'], { shell: '/bin/bash', encoding: 'utf8' });
  const candidate = which.stdout?.trim();
  if (candidate && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  return null;
})();

describe.skipIf(!REAL_CODEX)('producer shim — live smoke (T-1.7)', () => {
  it('resolves the real bin + json flag and writes a decoder-shaped transcript', () => {
    const dir = makeDir();
    const sink = path.join(dir, 'sink');
    const res = spawnSync(process.execPath, [SHIM, 'exec', '--sandbox', 'read-only', '-'], {
      env: { PATH: process.env.PATH, MATRON_CODEX_REAL_BIN: REAL_CODEX, MATRON_CODEX_SINK_DIR: sink },
      input: 'Say only OK\n',
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.status).toBe(0);

    const metaName = fs.readdirSync(sink).find(n => n.endsWith('.meta.json'));
    const jsonlName = fs.readdirSync(sink).find(n => n.endsWith('.jsonl'));
    expect(fs.statSync(path.join(sink, metaName)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(sink, jsonlName)).mode & 0o777).toBe(0o600);

    const meta = JSON.parse(fs.readFileSync(path.join(sink, metaName), 'utf8'));
    expect(meta.schemaVersion).toMatch(/^codex-cli \d+\.\d+\.\d+$/);

    const events = fs.readFileSync(path.join(sink, jsonlName), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const types = new Set(events.map(e => e.type));
    expect(types.has('thread.started')).toBe(true);
    expect(types.has('turn.completed')).toBe(true);
    // The decoder's expected item shape: an agent_message on item.completed.
    expect(events.some(e => e.type === 'item.completed' && e.item?.type === 'agent_message')).toBe(true);
  }, 130_000);
});

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
