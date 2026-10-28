import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const TEE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'matron-tee');

describe.skipIf(process.platform === 'win32')('matron-tee log file', () => {
  it('is created owner-only, whatever the umask', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tee-'));
    try {
      const logPath = path.join(dir, 'matron-cmd-toolu_mode.log');
      const r = spawnSync(process.execPath, [TEE, logPath, '--', process.execPath, '-e', 'process.stdout.write("hello")'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('hello');
      expect(readFileSync(logPath, 'utf8')).toBe('hello');
      expect(statSync(logPath).mode & 0o077).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves a name that is already taken alone and still runs the command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tee-'));
    try {
      const logPath = path.join(dir, 'matron-cmd-toolu_taken.log');
      writeFileSync(logPath, 'someone else');
      const r = spawnSync(process.execPath, [TEE, logPath, '--', process.execPath, '-e', 'process.stdout.write("hello"); process.exit(3)'], { encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('hello');
      expect(r.stderr).toMatch(/live log disabled/);
      expect(readFileSync(logPath, 'utf8')).toBe('someone else');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
