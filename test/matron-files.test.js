import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matronFilesRoot,
  matronFilesDir,
  sessionDownloadDir,
} from '../lib/matron-files.js';
import { ivUploadsRoot } from '../lib/iv-uploads.js';

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

describe('matronFilesDir with a conversation', () => {
  it('adds one folder per conversation under the project folder', () => {
    expect(matronFilesDir('/home/user/matron-bridge', { mkdir: false, conversation: 'c0ffee-01' }))
      .toBe(path.join(os.homedir(), 'matron-files', 'matron-bridge', 'c0ffee-01'));
  });

  it('keeps a hostile conversation id to one safe segment', () => {
    for (const conversation of ['../../etc', '..', '.', 'a/b', '!room:example.com']) {
      const dir = matronFilesDir('/home/user/repo', { mkdir: false, conversation });
      expect(path.dirname(dir)).toBe(path.join(os.homedir(), 'matron-files', 'repo'));
      expect(path.basename(dir)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('sessionDownloadDir', () => {
  it("is the conversation's folder for an SDK session", () => {
    expect(sessionDownloadDir({ roomId: 'convo-1', workdir: '/home/user/repo' }, { mkdir: false }))
      .toBe(path.join(os.homedir(), 'matron-files', 'repo', 'convo-1'));
  });

  it('is the per-room upload dir for a PTY session', () => {
    expect(sessionDownloadDir({ roomId: 'convo-1', workdir: '/home/user/repo', iv: true }, { mkdir: false }))
      .toBe(path.join(ivUploadsRoot(), 'convo-1'));
  });

  it('gives two conversations in the same repo different folders', () => {
    const a = sessionDownloadDir({ roomId: 'convo-a', workdir: '/home/user/repo' }, { mkdir: false });
    const b = sessionDownloadDir({ roomId: 'convo-b', workdir: '/home/user/repo' }, { mkdir: false });
    expect(a).not.toBe(b);
  });

  it('is null for a session with no room id', () => {
    expect(sessionDownloadDir({ workdir: '/home/user/repo' }, { mkdir: false })).toBeNull();
    expect(sessionDownloadDir(null, { mkdir: false })).toBeNull();
  });
});
