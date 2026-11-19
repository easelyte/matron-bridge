import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The bridge cannot remove a message once it is in the chat, so it must not
// offer a tool that claims to, nor tell agents that a posted secret can be
// taken back.

const read = (name) => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

let client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../ask-user.js', import.meta.url))],
    // Nothing listens here: listing tools makes no bridge call.
    env: { BRIDGE_API_URL: 'http://127.0.0.1:9', BRIDGE_ROOM_ID: 'room-fixture' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'no-redact-test', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

describe('message redaction is not offered', () => {
  it('the ask-user server registers no redact_message tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('share_sensitive_data');
    expect(names).not.toContain('redact_message');
  });

  it.each(['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md'])('%s does not point agents at a redaction tool', (name) => {
    expect(read(name)).not.toMatch(/redact_message/);
  });

  it.each(['BRIDGE_CLAUDE.md', 'BRIDGE_CODEX.md'])('%s says a posted message cannot be removed and the secret must be rotated', (name) => {
    const text = read(name);
    expect(text).toMatch(/cannot remove a message/);
    expect(text).toMatch(/rotate/);
  });
});
