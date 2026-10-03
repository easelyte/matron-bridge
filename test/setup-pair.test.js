// Unit tests for the pure parts of npm run pair (setup/pair.mjs), the shared
// setup helpers it reuses from setup/common.mjs, and the wizard's token-source
// menu. The interactive flows themselves need a live journal.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, pairingJournalUrl } from '../setup/pair.mjs';
import { currentToken, tokenEnv, TOKEN_PATH, pairWithApp, strandedTokenFile } from '../setup/common.mjs';
import { tokenMethod } from '../setup/wizard.mjs';

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
