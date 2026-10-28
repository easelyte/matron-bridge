import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrintSessionSettings, foreignGateEntry } from '../lib/permission-prompt.js';

// hooks/foreign-gate.sh (and its Windows port): the bridge's answer is the
// truth; the flag file decides only when the bridge cannot be reached.
const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const DENY_PREFIX = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"';

let server;
let port;
let answer = {};
const seen = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body, headers: req.headers });
      if (answer === 'error') { res.writeHead(500); res.end('{}'); return; }
      if (answer === 'garbage') { res.writeHead(200); res.end('<html>'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

function run(script, input, args) {
  return new Promise((resolve) => {
    const cmd = script.endsWith('.mjs') ? process.execPath : 'sh';
    const child = spawn(cmd, [path.join(HOOKS_DIR, script), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const flagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgate-'));
const flag = path.join(flagDir, 'flag');
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } };

for (const script of ['foreign-gate.sh', 'foreign-gate.mjs']) {
  describe.skipIf(script.endsWith('.sh') && process.platform === 'win32')(script, () => {
    const args = (p = port) => ['--port', String(p), '--room', 'room A/1', '--flag', flag];

    it('asks the bridge about every call, room in the query, hook input as the body', async () => {
      answer = {};
      seen.length = 0;
      const r = await run(script, { tool_name: 'Bash', tool_input: { command: 'ls' } }, args());
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      const u = new URL(seen[0].url, 'http://x');
      expect(u.pathname).toBe('/foreign-check');
      expect(u.searchParams.get('room')).toBe('room A/1');
      expect(JSON.parse(seen[0].body).tool_name).toBe('Bash');
    });

    it('prints the bridge\'s deny as it is', async () => {
      answer = deny;
      const r = await run(script, { tool_name: 'Bash' }, args());
      expect(JSON.parse(r.out)).toEqual(deny);
    });

    it('never passes on an allow of its own: anything but {} or a deny falls back', async () => {
      answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      fs.writeFileSync(flag, '1');
      expect((await run(script, { tool_name: 'Bash' }, args())).out.startsWith(DENY_PREFIX)).toBe(true);
      fs.rmSync(flag);
      expect((await run(script, { tool_name: 'Bash' }, args())).out).toBe('');
    });

    it('bridge unreachable: flag present -> deny, absent -> nothing', async () => {
      const dead = createServer();
      await new Promise((r) => dead.listen(0, '127.0.0.1', r));
      const deadPort = dead.address().port;
      await new Promise((r) => dead.close(r));
      fs.writeFileSync(flag, '1');
      expect((await run(script, { tool_name: 'Bash' }, args(deadPort))).out.startsWith(DENY_PREFIX)).toBe(true);
      fs.rmSync(flag);
      expect((await run(script, { tool_name: 'Bash' }, args(deadPort))).out).toBe('');
    });

    it('an HTTP error or garbage falls back the same way', async () => {
      fs.writeFileSync(flag, '1');
      answer = 'error';
      expect((await run(script, { tool_name: 'Bash' }, args())).out.startsWith(DENY_PREFIX)).toBe(true);
      answer = 'garbage';
      expect((await run(script, { tool_name: 'Bash' }, args())).out.startsWith(DENY_PREFIX)).toBe(true);
      fs.rmSync(flag);
    });

    it('a misbuilt command with no flag path denies when it cannot ask', async () => {
      expect((await run(script, { tool_name: 'Bash' }, ['--port', 'x', '--room', 'r'])).out.startsWith(DENY_PREFIX)).toBe(true);
    });
  });
}

describe('settings', () => {
  it('every print session gets the gate on every tool, first, and hooks cannot be switched off', () => {
    for (const bypass of [true, false]) {
      const s = buildPrintSessionSettings({ bypass, hooksDir: '/h', apiPort: 9802, roomId: 'r1', foreignFlag: '/tmp/f', platform: 'linux' });
      expect(s.disableAllHooks).toBe(false);
      expect(s.hooks.PreToolUse[0].matcher).toBe('.*');
      expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("/h/foreign-gate.sh '--port' '9802' '--room' 'r1' '--flag' '/tmp/f'");
    }
  });
  it('the Windows entry runs the Node port in exec form', () => {
    const e = foreignGateEntry({ hooksDir: 'C:\\h', apiPort: 1, roomId: 'r', foreignFlag: 'C:\\f', platform: 'win32', execPath: 'node.exe' });
    expect(e.hooks[0]).toMatchObject({ command: 'node.exe', args: ['C:\\h\\foreign-gate.mjs', '--port', '1', '--room', 'r', '--flag', 'C:\\f'] });
  });
});

// The session's loopback API token travels as a header read from the file the
// bridge bakes into the hook command (--auth), never as an argv value.
for (const script of ['foreign-gate.sh', 'foreign-gate.mjs']) {
  describe.skipIf(script.endsWith('.sh') && process.platform === 'win32')(`${script} token`, () => {
    it('sends the header from the --auth file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgate-auth-'));
      const auth = path.join(dir, 'header');
      fs.writeFileSync(auth, 'X-Matron-Session-Token: tok123\n', { mode: 0o600 });
      answer = {};
      seen.length = 0;
      await run(script, { tool_name: 'Bash' }, ['--port', String(port), '--room', 'r1', '--flag', flag, '--auth', auth]);
      expect(seen[0].headers['x-matron-session-token']).toBe('tok123');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a refused token (401) with the flag present still denies', async () => {
      answer = 'error';
      fs.writeFileSync(flag, '1');
      const r = await run(script, { tool_name: 'Bash' }, ['--port', String(port), '--room', 'r1', '--flag', flag]);
      expect(r.out.startsWith(DENY_PREFIX)).toBe(true);
      fs.rmSync(flag);
    });
  });
}
