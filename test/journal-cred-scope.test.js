import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  stripJournalCreds, stripBridgeOnlySecrets,
  JOURNAL_CHILD_STRIPPED_KEYS, BRIDGE_ONLY_SECRET_KEYS, PROVIDER_API_KEYS,
} from '../lib/journal-cred-scope.js';
import { withCodexAppServer } from '../lib/codex-account.js';
import { runSleepCommand } from '../lib/sleep-command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

const SECRET_ENV = Object.freeze({
  PATH: '/usr/bin',
  JOURNAL_TOKEN: 'agent-token',
  JOURNAL_TOKEN_FILE: '/etc/matron/agent-token',
  JOURNAL_WS_URL: 'wss://journal.example/ws',
  HMAC_SECRET: 'viewer-signing-key',
  OPENAI_API_KEY: 'sk-summary',
  GEMINI_API_KEY: 'gemini-summary',
  MATRON_BRIDGE_API_PORT: '9812',
});

function withProcessEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('stripBridgeOnlySecrets', () => {
  it('removes HMAC_SECRET and keeps everything else, journal token included', () => {
    const out = stripBridgeOnlySecrets(SECRET_ENV);
    expect('HMAC_SECRET' in out).toBe(false);
    expect(out.JOURNAL_TOKEN).toBe('agent-token');
    expect(out.OPENAI_API_KEY).toBe('sk-summary');
    expect(out.JOURNAL_TOKEN_FILE).toBe('/etc/matron/agent-token');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('returns a copy and never mutates the caller', () => {
    const env = { ...SECRET_ENV };
    const out = stripBridgeOnlySecrets(env);
    expect(out).not.toBe(env);
    expect(env).toEqual(SECRET_ENV);
  });

  it('fails safe on a missing arg and rejects non-objects', () => {
    withProcessEnv({ HMAC_SECRET: 'boot-secret' }, () => {
      expect('HMAC_SECRET' in stripBridgeOnlySecrets()).toBe(false);
      expect(process.env.HMAC_SECRET).toBe('boot-secret');
    });
    expect(stripBridgeOnlySecrets(null)).toEqual({});
    expect(() => stripBridgeOnlySecrets('nope')).toThrow(TypeError);
  });

  it('targets exactly the bridge-only secrets', () => {
    expect(BRIDGE_ONLY_SECRET_KEYS).toEqual(['HMAC_SECRET']);
  });
});

describe('stripJournalCreds', () => {
  it('removes the journal credential and the bridge-only secrets', () => {
    const out = stripJournalCreds(SECRET_ENV);
    expect('JOURNAL_TOKEN' in out).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in out).toBe(false);
    expect('HMAC_SECRET' in out).toBe(false);
    expect('OPENAI_API_KEY' in out).toBe(false);
    expect('GEMINI_API_KEY' in out).toBe(false);
    // Non-credential config a journal-free child may still need survives.
    expect(out.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
    expect(out.MATRON_BRIDGE_API_PORT).toBe('9812');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('returns a copy and never mutates the caller (safe on process.env)', () => {
    const env = { ...SECRET_ENV };
    const out = stripJournalCreds(env);
    expect(out).not.toBe(env);
    expect(env).toEqual(SECRET_ENV);
  });

  it('fails safe: an omitted arg returns a sanitized copy of process.env', () => {
    withProcessEnv({ JOURNAL_TOKEN: 'boot-token', JOURNAL_TOKEN_FILE: '/etc/matron/agent-token', HMAC_SECRET: 'boot-secret' }, () => {
      const out = stripJournalCreds();
      expect('JOURNAL_TOKEN' in out).toBe(false);
      expect('JOURNAL_TOKEN_FILE' in out).toBe(false);
      expect('HMAC_SECRET' in out).toBe(false);
      expect(process.env.JOURNAL_TOKEN).toBe('boot-token');
      expect(process.env.HMAC_SECRET).toBe('boot-secret');
    });
  });

  it('is a no-op on a clean env and rejects invalid non-objects', () => {
    expect(stripJournalCreds({ FOO: '1' })).toEqual({ FOO: '1' });
    expect(stripJournalCreds(null)).toEqual({});
    expect(() => stripJournalCreds('nope')).toThrow(TypeError);
    expect(() => stripJournalCreds(42)).toThrow(TypeError);
  });

  it('targets exactly the two journal credential keys', () => {
    expect(JOURNAL_CHILD_STRIPPED_KEYS).toEqual(['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE']);
  });

  it('keeps the provider keys only when asked', () => {
    expect(PROVIDER_API_KEYS).toEqual(['OPENAI_API_KEY', 'GEMINI_API_KEY']);
    const out = stripJournalCreds(SECRET_ENV, { keepProviderKeys: true });
    expect(out.OPENAI_API_KEY).toBe('sk-summary');
    expect(out.GEMINI_API_KEY).toBe('gemini-summary');
    expect('JOURNAL_TOKEN' in out).toBe(false);
    expect('HMAC_SECRET' in out).toBe(false);
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

describe('journal-free child spawns carry no journal credential or bridge-only secret', () => {
  it('codex account reader: withCodexAppServer', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    const inputEnv = { ...SECRET_ENV, CODEX_HOME: '/home/user/.codex' };
    void withCodexAppServer(async () => {}, { cwd: '/w', env: inputEnv, spawnImpl, timeoutMs: 50 })
      .catch(() => {});
    await Promise.resolve();

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const passedEnv = spawnImpl.mock.calls[0][2].env;
    expect('JOURNAL_TOKEN' in passedEnv).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in passedEnv).toBe(false);
    expect('HMAC_SECRET' in passedEnv).toBe(false);
    expect(passedEnv.CODEX_HOME).toBe('/home/user/.codex');
    // Codex can authenticate with OPENAI_API_KEY: the account reader keeps it.
    expect(passedEnv.OPENAI_API_KEY).toBe('sk-summary');
    expect(inputEnv.JOURNAL_TOKEN).toBe('agent-token');
  });

  it('sleep command: runSleepCommand', () => {
    withProcessEnv({ JOURNAL_TOKEN: 'boot-token', HMAC_SECRET: 'boot-secret', OPENAI_API_KEY: 'sk-boot' }, () => {
      const spawn = vi.fn(() => fakeChild());
      void runSleepCommand('poweroff', { spawn, setTimer: () => {} }).catch(() => {});
      const passedEnv = spawn.mock.calls[0][2].env;
      expect(passedEnv).toBeTypeOf('object');
      expect('JOURNAL_TOKEN' in passedEnv).toBe(false);
      expect('HMAC_SECRET' in passedEnv).toBe(false);
      expect('OPENAI_API_KEY' in passedEnv).toBe(false);
      expect(passedEnv.PATH).toBe(process.env.PATH);
    });
  });
});

describe('index.js child spawns are scoped', () => {
  // Source-level: index.js is an entrypoint with no exports, so the wiring of
  // its spawn sites can only be checked here. What the builders return is
  // covered behaviorally in spawn-env.test.js.
  it('never hands a child a bare copy of process.env', () => {
    const bare = [...indexSrc.matchAll(/\.\.\.process\.env\b/g)].map(m => indexSrc.slice(Math.max(0, m.index - 40), m.index));
    for (const before of bare) expect(before).toMatch(/stripJournalCreds\(\{\s*$/);
    expect(indexSrc).not.toMatch(/env:\s*process\.env\b/);
  });

  it('passes an explicit env to every direct spawn (none inherits process.env)', () => {
    const sites = [...indexSrc.matchAll(/\b(spawn|execFileSync)\(/g)].map(m => m.index);
    expect(sites.length).toBeGreaterThan(0);
    for (const at of sites) {
      // Walk to the matching close paren and require an env key in between.
      let depth = 0;
      let end = at;
      for (let i = indexSrc.indexOf('(', at); i < indexSrc.length; i++) {
        if (indexSrc[i] === '(') depth++;
        else if (indexSrc[i] === ')' && --depth === 0) { end = i; break; }
      }
      expect(indexSrc.slice(at, end), `spawn at offset ${at}`).toMatch(/\benv:/);
    }
  });

  it('builds the Claude and Codex session envs through lib/spawn-env.js, with the read-proxy header file', () => {
    for (const re of [/const spawnEnv = buildClaudeSpawnEnv\(\{([^}]*)\}\)/, /const interactiveEnv = buildClaudeSpawnEnv\(\{([^}]*)\}\)/]) {
      const m = indexSrc.match(re);
      expect(m).not.toBeNull();
      expect(m[1]).toMatch(/journalProxyHeaderFile: JOURNAL_PROXY_HEADER_FILE/);
    }
    const codex = indexSrc.match(/env: buildCodexSpawnEnv\(\{([^}]*)\}\)/);
    expect(codex).not.toBeNull();
    expect(codex[1]).toMatch(/appServer: CODEX_APP_SERVER/);
    expect(codex[1]).toMatch(/journalProxyHeaderFile: JOURNAL_PROXY_HEADER_FILE/);
  });

  it('writes the proxy capability to a 0600 header file, never into an env value', () => {
    expect(indexSrc).toMatch(/fs\.writeFileSync\(file, `X-Matron-Journal-Proxy-Token: \$\{JOURNAL_PROXY_CAP_TOKEN\}\\n`, \{ mode: 0o600 \}\)/);
    expect(indexSrc).not.toMatch(/MATRON_JOURNAL_PROXY_TOKEN/);
  });

  it('scopes the `claude -p /usage` one-shot and the ps read', () => {
    const start = indexSrc.indexOf('function fetchUsageLimitsText(');
    expect(start).toBeGreaterThan(-1);
    expect(indexSrc.slice(start, start + 2000)).toMatch(/env: stripJournalCreds\(\{ \.\.\.process\.env, CLAUDECODE: '' \}\)/);
    expect(indexSrc).toMatch(/execFileSync\('ps', [^\n]*env: stripJournalCreds\(\)/);
  });
});
