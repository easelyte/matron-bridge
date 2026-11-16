import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/foreign-gate-managed.mjs';
import { claudeSessionFlagPath, claudeSessionFlagKey, claudeSessionFlagDir, setForeignFlag, clearForeignFlag } from '../lib/foreign-turn.js';

// hooks/foreign-gate-managed.mjs: the gate as one managed hook for every
// session on the machine. The session is the hook input's session_id, the
// token comes from the session's own token file, and the fallback flag is
// named by the session id.
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'foreign-gate-managed.mjs');
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } };

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
      if (typeof answer === 'number') { res.writeHead(answer); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgm-'));
const tokenFile = path.join(tokenDir, 'session.header');
fs.writeFileSync(tokenFile, 'X-Matron-Bridge-Token: abc123\n');
const input = (sessionId) => JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'ls' } });
const env = { MATRON_BRIDGE_API_HEADER_FILE: tokenFile };

describe('decide', () => {
  it('asks the bridge with no room, the hook input as the body and the session token', async () => {
    answer = {};
    seen.length = 0;
    const out = await decide({ input: input('s-1'), argv: ['--port', String(port)], env });
    expect(out).toBe(null);
    expect(seen[0].url).toBe('/foreign-check');
    expect(JSON.parse(seen[0].body).session_id).toBe('s-1');
    expect(seen[0].headers['x-matron-bridge-token']).toBe('abc123');
  });

  it('passes the bridge deny through', async () => {
    answer = deny;
    expect(await decide({ input: input('s-1'), argv: ['--port', String(port)], env })).toEqual(deny);
  });

  it('when the bridge refuses the call, the session-id flag decides', async () => {
    answer = 401;
    const flagged = (p) => p === claudeSessionFlagPath('s-2');
    const out = await decide({ input: input('s-2'), argv: ['--port', String(port)], env, exists: flagged });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await decide({ input: input('s-3'), argv: ['--port', String(port)], env, exists: flagged })).toBe(null);
  });

  it('when the bridge cannot be reached, the session-id flag decides', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    expect((await decide({ input: input('s-4'), env, fetchImpl, exists: () => true })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await decide({ input: input('s-4'), env, fetchImpl, exists: () => false })).toBe(null);
  });

  it('an answer that is neither {} nor a deny falls back to the flag', async () => {
    answer = { decision: 'allow' };
    expect((await decide({ input: input('s-5'), argv: ['--port', String(port)], env, exists: () => true })).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('takes the port from --port, then MATRON_BRIDGE_API_PORT', async () => {
    answer = {};
    seen.length = 0;
    await decide({ input: input('s-6'), env: { ...env, MATRON_BRIDGE_API_PORT: String(port) } });
    expect(seen).toHaveLength(1);
  });

  it('without a session id there is nothing to gate by', async () => {
    seen.length = 0;
    expect(await decide({ input: '{"tool_name":"Bash"}', argv: ['--port', String(port)], env, exists: () => true })).toBe(null);
    expect(await decide({ input: 'not json', argv: ['--port', String(port)], env, exists: () => true })).toBe(null);
    expect(seen).toHaveLength(0);
  });
});

describe('the session-id flag', () => {
  it('lives in a fixed directory on POSIX, whatever TMPDIR says', () => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = '/somewhere/else';
    try {
      expect(claudeSessionFlagDir('linux').startsWith('/tmp/matron-foreign-')).toBe(true);
      expect(claudeSessionFlagPath('s-1').startsWith('/tmp/matron-foreign-')).toBe(process.platform !== 'win32');
    } finally {
      if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    }
  });
});

describe('as a hook', () => {
  function run(stdin, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end(stdin);
    });
  }

  it('prints nothing for an allowed call and exits 0', async () => {
    answer = {};
    const r = await run(input('s-7'), ['--port', String(port)]);
    expect(r).toEqual({ code: 0, out: '' });
  });

  it('denies from the real flag file while the bridge refuses the call', async () => {
    answer = 401;
    const id = `test-${randomUUID()}`;
    setForeignFlag(claudeSessionFlagKey(id), { dir: claudeSessionFlagDir() });
    try {
      const r = await run(input(id), ['--port', String(port)]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      clearForeignFlag(claudeSessionFlagKey(id), { dir: claudeSessionFlagDir() });
    }
    const r2 = await run(input(id), ['--port', String(port)]);
    expect(r2.out).toBe('');
  });
});
