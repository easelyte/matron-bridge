import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildMcpServers } from '../lib/mcp-config.js';

// A Claude session's MCP servers start with the session's environment (which
// carries MATRON_BRIDGE_API_PORT, the port the bridge really listens on) plus
// the `env` block of their entry in the generated MCP config. The ask-user
// server must end up calling that port, not a fixed one.

const committed = JSON.parse(fs.readFileSync(new URL('../mcp-config.json', import.meta.url), 'utf8'));
const askUserPath = fileURLToPath(new URL('../ask-user.js', import.meta.url));

let bridge, client;

afterEach(async () => {
  await client?.close();
  client = null;
  await new Promise((resolve) => (bridge ? bridge.close(resolve) : resolve()));
  bridge = null;
});

async function startBridge(requests) {
  bridge = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secretId: 'fixture-secret-request', itemNum: 1 }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  return bridge.address().port;
}

async function requestSecretWith(env) {
  client = new Client({ name: 'api-port-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [askUserPath], env, stderr: 'pipe' }));
  return client.callTool({ name: 'request_secret', arguments: { label: 'token', context: 'For the fixture deploy; no scope.' } });
}

describe('ask-user reaches the bridge on its real API port', () => {
  it('uses the session MATRON_BRIDGE_API_PORT with the env the generated config gives it', async () => {
    const requests = [];
    const port = await startBridge(requests);
    const { config } = buildMcpServers({ baseConfig: committed, platform: 'linux', execPath: '/usr/bin/node' });
    const sessionEnv = { MATRON_BRIDGE_API_PORT: String(port), BRIDGE_ROOM_ID: 'room-fixture' };
    const result = await requestSecretWith({ ...sessionEnv, ...(config.mcpServers['ask-user'].env || {}) });
    expect(result.isError).not.toBe(true);
    expect(requests.map((r) => r.path)).toEqual(['/secret']);
  });

  it('lets an explicit BRIDGE_API_URL win over the port', async () => {
    const requests = [];
    const port = await startBridge(requests);
    const result = await requestSecretWith({
      BRIDGE_API_URL: `http://127.0.0.1:${port}`, MATRON_BRIDGE_API_PORT: '1', BRIDGE_ROOM_ID: 'room-fixture',
    });
    expect(result.isError).not.toBe(true);
    expect(requests.map((r) => r.path)).toEqual(['/secret']);
  });
});
