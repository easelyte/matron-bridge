#!/usr/bin/env node

// MCP server for displaying agent-created files to the operator.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createShowFileHandler } from './lib/show-file-mcp-adapter.js';

const BRIDGE_API = process.env.BRIDGE_API_URL
  || (process.env.MATRON_BRIDGE_API_PORT && `http://127.0.0.1:${process.env.MATRON_BRIDGE_API_PORT}`)
  || 'http://127.0.0.1:9802';

// The adapter sends the session capability token and the agent-supplied path to
// BRIDGE_API. A stale or non-loopback value would leak the token and local path
// metadata to another host or process, so require an explicit loopback HTTP
// origin and fail loudly for any other scheme or host (fail-loud config).
{
  let parsedBridgeApi;
  try {
    parsedBridgeApi = new URL(BRIDGE_API);
  } catch {
    throw new Error(`Invalid BRIDGE_API_URL: ${JSON.stringify(BRIDGE_API)}`);
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (parsedBridgeApi.protocol !== 'http:' || !loopbackHosts.has(parsedBridgeApi.hostname)) {
    throw new Error(
      `BRIDGE_API_URL must be a loopback http origin (127.0.0.1, localhost, or ::1); got ${JSON.stringify(BRIDGE_API)}`,
    );
  }
}

const server = new McpServer({
  name: 'show-file',
  version: '1.0.0',
});

server.registerTool('show_file', {
  description: 'Display a file to the operator inline: an image (PNG/JPG/GIF/WebP) renders as a picture, any other file (PDF, SVG, report) as a downloadable attachment. The file must exist and be under the session workdir.',
  inputSchema: {
    path: z.string().refine(filePath => path.isAbsolute(filePath), 'path must be absolute'),
    caption: z.string().max(4096).optional(),
  },
}, createShowFileHandler({
  bridgeApi: BRIDGE_API,
  token: process.env.SHOW_FILE_TOKEN,
}));

const transport = new StdioServerTransport();
await server.connect(transport);
