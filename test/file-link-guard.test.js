import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitivePath, checkFileLink, validateAndOpen, pinAllowedRoots, pinAllowedRootsSync,
  FileLinkDenied, MAX_VIEW_BYTES,
} from '../lib/file-link-guard.js';

describe('isSensitivePath', () => {
  it.each([
    '/w/.env', '/w/.env.local', '/w/prod.env', '/w/secrets.yaml', '/w/secret.json',
    '/w/credentials', '/w/credentials.json', '/w/server.pem', '/w/app.key',
    '/w/id_rsa', '/w/id_ed25519.pub', '/w/.npmrc', '/w/.netrc', '/w/tokens.json',
    '/w/service-account-prod.json', '/w/.htpasswd', '/w/config.json',
    '/home/u/.aws/anything.txt', '/home/u/.ssh/known_hosts', '/home/u/.kube/cfg',
    '/home/u/.docker/x', '/home/u/.gnupg/x',
    '/w/.env/apikey.dat', '/w/.env.production/x.dat', '/w/secrets/db.dat',
    '/w/secret/note.txt', '/w/credentials/token.dat',
    '/w/proj/secrets', '/w/proj/secret', '/w/prod.env/x.dat', '/w/tokens.json/x.dat',
    '/w/app.key/nested/file.txt',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it.each([
    '/w/index.js', '/w/env.md', '/w/configuration.json', '/w/package.json',
    '/w/README.md', '/w/awsome/notes.txt', '/w/keyboard.js',
    '/w/secretary/notes.txt', '/w/credentialing/doc.md',
  ])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

describe('checkFileLink', () => {
  it('denies sensitive names with reason', () => {
    expect(checkFileLink('/w/proj/.env', '/w/proj')).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('denies paths outside the workdir, boundary-safe', () => {
    expect(checkFileLink('/w/proj-evil/a.js', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
    expect(checkFileLink('/etc/hosts', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
  });

  it('allows the workdir itself and files under it', () => {
    expect(checkFileLink('/w/proj/src/a.js', '/w/proj')).toEqual({ ok: true });
    expect(checkFileLink('/w/proj', '/w/proj')).toEqual({ ok: true });
  });

  it('resolves relative segments before checking', () => {
    expect(checkFileLink('/w/proj/src/../../other/a.js', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
  });

  it('skips containment without a workdir but keeps the denylist', () => {
    expect(checkFileLink('/anywhere/a.js', null)).toEqual({ ok: true });
    expect(checkFileLink('/anywhere/.env', null)).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('treats the filesystem root workdir as containing everything', () => {
    expect(checkFileLink('/home/u/proj/a.js', '/')).toEqual({ ok: true });
    expect(checkFileLink('/etc/hosts', '/')).toEqual({ ok: true });
    expect(checkFileLink('/etc/.env', '/')).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('rejects relative paths outright', () => {
    expect(checkFileLink('proj/a.js', '/w/proj')).toEqual({ ok: false, reason: 'relative-path' });
    expect(checkFileLink('./a.js', null)).toEqual({ ok: false, reason: 'relative-path' });
  });
});

describe('validateAndOpen', () => {
  let dir, outside;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-outside-'));
    writeFileSync(path.join(dir, 'ok.txt'), 'hello guard\n');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(outside, 'target.txt'), 'outside content\n');
    symlinkSync(path.join(outside, 'target.txt'), path.join(dir, 'sneaky.txt'));
    writeFileSync(path.join(outside, 'config.json'), '{"token":"x"}\n');
    symlinkSync(path.join(outside, 'config.json'), path.join(dir, 'innocent.txt'));
    writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(64));
    mkdirSync(path.join(dir, 'sub'));
  });
  afterAll(() => {
    for (const d of [dir, outside]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  const denied = async (p, opts) => {
    try {
      await validateAndOpen(p, opts);
    } catch (err) {
      expect(err).toBeInstanceOf(FileLinkDenied);
      return err.reason;
    }
    throw new Error('expected FileLinkDenied');
  };

  it('returns content and realPath for a normal file in the workdir', async () => {
    const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), { workdir: dir });
    expect(content.toString('utf-8')).toBe('hello guard\n');
    expect(path.basename(realPath)).toBe('ok.txt');
  });

  it('rejects a symlink at the final component', async () => {
    expect(await denied(path.join(dir, 'sneaky.txt'), { workdir: dir })).toBe('symlink');
  });

  it('rejects a sensitive file', async () => {
    expect(await denied(path.join(dir, '.env'), { workdir: dir })).toBe('sensitive');
  });

  it('rejects a file over maxBytes', async () => {
    expect(await denied(path.join(dir, 'big.txt'), { workdir: dir, maxBytes: 16 })).toBe('too-large');
  });

  it('rejects a directory', async () => {
    expect(await denied(path.join(dir, 'sub'), { workdir: dir })).toMatch(/not-a-file|unreadable/);
  });

  it('rejects a missing file', async () => {
    expect(await denied(path.join(dir, 'nope.txt'), { workdir: dir })).toBe('unreadable');
  });

  it('rejects content outside the workdir even without a symlink', async () => {
    expect(await denied(path.join(outside, 'target.txt'), { workdir: dir })).toBe('outside-workdir');
  });

  it('skips containment for legacy calls without a workdir', async () => {
    const { content } = await validateAndOpen(path.join(outside, 'target.txt'));
    expect(content.toString('utf-8')).toBe('outside content\n');
  });

  it('rejects relative paths outright', async () => {
    expect(await denied('some/relative.txt', { workdir: dir })).toBe('relative-path');
  });

  it('rejects a file reached through a symlinked ancestor directory', async () => {
    symlinkSync(outside, path.join(dir, 'linkdir'));
    expect(await denied(path.join(dir, 'linkdir', 'target.txt'), { workdir: dir })).toBe('outside-workdir');
  });

  it('allows a legitimate file when the workdir itself is a symlink', async () => {
    const wdLink = path.join(outside, 'wd-link');
    symlinkSync(dir, wdLink);
    const { content } = await validateAndOpen(path.join(dir, 'ok.txt'), { workdir: wdLink });
    expect(content.toString('utf-8')).toBe('hello guard\n');
  });

  it('allows a realPath under one of several allowed roots', async () => {
    const allowedRoots = await pinAllowedRoots([dir, outside]);
    const { content, realPath } = await validateAndOpen(path.join(outside, 'target.txt'), {
      allowedRoots,
    });
    expect(content.toString('utf-8')).toBe('outside content\n');
    expect(realPath).toBe(path.join(outside, 'target.txt'));
  });

  it('rejects a realPath outside every allowed root before reading it', async () => {
    const allowedRoots = await pinAllowedRoots([dir]);
    const actualOpen = fsp.open.bind(fsp);
    const readSpies = [];
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      readSpies.push(vi.spyOn(fd, 'read'));
      return fd;
    });

    try {
      expect(await denied(path.join(outside, 'target.txt'), { allowedRoots }))
        .toBe('outside-scope');
      expect(readSpies).toHaveLength(1);
      expect(readSpies[0]).not.toHaveBeenCalled();
    } finally {
      readSpies.forEach((spy) => spy.mockRestore());
      openSpy.mockRestore();
    }
  });

  it('gives outside-scope precedence over sensitive and oversized denials', async () => {
    const allowedRoots = await pinAllowedRoots([dir]);
    expect(await denied(path.join(outside, 'config.json'), { allowedRoots }))
      .toBe('outside-scope');
    expect(await denied(path.join(outside, 'target.txt'), { allowedRoots, maxBytes: 1 }))
      .toBe('outside-scope');
  });

  it('canonicalizes symlinked allowed roots', async () => {
    const rootLink = path.join(outside, 'root-link');
    symlinkSync(dir, rootLink);
    const allowedRoots = await pinAllowedRoots([rootLink]);
    const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), {
      allowedRoots,
    });
    expect(content.toString('utf-8')).toBe('hello guard\n');
    expect(realPath).toBe(path.join(dir, 'ok.txt'));
  });

  it('rejects an allowed root that does not resolve', async () => {
    await expect(pinAllowedRoots([path.join(dir, 'missing-root')]))
      .rejects.toMatchObject({ reason: 'bad-workdir' });
  });

  it('synchronously pins root identity for pre-spawn authorization', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'flg-sync-root-swap-'));
    const approved = path.join(parent, 'approved');
    const moved = path.join(parent, 'moved');
    mkdirSync(approved);
    const allowedRoots = pinAllowedRootsSync([approved]);
    renameSync(approved, moved);
    symlinkSync(outside, approved);
    try {
      expect(await denied(path.join(approved, 'target.txt'), { allowedRoots })).toBe('bad-workdir');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a pinned root that is replaced before validation', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'flg-root-swap-'));
    const approved = path.join(parent, 'approved');
    const moved = path.join(parent, 'moved');
    mkdirSync(approved);
    writeFileSync(path.join(outside, 'neutral.txt'), 'must not escape\n');
    const allowedRoots = await pinAllowedRoots([approved]);
    renameSync(approved, moved);
    symlinkSync(outside, approved);
    try {
      expect(await denied(path.join(approved, 'neutral.txt'), { allowedRoots })).toBe('bad-workdir');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a FIFO without blocking in open or attempting a read', async () => {
    const fifo = path.join(dir, 'agent.fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const result = await Promise.race([
      denied(fifo, { workdir: dir }),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
    ]);
    expect(result).toBe('not-a-file');
  });

  it('exports a 5MB default cap', () => {
    expect(MAX_VIEW_BYTES).toBe(5 * 1024 * 1024);
  });
});
