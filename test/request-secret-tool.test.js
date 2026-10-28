import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let bridge, client, transport;
const requests = [];

beforeAll(async () => {
  bridge = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secretId: 'fixture-secret-request', itemNum: 120 }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../ask-user.js', import.meta.url))],
    env: { BRIDGE_API_URL: `http://127.0.0.1:${bridge.address().port}`, BRIDGE_ROOM_ID: 'room-fixture' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'secret-context-test', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  bridge?.close();
});

describe('request_secret MCP contract', () => {
  it('requires context in the advertised schema and forwards a valid explanation', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === 'request_secret');
    expect(tool.inputSchema.required).toContain('context');
    expect(tool.inputSchema.properties).not.toHaveProperty('convoId');
    expect(tool.inputSchema.properties).not.toHaveProperty('origin');
    const context = 'For the staging release: Workers Scripts Edit on the staging account, to deploy the fix.';
    const result = await client.callTool({ name: 'request_secret', arguments: { label: 'Deployment token', context, multiline: true } });
    expect(result.isError).not.toBe(true);
    expect(requests.at(-1)).toEqual({ path: '/secret', body: { label: 'Deployment token', context, roomId: 'room-fixture', multiline: true } });
  });

  it('does not forward caller-supplied conversation, URL or room overrides', async () => {
    const context = 'For the staging release; worker edits on staging only.';
    const result = await client.callTool({ name: 'request_secret', arguments: {
      label: 'token', context, convoId: 'forged-conversation', origin: 'https://untrusted.example', roomId: 'forged-room',
    } });
    expect(result.isError).not.toBe(true);
    expect(requests.at(-1)).toEqual({ path: '/secret', body: { label: 'token', context, roomId: 'room-fixture', multiline: false } });
  });

  it.each([undefined, '', ' \n ', 'x'.repeat(2001)])('rejects absent or invalid context without calling the bridge: %j', async (context) => {
    const count = requests.length;
    const result = await client.callTool({ name: 'request_secret', arguments: { label: 'Deployment token', ...(context === undefined ? {} : { context }) } });
    expect(result.isError).toBe(true);
    expect(requests.length).toBe(count);
  });
});
