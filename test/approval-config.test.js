import { describe, it, expect } from 'vitest';
import { readApprovalConfig, journalHostOf } from '../lib/approval-config.js';

describe('approval config', () => {
  it("names the journal by its URL's host, lowercased, with a port only when it is not the default", () => {
    expect(journalHostOf('wss://Journal.Example/ws')).toBe('journal.example');
    expect(journalHostOf('wss://journal.example:443/ws')).toBe('journal.example');
    expect(journalHostOf('wss://journal.example:8443/ws')).toBe('journal.example:8443');
    expect(journalHostOf('ws://journal.example:80/ws')).toBe('journal.example');
    expect(journalHostOf('')).toBe(null);
    expect(journalHostOf('not a url')).toBe(null);
  });

  it('is all off by default', () => {
    expect(readApprovalConfig({}, { journalWsUrl: 'wss://journal.example/ws' })).toEqual({
      keysFile: '', maxAgeMs: null, stepUpAll: false, journalHost: 'journal.example', locked: false, unlockMaxMinutes: 120,
    });
  });

  it('reads the keys file, the age bound, the step-up default and a journal host given outright', () => {
    const c = readApprovalConfig({
      MATRON_APPROVAL_KEYS_FILE: '/etc/matron/approval-keys.json', MATRON_APPROVAL_MAX_AGE_MS: '60000',
      MATRON_STEP_UP_ALL: '1', MATRON_APPROVAL_JOURNAL_HOST: 'Public.Example',
    }, { journalWsUrl: 'ws://journal.internal.example:8080/ws' });
    expect(c).toMatchObject({ keysFile: '/etc/matron/approval-keys.json', maxAgeMs: 60000, stepUpAll: true, journalHost: 'public.example' });
  });

  it('ignores an age bound that is not a positive number', () => {
    expect(readApprovalConfig({ MATRON_APPROVAL_MAX_AGE_MS: 'soon' }, {}).maxAgeMs).toBe(null);
    expect(readApprovalConfig({ MATRON_APPROVAL_MAX_AGE_MS: '0' }, {}).maxAgeMs).toBe(null);
  });

  it('locked mode needs a keys file, and an unlock cap of at least a minute', () => {
    expect(() => readApprovalConfig({ MATRON_LOCKED: '1' }, {})).toThrow(/MATRON_LOCKED.*MATRON_APPROVAL_KEYS_FILE/);
    const c = readApprovalConfig({ MATRON_LOCKED: '1', MATRON_APPROVAL_KEYS_FILE: '/k.json', MATRON_UNLOCK_MAX_MINUTES: '30' }, {});
    expect(c).toMatchObject({ locked: true, unlockMaxMinutes: 30 });
    expect(readApprovalConfig({ MATRON_UNLOCK_MAX_MINUTES: '0' }, {}).unlockMaxMinutes).toBe(120);
    expect(readApprovalConfig({ MATRON_UNLOCK_MAX_MINUTES: 'x' }, {}).unlockMaxMinutes).toBe(120);
  });
});
