import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveLogDir, liveLogPath, isOwnLiveLog, openOwnLiveLog, openOwnLiveLogSync } from '../lib/live-log-dir.js';

describe('liveLogDir', () => {
  it('is the literal /tmp on POSIX (bridge, session and hook all share it)', () => {
    expect(liveLogDir({ platform: 'linux', tmpdir: () => '/var/folders/x' })).toBe('/tmp');
    expect(liveLogDir({ platform: 'darwin', tmpdir: () => '/var/folders/x' })).toBe('/tmp');
  });

  it('is the user temp dir on Windows', () => {
    expect(liveLogDir({ platform: 'win32', tmpdir: () => 'C:\\Users\\u\\AppData\\Local\\Temp' }))
      .toBe('C:\\Users\\u\\AppData\\Local\\Temp');
  });

  it('liveLogPath names the file by tool_use_id under that dir', () => {
    expect(liveLogPath('toolu_1', { platform: 'linux' })).toBe(path.join('/tmp', 'matron-cmd-toolu_1.log'));
    expect(liveLogPath('toolu_1', { platform: 'win32', tmpdir: () => 'T' })).toBe(path.join('T', 'matron-cmd-toolu_1.log'));
  });
});

describe('reading a live log back', () => {
  const posix = process.platform !== 'win32';
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-log-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('opens the user\'s own regular file', async () => {
    const p = path.join(dir, 'matron-cmd-a.log');
    fs.writeFileSync(p, 'out', { mode: 0o600 });
    const fd = openOwnLiveLogSync(p);
    expect(fd).not.toBeNull();
    fs.closeSync(fd);
    const handle = await openOwnLiveLog(p);
    expect(handle).not.toBeNull();
    await handle.close();
  });

  it('returns null when there is no log yet', async () => {
    expect(openOwnLiveLogSync(path.join(dir, 'missing.log'))).toBeNull();
    expect(await openOwnLiveLog(path.join(dir, 'missing.log'))).toBeNull();
  });

  it.runIf(posix)('does not follow a link at the log name', async () => {
    const target = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(target, 'not the output');
    const p = path.join(dir, 'matron-cmd-b.log');
    fs.symlinkSync(target, p);
    expect(openOwnLiveLogSync(p)).toBeNull();
    expect(await openOwnLiveLog(p)).toBeNull();
  });

  it.runIf(posix)('refuses a file with a second hard link', () => {
    const target = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(target, 'not the output');
    const p = path.join(dir, 'matron-cmd-c.log');
    fs.linkSync(target, p);
    expect(openOwnLiveLogSync(p)).toBeNull();
  });

  it('opens the log where there are no uids (Windows), without the device match', async () => {
    const p = path.join(dir, 'matron-cmd-w.log');
    fs.writeFileSync(p, 'out');
    const fd = openOwnLiveLogSync(p, { getuid: null });
    expect(fd).not.toBeNull();
    fs.closeSync(fd);
    const handle = await openOwnLiveLog(p, { getuid: null });
    expect(handle).not.toBeNull();
    await handle.close();
  });

  it('refuses a file owned by another account', () => {
    const st = { isFile: () => true, nlink: 1, uid: 4242 };
    expect(isOwnLiveLog(st, { getuid: () => 1000 })).toBe(false);
    expect(isOwnLiveLog({ ...st, uid: 1000 }, { getuid: () => 1000 })).toBe(true);
    expect(isOwnLiveLog({ ...st, isFile: () => false, uid: 1000 }, { getuid: () => 1000 })).toBe(false);
  });
});
