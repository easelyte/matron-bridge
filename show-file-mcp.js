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
}, createShowFileHandler({
  bridgeApi: BRIDGE_API,
  token: process.env.SHOW_FILE_TOKEN,
}));

const transport = new StdioServerTransport();
await server.connect(transport);
