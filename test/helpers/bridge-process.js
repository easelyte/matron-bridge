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

export function supervise(launch) {
  let stopped = false;
  const supervisor = {
    child: null, launches: 0, exits: [],
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
      if (!stopped && code === 75) start();
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
export async function startBridge({ confine = true } = {}) {
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
    for (const name of ['index.js', 'package.json', 'mcp-config.json', 'lib', 'hooks', 'bin', 'scripts',
      'coordinator', 'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'BRIDGE_COORDINATOR.md', 'BRIDGE_NOTICES.md']) {
      fs.cpSync(path.join(repo, name), path.join(checkout, name), { recursive: true });
    }
    // repairSpawnHelperOnce only adds spawn-helper exec bits, as npm ci's postinstall already does.
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(repo, 'test/stub-claude.mjs'), path.join(home, 'stub-claude.mjs'));
    // Adapt the existing PTY stub to the transcript location the real bridge tails.
    const shim = `#!${process.execPath}\nimport fs from 'node:fs';
import path from 'node:path';
import { transcriptPathFor } from '../bridge/lib/transcript-dir.js';
const flag = process.argv.indexOf('--session-id');
if (flag < 0) process.exit(2);
process.env.TRANSCRIPT_PATH = transcriptPathFor(process.cwd(), process.argv[flag + 1]);
fs.mkdirSync(path.dirname(process.env.TRANSCRIPT_PATH), { recursive: true });
await import('../stub-claude.mjs');\n`;
    fs.writeFileSync(path.join(home, 'bin', 'claude'), shim, { mode: 0o755 });
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
      MATRON_INTERACTIVE_MODE: '1', MATRON_CODE_UPDATE_RESTART: '0',
      SESSION_IDLE_TIMEOUT_MS: '0', MATRON_KEEP_AWAKE: 'off',
      MATRON_LIVE_OUTPUT_TTL: '3153600000', // Keep startup's literal /tmp sweep inert in both modes.
    };
    supervisor = supervise(() => {
      const child = confined ? childProcess.spawn('bwrap', ['--die-with-parent', '--unshare-pid', '--as-pid-1', '--info-fd', '3',
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
    });
    async function post(route, body = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(1000),
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
      get output() { return output; },
      async startSession() {
        sendText('harness-control', '/start');
        session = await waitFor(async () => (await post('/sessions')).find(s => s.alive), diagnostics);
        return session;
      },
      async echo(text) {
        sendText(session.claudeSessionId, text);
        const transcript = path.join(home, '.claude', 'projects',
          encodeProjectDir(workdir), `${session.claudeSessionId}.jsonl`);
        return waitFor(() => {
          if (!fs.existsSync(transcript)) return false;
          const content = fs.readFileSync(transcript, 'utf8');
          return content.includes(`echo: ${text}`) && content;
        }, diagnostics);
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
