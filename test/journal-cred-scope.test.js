import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { stripJournalCreds, JOURNAL_CHILD_STRIPPED_KEYS, stripBridgeOnlySecrets, BRIDGE_ONLY_SECRET_KEYS } from '../lib/journal-cred-scope.js';
import { withCodexAppServer } from '../lib/codex-account.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

describe('stripJournalCreds', () => {
  it('removes the full-journal read credential from a child env', () => {
    const env = {
      PATH: '/usr/bin',
      JOURNAL_TOKEN: 'full-read-secret',
      JOURNAL_TOKEN_FILE: '/run/journal.token',
      MATRON_BRIDGE_API_PORT: '9812',
    };
    const out = stripJournalCreds(env);
    expect('JOURNAL_TOKEN' in out).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in out).toBe(false);
    // Non-credential env a journal-free child still needs is preserved.
    expect(out.MATRON_BRIDGE_API_PORT).toBe('9812');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('returns a COPY and never mutates the caller (safe on process.env)', () => {
    const env = { JOURNAL_TOKEN: 'x', JOURNAL_TOKEN_FILE: '/f', KEEP: '1' };
    const out = stripJournalCreds(env);
    expect(out).not.toBe(env);
    // Caller's object is untouched — clobbering process.env would break the
    // bridge's own journal auth.
    expect(env.JOURNAL_TOKEN).toBe('x');
    expect(env.JOURNAL_TOKEN_FILE).toBe('/f');
    expect(out.KEEP).toBe('1');
    expect('JOURNAL_TOKEN' in out).toBe(false);
  });

  it('fails safe: omitted arg returns a sanitized copy of process.env, not the full env', () => {
    const saved = { t: process.env.JOURNAL_TOKEN, f: process.env.JOURNAL_TOKEN_FILE };
    process.env.JOURNAL_TOKEN = 'boot-secret';
    process.env.JOURNAL_TOKEN_FILE = '/etc/matron/agent-token';
    try {
      const out = stripJournalCreds();
      expect('JOURNAL_TOKEN' in out).toBe(false);
      expect('JOURNAL_TOKEN_FILE' in out).toBe(false);
      // ...and the real process.env is left intact.
      expect(process.env.JOURNAL_TOKEN).toBe('boot-secret');
    } finally {
      if (saved.t === undefined) delete process.env.JOURNAL_TOKEN; else process.env.JOURNAL_TOKEN = saved.t;
      if (saved.f === undefined) delete process.env.JOURNAL_TOKEN_FILE; else process.env.JOURNAL_TOKEN_FILE = saved.f;
    }
  });

  it('is a no-op on env with no journal creds and rejects invalid non-objects', () => {
    expect(stripJournalCreds({ FOO: '1' })).toEqual({ FOO: '1' });
    expect(stripJournalCreds(null)).toEqual({});
    expect(() => stripJournalCreds('nope')).toThrow(TypeError);
    expect(() => stripJournalCreds(42)).toThrow(TypeError);
  });

  it('targets exactly the two full-journal read credential keys', () => {
    expect(JOURNAL_CHILD_STRIPPED_KEYS).toEqual(['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE']);
  });
});

describe('codex account-reader app-server is spawned without the journal credential', () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    return child;
  }

  it('strips JOURNAL_TOKEN / JOURNAL_TOKEN_FILE from the spawned env, keeping other vars', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    const inputEnv = {
      PATH: '/usr/bin',
      JOURNAL_TOKEN: 'full-read-secret',
      JOURNAL_TOKEN_FILE: '/run/journal.token',
      CODEX_HOME: '/home/codex',
    };
    // Never resolves the callback (fake child emits nothing); race it against a
    // microtask so we only observe the synchronous spawn call.
    void withCodexAppServer(async () => {}, { cwd: '/w', env: inputEnv, spawnImpl, timeoutMs: 50 })
      .catch(() => {});
    await Promise.resolve();

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const passedEnv = spawnImpl.mock.calls[0][2].env;
    expect('JOURNAL_TOKEN' in passedEnv).toBe(false);
    expect('JOURNAL_TOKEN_FILE' in passedEnv).toBe(false);
    expect(passedEnv.PATH).toBe('/usr/bin');
    expect(passedEnv.CODEX_HOME).toBe('/home/codex');
    // The caller's env object must NOT be mutated (default source is process.env).
    expect(inputEnv.JOURNAL_TOKEN).toBe('full-read-secret');
    expect(inputEnv.JOURNAL_TOKEN_FILE).toBe('/run/journal.token');
  });
});

describe('bridge-controlled journal-free child spawns are scoped in index.js', () => {
  // Source-level assertions. Two bridge-controlled housekeeping spawns default
  // to `...process.env` and run fixed, journal-free jobs; both must pass their
  // env through stripJournalCreds so the full-journal read credential is not
  // handed to code that never reads the journal.
  it('imports the helper', () => {
    expect(indexSrc).toMatch(/import\s*\{[^}]*stripJournalCreds[^}]*\}\s*from\s*'\.\/lib\/journal-cred-scope\.js'/);
  });

  it('scopes the `claude -p /usage` limits one-shot', () => {
    const start = indexSrc.indexOf('function fetchUsageLimitsText(');
    expect(start).toBeGreaterThan(-1);
    const body = indexSrc.slice(start, start + 1400);
    expect(body).toMatch(/env:\s*stripJournalCreds\(\{\s*\.\.\.process\.env/);
  });

  // The Claude session / interactive / Codex spawn envs are built by
  // lib/spawn-env.js and tested behaviorally in test/spawn-env.test.js (loop
  // #784); only the index.js-side wiring that has no builder stays here.

  // Loop #765: the journal read-proxy capability reaches Claude children as a
  // 0600 header FILE path, never as a token value in the env or on argv (a token
  // on curl's command line leaks via world-readable /proc/<pid>/cmdline).
  it('injects the proxy capability as a header-file PATH, not a token value', () => {
    // The child env carries the file path (asserted on the built env in
    // test/spawn-env.test.js), never the raw token value...
    expect(indexSrc).not.toContain('MATRON_JOURNAL_PROXY_TOKEN: JOURNAL_PROXY_CAP_TOKEN');
    // ...and the header file is written 0600.
    expect(indexSrc).toMatch(/writeFileSync\(JOURNAL_PROXY_HEADER_FILE[\s\S]*?mode: 0o600/);
  });
});

describe('bridge-only secrets (HMAC_SECRET)', () => {
  it('stripBridgeOnlySecrets removes HMAC_SECRET, keeps the journal token and the rest', () => {
    const env = { HMAC_SECRET: 'sign', JOURNAL_TOKEN: 'j', SHOW_FILE_TOKEN: 's', PATH: '/bin' };
    const out = stripBridgeOnlySecrets(env);
    expect('HMAC_SECRET' in out).toBe(false);
    expect(out.JOURNAL_TOKEN).toBe('j');
    expect(out.SHOW_FILE_TOKEN).toBe('s');
    expect(env.HMAC_SECRET).toBe('sign');
    expect(() => stripBridgeOnlySecrets('nope')).toThrow(TypeError);
    expect(BRIDGE_ONLY_SECRET_KEYS).toContain('HMAC_SECRET');
  });

  it('stripJournalCreds also drops HMAC_SECRET (every caller is a child spawn)', () => {
    const out = stripJournalCreds({ HMAC_SECRET: 'sign', JOURNAL_TOKEN: 'j', KEEP: '1' });
    expect('HMAC_SECRET' in out).toBe(false);
    expect('JOURNAL_TOKEN' in out).toBe(false);
    expect(out.KEEP).toBe('1');
  });

  // The one broad text invariant kept from the old source pins (loop #784):
  // no child spawn in index.js gets the bridge's env unscoped. Every
  // process.env handed to a child goes through a strip helper or a
  // lib/spawn-env.js builder (which strip internally, tested behaviorally).
  it('no child spawn in index.js inherits a bare process.env', () => {
    const bare = indexSrc.match(/\{\s*\.\.\.process\.env\b/g) || [];
    const wrapped = indexSrc.match(/strip(?:JournalCreds|BridgeOnlySecrets)\(\{\s*\.\.\.process\.env\b/g) || [];
    expect(bare.length).toBe(wrapped.length);
    expect(indexSrc).not.toMatch(/\benv:\s*process\.env\b/);
  });
});
