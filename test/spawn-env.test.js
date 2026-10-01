// Behavioral tests for the agent-session child envs (lib/spawn-env.js):
// assert what the child gets rather than how index.js spells the literal.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildClaudeSpawnEnv, buildCodexSpawnEnv, pathWithNodeBin } from '../lib/spawn-env.js';

const EXEC = '/opt/node/bin/node';
const BRIDGE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/bridge',
  JOURNAL_TOKEN: 'agent-token',
  JOURNAL_TOKEN_FILE: '/etc/matron/agent-token',
  JOURNAL_WS_URL: 'wss://journal.example/ws',
  HMAC_SECRET: 'viewer-signing-key',
  OPENAI_API_KEY: 'sk-user',
  SHOW_FILE_TOKEN: 'inherited-show-file',
  // Fork delta: permission cards.
  MATRON_PERMISSION_TOKEN: 'inherited-permission',
  MATRON_PERMISSION_CARDS: '1',
  CLAUDECODE: '1',
  MCP_TOOL_TIMEOUT: '600000',
});

// Fork delta: buildClaudeSpawnEnv takes a required mode ('print' | 'iv');
// the shared expectations below run in print mode.
function claude(overrides = {}) {
  return buildClaudeSpawnEnv({
    mode: 'print',
    permissionToken: 'session-permission',
    baseEnv: BRIDGE_ENV,
    execPath: EXEC,
    pathDelimiter: ':',
    roomId: '!room:example',
    apiPort: 8787,
    journalProxyHeaderFile: '/tmp/matron-journal-proxy-x/header',
    pluginCacheDir: '/var/cache/plugins',
    showBashOutput: true,
    showFileToken: 'session-show-file',
    ...overrides,
  });
}

describe('buildClaudeSpawnEnv', () => {
  it('strips HMAC_SECRET', () => {
    const env = claude();
    expect('HMAC_SECRET' in env).toBe(false);
    expect(Object.values(env)).not.toContain('viewer-signing-key');
  });

  it('strips the journal token (search goes through the read proxy)', () => {
    const env = claude();
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
    expect(Object.values(env)).not.toContain('agent-token');
    // Non-credential journal config passes through.
    expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
  });

  it('passes the read-proxy capability as a header-file path', () => {
    expect(claude().MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/tmp/matron-journal-proxy-x/header');
    expect(claude({ journalProxyHeaderFile: '' }).MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('');
    expect(claude({ journalProxyHeaderFile: undefined }).MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('');
  });

  it('passes the rest of the bridge env through', () => {
    const env = claude();
    expect(env.HOME).toBe('/home/bridge');
    expect(env.MCP_TOOL_TIMEOUT).toBe('600000');
    // The user's provider keys stay with the session.
    expect(env.OPENAI_API_KEY).toBe('sk-user');
  });

  it('never mutates the base env', () => {
    const base = { ...BRIDGE_ENV };
    claude({ baseEnv: base });
    expect(base).toEqual(BRIDGE_ENV);
  });

  it('sets the session wiring keys', () => {
    const env = claude();
    expect(env.CLAUDECODE).toBe('');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
    expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
    expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
    expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe('/var/cache/plugins');
    expect(env.MATRON_BASH_TEE_ENABLED).toBe('1');
    expect(claude({ showBashOutput: false }).MATRON_BASH_TEE_ENABLED).toBe('0');
  });

  it('prepends the node bin dir to PATH once', () => {
    expect(claude().PATH).toBe('/opt/node/bin:/usr/bin:/bin');
    expect(claude({ baseEnv: { ...BRIDGE_ENV, PATH: '/usr/bin:/opt/node/bin' } }).PATH).toBe('/usr/bin:/opt/node/bin');
    expect(claude({ baseEnv: {} }).PATH).toBe('/opt/node/bin:');
  });

  it('loads MCP tools up front unless the bridge env says otherwise', () => {
    expect(claude().ENABLE_TOOL_SEARCH).toBe('false');
    expect(claude({ baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: 'auto:10' } }).ENABLE_TOOL_SEARCH).toBe('auto:10');
    // `??`, not `||`: an explicit empty string is the operator's choice.
    expect(claude({ baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: '' } }).ENABLE_TOOL_SEARCH).toBe('');
  });

  it('carries only the per-session SHOW_FILE_TOKEN, never an inherited one', () => {
    expect(claude().SHOW_FILE_TOKEN).toBe('session-show-file');
    expect('SHOW_FILE_TOKEN' in claude({ showFileToken: undefined })).toBe(false);
  });

  it('rejects a non-object base env', () => {
    expect(() => claude({ baseEnv: null })).toThrow(TypeError);
    expect(() => claude({ baseEnv: 'nope' })).toThrow(TypeError);
  });
});

describe('buildCodexSpawnEnv', () => {
  const codex = (overrides = {}) => buildCodexSpawnEnv({
    baseEnv: BRIDGE_ENV, roomId: '!room:example', apiPort: 8787,
    journalProxyHeaderFile: '/tmp/matron-journal-proxy-x/header', ...overrides,
  });

  it('strips HMAC_SECRET on both transports', () => {
    expect('HMAC_SECRET' in codex({ appServer: true })).toBe(false);
    expect('HMAC_SECRET' in codex({ appServer: false })).toBe(false);
  });

  it('app-server: strips the journal token (MCP tools for writes, read proxy for search)', () => {
    const env = codex({ appServer: true });
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
  });

  it('legacy exec: keeps the journal token for the /items HTTP fallback', () => {
    const env = codex({ appServer: false });
    expect(env.JOURNAL_TOKEN).toBe('agent-token');
    expect(env.JOURNAL_TOKEN_FILE).toBe('/etc/matron/agent-token');
  });

  it('fails safe: an unspecified transport is treated as app-server', () => {
    const env = codex();
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
  });

  it('passes the read-proxy header file on both transports', () => {
    expect(codex({ appServer: true }).MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/tmp/matron-journal-proxy-x/header');
    expect(codex({ appServer: false }).MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/tmp/matron-journal-proxy-x/header');
  });

  it('sets the bridge wiring keys and passes the rest through', () => {
    const env = codex();
    expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
    expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
    expect(codex({ appServer: true }).OPENAI_API_KEY).toBe('sk-user');
    expect(codex({ appServer: false }).OPENAI_API_KEY).toBe('sk-user');
  });

  it('never mutates the base env', () => {
    const base = { ...BRIDGE_ENV };
    codex({ baseEnv: base });
    expect(base).toEqual(BRIDGE_ENV);
  });

  it('rejects a non-object base env', () => {
    expect(() => codex({ baseEnv: 'nope' })).toThrow(TypeError);
  });
});

// easelyte fork delta: permission cards (MATRON_PERMISSION_CARDS /
// MATRON_PERMISSION_TOKEN) reach print sessions only.
describe('buildClaudeSpawnEnv permission-card keys (fork)', () => {
  it('print: snapshots MATRON_PERMISSION_CARDS and injects the per-session permission token', () => {
    const env = claude({ mode: 'print' });
    expect(env.MATRON_PERMISSION_CARDS).toBe('1');
    expect(env.MATRON_PERMISSION_TOKEN).toBe('session-permission');
    const off = claude({ mode: 'print', baseEnv: { ...BRIDGE_ENV, MATRON_PERMISSION_CARDS: undefined } });
    expect(off.MATRON_PERMISSION_CARDS).toBe('');
  });

  it('iv: carries neither permission-card key, even when the bridge env has them', () => {
    const env = claude({ mode: 'iv' });
    expect('MATRON_PERMISSION_CARDS' in env).toBe(false);
    expect('MATRON_PERMISSION_TOKEN' in env).toBe(false);
  });

  it('iv: otherwise the same shape as print (credentials stripped, wiring set)', () => {
    const env = claude({ mode: 'iv' });
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('HMAC_SECRET' in env).toBe(false);
    expect(env.MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/tmp/matron-journal-proxy-x/header');
    expect(env.SHOW_FILE_TOKEN).toBe('session-show-file');
  });

  it('rejects an unknown or missing mode', () => {
    expect(() => claude({ mode: 'exec' })).toThrow(RangeError);
    expect(() => claude({ mode: undefined })).toThrow(RangeError);
  });
});

describe('pathWithNodeBin', () => {
  it('matches whole PATH entries, not substrings', () => {
    expect(pathWithNodeBin('/opt/node/bin-old:/usr/bin', EXEC, ':')).toBe('/opt/node/bin:/opt/node/bin-old:/usr/bin');
  });

  it('uses ; on Windows and leaves an already-present dir alone', () => {
    const exec = 'C:\\nodejs\\node.exe';
    const dir = path.dirname(exec);
    expect(pathWithNodeBin('C:\\Windows;C:\\Git\\bin', exec, ';')).toBe(`${dir};C:\\Windows;C:\\Git\\bin`);
    expect(pathWithNodeBin(`C:\\Windows;${dir}`, exec, ';')).toBe(`C:\\Windows;${dir}`);
  });
});
