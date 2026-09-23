// Behavioral tests for the agent-session child envs (lib/spawn-env.js).
// These replace the source-text pins that used to check how index.js spelled
// the env object literals (loop #784): assert what the child gets instead.
import { describe, it, expect } from 'vitest';
import { buildClaudeSpawnEnv, buildCodexSpawnEnv, pathWithNodeBin } from '../lib/spawn-env.js';
import { DEFAULT_BASH_DEFAULT_TIMEOUT_MS, DEFAULT_BASH_MAX_TIMEOUT_MS } from '../lib/bash-timeout-env.js';

const EXEC = '/opt/node/bin/node';
const BRIDGE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/bridge',
  JOURNAL_TOKEN: 'full-read-secret',
  JOURNAL_TOKEN_FILE: '/run/journal.token',
  JOURNAL_WS_URL: 'wss://journal.example/ws',
  HMAC_SECRET: 'viewer-signing-key',
  SHOW_FILE_TOKEN: 'inherited-show-file',
  MATRON_PERMISSION_TOKEN: 'inherited-permission',
  MATRON_PERMISSION_CARDS: '1',
  CLAUDECODE: '1',
  MCP_TOOL_TIMEOUT: '600000',
});

function claude(mode, overrides = {}) {
  return buildClaudeSpawnEnv({
    mode,
    baseEnv: BRIDGE_ENV,
    execPath: EXEC,
    roomId: '!room:example',
    apiPort: 8787,
    journalProxyHeaderFile: '/run/matron/proxy/header',
    pluginCacheDir: '/var/cache/plugins',
    showBashOutput: true,
    showFileToken: 'session-show-file',
    permissionToken: 'session-permission',
    warn: () => {},
    ...overrides,
  });
}

describe('buildClaudeSpawnEnv', () => {
  for (const mode of ['print', 'iv']) {
    describe(`${mode} mode`, () => {
      it('strips the full-journal read credential and bridge-only secrets', () => {
        const env = claude(mode);
        expect('JOURNAL_TOKEN' in env).toBe(false);
        expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
        expect('HMAC_SECRET' in env).toBe(false);
        // Non-credential journal config and the rest of the bridge env pass through.
        expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
        expect(env.HOME).toBe('/home/bridge');
        expect(env.MCP_TOOL_TIMEOUT).toBe('600000');
      });

      it('never mutates the base env', () => {
        const base = { ...BRIDGE_ENV };
        claude(mode, { baseEnv: base });
        expect(base).toEqual(BRIDGE_ENV);
      });

      it('sets the session wiring keys', () => {
        const env = claude(mode);
        expect(env.CLAUDECODE).toBe('');
        expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
        expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
        expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
        expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe('/var/cache/plugins');
        expect(env.MATRON_BASH_TEE_ENABLED).toBe('1');
        expect(claude(mode, { showBashOutput: false }).MATRON_BASH_TEE_ENABLED).toBe('0');
      });

      it('passes the read-proxy capability as a header-file path, never a token value', () => {
        const env = claude(mode);
        expect(env.MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/run/matron/proxy/header');
        expect(Object.values(env)).not.toContain('full-read-secret');
      });

      it('prepends the node bin dir to PATH once', () => {
        expect(claude(mode).PATH).toBe('/opt/node/bin:/usr/bin:/bin');
        const already = claude(mode, { baseEnv: { ...BRIDGE_ENV, PATH: '/usr/bin:/opt/node/bin' } });
        expect(already.PATH).toBe('/usr/bin:/opt/node/bin');
        expect(claude(mode, { baseEnv: {} }).PATH).toBe('/opt/node/bin:');
      });

      it('applies the Bash timeout floor, honouring the bridge env override', () => {
        const env = claude(mode);
        expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(DEFAULT_BASH_DEFAULT_TIMEOUT_MS));
        expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(DEFAULT_BASH_MAX_TIMEOUT_MS));
        const custom = claude(mode, { baseEnv: { ...BRIDGE_ENV, BASH_DEFAULT_TIMEOUT_MS: '700000', BASH_MAX_TIMEOUT_MS: '900000' } });
        expect(custom.BASH_DEFAULT_TIMEOUT_MS).toBe('700000');
        expect(custom.BASH_MAX_TIMEOUT_MS).toBe('900000');
      });

      it('loads MCP tools up front unless the bridge env says otherwise', () => {
        expect(claude(mode).ENABLE_TOOL_SEARCH).toBe('false');
        expect(claude(mode, { baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: 'auto:10' } }).ENABLE_TOOL_SEARCH).toBe('auto:10');
        // `??`, not `||`: an explicit empty string is the operator's choice.
        expect(claude(mode, { baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: '' } }).ENABLE_TOOL_SEARCH).toBe('');
      });

      it('carries only the per-session SHOW_FILE_TOKEN, never an inherited one', () => {
        expect(claude(mode).SHOW_FILE_TOKEN).toBe('session-show-file');
        expect('SHOW_FILE_TOKEN' in claude(mode, { showFileToken: undefined })).toBe(false);
      });
    });
  }

  it('print: snapshots MATRON_PERMISSION_CARDS and injects the per-session permission token', () => {
    const env = claude('print');
    expect(env.MATRON_PERMISSION_CARDS).toBe('1');
    expect(env.MATRON_PERMISSION_TOKEN).toBe('session-permission');
    const off = claude('print', { baseEnv: { ...BRIDGE_ENV, MATRON_PERMISSION_CARDS: undefined } });
    expect(off.MATRON_PERMISSION_CARDS).toBe('');
  });

  it('iv: carries neither permission-card key, even when the bridge env has them', () => {
    const env = claude('iv');
    expect('MATRON_PERMISSION_CARDS' in env).toBe(false);
    expect('MATRON_PERMISSION_TOKEN' in env).toBe(false);
  });

  it('rejects an unknown mode or a non-object base env', () => {
    expect(() => claude('exec')).toThrow(RangeError);
    expect(() => claude('print', { baseEnv: null })).toThrow(TypeError);
  });
});

describe('buildCodexSpawnEnv', () => {
  const codex = (appServer) => buildCodexSpawnEnv({
    baseEnv: BRIDGE_ENV, roomId: '!room:example', apiPort: 8787, appServer,
    journalProxyHeaderFile: '/run/matron/proxy/header',
  });

  for (const appServer of [true, false]) {
    describe(appServer ? 'app-server transport' : 'legacy exec transport', () => {
      const env = codex(appServer);

      it('strips bridge-only secrets', () => {
        expect('HMAC_SECRET' in env).toBe(false);
      });

      it('sets the bridge wiring keys and passes the rest through', () => {
        expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
        expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
      });

      it('passes the journal read-proxy capability as a header-file path', () => {
        expect(env.MATRON_JOURNAL_PROXY_HEADER_FILE).toBe('/run/matron/proxy/header');
      });
    });
  }

  // Loop #781: app-server sessions have the item_* / mission MCP tools and reach
  // journal search through the read proxy, so they never need the full-read token.
  it('app-server: strips the full-journal read credential', () => {
    const env = codex(true);
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
    expect(Object.values(env)).not.toContain('full-read-secret');
  });

  // Legacy exec sessions have no Matron MCP tools; BRIDGE_CODEX.md's /items
  // HTTP fallback authenticates with the token, so they keep it.
  it('legacy exec: keeps the journal token for the /items fallback', () => {
    const env = codex(false);
    expect(env.JOURNAL_TOKEN).toBe('full-read-secret');
    expect(env.JOURNAL_TOKEN_FILE).toBe('/run/journal.token');
  });

  it('fails safe: an unspecified transport is treated as app-server (token stripped)', () => {
    const env = buildCodexSpawnEnv({ baseEnv: BRIDGE_ENV, roomId: 'r', apiPort: 1 });
    expect('JOURNAL_TOKEN' in env).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in env).toBe(false);
  });

  it('never mutates the base env', () => {
    const base = { ...BRIDGE_ENV };
    buildCodexSpawnEnv({ baseEnv: base, roomId: 'r', apiPort: 1, appServer: true });
    expect(base).toEqual(BRIDGE_ENV);
  });

  it('rejects a non-object base env', () => {
    expect(() => buildCodexSpawnEnv({ baseEnv: 'nope' })).toThrow(TypeError);
  });
});

describe('pathWithNodeBin', () => {
  it('matches whole PATH entries, not substrings', () => {
    expect(pathWithNodeBin('/opt/node/bin-old:/usr/bin', EXEC)).toBe('/opt/node/bin:/opt/node/bin-old:/usr/bin');
  });
});
