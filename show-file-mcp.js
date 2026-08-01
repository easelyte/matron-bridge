#!/usr/bin/env node

// MCP server for displaying agent-created files to the operator.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_API = process.env.BRIDGE_API_URL
  || (process.env.MATRON_BRIDGE_API_PORT && `http://127.0.0.1:${process.env.MATRON_BRIDGE_API_PORT}`)
  || 'http://127.0.0.1:9802';

const DENIAL_REASONS = new Set([
  'relative-path',
  'symlink',
  'sensitive',
  'outside-scope',
  'not-a-file',
  'unreadable',
  'too-large',
  'upload-failed',
]);

const server = new McpServer({
  name: 'show-file',
  version: '1.0.0',
});

server.registerTool('show_file', {
  description: 'Display a file to the operator inline: an image (PNG/JPG/SVG/GIF/WebP) renders as a picture, any other file (PDF, report) as a downloadable attachment. The file must exist and be under the session workdir.',
  inputSchema: {
    path: z.string().refine(filePath => path.isAbsolute(filePath), 'path must be absolute'),
    caption: z.string().max(4096).optional(),
  },
}, async ({ path: filePath, caption }) => {
  const basename = path.basename(filePath);

  try {
    const postRes = await fetch(`${BRIDGE_API}/show-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: filePath,
        caption,
        token: process.env.SHOW_FILE_TOKEN,
      }),
    });
    const data = await postRes.json();

    if (!postRes.ok) {
      const reason = DENIAL_REASONS.has(data?.error) ? data.error : 'internal error';
      return { content: [{ type: 'text', text: `Could not show ${basename}: ${reason}` }] };
    }

    if (!data?.ok || (data.kind !== 'image' && data.kind !== 'file')) {
      return { content: [{ type: 'text', text: `Could not show ${basename}: internal error` }] };
    }

    return { content: [{ type: 'text', text: `Shown to operator: ${basename} (${data.kind}).` }] };
  } catch (_error) {
    return { content: [{ type: 'text', text: `Could not show ${basename}: internal error` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
