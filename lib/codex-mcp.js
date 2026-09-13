import path from 'node:path';
import { buildMcpServers } from './mcp-config.js';

export function codexMcpConfig({ baseConfig, extras = [], bridgeDir, roomId, apiPort, showFileToken,
  nodePath = process.execPath, platform = process.platform } = {}) {
  const { config } = buildMcpServers({ baseConfig, extras, platform, askUserBaseDir: bridgeDir });
  const servers = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.command) {
      servers[name] = { command: server.command === 'node' ? nodePath : server.command,
        args: server.args || [], env: { ...(server.env || {}) },
        tool_timeout_sec: 600, enabled: true };
    } else if (server.url) servers[name] = { url: server.url, http_headers: server.headers || {}, enabled: true };
  }
  for (const name of ['ask-user', 'show-file']) {
    if (!servers[name]) continue;
    if (name === 'show-file' && !showFileToken) { delete servers[name]; continue; }
    // Remote entries have no subprocess environment. Never send local room
    // capabilities or viewer tokens to a configured HTTP server.
    if (!servers[name].command) continue;
    Object.assign(servers[name].env, { BRIDGE_ROOM_ID: roomId,
      BRIDGE_API_URL: `http://127.0.0.1:${apiPort}`, MATRON_BRIDGE_API_PORT: String(apiPort),
      PATH: `${path.dirname(nodePath)}:${process.env.PATH || ''}` });
    if (name === 'show-file') {
      servers[name].env.SHOW_FILE_TOKEN = showFileToken;
    }
  }
  // Claude's auto-permission shim must not bypass native Codex approvals.
  if (servers['ask-user']) servers['ask-user'].disabled_tools = ['permission_request'];
  return { mcp_servers: servers };
}
