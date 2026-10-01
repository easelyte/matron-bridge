// The Node ports of the bridge hooks (used on Windows). Pure Node, so they
// run on every CI platform: stdin JSON in, stdout JSON (or nothing) out,
// and the bridge endpoints they POST to observed on a local stub server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookOutput, rewriteCommand, bashDoubleQuotePath } from '../hooks/matron-bash-tee.mjs';
import { liveLogPath } from '../lib/live-log-dir.js';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const TEE = path.join(HOOKS, 'matron-tee');

function runHook(name, input, env = {}) {
  const parentEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MATRON_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOKS, name)], { env: { ...parentEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

describe('matron-bash-tee.mjs', () => {
  const base = { session_id: 's1', tool_use_id: 'toolu_abc', tool_name: 'Bash', tool_input: { command: 'ls -la' } };

  it('rewrites Bash commands when MATRON_BASH_TEE_ENABLED=1', async () => {
    const { code, stdout } = await runHook('matron-bash-tee.mjs', base, { MATRON_BASH_TEE_ENABLED: '1' });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const fwd = (p) => p.replace(/\\/g, '/');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.updatedInput.command).toBe(
      `"${fwd(process.execPath)}" "${fwd(TEE)}" "${fwd(liveLogPath('toolu_abc'))}" -- bash -c 'ls -la'`,
    );
  });

  it('is silent (exit 0, no output) when disabled, for non-Bash tools, and on bad input', async () => {
    for (const [input, env] of [
      [base, {}],
      [base, { MATRON_BASH_TEE_ENABLED: '0' }],
      [{ ...base, tool_name: 'Read' }, { MATRON_BASH_TEE_ENABLED: '1' }],
      [{ ...base, tool_use_id: '../evil' }, { MATRON_BASH_TEE_ENABLED: '1' }],
      [{ ...base, tool_input: {} }, { MATRON_BASH_TEE_ENABLED: '1' }],
      ['not json', { MATRON_BASH_TEE_ENABLED: '1' }],
    ]) {
      const { code, stdout } = await runHook('matron-bash-tee.mjs', input, env);
      expect(code).toBe(0);
      expect(stdout).toBe('');
    }
  });

  it('POSIX-quotes the original command for bash -c', () => {
    const out = rewriteCommand({ command: `echo 'hi' && ls "a b"`, nodeBin: 'C:\\n\\node.exe', teeBin: 'C:\\h\\matron-tee', logPath: 'C:\\t\\x.log' });
    expect(out).toBe(`"C:/n/node.exe" "C:/h/matron-tee" "C:/t/x.log" -- bash -c 'echo '\\''hi'\\'' && ls "a b"'`);
  });

  it('escapes what bash interprets inside double quotes in a path', () => {
    expect(bashDoubleQuotePath('C:\\Users\\a $b\\x"y`z')).toBe('"C:/Users/a \\$b/x\\"y\\`z"');
  });

  it('hookOutput refuses a tool_use_id outside toolu_[A-Za-z0-9_]+', () => {
    expect(hookOutput({ ...base, tool_use_id: 'toolu_a;rm -rf' }, { env: { MATRON_BASH_TEE_ENABLED: '1' }, hooksDir: HOOKS })).toBeNull();
  });
});

describe('compact-notify.mjs / stop-notify.mjs', () => {
  let server;
  let port;
  const hits = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { hits.push({ path: req.url, body: JSON.parse(body || '{}') }); res.writeHead(200); res.end('{}'); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));

  it('compact-notify POSTs the session id to /compact-start', async () => {
    const { code } = await runHook('compact-notify.mjs', { session_id: 'sid-1' }, { MATRON_BRIDGE_API_PORT: String(port) });
    expect(code).toBe(0);
    expect(hits).toContainEqual({ path: '/compact-start', body: { session_id: 'sid-1' } });
  });

  it('stop-notify POSTs session id and transcript path to /turn-end', async () => {
    const { code } = await runHook('stop-notify.mjs', { session_id: 'sid-2', transcript_path: '/t/x.jsonl' }, { MATRON_BRIDGE_API_PORT: String(port) });
    expect(code).toBe(0);
    expect(hits).toContainEqual({ path: '/turn-end', body: { session_id: 'sid-2', transcript_path: '/t/x.jsonl' } });
  });

  it('exits 0 when the bridge is unreachable', async () => {
    const { code } = await runHook('stop-notify.mjs', { session_id: 'x' }, { MATRON_BRIDGE_API_PORT: '1' });
    expect(code).toBe(0);
  });
});
