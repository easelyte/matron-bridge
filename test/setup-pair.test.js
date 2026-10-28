// Unit tests for the pure parts of npm run pair (setup/pair.mjs), the shared
// setup helpers it reuses from setup/common.mjs, and the wizard's token-source
// menu. The interactive flows themselves need a live journal.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, pairingJournalUrl, existingTokenCheck } from '../setup/pair.mjs';
import {
  currentToken, tokenEnv, TOKEN_PATH, pairWithApp, strandedTokenFile,
  sameJournal, storedTokenFor, writeEnvFile,
} from '../setup/common.mjs';
import { tokenMethod, storedTokenToOffer } from '../setup/wizard.mjs';

describe('npm run pair argument parsing', () => {
  it('defaults to the .env journal, no force', () => {
    expect(parseArgs([])).toEqual({ server: '', force: false, help: false });
  });

  it('accepts --server <url>, --server=<url> and --force', () => {
    expect(parseArgs(['--server', 'journal.example.com', '--force']))
      .toEqual({ server: 'journal.example.com', force: true, help: false });
    expect(parseArgs(['--server=https://j.example.com']).server).toBe('https://j.example.com');
  });

  it('rejects a missing --server value and unknown arguments', () => {
    expect(() => parseArgs(['--server'])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--server', '--force'])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--server='])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--frce'])).toThrow(/unknown argument/);
  });
});

describe('pairing journal URL', () => {
  it('normalises https and bare hosts to the bridge wss form', () => {
    expect(pairingJournalUrl('https://journal.example.com')).toBe('wss://journal.example.com/ws');
    expect(pairingJournalUrl('journal.example.com')).toBe('wss://journal.example.com/ws');
  });

  it('allows plain ws:// only for this machine', () => {
    expect(pairingJournalUrl('ws://127.0.0.1:9810/ws')).toBe('ws://127.0.0.1:9810/ws');
    expect(() => pairingJournalUrl('http://journal.example.com')).toThrow(/cleartext/);
  });

  it('rejects garbage', () => {
    expect(() => pairingJournalUrl('ftp://x')).toThrow(/could not parse/);
  });

  it('pairWithApp resolves to the token string and never prints it', async () => {
    const replies = [
      { pair_code: 'BCDF-GHJK', poll_token: 'p'.repeat(64), expires_in: 600 },
      { status: 'approved', token: 'the-agent-token', device_id: 9 },
    ];
    const fetch = async () => ({ status: 200, headers: { get: () => null }, json: async () => replies.shift() });
    const printed = [];
    const ac = new AbortController();
    // Real abortableSleep with the default 2.5 s poll is too slow for a unit
    // test, so time is skipped with fake timers.
    vi.useFakeTimers();
    try {
      const p = pairWithApp({ journalUrl: 'wss://j.example.com/ws', fetch, signal: ac.signal, print: (l) => printed.push(l) });
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe('the-agent-token');
    } finally {
      vi.useRealTimers();
    }
    expect(printed.join('\n')).toContain('BCDF-GHJK');
    expect(printed.join('\n')).not.toContain('the-agent-token');
    expect(printed.join('\n')).not.toContain('p'.repeat(64));
  });

  it('pairWithApp refuses a remote cleartext journal before any request', async () => {
    await expect(pairWithApp({ journalUrl: 'ws://journal.example.com/ws', print: () => {} }))
      .rejects.toThrow(/cleartext/);
  });
});

describe('currentToken (same precedence as index.js)', () => {
  it('prefers JOURNAL_TOKEN_FILE over JOURNAL_TOKEN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-env-'));
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, ' from-file \n');
    expect(currentToken({ JOURNAL_TOKEN_FILE: file, JOURNAL_TOKEN: 'raw' })).toBe('from-file');
    fs.rmSync(dir, { recursive: true });
  });

  it('treats an unreadable token file as no token (no fall-back to JOURNAL_TOKEN)', () => {
    expect(currentToken({ JOURNAL_TOKEN_FILE: '/nonexistent/tok', JOURNAL_TOKEN: 'raw' })).toBe('');
  });

  it('uses JOURNAL_TOKEN when no file is set', () => {
    expect(currentToken({ JOURNAL_TOKEN: ' raw ' })).toBe('raw');
    expect(currentToken({})).toBe('');
  });
});

describe('strandedTokenFile', () => {
  const withTokenFile = (content, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-stranded-'));
    const file = path.join(dir, '.journal-token');
    if (content !== null) fs.writeFileSync(file, content);
    try { fn(file); } finally { fs.rmSync(dir, { recursive: true }); }
  };

  it('finds a paired token that .env never pointed at', () => {
    withTokenFile('tok\n', (file) => expect(strandedTokenFile({}, file)).toBe(file));
  });

  it('never overrides a token source .env already names', () => {
    withTokenFile('tok\n', (file) => {
      expect(strandedTokenFile({ JOURNAL_TOKEN_FILE: '/etc/matron/agent-token' }, file)).toBe('');
      expect(strandedTokenFile({ JOURNAL_TOKEN: 'raw' }, file)).toBe('');
    });
  });

  it('ignores a missing or empty token file', () => {
    withTokenFile(null, (file) => expect(strandedTokenFile({}, file)).toBe(''));
    withTokenFile('  \n', (file) => expect(strandedTokenFile({}, file)).toBe(''));
  });

  it('defaults to the repo token path', () => {
    expect(strandedTokenFile({ JOURNAL_TOKEN: 'raw' })).toBe('');
  });
});

describe('tokenEnv', () => {
  it('points .env at the repo token file and clears the raw token', () => {
    expect(tokenEnv('wss://j.example.com/ws')).toEqual({
      JOURNAL_WS_URL: 'wss://j.example.com/ws',
      JOURNAL_TOKEN_FILE: TOKEN_PATH,
      JOURNAL_TOKEN: '',
    });
    expect(path.basename(TOKEN_PATH)).toBe('.journal-token');
  });
});

describe('wizard token-source menu', () => {
  it('defaults to pairing on Enter', () => {
    expect(tokenMethod('')).toBe('pair');
    expect(tokenMethod('1')).toBe('pair');
  });

  it('accepts 2 for pasting a matron-admin token', () => {
    expect(tokenMethod('2')).toBe('paste');
    expect(tokenMethod(' paste ')).toBe('paste');
  });

  it('flags anything else', () => {
    expect(tokenMethod('3')).toBe(null);
  });
});

describe('a stored agent token stays with the journal it was saved for', () => {
  const withTokenFile = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-journal-'));
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, 'token-for-a\n');
    try { fn(file); } finally { fs.rmSync(dir, { recursive: true }); }
  };

  it('sameJournal compares scheme, host and port across URL forms', () => {
    expect(sameJournal('wss://a.example.com/ws', 'https://a.example.com')).toBe(true);
    expect(sameJournal('wss://a.example.com/ws', 'a.example.com')).toBe(true);
    expect(sameJournal('wss://a.example.com/ws', 'wss://b.example.com/ws')).toBe(false);
    expect(sameJournal('wss://a.example.com/ws', 'wss://a.example.com:8443/ws')).toBe(false);
    expect(sameJournal('ws://localhost:9810/ws', 'wss://localhost:9810/ws')).toBe(false);
    expect(sameJournal('', 'wss://a.example.com/ws')).toBe(false);
    expect(sameJournal(undefined, undefined)).toBe(false);
  });

  it('storedTokenFor hands out the token only for its own journal', () => {
    withTokenFile((file) => {
      const existing = { JOURNAL_WS_URL: 'wss://a.example.com/ws', JOURNAL_TOKEN_FILE: file };
      expect(storedTokenFor(existing, 'https://a.example.com')).toBe('token-for-a');
      expect(storedTokenFor(existing, 'wss://b.example.com/ws')).toBe('');
    });
    expect(storedTokenFor({ JOURNAL_TOKEN: 'raw' }, 'wss://a.example.com/ws')).toBe('');
  });

  it('npm run pair --server <another journal> checks no stored token there', () => {
    withTokenFile((file) => {
      const existing = { JOURNAL_WS_URL: 'wss://a.example.com/ws', JOURNAL_TOKEN_FILE: file };
      expect(existingTokenCheck(existing, 'wss://a.example.com/ws')).toEqual({ token: 'token-for-a', note: '' });
      const other = existingTokenCheck(existing, 'wss://b.example.com/ws');
      expect(other.token).toBe('');
      expect(other.note).toContain('wss://a.example.com/ws');
      expect(other.note).not.toContain('token-for-a');
    });
  });

  it('npm run pair never checks a token with no record of its journal', () => {
    withTokenFile((tokenPath) => {
      const check = existingTokenCheck({ JOURNAL_WS_URL: 'wss://a.example.com/ws' }, 'wss://a.example.com/ws', { tokenPath });
      expect(check.token).toBe('');
      expect(check.note).toContain('unfinished setup');
    });
  });

  it('the wizard offers to keep a token only for its own journal', () => {
    const existing = { JOURNAL_WS_URL: 'wss://a.example.com/ws', JOURNAL_TOKEN_FILE: '/srv/box-a/tok' };
    expect(storedTokenToOffer(existing, 'wss://a.example.com/ws'))
      .toMatchObject({ file: '/srv/box-a/tok', defaultKeep: true });
    const other = storedTokenToOffer(existing, 'wss://b.example.com/ws');
    expect(other.file).toBe('');
    expect(other.note).toContain('needs a token of its own');
  });

  it('the wizard asks before keeping a token from an unfinished setup, defaulting to no', () => {
    withTokenFile((tokenPath) => {
      expect(storedTokenToOffer({}, 'wss://a.example.com/ws', { tokenPath }))
        .toMatchObject({ file: tokenPath, defaultKeep: false });
    });
  });
});

describe('writeEnvFile', () => {
  it('keeps the .env backup owner-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-envfile-'));
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');
    try {
      fs.writeFileSync(examplePath, 'JOURNAL_WS_URL=\n');
      fs.writeFileSync(envPath, 'JOURNAL_WS_URL=wss://a.example.com/ws\n', { mode: 0o644 });
      fs.chmodSync(envPath, 0o644);
      fs.writeFileSync(`${envPath}.bak`, 'old\n', { mode: 0o644 });
      fs.chmodSync(`${envPath}.bak`, 0o644);
      expect(writeEnvFile({}, { JOURNAL_WS_URL: 'wss://b.example.com/ws' }, { envPath, examplePath })).toBe(true);
      expect(fs.readFileSync(`${envPath}.bak`, 'utf8')).toBe('JOURNAL_WS_URL=wss://a.example.com/ws\n');
      expect(fs.readFileSync(envPath, 'utf8')).toBe('JOURNAL_WS_URL=wss://b.example.com/ws\n');
      if (process.platform !== 'win32') {
        expect(fs.statSync(`${envPath}.bak`).mode & 0o777).toBe(0o600);
        expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('makes no backup on a first run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-envfile-'));
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');
    try {
      fs.writeFileSync(examplePath, 'JOURNAL_WS_URL=\n');
      expect(writeEnvFile({}, { JOURNAL_WS_URL: 'wss://a.example.com/ws' }, { envPath, examplePath })).toBe(false);
      expect(fs.existsSync(`${envPath}.bak`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
