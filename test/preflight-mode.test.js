import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { liveLogDir } from '../lib/live-log-dir.js';
import { afterEach, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../', import.meta.url));
const loopback = 'localhost';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  roots.push(root);
  const checkout = path.join(root, 'bridge');
  const home = path.join(root, 'home');
  fs.mkdirSync(checkout);
  fs.mkdirSync(home);
  for (const name of ['index.js', 'package.json', 'mcp-config.json', 'lib', 'bin', 'hooks', 'scripts', 'coordinator',
    'BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md', 'BRIDGE_COORDINATOR.md', 'BRIDGE_NOTICES.md']) {
    fs.cpSync(path.join(repo, name), path.join(checkout, name), { recursive: true });
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(checkout, 'node_modules'));
  // Prevent a broken early-exit rule from writing, sweeping live logs or starting timers/listeners.
  const guard = path.join(root, 'guard.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const refuse = () => { console.error('startup side effect'); throw new Error('startup side effect'); };
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (process.env.MATRON_BRIDGE_PREFLIGHT === 'module' && String(file).endsWith('.env')) return refuse();
  return readFile(file, ...args);
};
const readDir = fs.readdirSync;
fs.readdirSync = (dir, ...args) => {
  if (dir === ${JSON.stringify(liveLogDir())}) return refuse();
  return readDir(dir, ...args);
};
for (const name of ['writeFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'renameSync', 'chmodSync']) fs[name] = refuse;
net.Server.prototype.listen = refuse;
globalThis.setInterval = refuse;
syncBuiltinESMExports();
`);
  const portServer = net.createServer();
  portServer.listen(0, loopback);
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  return {
    checkout, home,
    async run(mode, { env = {}, file, missing = false } = {}) {
      const childHome = fs.mkdtempSync(path.join(root, 'home-'));
      const sentinel = path.join(childHome, '.matron-bridge-restart.env');
      const tokenFile = `MATRON_RESTART_TOKEN=${'a'.repeat(64)}\nMATRON_BRIDGE_API_PORT=${port}\n`;
      fs.writeFileSync(sentinel, tokenFile);
      const envFile = path.join(checkout, '.env');
      if (missing) fs.rmSync(envFile, { recursive: true, force: true });
      else if (file !== undefined) fs.writeFileSync(envFile, file);
      const journal = new WebSocketServer({ host: loopback, port: 0 });
      await once(journal, 'listening');
      let connections = 0;
      journal.on('connection', socket => { connections++; socket.close(); });
      const childEnv = { HOME: childHome, TMPDIR: root, PATH: path.dirname(process.execPath),
        MATRON_BRIDGE_PREFLIGHT: mode, MATRON_BRIDGE_API_PORT: String(port) };
      if (mode !== 'module') {
        childEnv.JOURNAL_WS_URL = `ws://${loopback}:${journal.address().port}/ws`;
        childEnv.JOURNAL_TOKEN = 'fixture-only';
      }
      Object.assign(childEnv, env);
      try {
        const result = await new Promise(resolve => execFile(process.execPath,
          ['--import', guard, 'index.js'], { cwd: checkout, env: childEnv, timeout: 4000 },
          (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr })));
        expect(result.output).not.toContain('startup side effect');
        expect(connections).toBe(0);
        expect(fs.readFileSync(sentinel, 'utf8')).toBe(tokenFile);
        expect(fs.readdirSync(childHome)).toEqual(['.matron-bridge-restart.env']);
        expect(fs.readdirSync(checkout).some(name => name.startsWith('.mcp-config-generated'))).toBe(false);
        const probe = net.createServer();
        probe.listen(port, loopback);
        await once(probe, 'listening');
        await new Promise(resolve => probe.close(resolve));
        return result;
      } finally {
        for (const socket of journal.clients) socket.terminate();
        await new Promise(resolve => journal.close(resolve));
      }
    },
  };
}

it('loads both modes without startup effects and ignores dotenv in module mode', async () => {
  const f = await fixture();
  const gate = await f.run('gate', { file: '# comment\n\nexport FIXTURE=value\n_NAME=ok\n' });
  expect(gate.code, gate.output).toBe(0);
  expect(gate.output).toContain('[preflight] ok');
  expect((await f.run('module', { missing: true })).code).toBe(0);
  expect((await f.run('module', { file: 'SUMMARY_PROVIDERS=invalid\nbad line\n' })).code).toBe(0);
}, 30000);

it('refuses malformed, missing and unreadable dotenv input and accepts its correction', async () => {
  const f = await fixture();
  for (const line of ['bad line', ' KEY=value', 'KEY =value', '1KEY=value', 'export  KEY=value']) {
    expect((await f.run('gate', { file: line })).code).toBe(1);
  }
  const corrected = await f.run('gate', { file: 'KEY=value\n' });
  expect(corrected.code).toBe(0);
  expect(corrected.output).toContain('[preflight] ok');
  expect((await f.run('gate', { missing: true })).code).toBe(1);
  fs.mkdirSync(path.join(f.checkout, '.env'));
  expect((await f.run('gate')).code).toBe(1);
}, 30000);

it('refuses every unknown mode before startup effects', async () => {
  const f = await fixture();
  for (const mode of ['gat', '', 'GATE', 'module ']) {
    const result = await f.run(mode);
    expect(result.code, result.output).toBe(2);
  }
}, 30000);

it('refuses an import exception in both modes', async () => {
  const f = await fixture();
  fs.appendFileSync(path.join(f.checkout, 'lib/transcribe.js'), "\nthrow new Error('fixture import failed');\n");
  for (const mode of ['gate', 'module']) {
    const result = await f.run(mode, { file: 'KEY=value' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('fixture import failed');
  }
}, 30000);

it('rejects invalid API ports from dotenv and accepts corrected ports', async () => {
  const f = await fixture();
  for (const port of ['65536', '-1', 'invalid']) {
    const result = await f.run('gate', { file: `MATRON_BRIDGE_API_PORT=${port}\n` });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('invalid MATRON_BRIDGE_API_PORT');
  }
  for (const port of ['0', '65535']) {
    const result = await f.run('gate', { file: `MATRON_BRIDGE_API_PORT=${port}\n` });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[preflight] ok');
  }
}, 30000);

it.each(['MATRON_CODE_UPDATE_POLL_MS', 'MATRON_CODE_UPDATE_SETTLE_MS', 'MATRON_CODE_UPDATE_WARN_EVERY_MS'])(
  'accepts one and rejects zero for %s in gate mode', async name => {
    const f = await fixture();
    const accepted = await f.run('gate', { file: `${name}=1\n` });
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.output).toContain('[preflight] ok');
    const rejected = await f.run('gate', { file: `${name}=0\n` });
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain(`invalid ${name}`);
  }, 30000);

it('validates boot configuration and its numeric boundaries in gate mode', async () => {
  const f = await fixture();
  const invalid = [
    { MATRON_DEFAULT_AGENT: 'invalid' }, { MATRON_DEFAULT_MODEL: 'invalid' },
    { MATRON_DEFAULT_EFFORT: 'invalid' }, { MATRON_PERMISSION_MODE: 'invalid' },
    { CODEX_SANDBOX_MODE: 'invalid' }, { CODEX_NETWORK_ACCESS: 'invalid' },
    { SUMMARY_PROVIDERS: 'invalid' }, { SUMMARY_PROVIDERS: 'openai,openai' },
    { MCP_DEFAULT_EXTRAS: 'invalid' }, { SHOW_FILE_ARTIFACT_ROOTS: 'missing' },
    { SHOW_FILE_ARTIFACT_ROOTS: path.join(f.checkout, 'missing') },
    { SHOW_FILE_ARTIFACT_ROOTS: path.join(f.checkout, 'package.json') },
    { SHOW_FILE_UPLOAD_TIMEOUT_MS: '0' }, { SHOW_FILE_UPLOAD_TIMEOUT_MS: '300001' },
    { MATRON_CODE_UPDATE_POLL_MS: '0' }, { MATRON_CODE_UPDATE_SETTLE_MS: '1x' },
    { MATRON_CODE_UPDATE_WARN_EVERY_MS: '-1' }, { MATRON_CODE_UPDATE_FORCE_AFTER_MS: '-1' },
    { MATRON_CODE_UPDATE_POLL_MS: '9007199254740992' },
    { MATRON_CODE_UPDATE_RESTART: 'invalid' }, { MATRON_CODE_UPDATE_AUTO_CARRY_ON: 'invalid' },
    { JOURNAL_TOKEN_FILE: path.join(f.home, 'missing') }, { JOURNAL_TOKEN: '' }, { JOURNAL_WS_URL: '' },
  ];
  for (const env of invalid) expect((await f.run('gate', { file: 'KEY=value', env })).code, Object.keys(env).join()).toBe(1);
  for (const timeout of ['1', '300000']) expect((await f.run('gate', {
    file: 'KEY=value', env: { SHOW_FILE_UPLOAD_TIMEOUT_MS: timeout, MATRON_CODE_UPDATE_FORCE_AFTER_MS: '0',
      MATRON_CODE_UPDATE_POLL_MS: '9007199254740991' },
  })).code).toBe(0);
  expect((await f.run('gate', { file: 'KEY=value', env: { SHOW_FILE_ARTIFACT_ROOTS: f.checkout } })).code).toBe(0);
  for (const tokenFile of ['empty.env', 'unreadable.env']) {
    const tokenPath = path.join(f.checkout, tokenFile);
    if (tokenFile === 'empty.env') fs.writeFileSync(tokenPath, '');
    else fs.mkdirSync(tokenPath);
    expect((await f.run('gate', { file: 'KEY=value', env: { JOURNAL_TOKEN_FILE: tokenPath } })).code).toBe(1);
  }
  expect((await f.run('gate', { file: 'SUMMARY_PROVIDERS=invalid', env: { SUMMARY_PROVIDERS: 'openai' } })).code).toBe(1);
  fs.writeFileSync(path.join(f.checkout, 'mcp-config.local.json'), '{');
  expect((await f.run('gate', { file: 'KEY=value' })).code).toBe(1);
  fs.rmSync(path.join(f.checkout, 'mcp-config.local.json'));
  fs.mkdirSync(path.join(f.checkout, 'mcp-config.local.json'));
  expect((await f.run('gate', { file: 'KEY=value' })).code).toBe(1);
  fs.rmSync(path.join(f.checkout, 'mcp-config.local.json'), { recursive: true });
  fs.writeFileSync(path.join(f.checkout, 'mcp-config.json'), '{');
  expect((await f.run('gate', { file: 'KEY=value' })).code).toBe(1);
}, 60000);
