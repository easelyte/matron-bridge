import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { liveLogDir } from '../lib/live-log-dir.js';
import { createRestartNotes } from '../lib/restart-notes.js';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture({ disabled = false, state, collectMs, bootFault, gitFailure = false, supported = true, preflightError, realPreflight = false, landed, latchPhase, noticeFault, recoveryFault } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-routes-'));
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(checkout);
  for (const name of ['index.js', 'package.json', 'package-lock.json', 'mcp-config.json', 'lib', 'hooks', 'bin', 'scripts',
    'coordinator', 'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'BRIDGE_COORDINATOR.md', 'BRIDGE_NOTICES.md']) {
    fs.cpSync(path.join(repo, name), path.join(checkout, name), { recursive: true });
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'));
  const latchFlag = path.join(root, 'latch-flag');
  // Model process-local latch flags without starting shutdown or agent processes.
  if (latchPhase === 'latched') {
    const latchFile = path.join(checkout, 'lib', 'restart-latch.js');
    fs.writeFileSync(latchFile, "import fixtureFs from 'node:fs';\n" + fs.readFileSync(latchFile, 'utf8').replace('beforeRequest() {', `beforeRequest() { if (fixtureFs.existsSync(${JSON.stringify(latchFlag)})) { active = true; fixtureFs.unlinkSync(${JSON.stringify(latchFlag)}); }`));
  }
  if (latchPhase === 'stamped') {
    const entry = path.join(checkout, 'index.js');
    fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace('stamped: false, verdict:', 'stamped: true, verdict:'));
  }
  if (noticeFault) {
    const publisher = path.join(checkout, 'lib', 'journal-publisher.js');
    fs.writeFileSync(publisher, fs.readFileSync(publisher, 'utf8').replace(
      'publishText(convoId, payload, options) {',
      `publishText(convoId, payload, options) { if (payload.body === 'The planned bridge restart was cancelled.') { ${noticeFault === 'throw' ? "throw new Error('fixture notice failure');" : 'return false;'} }`));
  }
  const heldFile = path.join(home, '.matron-bridge-restart-notes.json');
  const notes = createRestartNotes({ heldFile, pendingFile: path.join(home, '.matron-bridge-restart-pending.json') });
  const file = path.join(home, '.matron-bridge-restart-state.json');
  const store = createPlannedRestartState({ file });
  if (state) {
    store.addRequest({ reason: 'config', request_key: 'alice' });
    store.setState(state, { participants: ['alice'], stamp_written: false,
      ...(state === 'restarting' ? { restarting_at: Date.now(), expected_sha: 'a'.repeat(40), verdicts: {} }
        : { verdicts: { alice: { outcome: 'resumed', at: 1 } } }) });
  }
  if (recoveryFault === 'inflight') fs.writeFileSync(path.join(home, '.matron-bridge-inflight.json'), '{');
  if (recoveryFault === 'notes') fs.writeFileSync(heldFile, '{');
  if (bootFault === 'corrupt') fs.writeFileSync(file, '{');
  if (bootFault === 'unreadable') fs.mkdirSync(file);
  const tokenFile = path.join(home, '.matron-bridge-restart.env');
  const evidence = path.join(root, 'listen.json');
  const gitEvidence = path.join(root, 'git');
  const headFile = path.join(root, 'head');
  const preflightEvidence = path.join(root, 'preflight');
  const probes = path.join(root, 'probes');
  const writeFault = path.join(root, 'write-fault');
  const noteWriteFault = path.join(root, 'note-write-fault');
  const notices = [];
  const timerEvidence = path.join(root, 'timer');
  const guard = path.join(root, 'guard.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs';
import net from 'node:net';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const readDir = fs.readdirSync;
fs.readdirSync = (dir, ...args) => dir === ${JSON.stringify(liveLogDir())} ? [] : readDir(dir, ...args);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === ${JSON.stringify(file)} && fs.existsSync(${JSON.stringify(writeFault)})) throw new Error('fixture write failure');
  if (String(to) === ${JSON.stringify(heldFile)} && fs.existsSync(${JSON.stringify(noteWriteFault)})) throw new Error('fixture note write failure');
  return rename(from, to);
};
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => {
  const timer = interval(fn, ms, ...args);
  if (ms === 1000) {
    const unref = timer.unref.bind(timer);
    timer.unref = () => { fs.writeFileSync(${JSON.stringify(timerEvidence)}, 'unref'); return unref(); };
  }
  return timer;
};
let headReads = 0;
const exec = cp.execFileSync;
cp.execFileSync = (command, args, options) => {
  if (command === 'ps') { fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n'); return ''; }
  if (command === 'git') {
    fs.appendFileSync(${JSON.stringify(gitEvidence)}, args.join(' ') + '\\n');
    if (args[0] === 'rev-parse') {
      if (${gitFailure === true} || (${gitFailure === 'boot'} && ++headReads === 1)) throw new Error('fixture HEAD unavailable');
      return (fs.existsSync(${JSON.stringify(headFile)}) ? fs.readFileSync(${JSON.stringify(headFile)}, 'utf8') : 'a'.repeat(40)) + '\\n';
    }
    if (args[0] === 'merge-base' && args[3] === 'refs/remotes/origin/master' && ${landed === false}) throw Object.assign(new Error('not landed'), { status: 1 });
    if (args[0] === 'status' || args[0] === 'merge-base' || args[0] === 'cat-file') return '';
    if (args[0] === 'show') return ${JSON.stringify(supported ? "export const PREFLIGHT_PROTOCOL = 'gate/1';\n" : '')};
    throw new Error('unexpected git command');
  }
  return exec(command, args, options);
};
const execAsync = cp.execFile;
cp.execFile = (command, args, options, callback) => {
  if (command === process.execPath && args.length === 1 && args[0] === 'index.js' && options.env?.MATRON_BRIDGE_PREFLIGHT === 'gate') {
    fs.appendFileSync(${JSON.stringify(preflightEvidence)}, 'gate\\n');
    if (${realPreflight}) {
      const childHome = fs.mkdtempSync(${JSON.stringify(path.join(root, 'gate-home-'))});
      return execAsync(command, args, { ...options, env: { ...options.env, HOME: childHome } }, callback);
    }
    queueMicrotask(() => callback(${preflightError ? "new Error('fixture gate failed')" : "null"}, '', ${JSON.stringify(preflightError || '')}));
    return;
  }
  return execAsync(command, args, options, callback);
};
process.kill = () => { throw new Error('signals refused in fixture'); };
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const beforeBind = fs.existsSync(${JSON.stringify(tokenFile)}) ? fs.readFileSync(${JSON.stringify(tokenFile)}, 'utf8') : null;
  const callback = args.pop();
  args.push(function(...values) {
    callback.apply(this, values);
    fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ beforeBind,
      token: fs.existsSync(${JSON.stringify(tokenFile)}) ? fs.readFileSync(${JSON.stringify(tokenFile)}, 'utf8') : null,
      childFile: process.env.MATRON_RESTART_ENV_FILE }));
  });
  return listen.apply(this, args);
};
syncBuiltinESMExports();
`);
  const server = net.createServer();
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const journal = new WebSocketServer({ host: 'localhost', port: 0 });
  await once(journal, 'listening');
  journal.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.op === 'publish' && message.payload?.body === 'The planned bridge restart was cancelled.') notices.push(message);
    if (message.op === 'hello') socket.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: 0 }));
  }));
  fs.writeFileSync(path.join(checkout, '.env'), `JOURNAL_WS_URL=ws://localhost:${journal.address().port}/ws\nJOURNAL_TOKEN=fixture-only\n`);
  const child = spawn(process.execPath, ['--import', guard, 'index.js'], { cwd: checkout,
    env: { HOME: home, TMPDIR: root, PATH: process.env.PATH,
      MATRON_BRIDGE_API_PORT: String(port), MATRON_CODE_UPDATE_RESTART: '0', MATRON_KEEP_AWAKE: 'off',
      SESSION_IDLE_TIMEOUT_MS: '0', MATRON_PLANNED_RESTART: disabled ? '0' : '1',
      ...(collectMs === undefined ? {} : { MATRON_RESTART_COLLECT_MS: collectMs }),
      ...(landed === undefined ? {} : { MATRON_RESTART_LANDED_REF: 'refs/remotes/origin/master' }) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
    for (const socket of journal.clients) socket.terminate();
    await new Promise(resolve => journal.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && (!output.includes('Local API listening') || !fs.existsSync(evidence)); i++) {
    if (child.exitCode !== null) break;
    await delay(25);
  }
  expect(output, 'isolated bridge must boot').toContain('Local API listening');
  return { file, store, latchFlag, notes, heldFile, noteWriteFault, notices, child, tokenFile, evidence, headFile, probes, writeFault, timerEvidence, gitEvidence, preflightEvidence,
    envFile: path.join(checkout, '.env'),
    subagentFile: path.join(home, '.claude-subagent-running.json'),
    get output() { return output; },
    async duplicate() {
      const second = spawn(process.execPath, ['--import', guard, 'index.js'], { cwd: checkout,
        env: { HOME: home, TMPDIR: root, PATH: process.env.PATH,
          MATRON_BRIDGE_API_PORT: String(port), MATRON_CODE_UPDATE_RESTART: '0', MATRON_KEEP_AWAKE: 'off',
          SESSION_IDLE_TIMEOUT_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      second.stdout.on('data', data => { output += data; });
      second.stderr.on('data', data => { output += data; });
      cleanups.unshift(async () => {
        if (second.exitCode === null && second.signalCode === null) { second.kill('SIGKILL'); await once(second, 'exit'); }
      });
      await Promise.race([once(second, 'exit'), delay(5000)]);
      expect(output).toContain('EADDRINUSE');
      expect(second.exitCode).not.toBe(null);
    },
    async post(route, body = {}, token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim().split('=')[1] : null) {
      const response = await fetch(`http://localhost:${port}${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Matron-Restart-Token': token }) },
        body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(2000) });
      return { status: response.status, body: await response.json() };
    } };
}

it('writes a private per-boot token after binding and before accepting and removes it on exit', async () => {
  const f = await fixture();
  const evidence = JSON.parse(fs.readFileSync(f.evidence));
  expect(evidence.beforeBind).toBe(null);
  expect(typeof evidence.token).toBe('string');
  expect(evidence.token).toMatch(/^MATRON_RESTART_TOKEN=[a-f0-9]{64}\n$/);
  expect(evidence.childFile).toBe(f.tokenFile);
  const source = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
  expect(source).toContain('repoDir: __dirname');
  expect(source).toContain('cwd: __dirname');
  expect(source).toContain('landedRef: process.env.MATRON_RESTART_LANDED_REF');
  expect(source).toContain('sessions: () => sessions');
  expect(source).toContain('sessions, bootAt: BRIDGE_BOOT_AT, readProcessTable: readProcessTableStrict');
  expect(source).toContain('mcpSignatures: MCP_SERVER_SIGNATURES');
  expect(source.includes("defaultPreflight(repoDir, { mode: 'gate', bootDotenvKeys: BOOT_DOTENV_KEYS })")).toBe(true);
  expect(source).toContain('onReady: verdict => restartLatch.onReady(verdict)');
  expect(fs.statSync(f.tokenFile).mode & 0o777).toBe(0o600);
  expect(f.store.getState().boot_sha).toBe('a'.repeat(40));
  f.child.kill('SIGTERM');
  await once(f.child, 'exit');
  expect(fs.existsSync(f.tokenFile)).toBe(false);
});

it('rejects missing and incorrect tokens on every route without state changes', async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.file, 'utf8');
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) {
    for (const token of [null, 'b'.repeat(63), 'b'.repeat(64), 'b'.repeat(65)]) {
      expect((await f.post(route, { request_key: 'bob' }, token)).status).toBe(401);
      expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    }
  }
});

it('persists and joins requests idempotently, evaluates dry runs, and cancels pending work', async () => {
  const f = await fixture();
  const first = await f.post('/restart', { reason: 'config', request_key: 'alice' });
  expect(first.status).toBe(200);
  expect(first.body.state).toBe('pending');
  expect((await f.post('/restart', { reason: 'config', request_key: 'bob' })).body.id).toBe(first.body.id);
  await f.post('/restart', { reason: 'config', request_key: 'bob' });
  expect(f.store.getState().requests).toHaveLength(2);
  const before = fs.readFileSync(f.file, 'utf8');
  const dry = await f.post('/restart/dry-run', { sha: 'b'.repeat(40) });
  expect(dry.status).toBe(200);
  expect(Object.keys(dry.body).sort()).toEqual(['waiting_on', 'would_pass']);
  expect(Object.keys(dry.body.waiting_on).sort()).toEqual(['code', 'collect', 'preflight', 'quiet', 'unwarned']);
  expect(dry.body.waiting_on.collect.remaining_ms).toBeGreaterThan(290000);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  expect((await f.post('/restart/cancel')).body.state).toBe('cancelled');
});

it.each(['restarting', 'back', 'abandoned'])('honors persisted %s with no in-memory stamp', async state => {
  const f = await fixture({ state });
  const before = fs.readFileSync(f.file, 'utf8');
  const id = f.store.getState().id;
  const response = await f.post('/restart', { reason: 'config', request_key: 'bob' });
  expect(response.status).toBe(state === 'restarting' ? 503 : 200);
  if (state === 'restarting') {
    expect(response.body).toEqual({ error: 'restarting', id });
    expect((await f.post('/restart/cancel')).status).toBe(409);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    // The full before-stamp un-latch seam belongs to the latch integration.
    expect(f.store.addRequest({ request_key: 'bob' })).toEqual({ busy: 'restarting', id });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    f.store.setState('pending', { restarting_at: null, expected_sha: null, stamp_written: false,
      boot_phase: null, participants: [] });
    expect(await f.post('/restart', { reason: 'config', request_key: 'bob' })).toEqual({
      status: 200, body: { id, state: 'pending' },
    });
    expect(f.store.getState().requests).toHaveLength(2);
  } else expect(response.body.id).not.toBe(id);
});

it('disables all restart routes', async () => {
  const f = await fixture({ disabled: true });
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) expect((await f.post(route)).status).toBe(404);
});

it('refuses invalid JSON, invalid requests, and unreadable state', async () => {
  const f = await fixture();
  expect((await f.post('/restart', '{')).status).toBe(400);
  for (const body of [null, [], {}, { reason: 1 }, { reason: '', request_key: 'bob' }, { reason: 'config', sha: 1 }]) {
    expect((await f.post('/restart', body)).status).toBe(400);
  }
  fs.writeFileSync(f.file, '{');
  for (const route of ['/restart', '/restart/cancel']) expect((await f.post(route, { reason: 'config', request_key: 'bob' })).status).toBe(503);
  expect((await f.post('/restart/dry-run')).body.would_pass).toBe(false);
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  for (const route of ['/restart', '/restart/cancel']) expect((await f.post(route, { reason: 'config', request_key: 'bob' })).status).toBe(503);
  expect((await f.post('/restart/dry-run')).body.would_pass).toBe(false);
});

it('polls only pending work with an unreferenced timer', async () => {
  const f = await fixture();
  expect(fs.readFileSync(f.timerEvidence, 'utf8')).toBe('unref');
  await delay(1100);
  expect(fs.existsSync(f.probes)).toBe(false);
  await f.post('/restart', { reason: 'config', request_key: 'alice' });
  await delay(1100);
  expect(fs.existsSync(f.probes)).toBe(true);
  await f.post('/restart/cancel');
  const count = fs.readFileSync(f.probes, 'utf8');
  await delay(1100);
  expect(fs.readFileSync(f.probes, 'utf8')).toBe(count);
  const disabled = await fixture({ disabled: true });
  expect(fs.existsSync(disabled.timerEvidence)).toBe(false);
}, 15000);

it('never acknowledges a failed request or cancel write', async () => {
  const f = await fixture();
  await f.post('/restart', { reason: 'config', request_key: 'alice' });
  const before = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.writeFault, 'fail');
  for (const route of ['/restart', '/restart/cancel']) {
    expect((await f.post(route, { reason: 'config', request_key: 'bob' })).status).toBe(503);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  }
});

it('uses the configured zero collect window', async () => {
  const f = await fixture({ collectMs: '0' });
  await f.post('/restart', { reason: 'config', request_key: 'alice' });
  expect((await f.post('/restart/dry-run')).body.waiting_on.collect).toBe(null);
});

it.each(['corrupt', 'unreadable'])('bypasses restart initialization when disabled with %s boot state', async bootFault => {
  const f = await fixture({ disabled: true, bootFault });
  expect(fs.existsSync(f.gitEvidence)).toBe(false);
  expect(fs.existsSync(f.tokenFile)).toBe(false);
  expect(fs.existsSync(f.timerEvidence)).toBe(false);
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) expect((await f.post(route)).status).toBe(404);
});

it.each(['corrupt', 'unreadable'])('keeps the bridge available with %s restart boot state', async bootFault => {
  const f = await fixture({ bootFault });
  expect(f.output).toContain('[restart] initialization failed; planned restart unavailable');
  expect(fs.existsSync(f.timerEvidence)).toBe(false);
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) expect((await f.post(route)).status).toBe(503);
});

it.each([true, 'boot'])('keeps the bridge available when boot HEAD is unavailable (%s)', async gitFailure => {
  const f = await fixture({ gitFailure });
  expect(f.store.getState().boot_sha).toBe(null);
  expect(f.output).toContain('[restart] boot HEAD unavailable');
  const dry = await f.post('/restart/dry-run', { reason: 'config' });
  expect(dry.status).toBe(200);
  expect(dry.body.would_pass).toBe(false);
  expect(dry.body.waiting_on.code).toBe(gitFailure === 'boot' ? 'head moved (config-only)' : 'not a descendant');
});

it('rejects a removed boot dotenv token and accepts its restoration through the real gate', async () => {
  const f = await fixture({ realPreflight: true });
  const original = fs.readFileSync(f.envFile, 'utf8');
  async function verdict() {
    let dry;
    for (let i = 0; i < 100; i++) {
      dry = await f.post('/restart/dry-run', { reason: 'config' });
      if (!dry.body.waiting_on.preflight?.unknown) return dry.body;
      await delay(25);
    }
    throw new Error('gate did not settle');
  }
  expect((await verdict()).would_pass).toBe(true);
  fs.writeFileSync(f.envFile, original.replace(/^JOURNAL_TOKEN=.*\n/m, ''));
  const removed = await verdict();
  expect(removed.would_pass).toBe(false);
  expect(removed.waiting_on.preflight.error).toContain('journal token required');
  fs.writeFileSync(f.envFile, original);
  expect((await verdict()).would_pass).toBe(true);
}, 30000);

it.each([null, 'fixture gate failed'])('uses the gate preflight result through dry run (%s)', async preflightError => {
  const f = await fixture({ preflightError });
  let dry;
  for (let i = 0; i < 40; i++) {
    dry = await f.post('/restart/dry-run', { reason: 'config' });
    if (!dry.body.waiting_on.preflight?.unknown) break;
    await delay(25);
  }
  expect(dry.body.waiting_on.code).toBe(null);
  expect(fs.readFileSync(f.preflightEvidence, 'utf8')).toBe('gate\n');
  expect(dry.body.would_pass).toBe(preflightError === null);
  if (preflightError) expect(dry.body.waiting_on.preflight.error).toContain(preflightError);
  else expect(dry.body.waiting_on.preflight).toBe(null);
});

it('holds dry runs when the gate mode is unsupported at HEAD', async () => {
  const f = await fixture({ supported: false });
  const dry = await f.post('/restart/dry-run', { reason: 'config' });
  expect(dry.body.would_pass).toBe(false);
  expect(dry.body.waiting_on.code).toBe(null);
  expect(dry.body.waiting_on.preflight).toEqual({ error: 'mode unsupported at HEAD' });
  expect(fs.existsSync(f.preflightEvidence)).toBe(false);
});

it.each(['corrupt', 'unreadable'])('holds dry runs with %s subagent state', async kind => {
  const f = await fixture();
  // Introduce the fault after boot reconciliation has finished.
  fs.rmSync(f.subagentFile, { force: true });
  if (kind === 'corrupt') fs.writeFileSync(f.subagentFile, '{');
  else fs.mkdirSync(f.subagentFile);
  const before = fs.readFileSync(f.file, 'utf8');
  let dry;
  for (let poll = 0; poll < 40; poll++) {
    dry = await f.post('/restart/dry-run', { reason: 'config' });
    if (!dry.body.waiting_on.preflight?.unknown) break;
    await delay(25);
  }
  expect(dry.status).toBe(200);
  expect(dry.body.waiting_on.code).toBe(null);
  expect(dry.body.waiting_on.preflight).toBe(null);
  expect(dry.body.would_pass).toBe(false);
  expect(dry.body.waiting_on.quiet).toEqual({ holders: [], probe_error: 'subagents' });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  if (kind === 'corrupt') expect(fs.readFileSync(f.subagentFile, 'utf8')).toBe('{');
  else expect(fs.statSync(f.subagentFile).isDirectory()).toBe(true);
});


it('preserves the active token after a duplicate launch fails to bind', async () => {
  const f = await fixture();
  const original = fs.readFileSync(f.tokenFile, 'utf8');
  await f.duplicate();
  expect(fs.readFileSync(f.tokenFile, 'utf8')).toBe(original);
  expect((await f.post('/restart/dry-run')).status).toBe(200);
});

it('preserves a replacement token file when its original owner exits', async () => {
  const f = await fixture();
  const replacement = `MATRON_RESTART_TOKEN=${'b'.repeat(64)}\n`;
  fs.writeFileSync(f.tokenFile, replacement);
  f.child.kill('SIGTERM');
  await once(f.child, 'exit');
  expect(fs.existsSync(f.tokenFile)).toBe(true);
  expect(fs.readFileSync(f.tokenFile, 'utf8')).toBe(replacement);
});

it.each([true, false])('enforces configured landed ancestry through dry run (%s)', async landed => {
  const f = await fixture({ landed });
  let dry;
  for (let i = 0; i < 40; i++) {
    dry = await f.post('/restart/dry-run', { sha: 'a'.repeat(40) });
    if (!dry.body.waiting_on.preflight?.unknown || dry.body.waiting_on.code) break;
    await delay(25);
  }
  expect(dry.body.waiting_on.code).toBe(landed ? null : 'head not landed');
  expect(dry.body.would_pass).toBe(landed);
  expect(fs.readFileSync(f.gitEvidence, 'utf8')).toContain(`merge-base --is-ancestor ${'a'.repeat(40)} refs/remotes/origin/master`);
});

it('pins config-only dry runs to the boot commit with a configured landed ref', async () => {
  const f = await fixture({ landed: true });
  fs.writeFileSync(f.headFile, 'b'.repeat(40));
  const dry = await f.post('/restart/dry-run', { reason: 'config' });
  expect(dry.body.waiting_on.code).toBe('head moved (config-only)');
  expect(dry.body.would_pass).toBe(false);
});


it.each(['pending', 'latched'])('cancels %s work and notifies only sessions with held notes once', async latchPhase => {
  const f = await fixture({ latchPhase });
  const { body: { id } } = await f.post('/restart', { reason: 'config', request_key: 'alice' });
  await f.post('/restart', { reason: 'config', request_key: 'bob' });
  f.store.markNotified(id, 'alice');
  f.store.markNotified(id, 'box-a');
  f.notes.hold(id, 'alice', 'continue');
  f.notes.hold(id, 'bob', 'continue');
  f.notes.hold('older', 'box-a', 'keep');
  if (latchPhase === 'latched') fs.writeFileSync(f.latchFlag, 'latched');
  if (latchPhase === 'latched') f.store.setState('restarting', {
    restarting_at: 1, expected_sha: 'a'.repeat(40), stamp_written: true,
    boot_phase: 'latching', participants: ['alice', 'bob'],
  });
  expect(await f.post('/restart/cancel')).toEqual({ status: 200, body: { id, state: 'cancelled' } });
  expect(f.store.getState().requests).toEqual([]);
  expect(f.notes.listHeld(id)).toEqual([]);
  expect(f.notes.listHeld('older')).toHaveLength(1);
  if (latchPhase === 'latched') expect(f.store.getState()).toMatchObject({
    restarting_at: null, expected_sha: null, stamp_written: false, boot_phase: null, participants: [],
  });
  await f.post('/restart/cancel');
  await delay(100);
  expect(f.notices.map(message => message.convo_id).sort()).toEqual(['alice', 'bob']);
});

it.each(['stamped', 'persisted'])('refuses cancellation of %s restarts without changing state or notes', async latchPhase => {
  const f = await fixture({ latchPhase });
  f.store.addRequest({ reason: 'config', request_key: 'alice' });
  const { id } = f.store.getState();
  f.notes.hold(id, 'alice', 'continue');
  f.store.setState(latchPhase === 'persisted' ? 'restarting' : 'pending', { participants: ['alice'], verdicts: { bob: { outcome: 'resumed', at: 1 } } });
  const before = fs.readFileSync(f.file, 'utf8');
  const notesBefore = fs.readFileSync(f.heldFile, 'utf8');
  expect(await f.post('/restart/cancel')).toEqual({ status: 409, body: { error: 'restarting' } });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  expect(fs.readFileSync(f.heldFile, 'utf8')).toBe(notesBefore);
  expect(f.notices).toEqual([]);
});

it.each(['corrupt', 'unreadable', 'write'])('refuses cancellation when held notes are %s', async fault => {
  const f = await fixture();
  const { body: { id } } = await f.post('/restart', { reason: 'config', request_key: 'alice' });
  f.notes.hold(id, 'alice', 'continue');
  if (fault === 'corrupt') fs.writeFileSync(f.heldFile, '{');
  if (fault === 'unreadable') { fs.rmSync(f.heldFile); fs.mkdirSync(f.heldFile); }
  if (fault === 'write') fs.writeFileSync(f.noteWriteFault, 'fail');
  const before = fs.readFileSync(f.file, 'utf8');
  expect((await f.post('/restart/cancel')).status).toBe(503);
  if (fault === 'write') expect(f.store.getState().state).toBe('cancelling');
  else expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});

it('cancels pending requests when no held notes file exists', async () => {
  const f = await fixture();
  await f.post('/restart', { reason: 'config', request_key: 'alice' });
  expect((await f.post('/restart/cancel')).body.state).toBe('cancelled');
  expect(f.store.getState().requests).toEqual([]);
  expect(f.notices).toEqual([]);
});


it.each(['throw', 'refuse'])('refuses cancellation when publishing a notice would %s', async noticeFault => {
  const f = await fixture({ noticeFault });
  const { body: { id } } = await f.post('/restart', { reason: 'config', request_key: 'alice' });
  f.notes.hold(id, 'alice', 'continue');
  const notesBefore = fs.readFileSync(f.heldFile, 'utf8');
  expect((await f.post('/restart/cancel')).status).toBe(503);
  expect(f.store.getState().state).toBe('cancelling');
  expect(fs.readFileSync(f.heldFile, 'utf8')).toBe(notesBefore);
});

it('blocks restart joins while cancellation is incomplete and resumes a retry', async () => {
  const f = await fixture();
  const { body: { id } } = await f.post('/restart', { reason: 'config', request_key: 'alice' });
  f.notes.hold(id, 'alice', 'continue');
  fs.writeFileSync(f.noteWriteFault, 'fail');
  expect((await f.post('/restart/cancel')).status).toBe(503);
  expect(f.store.getState().state).toBe('cancelling');
  expect(await f.post('/restart', { reason: 'config', request_key: 'bob' })).toEqual({ status: 503, body: { error: 'restarting', id } });
  fs.rmSync(f.noteWriteFault);
  expect((await f.post('/restart/cancel')).body.state).toBe('cancelled');
  expect(new Set(f.notices.map(notice => notice.idem_key))).toEqual(new Set([`restart-cancel:${id}:alice`]));
});

it('caps authenticated restart request bodies at sixty-four kibibytes', async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.file, 'utf8');
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) {
    expect((await f.post(route, { reason: 'a'.repeat(65536), request_key: 'alice' })).status).toBe(413);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  }
});

it.each(['inflight', 'notes'])('boots with corrupt %s recovery data', async recoveryFault => {
  const f = await fixture({ recoveryFault });
  expect(f.child.exitCode).toBe(null);
  expect((await f.post('/restart/dry-run')).status).toBe(recoveryFault === 'notes' ? 503 : 200);
  if (recoveryFault === 'notes') expect(f.output).toContain('[restart] recovery initialization failed; planned restart unavailable');
});

it('accepts exactly the serialized body limit and rejects the next byte', async () => {
  const f = await fixture();
  const base = { reason: 'config', request_key: 'alice', padding: '' };
  const body = JSON.stringify({ ...base, padding: 'é'.repeat(Math.floor((65536 - Buffer.byteLength(JSON.stringify(base))) / 2)) });
  const exact = body + ' '.repeat(65536 - Buffer.byteLength(body));
  expect(Buffer.byteLength(exact)).toBe(65536);
  for (const route of ['/restart', '/restart/dry-run', '/restart/cancel']) {
    const before = fs.readFileSync(f.file, 'utf8');
    expect((await f.post(route, exact + ' ')).status).toBe(413);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect((await f.post(route, exact)).status).toBe(200);
  }
});
