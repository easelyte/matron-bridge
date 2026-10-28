import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createLiveOutputStore, sweepOrphanedLogs } from '../lib/live-output.js';

describe('LiveOutputStore', () => {
  let store;
  beforeEach(() => { store = createLiveOutputStore({ ttlSeconds: 60, now: () => 1000 }); });

  it('register and get an entry', () => {
    store.register('toolu_1', { logPath: '/tmp/a.log', roomId: '!room:s' });
    const entry = store.get('toolu_1');
    expect(entry).toEqual({
      logPath: '/tmp/a.log',
      doneSentinelPath: '/tmp/a.log.done',
      roomId: '!room:s',
      expiresAt: 1060,
      complete: false,
    });
  });

  it('get returns undefined for unknown id', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('markComplete writes sentinel JSON and flips complete flag', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const logPath = path.join(tmp, 'cmd.log');
    store.register('toolu_2', { logPath, roomId: '!r:s' });
    store.markComplete('toolu_2', { exitCode: 0, denied: false, truncated: false });
    expect(existsSync(`${logPath}.done`)).toBe(true);
    const sentinel = JSON.parse(readFileSync(`${logPath}.done`, 'utf-8'));
    expect(sentinel).toEqual({ exitCode: 0, denied: false, truncated: false });
    expect(store.get('toolu_2').complete).toBe(true);
    rmSync(tmp, { recursive: true });
  });

  it('markComplete is a no-op for unknown id', () => {
    expect(() => store.markComplete('nope', { exitCode: 0 })).not.toThrow();
  });

  it('gcExpired deletes log + sentinel files and removes entries past expiry', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const logPath = path.join(tmp, 'cmd.log');
    let clock = 1000;
    const s = createLiveOutputStore({ ttlSeconds: 60, now: () => clock });
    writeFileSync(logPath, 'output');
    s.register('toolu_3', { logPath, roomId: '!r:s' });
    s.markComplete('toolu_3', { exitCode: 0, denied: false, truncated: false });

    clock = 1000 + 70; // past expiry
    const removed = s.gcExpired();
    expect(removed).toBe(1);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(`${logPath}.done`)).toBe(false);
    expect(s.get('toolu_3')).toBeUndefined();
    rmSync(tmp, { recursive: true });
  });

  it('sweepOrphanedLogs deletes pre-existing log files older than ttl', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const oldLog = path.join(tmp, 'matron-cmd-old.log');
    const oldDone = path.join(tmp, 'matron-cmd-old.log.done');
    const newLog = path.join(tmp, 'matron-cmd-new.log');
    writeFileSync(oldLog, 'old');
    writeFileSync(oldDone, '{}');
    writeFileSync(newLog, 'new');

    const fiveHoursAgo = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
    utimesSync(oldLog, fiveHoursAgo, fiveHoursAgo);
    utimesSync(oldDone, fiveHoursAgo, fiveHoursAgo);

    const removed = sweepOrphanedLogs(tmp, 14400);
    expect(removed).toBe(2);
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(oldDone)).toBe(false);
    expect(existsSync(newLog)).toBe(true);
    rmSync(tmp, { recursive: true });
  });
});

describe('markComplete in a shared directory', () => {
  it.skipIf(process.platform === 'win32')('writes the sentinel owner-only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'));
    try {
      const store = createLiveOutputStore();
      store.register('toolu_m', { logPath: path.join(dir, 'matron-cmd-toolu_m.log') });
      store.markComplete('toolu_m', { exitCode: 0 });
      const st = statSync(path.join(dir, 'matron-cmd-toolu_m.log.done'));
      expect(st.mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not throw or write through when the name is already taken', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'));
    try {
      const store = createLiveOutputStore();
      const logPath = path.join(dir, 'matron-cmd-toolu_s.log');
      store.register('toolu_s', { logPath });
      mkdirSync(`${logPath}.done`);
      expect(() => store.markComplete('toolu_s', { exitCode: 0 })).not.toThrow();
      expect(store.get('toolu_s').complete).toBe(true);

      const target = path.join(dir, 'victim');
      writeFileSync(target, 'keep');
      store.register('toolu_l', { logPath: path.join(dir, 'matron-cmd-toolu_l.log') });
      symlinkSync(target, path.join(dir, 'matron-cmd-toolu_l.log.done'));
      expect(() => store.markComplete('toolu_l', { exitCode: 0 })).not.toThrow();
      expect(readFileSync(target, 'utf8')).toBe('keep');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
