import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import childProcess, { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { encodeProjectDir } from '../../lib/transcript-dir.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
export function probeConfinement(run = spawnSync) {
  return run('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true'], {
    env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 1000,
  }).status === 0;
}
const bwrapAvailable = probeConfinement();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function supervise(launch, beforeRelaunch) {
  let stopped = false;
  const supervisor = {
    child: null, launches: 0, exits: [],
    restart() { stopped = false; start(); },
    stop(signal = 'SIGTERM') {
      stopped = true;
      const child = supervisor.child;
      if (child && child.exitCode == null && child.signalCode == null) child.kill(signal);
    },
  };
  function start() {
    const child = launch();
    supervisor.child = child;
    supervisor.launches++;
    child.once('exit', (code, signal) => {
      supervisor.exits.push({ code, signal });
      if (!stopped && code === 75) {
        if (beforeRelaunch) Promise.resolve(beforeRelaunch()).then(() => { if (!stopped) start(); });
        else start();
      }
    });
  }
  start();
  return supervisor;
}

async function waitFor(read, diagnostics = () => '', timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`bridge harness timed out: ${diagnostics()}`);
}

async function randomPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Run the actual entry point from a disposable source copy: startup writes
// generated MCP config beside index.js. Where available, bwrap adds a read-only
// filesystem view, private /tmp and PID namespace. Otherwise own a process group.
export async function startBridge({ confine = true, interactive = true, planned = false, collectMs = 100, backgroundChild = false, crashBeforeHistory = false, beforeRelaunch } = {}) {
  const confined = confine && bwrapAvailable;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-process-'));
  const checkout = path.join(home, 'bridge');
  const workdir = path.join(home, 'work');
  const readonly = path.join(home, 'readonly');
  const probeTarget = '/tmp/harness-readonly/probe';
  const repoProbeTarget = path.join(repo, `.harness-write-${path.basename(home)}`);
  const frames = [];
  let journal;
  let supervisor;
  let output = '';
  const diagnostics = () => output.slice(-4000);
  async function close() {
    if (supervisor?.child) {
      const child = supervisor.child;
      supervisor.stop();
      if (child.exitCode == null && child.signalCode == null) {
        try {
          await waitFor(() => child.exitCode != null || child.signalCode != null, diagnostics, 4000);
        } catch {
          supervisor.stop('SIGKILL');
          await once(child, 'exit');
        }
      }
    }
    // The group may still contain children after the bridge itself has exited.
    if (!confined && supervisor?.child) supervisor.child.kill('SIGKILL');
    if (journal) {
      for (const socket of journal.clients) socket.terminate();
      await new Promise(resolve => journal.close(resolve));
    }
    // A broken confinement would leave the repo-side probe behind; always remove it.
    fs.rmSync(repoProbeTarget, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  try {
    fs.mkdirSync(checkout);
    fs.mkdirSync(workdir);
    fs.mkdirSync(readonly);
    // The refused-write probe targets a HOME-owned fixture exposed read-only
    // outside HOME, so a confinement mutation can only write disposable data.
    fs.writeFileSync(path.join(home, 'probe.mjs'), `import fs from 'node:fs';
try { fs.writeFileSync(${JSON.stringify(probeTarget)}, 'probe'); }
catch (error) {
  if (error.code === 'EROFS') console.log('harness: outside HOME write refused');
  else throw error;
}
try { fs.writeFileSync(${JSON.stringify(repoProbeTarget)}, 'probe', { flag: 'wx' }); }
catch (error) {
  if (error.code === 'EROFS') console.log('harness: real repo write refused');
  else throw error;
}
`);
    fs.mkdirSync(path.join(home, 'bin'));
    // Only code/config inputs; never copy a live .env, overlay or HOME state.
    for (const name of ['index.js', 'package.json', 'package-lock.json', '.gitignore', 'mcp-config.json', 'lib', 'hooks', 'bin', 'scripts',
      'coordinator', 'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'BRIDGE_COORDINATOR.md', 'BRIDGE_NOTICES.md']) {
      fs.cpSync(path.join(repo, name), path.join(checkout, name), { recursive: true });
    }
    if (crashBeforeHistory) {
      const file = path.join(checkout, 'lib/restart-boot.js');
      const source = fs.readFileSync(file, 'utf8');
      // Let the accepted PTY submission finish, while keeping history unwritten.
      const seam = "    onStep('back');";
      if (!source.includes(seam)) throw new Error('Cannot locate history crash seam');
      fs.writeFileSync(file, source.replace(seam, seam + "\n    if (process.env.HARNESS_CRASH_BEFORE_HISTORY === '1') { setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000); return; }"));
    }
    const gitEnv = { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' };
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=alice', '-c', 'user.email=alice',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable checkout']]) {
      const result = spawnSync('git', args, { cwd: checkout, env: gitEnv, encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) throw new Error('Cannot initialize disposable checkout');
    }
    if (planned) fs.writeFileSync(path.join(checkout, '.env'), `MATRON_RESTART_COLLECT_MS=${collectMs}\n`);
    // repairSpawnHelperOnce only adds spawn-helper exec bits, as npm ci's postinstall already does.
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(repo, 'test/stub-claude.mjs'), path.join(home, 'stub-claude.mjs'));
    fs.writeFileSync(path.join(home, 'stub-claude.mjs'),
      fs.readFileSync(path.join(home, 'stub-claude.mjs'), 'utf8')
        .replace('function emit(event) {', 'function emit(event) { event.session_id = process.env.STUB_SESSION_ID;')
        .replace("process.stdout.write('> ');", `process.stdout.write(${JSON.stringify('❯ \n──────\n  ? for shortcuts')});`)
        .replace('function consume(text) {', `function consume(text) {
  if (text === '__crash__') process.exit(1);
  if (text === '__resume_failed__') {
    emit({ type: 'result', is_error: true, errors: ['No conversation found'] });
    setTimeout(() => process.exit(1), 500);
    return;
  }`));
    // Adapt the existing PTY stub to the transcript location the real bridge tails.
    const shim = `#!${process.execPath}\nimport fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(process.env.HOME + '/stub-launches', JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n');
const { transcriptPathFor } = await import('../bridge/lib/transcript-dir.js');
const flag = process.argv.findIndex(arg => arg === '--session-id' || arg === '--resume');
if (flag < 0 || !process.argv[flag + 1]) process.exit(2);
process.env.STUB_SESSION_ID = process.argv[flag + 1];
process.env.TRANSCRIPT_PATH = transcriptPathFor(process.cwd(), process.argv[flag + 1]);
fs.mkdirSync(path.dirname(process.env.TRANSCRIPT_PATH), { recursive: true });
fs.appendFileSync(process.env.HOME + '/stub-starts', process.pid + '\\n');
if (process.argv.includes('--print')) {
  const { createInterface } = await import('node:readline');
  const emit = event => {
    event.session_id = process.env.STUB_SESSION_ID;
    fs.appendFileSync(process.env.TRANSCRIPT_PATH, JSON.stringify(event) + '\\n');
    console.log(JSON.stringify(event));
  };
  createInterface({ input: process.stdin }).on('line', line => {
    const event = JSON.parse(line);
    const text = Array.isArray(event.message.content)
      ? event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : event.message.content;
    if (text === '__resume_failed__') {
      emit({ type: 'result', is_error: true, errors: ['No conversation found'] });
      setTimeout(() => process.exit(1), 500);
      return;
    }
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] } });
    emit({ type: 'result', subtype: 'success' });
  });
} else {
/*SESSIONSETUP*/await import('../stub-claude.mjs');
process.stdout.write('\\n? for shortcuts\\n');
}\n`;
    const sessionSetup = `
fs.writeFileSync(path.join(process.env.HOME, process.argv[flag + 1] + '.env.json'), JSON.stringify({
  roomId: process.env.BRIDGE_ROOM_ID, tokenFile: process.env.MATRON_RESTART_ENV_FILE,
}));
if (${backgroundChild} && !fs.existsSync(path.join(process.env.HOME, 'child-started'))) {
  fs.writeFileSync(path.join(process.env.HOME, 'child-started'), process.argv[flag + 1]);
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', "const fs = require('node:fs'); const path = require('node:path'); setInterval(() => { if (fs.existsSync(path.join(process.env.HOME, 'child-release'))) process.exit(0); }, 25);"], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH }, stdio: 'ignore',
  });
}
let endedBytes = fs.existsSync(process.env.TRANSCRIPT_PATH) ? fs.statSync(process.env.TRANSCRIPT_PATH).size : 0;
fs.watchFile(process.env.TRANSCRIPT_PATH, { interval: 25 }, async stat => {
  if (stat.size <= endedBytes) return;
  endedBytes = stat.size;
  const rows = fs.readFileSync(process.env.TRANSCRIPT_PATH, 'utf8').trim().split('\\n').map(JSON.parse);
  if (rows.at(-1)?.type === 'result') await fetch('http://localhost:' + process.env.MATRON_BRIDGE_API_PORT + '/turn-end', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: process.argv[flag + 1], transcript_path: process.env.TRANSCRIPT_PATH }),
  });
});
`;
    fs.writeFileSync(path.join(home, 'bin', 'claude'), shim.replace('/*SESSIONSETUP*/', planned ? sessionSetup : ''), { mode: 0o755 });
    journal = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    journal.on('connection', socket => {
      socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        frames.push(frame);
        if (frame.op === 'hello') {
          socket.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: 0 }));
        }
      });
    });
    await once(journal, 'listening');
    const port = await randomPort();
    const env = {
      HOME: home, TMPDIR: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      JOURNAL_WS_URL: `ws://127.0.0.1:${journal.address().port}/ws`,
      JOURNAL_TOKEN: 'harness-only', JOURNAL_CONTROL_CONVO_ID: 'harness-control',
      ALLOWED_USER_IDS: 'harness',
      DEFAULT_WORKDIR: workdir, MATRON_BRIDGE_API_PORT: String(port),
      MATRON_INTERACTIVE_MODE: interactive ? '1' : '0', MATRON_CODE_UPDATE_RESTART: '0',
      SESSION_IDLE_TIMEOUT_MS: '0', MATRON_KEEP_AWAKE: 'off',
      MATRON_LIVE_OUTPUT_TTL: '3153600000', // Keep startup's literal /tmp sweep inert in both modes.
    };
    supervisor = supervise(() => {
      env.HARNESS_CRASH_BEFORE_HISTORY = crashBeforeHistory && supervisor?.launches === 1 ? '1' : '0';
      // Keep the namespace init wrapper when testing a self-inflicted crash.
      const child = confined ? childProcess.spawn('bwrap', ['--die-with-parent', '--unshare-pid', ...(crashBeforeHistory ? [] : ['--as-pid-1']), '--info-fd', '3',
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--tmpfs', '/tmp', '--bind', home, home, '--ro-bind', readonly, '/tmp/harness-readonly',
        '--chdir', checkout, process.execPath, '--import', path.join(home, 'probe.mjs'), 'index.js'],
      { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
        : childProcess.spawn(process.execPath, ['index.js'], {
          cwd: checkout, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      let info = '';
      let nodePid;
      const killWrapper = child.kill.bind(child);
      if (confined) child.stdio[3].on('data', data => {
        info += data;
        try { nodePid = JSON.parse(info)['child-pid']; } catch { /* incomplete frame */ }
      });
      child.kill = signal => {
        if (!confined) {
          if (!child.pid) return false;
          try { process.kill(-child.pid, signal); return true; } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            return false;
          }
        }
        if (!nodePid) return killWrapper(signal);
        try { process.kill(nodePid, signal); return true; } catch { return false; }
      };
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', error => { output += error.message; });
      return child;
    }, beforeRelaunch);
    async function post(route, body = {}, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(planned ? 5000 : 1000),
      });
      if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
      return response.json();
    }
    await waitFor(() => frames.some(frame => frame.op === 'hello')
      && output.includes(`Local API listening on 127.0.0.1:${port}`), diagnostics);
    let seq = 0;
    function sendText(convoId, body) {
      for (const socket of journal.clients) socket.send(JSON.stringify({
        kind: 'journal', seq: ++seq, convo_id: convoId, sender: 'user:harness',
        type: 'text', payload: { body }, ts: Date.now(),
      }));
    }
    let session;
    return {
      ready: true, confined, home, checkout, port, frames, supervisor, post, sendText,
      token(file = path.join(home, '.matron-bridge-restart.env')) {
        return fs.readFileSync(file, 'utf8').split('\n')[0].split('=')[1];
      },
      transcript(id) {
        const file = path.join(home, '.claude', 'projects', encodeProjectDir(workdir), `${id}.jsonl`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
      },
      stubLaunches() {
        const log = path.join(home, 'stub-launches');
        return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
      },
      stubStarts() {
        const log = path.join(home, 'stub-starts');
        return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(Number) : [];
      },
      get output() { return output; },
      async startSession() {
        const existing = new Set((await post('/sessions')).map(s => s.claudeSessionId));
        sendText('harness-control', '/start');
        session = await waitFor(async () => (await post('/sessions')).find(s => s.alive && !existing.has(s.claudeSessionId)), diagnostics);
        return session;
      },
      async echo(text) {
        sendText(session.claudeSessionId, text);
        const transcript = path.join(home, '.claude', 'projects',
          encodeProjectDir(workdir), `${session.claudeSessionId}.jsonl`);
        const content = await waitFor(() => {
          if (!fs.existsSync(transcript)) return false;
          const content = fs.readFileSync(transcript, 'utf8');
          return content.includes(`echo: ${text}`) && content;
        }, diagnostics);
        if (interactive) await post('/turn-end', { session_id: session.claudeSessionId });
        await waitFor(async () => (await post('/sessions')).some(s => s.alive && !s.busy), diagnostics);
        return content;
      },
      async terminate() {
        const child = supervisor.child;
        supervisor.stop();
        await waitFor(() => child.exitCode != null || child.signalCode != null, diagnostics, 4000);
        return supervisor.exits.at(-1);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
