import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { stripJournalCreds, JOURNAL_CHILD_STRIPPED_KEYS } from '../lib/journal-cred-scope.js';
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

  it('mutates and returns the same object', () => {
    const env = { JOURNAL_TOKEN: 'x' };
    expect(stripJournalCreds(env)).toBe(env);
    expect(env.JOURNAL_TOKEN).toBeUndefined();
  });

  it('is a no-op on env with no journal creds and tolerates non-objects', () => {
    expect(stripJournalCreds({ FOO: '1' })).toEqual({ FOO: '1' });
    expect(() => stripJournalCreds(undefined)).not.toThrow();
    expect(() => stripJournalCreds(null)).not.toThrow();
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

  // Guard the deliberate NON-change: interactive/print session spawns keep the
  // token because the shipped prompt requires it for journal search. If someone
  // later strips it here, this test fails loudly and points them at the PR.
  it('does NOT strip the token from the interactive/print session spawns', () => {
    const printStart = indexSrc.indexOf('const spawnEnv = {');
    const ivStart = indexSrc.indexOf('const interactiveEnv = {');
    expect(printStart).toBeGreaterThan(-1);
    expect(ivStart).toBeGreaterThan(-1);
    expect(indexSrc.slice(printStart, printStart + 3000)).not.toContain('stripJournalCreds(spawnEnv)');
    expect(indexSrc.slice(ivStart, ivStart + 1200)).not.toContain('stripJournalCreds(interactiveEnv)');
  });
});
