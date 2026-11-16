// lib/named-node.js and its wiring: under a macOS named node copy
// (bin/run-named-node) the bridge's `node` MCP servers run with that copy,
// and PATH for children still gets the real node's directory. Everywhere
// else the output is exactly what it was before.
import { describe, it, expect } from 'vitest';
import { isNamedNode, realNodePath, withNamedNodeCommands } from '../lib/named-node.js';
import { buildMcpServers } from '../lib/mcp-config.js';
import { buildClaudeSpawnEnv } from '../lib/spawn-env.js';
import { codexMcpConfig } from '../lib/codex-mcp.js';

const COPY = '/opt/example/.matron/bin/matron-bridge';
const REAL = '/opt/homebrew/Cellar/node/22.1.0/bin/node';
const PLAIN = '/usr/local/bin/node';

const SERVERS = {
  'ask-user': { command: 'node', args: ['/bridge/ask-user.js'], env: { A: '1' } },
  'show-file': { command: 'node', args: ['/bridge/show-file-mcp.js'] },
  other: { command: 'npx', args: ['-y', 'some-mcp'] },
  'node-ish': { command: '/usr/bin/node', args: ['x.js'] },
  remote: { url: 'https://example.com/mcp' },
};

const BASE_CONFIG = {
  mcpServers: { 'ask-user': { command: 'node', args: ['./ask-user.js'], env: { BRIDGE_API_URL: 'http://127.0.0.1:9802' } } },
  mcpExtras: { share: { 'show-file': { command: 'node', args: ['./show-file-mcp.js'] } } },
};

describe('isNamedNode', () => {
  it('is true only on macOS under a matron-* executable', () => {
    expect(isNamedNode(COPY, 'darwin')).toBe(true);
    expect(isNamedNode('/x/matron-viewer', 'darwin')).toBe(true);
    expect(isNamedNode(PLAIN, 'darwin')).toBe(false);
    expect(isNamedNode(COPY, 'linux')).toBe(false);
    expect(isNamedNode('/opt/example/matron-bridge/node', 'darwin')).toBe(false);
  });
});

describe('realNodePath', () => {
  it('returns the MATRON_REAL_NODE the launcher exported under a named copy', () => {
    expect(realNodePath({ execPath: COPY, env: { MATRON_REAL_NODE: REAL }, platform: 'darwin' })).toBe(REAL);
  });

  it('returns execPath under plain node, on other systems, or without the variable', () => {
    expect(realNodePath({ execPath: PLAIN, env: { MATRON_REAL_NODE: REAL }, platform: 'darwin' })).toBe(PLAIN);
    expect(realNodePath({ execPath: COPY, env: { MATRON_REAL_NODE: REAL }, platform: 'linux' })).toBe(COPY);
    expect(realNodePath({ execPath: COPY, env: {}, platform: 'darwin' })).toBe(COPY);
  });
});

describe('withNamedNodeCommands', () => {
  it('runs `node` servers with the named copy and leaves the rest alone', () => {
    const out = withNamedNodeCommands(SERVERS, { execPath: COPY, platform: 'darwin' });
    expect(out['ask-user']).toEqual({ command: COPY, args: ['/bridge/ask-user.js'], env: { A: '1' } });
    expect(out['show-file'].command).toBe(COPY);
    expect(out.other).toBe(SERVERS.other);
    expect(out['node-ish']).toBe(SERVERS['node-ish']);
    expect(out.remote).toBe(SERVERS.remote);
    expect(SERVERS['ask-user'].command).toBe('node');
  });

  it('returns the input itself when not under a named copy', () => {
    expect(withNamedNodeCommands(SERVERS, { execPath: PLAIN, platform: 'darwin' })).toBe(SERVERS);
    expect(withNamedNodeCommands(SERVERS, { execPath: COPY, platform: 'linux' })).toBe(SERVERS);
  });
});

describe('buildMcpServers under a named node copy', () => {
  it('writes the copy as the command of the node servers on macOS', () => {
    const { config } = buildMcpServers({ baseConfig: BASE_CONFIG, extras: ['share'], platform: 'darwin', askUserBaseDir: '/bridge', execPath: COPY });
    expect(config.mcpServers['ask-user'].command).toBe(COPY);
    expect(config.mcpServers['show-file'].command).toBe(COPY);
  });

  it('keeps `node` everywhere else, exactly as before', () => {
    const linux = buildMcpServers({ baseConfig: BASE_CONFIG, extras: ['share'], platform: 'linux', askUserBaseDir: '/bridge', execPath: COPY });
    const plain = buildMcpServers({ baseConfig: BASE_CONFIG, extras: ['share'], platform: 'darwin', askUserBaseDir: '/bridge', execPath: PLAIN });
    for (const { config } of [linux, plain]) {
      expect(config.mcpServers['ask-user'].command).toBe('node');
      expect(config.mcpServers['show-file'].command).toBe('node');
    }
    expect(JSON.stringify(linux.config)).toBe(JSON.stringify(
      buildMcpServers({ baseConfig: BASE_CONFIG, extras: ['share'], platform: 'linux', askUserBaseDir: '/bridge' }).config,
    ));
  });
});

describe('child PATH under a named node copy', () => {
  it('Claude sessions get the real node directory, not the copy directory', () => {
    const env = buildClaudeSpawnEnv({
      baseEnv: { PATH: '/usr/bin:/bin', MATRON_REAL_NODE: REAL },
      execPath: COPY, platform: 'darwin', pathDelimiter: ':', roomId: 'r', apiPort: 1,
    });
    expect(env.PATH).toBe('/opt/homebrew/Cellar/node/22.1.0/bin:/usr/bin:/bin');
  });

  it('Codex MCP servers run with the copy and get the real node directory on PATH', () => {
    const prev = process.env.MATRON_REAL_NODE;
    process.env.MATRON_REAL_NODE = REAL;
    try {
      const { mcp_servers: servers } = codexMcpConfig({ baseConfig: BASE_CONFIG, bridgeDir: '/bridge', roomId: 'r', apiPort: 1, nodePath: COPY, platform: 'darwin' });
      expect(servers['ask-user'].command).toBe(COPY);
      expect(servers['ask-user'].env.PATH.split(':')[0]).toBe('/opt/homebrew/Cellar/node/22.1.0/bin');
    } finally {
      if (prev === undefined) delete process.env.MATRON_REAL_NODE;
      else process.env.MATRON_REAL_NODE = prev;
    }
  });
});
