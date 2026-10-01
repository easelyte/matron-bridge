import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { liveLogDir, liveLogPath } from '../lib/live-log-dir.js';

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
