// Tool-role filtering for the ask-user MCP server (lib/tool-roles.js) and the
// BRIDGE_TOOL_ROLE env the bridge hands each Claude session.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COORDINATOR_ONLY, ALWAYS, shouldRegister } from '../lib/tool-roles.js';
import { buildClaudeSpawnEnv } from '../lib/spawn-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('shouldRegister', () => {
  it('worker hides every Coordinator-only tool', () => {
    for (const name of COORDINATOR_ONLY) expect(shouldRegister(name, 'worker')).toBe(false);
  });

  it('worker keeps ordinary tools', () => {
    for (const name of ['item_create', 'memory_save', 'mission_start', 'request_secret']) {
      expect(shouldRegister(name, 'worker')).toBe(true);
    }
  });

  it('coordinator and full register everything', () => {
    for (const role of ['coordinator', 'full']) {
      for (const name of [...COORDINATOR_ONLY, 'item_create']) expect(shouldRegister(name, role)).toBe(true);
    }
  });

  it('fails open for unset or unknown roles', () => {
    for (const role of [undefined, null, '', 'bogus', 'WORKER', 'Worker ']) {
      for (const name of [...COORDINATOR_ONLY, 'item_create']) expect(shouldRegister(name, role)).toBe(true);
    }
  });

  it('always registers permission_request, whatever the role', () => {
    expect(ALWAYS).toContain('permission_request');
    for (const role of ['worker', 'coordinator', 'full', undefined, 'bogus']) {
      expect(shouldRegister('permission_request', role)).toBe(true);
    }
    expect(COORDINATOR_ONLY).not.toContain('permission_request');
  });
});

describe('buildClaudeSpawnEnv BRIDGE_TOOL_ROLE', () => {
  const build = (extra = {}, baseEnv = {}) => buildClaudeSpawnEnv({
    mode: 'print',
    baseEnv: { PATH: '/usr/bin', ...baseEnv },
    execPath: '/opt/node/bin/node',
    pathDelimiter: ':',
    roomId: 'room-a',
    apiPort: 1234,
    pluginCacheDir: '/tmp/plugins',
    permissionToken: 't',
    ...extra,
  });

  it('sets no role without the opt-in', () => {
    expect('BRIDGE_TOOL_ROLE' in build({ coordinator: true })).toBe(false);
    expect('BRIDGE_TOOL_ROLE' in build({ coordinator: false })).toBe(false);
    expect('BRIDGE_TOOL_ROLE' in build({}, { BRIDGE_TOOL_FILTER: '0' })).toBe(false);
  });

  it('sets coordinator or worker with the opt-in', () => {
    const on = { BRIDGE_TOOL_FILTER: '1' };
    expect(build({ coordinator: true }, on).BRIDGE_TOOL_ROLE).toBe('coordinator');
    expect(build({ coordinator: false, roleKnown: true }, on).BRIDGE_TOOL_ROLE).toBe('worker');
    expect(build({ mode: 'iv', coordinator: true }, on).BRIDGE_TOOL_ROLE).toBe('coordinator');
    expect(build({ mode: 'iv', coordinator: false, roleKnown: true }, on).BRIDGE_TOOL_ROLE).toBe('worker');
  });

  it('gives the full list while the journal has not confirmed the role', () => {
    const on = { BRIDGE_TOOL_FILTER: '1' };
    expect(build({}, on).BRIDGE_TOOL_ROLE).toBe('full');
    expect(build({ coordinator: false }, on).BRIDGE_TOOL_ROLE).toBe('full');
    expect(build({ coordinator: false, roleKnown: false }, on).BRIDGE_TOOL_ROLE).toBe('full');
    expect(build({ mode: 'iv', coordinator: false }, on).BRIDGE_TOOL_ROLE).toBe('full');
  });

  it('does not inherit a role from the bridge env', () => {
    expect('BRIDGE_TOOL_ROLE' in build({}, { BRIDGE_TOOL_ROLE: 'worker' })).toBe(false);
    expect(build({ coordinator: true }, { BRIDGE_TOOL_ROLE: 'worker', BRIDGE_TOOL_FILTER: '1' }).BRIDGE_TOOL_ROLE).toBe('coordinator');
  });
});

// ask-user.js connects a stdio transport at import, so drive it as a child
// process over JSON-RPC and read back tools/list plus the boot line.
function listTools(role) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    if (role !== undefined) env.BRIDGE_TOOL_ROLE = role;
    const child = spawn(process.execPath, [path.join(ROOT, 'ask-user.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('ask-user.js tools/list timed out')); }, 15000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ tools: msg.result.tools.map((t) => t.name), stderr: err });
        }
      }
    });
    child.on('error', reject);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

describe('ask-user.js tool list', () => {
  it('worker role omits Coordinator-only tools and keeps the rest', async () => {
    const { tools, stderr } = await listTools('worker');
    for (const name of COORDINATOR_ONLY) expect(tools).not.toContain(name);
    for (const name of ['permission_request', 'item_create', 'memory_save']) expect(tools).toContain(name);
    expect(stderr).toMatch(/\[ask-user\] tool role=worker registered=\d+ hidden=\d+ would-hide=0/);
  });

  it.each([undefined, 'coordinator', 'full', 'bogus'])('role %s lists every tool', async (role) => {
    const { tools, stderr } = await listTools(role);
    for (const name of [...COORDINATOR_ONLY, 'permission_request', 'item_create', 'memory_save']) {
      expect(tools).toContain(name);
    }
    expect(stderr).toMatch(/hidden=0 would-hide=\d+/);
  });

  it('every COORDINATOR_ONLY name is a real registered tool', () => {
    const src = fs.readFileSync(path.join(ROOT, 'ask-user.js'), 'utf8');
    for (const name of COORDINATOR_ONLY) expect(src).toContain(`server.tool(\n  '${name}'`);
  });
});
