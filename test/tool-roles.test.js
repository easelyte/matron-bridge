import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { COORDINATOR_ONLY, shouldRegister } from '../lib/tool-roles.js';
import { buildClaudeSpawnEnv } from '../lib/spawn-env.js';

describe('tool roles', () => {
  it('hides only Coordinator tools from workers and always keeps permission_request', () => {
    for (const name of COORDINATOR_ONLY) expect(shouldRegister(name, 'worker')).toBe(false);
    for (const name of ['permission_request', 'item_create', 'memory_save', 'mission_start',
      'request_secret', 'project_create', 'project_update', 'project_status', 'box_defaults_set',
      'unseen_mine', 'unseen_flag', 'new_tool']) {
      expect(shouldRegister(name, 'worker')).toBe(true);
    }
  });

  it.each(['coordinator', 'full', undefined, null, '', 'unknown', 'WORKER', 'worker '])(
    'keeps all tools for role %s', (role) => {
      for (const name of [...COORDINATOR_ONLY, 'permission_request']) {
        expect(shouldRegister(name, role)).toBe(true);
      }
    },
  );
});

describe('Claude spawn tool role', () => {
  const build = (options = {}, baseEnv = {}) => buildClaudeSpawnEnv({ baseEnv, ...options });

  it.each([undefined, '', '0', 'true'])('requires the exact filter opt-in, got %s', (flag) => {
    for (const coordinator of [true, false]) {
      expect(build({ coordinator, roleKnown: true }, {
        BRIDGE_TOOL_FILTER: flag, BRIDGE_TOOL_ROLE: 'worker',
      })).not.toHaveProperty('BRIDGE_TOOL_ROLE');
    }
  });

  it('sets per-session roles without mutating the bridge environment', () => {
    const base = Object.freeze({ BRIDGE_TOOL_FILTER: '1', BRIDGE_TOOL_ROLE: 'worker' });
    expect(build({ coordinator: true }, base).BRIDGE_TOOL_ROLE).toBe('coordinator');
    expect(build({ coordinator: false, roleKnown: true }, base).BRIDGE_TOOL_ROLE).toBe('worker');
    for (const options of [{}, { coordinator: false }, { coordinator: false, roleKnown: false }]) {
      expect(build(options, base).BRIDGE_TOOL_ROLE).toBe('full');
    }
    expect(base.BRIDGE_TOOL_ROLE).toBe('worker');
  });

  it('passes the confirmed role to both print and interactive spawn builders', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/buildClaudeSpawnEnv\(\{([\s\S]*?)\}\);/g)];
    expect(calls).toHaveLength(2);
    for (const [, args] of calls) {
      expect(args).toContain('coordinator: options.coordinator === true,');
      expect(args).toContain('roleKnown: options.roleKnown === true,');
    }
    expect(src).toContain('options.roleKnown = coordinatorLookup.snapshot().known === true;');
  });
});

// Load the real server with an in-memory transport; no bridge APIs are called.
async function listTools(role) {
  vi.resetModules();
  vi.stubEnv('BRIDGE_TOOL_ROLE', role);
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: class {
      constructor() { return serverTransport; }
    },
  }));
  const client = new Client({ name: 'tool-role-test', version: '1.0.0' });
  try {
    await import('../ask-user.js');
    await client.connect(transport, { timeout: 10000 });
    return (await client.listTools({}, { timeout: 10000 })).tools;
  } finally {
    await client.close();
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.unstubAllEnvs();
  }
}

describe('ask-user MCP tool list', () => {
  it('removes exactly the Coordinator-only tools, including both timeline registrations', async () => {
    const full = await listTools();
    const workers = await listTools('worker');
    const names = (tools) => tools.map((tool) => tool.name).sort();
    const removed = full.filter((tool) => !workers.some((worker) => worker.name === tool.name));
    expect(names(removed)).toEqual([...COORDINATOR_ONLY].sort());
    expect(names(workers)).toContain('permission_request');
    expect(names(workers)).toContain('item_create');
    expect(names(workers)).toContain('memory_save');
    // Check access descriptions independently of the list. A memory scope
    // described as "Coordinator only)" does not restrict the memory tool itself.
    const describedAsCoordinatorOnly = full.filter((tool) =>
      /Coordinator only(?=[.!]| (?:\(|—))|Coordinator alone/i.test(tool.description));
    expect(names(describedAsCoordinatorOnly)).toEqual([...COORDINATOR_ONLY].sort());
  });

  it.each(['coordinator', 'full', 'unknown'])('role %s matches the default tool list', async (role) => {
    expect(await listTools(role)).toEqual(await listTools());
  });
});
