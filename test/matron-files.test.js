import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matronFilesRoot,
  matronFilesDir,
} from '../lib/matron-files.js';

describe('matronFilesRoot', () => {
  it('roots received files at ~/matron-files', () => {
    expect(matronFilesRoot()).toBe(path.join(os.homedir(), 'matron-files'));
  });

  it('honors the MATRON_FILES_DIR override', () => {
    const prev = process.env.MATRON_FILES_DIR;
    try {
      process.env.MATRON_FILES_DIR = '/tmp/custom-files';
      expect(matronFilesRoot()).toBe('/tmp/custom-files');
    } finally {
      if (prev === undefined) delete process.env.MATRON_FILES_DIR;
      else process.env.MATRON_FILES_DIR = prev;
    }
  });
});

describe('matronFilesDir', () => {
  it('keys the subdir on the workdir basename', () => {
    expect(matronFilesDir('/home/user/matron-bridge', { mkdir: false }))
      .toBe(path.join(os.homedir(), 'matron-files', 'matron-bridge'));
  });

  it('sanitizes filesystem-unsafe characters in the basename', () => {
    expect(matronFilesDir('/home/user/my repo (v2)!', { mkdir: false }))
      .toBe(path.join(os.homedir(), 'matron-files', 'my_repo__v2__'));
  });

  it('caps the segment at 80 characters', () => {
    const dir = matronFilesDir('/home/user/' + 'a'.repeat(200), { mkdir: false });
    expect(path.basename(dir)).toHaveLength(80);
  });

  it('falls back to "project" for root, ".", ".." and empty workdirs', () => {
    // path.basename('/') === '', and a '.'/'..' basename would resolve to a
    // directory inside path.join — fold all of them into 'project'.
    for (const workdir of ['/', '.', '..', '']) {
      expect(matronFilesDir(workdir, { mkdir: false }))
        .toBe(path.join(os.homedir(), 'matron-files', 'project'));
    }
  });

  it('creates the directory on demand', () => {
    const prev = process.env.MATRON_FILES_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfiles-'));
    try {
      process.env.MATRON_FILES_DIR = tmp;
      const dir = matronFilesDir('/home/user/matron-bridge');
      expect(dir).toBe(path.join(tmp, 'matron-bridge'));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MATRON_FILES_DIR;
      else process.env.MATRON_FILES_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
