// Explicit operator smoke test: ephemeral threads, no model turns, no tool
// execution, no login changes. Never include config values or credentials in
// the report. Kept out of npm test so CI needs no Codex installation/account.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CodexRpcClient } from '../lib/codex-rpc.js';
import { codexMcpConfig } from '../lib/codex-mcp.js';
import { codexPlanConfig } from '../lib/codex-app-session.js';

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let client = new CodexRpcClient({ cwd: bridgeDir });
client.on('request', request => client.rejectRequest(request.id, 'No actions allowed during contract check.'));
try {
  await client.connect();
  const { config: defaults } = await client.request('config/read', { cwd: bridgeDir, includeLayers: false });
  const injected = codexMcpConfig({ baseConfig: JSON.parse(fs.readFileSync(path.join(bridgeDir, 'mcp-config.json'), 'utf8')),
    bridgeDir, roomId: 'codex-contract-check', apiPort: 9802 });
  const config = { ...codexPlanConfig({}, defaults), mcp_servers: {
    ...Object.fromEntries(Object.keys(defaults.mcp_servers || {}).map(name => [name, { enabled: false }])),
    'ask-user': injected.mcp_servers['ask-user'],
  } };
  const start = (overrides, approvalPolicy = 'on-request') => client.request('thread/start', { cwd: bridgeDir, ephemeral: true,
    sandbox: 'read-only', approvalPolicy, approvalsReviewer: 'user', config: { ...config, ...overrides } });
  const thread = await start({});
  assert.equal(thread.approvalPolicy, 'on-request');
  let tools;
  for (let attempt = 0; attempt < 30; attempt++) {
    const page = await client.request('mcpServerStatus/list', { threadId: thread.thread.id, limit: 100, detail: 'toolsAndAuthOnly' });
    tools = page.data?.find(server => server.name === 'ask-user')?.tools;
    if (tools?.request_secret) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(tools?.request_secret, 'Native thread did not discover Matron request_secret');
  assert.ok(tools?.send_attachment, 'Native thread did not discover Matron attachments');
  // Production reconnects for permission/tool changes: avoid cross-thread
  // discovery caches in a shared process, and verify that exact lifecycle.
  client.close();
  client = new CodexRpcClient({ cwd: bridgeDir });
  client.on('request', request => client.rejectRequest(request.id));
  await client.connect();
  const planned = await start(codexPlanConfig(config, defaults), 'never');
  assert.equal(planned.sandbox.type, 'readOnly');
  const disabled = await client.request('mcpServerStatus/list', { threadId: planned.thread.id, limit: 100, detail: 'toolsAndAuthOnly' });
  assert.ok(!disabled.data?.some(server => Object.keys(server.tools || {}).length), 'Plan-mode tool disable did not take effect');
  const listed = await client.request('thread/list', { cwd: bridgeDir, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], archived: false, sortKey: 'updated_at', limit: 1 });
  assert.ok(Array.isArray(listed.data));
  for (const networkAccess of [true, false]) {
    client.close();
    client = new CodexRpcClient({ cwd: bridgeDir });
    client.on('request', request => client.rejectRequest(request.id));
    await client.connect();
    const network = await client.request('thread/start', { cwd: bridgeDir, ephemeral: true,
      sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      config: { ...codexPlanConfig(config, defaults), 'sandbox_workspace_write.network_access': networkAccess } });
    assert.equal(network.sandbox.type, 'workspaceWrite');
    assert.equal(network.sandbox.networkAccess, networkAccess);
  }
  console.log('PASS: initialize, scoped MCP discovery, plan-mode MCP disable, native thread listing, explicit network settings. No model turns or tools executed.');
} finally {
  client.close();
}
