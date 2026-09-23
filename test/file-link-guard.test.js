import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitivePath, checkFileLink, validateAndOpen, pinAllowedRoots, pinAllowedRootsSync,
  pinAllowedRootIdentities, FileLinkDenied, MAX_VIEW_BYTES,
  buildFilesDeepLink, appendFilesDeepLink,
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

  it('continues reading until the approved snapshot buffer is full', async () => {
    const filePath = path.join(dir, 'short-reads.txt');
    writeFileSync(filePath, 'abcdef');
    const actualOpen = fsp.open.bind(fsp);
    let readSpy;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      const actualRead = fd.read.bind(fd);
      readSpy = vi.spyOn(fd, 'read').mockImplementation(
        (buffer, offset, length, position) => actualRead(buffer, offset, Math.min(length, 2), position),
      );
      return fd;
    });

    try {
      const { content } = await validateAndOpen(filePath, { workdir: dir });
      expect(content.toString()).toBe('abcdef');
      expect(readSpy).toHaveBeenCalledTimes(3);
    } finally {
      readSpy?.mockRestore();
      openSpy.mockRestore();
    }
  });

  // Helper: spy fs open so that every read of `filePath` truncates it to
  // `truncateTo` after returning, simulating a file that changes size between
  // the stat-time snapshot and read completion.
  const withSizeChangingRead = async (filePath, truncateTo, fn) => {
    const actualOpen = fsp.open.bind(fsp);
    let readSpy;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      const actualRead = fd.read.bind(fd);
      readSpy = vi.spyOn(fd, 'read').mockImplementation(async (...readArgs) => {
        const result = await actualRead(...readArgs);
        await fsp.truncate(filePath, truncateTo);
        return result;
      });
      return fd;
    });
    try {
      return await fn();
    } finally {
      readSpy?.mockRestore();
      openSpy.mockRestore();
    }
  };

  it('strict mode rejects a file whose descriptor size changes after reading', async () => {
    const filePath = path.join(dir, 'mutated-strict.txt');
    writeFileSync(filePath, 'abcdef');
    await withSizeChangingRead(filePath, 1, async () => {
      expect(await denied(filePath, { workdir: dir, strictSnapshot: true })).toBe('unreadable');
    });
  });

  // Helper: same-length in-place overwrite mid-read. Size is unchanged, so the
  // size-only guard would miss it; mtime/ctime move, which strict mode catches.
  const withContentChangingRead = async (filePath, replacement, fn) => {
    const actualOpen = fsp.open.bind(fsp);
    let readSpy;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      const actualRead = fd.read.bind(fd);
      readSpy = vi.spyOn(fd, 'read').mockImplementation(async (...readArgs) => {
        const result = await actualRead(...readArgs);
        writeFileSync(filePath, replacement);
        const future = new Date(Date.now() + 10_000);
        await fsp.utimes(filePath, future, future);
        return result;
      });
      return fd;
    });
    try {
      return await fn();
    } finally {
      readSpy?.mockRestore();
      openSpy.mockRestore();
    }
  };

  it('strict mode rejects a same-size in-place overwrite during read', async () => {
    const filePath = path.join(dir, 'mutated-content-strict.txt');
    writeFileSync(filePath, 'abcdef');
    await withContentChangingRead(filePath, 'ABCDEF', async () => {
      expect(await denied(filePath, { workdir: dir, strictSnapshot: true })).toBe('unreadable');
    });
  });

  it('default (non-strict) mode returns the bounded snapshot for a size-changing file', async () => {
    const filePath = path.join(dir, 'mutated-serve.txt');
    writeFileSync(filePath, 'abcdef');
    const { content } = await withSizeChangingRead(filePath, 1, () =>
      validateAndOpen(filePath, { workdir: dir }),
    );
    // The read captured all 6 stat-time bytes before the truncate, so /view +
    // /download serve that bounded snapshot rather than 404-ing a live file.
    expect(content.toString()).toBe('abcdef');
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

// The Linux deployment resolves an open descriptor's real path through
// /proc/self/fd, which the kernel answers from the descriptor itself — no
// path re-walk, nothing to race. Platforms without procfs (macOS) have to
// re-resolve the pathname, and that re-walk is what these tests pin: the
// resolved name must be PROVEN to still name the descriptor we hold.
describe('fdRealPath (non-procfs platforms)', () => {
  let dir, outside;
  const withPlatform = async (value, fn) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-race-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-race-outside-'));
    mkdirSync(path.join(dir, 'decoy'));
    writeFileSync(path.join(dir, 'decoy', 'doc.txt'), 'harmless decoy\n');
    writeFileSync(path.join(outside, 'doc.txt'), 'STOLEN SECRET\n');
    // `swap` starts out pointing outside the workdir; the race flips it back
    // in-scope after open() so a bare realpath() would report an in-scope name
    // for a descriptor that is holding the out-of-scope file.
    symlinkSync(outside, path.join(dir, 'swap'));
  });
  afterAll(() => {
    for (const d of [dir, outside]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('serves a normal in-scope file unchanged when there is no race', async () => {
    await withPlatform('darwin', async () => {
      const { content, realPath } = await validateAndOpen(
        path.join(dir, 'decoy', 'doc.txt'), { workdir: dir },
      );
      expect(content.toString('utf-8')).toBe('harmless decoy\n');
      expect(realPath).toBe(path.join(dir, 'decoy', 'doc.txt'));
    });
  });

  it('refuses to serve a descriptor whose parent directory was swapped after open', async () => {
    const swapLink = path.join(dir, 'swap');
    const actualOpen = fsp.open.bind(fsp);
    // Perform the swap INSIDE the open() call so the race is deterministic
    // rather than timing-dependent: the descriptor is already pinned to the
    // out-of-scope file, and every later pathname walk sees the in-scope dir.
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      rmSync(swapLink, { force: true });
      symlinkSync(path.join(dir, 'decoy'), swapLink);
      return fd;
    });
    try {
      await withPlatform('darwin', async () => {
        let denial;
        try {
          await validateAndOpen(path.join(dir, 'swap', 'doc.txt'), { workdir: dir });
        } catch (err) {
          denial = err;
        }
        expect(denial).toBeInstanceOf(FileLinkDenied);
        expect(denial.reason).toBe('path-race');
      });
    } finally {
      openSpy.mockRestore();
      rmSync(swapLink, { force: true });
      symlinkSync(outside, swapLink);
    }
  });

  it('refuses when the resolved name is replaced by a symlink before the identity check', async () => {
    const victim = path.join(dir, 'victim.txt');
    writeFileSync(victim, 'victim\n');
    const actualRealpath = fsp.realpath.bind(fsp);
    const realpathSpy = vi.spyOn(fsp, 'realpath').mockImplementation(async (...args) => {
      const resolved = await actualRealpath(...args);
      if (resolved === victim) {
        rmSync(victim, { force: true });
        symlinkSync(path.join(dir, 'decoy', 'doc.txt'), victim);
      }
      return resolved;
    });
    try {
      await withPlatform('darwin', async () => {
        let denial;
        try {
          await validateAndOpen(victim, { workdir: dir });
        } catch (err) {
          denial = err;
        }
        expect(denial).toBeInstanceOf(FileLinkDenied);
        expect(denial.reason).toBe('path-race');
      });
    } finally {
      realpathSpy.mockRestore();
      rmSync(victim, { force: true });
    }
  });

  it('denies rather than throwing raw when the pathname vanishes before it resolves', async () => {
    const doomed = path.join(dir, 'doomed.txt');
    writeFileSync(doomed, 'doomed\n');
    const actualOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      rmSync(doomed, { force: true });
      return fd;
    });
    try {
      await withPlatform('darwin', async () => {
        let denial;
        try {
          await validateAndOpen(doomed, { workdir: dir });
        } catch (err) {
          denial = err;
        }
        expect(denial).toBeInstanceOf(FileLinkDenied);
        expect(denial.reason).toBe('unreadable');
      });
    } finally {
      openSpy.mockRestore();
      rmSync(doomed, { force: true });
    }
  });

  it('keeps the procfs answer on Linux — no pathname re-walk, no identity check', async () => {
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    try {
      // workdir containment needs one realpath of the WORKDIR; the point is
      // that the target's real path never goes through realpath() on Linux.
      const { realPath } = await validateAndOpen(path.join(dir, 'decoy', 'doc.txt'), {});
      expect(realPath).toBe(path.join(dir, 'decoy', 'doc.txt'));
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });
});

// A pathname is not an authorization boundary. pinAllowedRoots{,Sync} resolve
// one at a trusted moment and RETAIN the identity they approved; these tests
// pin the third constructor, which rebuilds that capability from an identity
// that travelled across a boundary (a signed viewer token).
describe('pinAllowedRootIdentities', () => {
  let dir, outside;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-ident-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-ident-outside-'));
    writeFileSync(path.join(dir, 'ok.txt'), 'in scope\n');
    writeFileSync(path.join(outside, 'ok.txt'), 'OUT OF SCOPE\n');
  });
  afterAll(() => {
    for (const d of [dir, outside]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  const identitiesFor = (p) => pinAllowedRootsSync([p]).roots
    .map(({ realPath, dev, ino }) => ({ realPath, dev, ino }));

  it('is interchangeable with pinAllowedRootsSync for an unchanged root', async () => {
    const allowedRoots = pinAllowedRootIdentities(identitiesFor(dir));
    const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), { allowedRoots });
    expect(content.toString('utf-8')).toBe('in scope\n');
    expect(realPath).toBe(path.join(dir, 'ok.txt'));
  });

  it('survives a JSON round-trip, which is the point of carrying identities', async () => {
    const carried = JSON.parse(JSON.stringify(identitiesFor(dir)));
    const allowedRoots = pinAllowedRootIdentities(carried);
    const { content } = await validateAndOpen(path.join(dir, 'ok.txt'), { allowedRoots });
    expect(content.toString('utf-8')).toBe('in scope\n');
  });

  it('rejects the root once its directory is replaced by a different one', async () => {
    const swapRoot = mkdtempSync(path.join(tmpdir(), 'flg-ident-swap-'));
    const realDir = path.join(swapRoot, 'work');
    mkdirSync(realDir);
    writeFileSync(path.join(realDir, 'ok.txt'), 'in scope\n');
    const allowedRoots = pinAllowedRootIdentities(identitiesFor(realDir));

    // Rename the pinned directory away and drop a symlink to elsewhere in its
    // place — the classic move that a bare pathname boundary follows.
    renameSync(realDir, path.join(swapRoot, 'work.bak'));
    symlinkSync(outside, realDir);

    try {
      let denial;
      try {
        await validateAndOpen(path.join(realDir, 'ok.txt'), { allowedRoots });
      } catch (err) {
        denial = err;
      }
      expect(denial).toBeInstanceOf(FileLinkDenied);
      expect(denial.reason).toBe('bad-workdir');
    } finally {
      rmSync(swapRoot, { recursive: true, force: true });
    }
  });

  it('refuses an empty capability — no roots is a broken scope, not an open one', async () => {
    for (const empty of [[], null, undefined]) {
      expect(() => pinAllowedRootIdentities(empty))
        .toThrowError(expect.objectContaining({ reason: 'bad-workdir' }));
    }
    // The hazard it prevents: an empty branded capability reaches
    // validateAndOpen's pinned-root branch with nothing to compare, and with
    // no workdir there is no containment left either.
    const { content } = await validateAndOpen(path.join(outside, 'ok.txt'), {
      allowedRoots: pinAllowedRootsSync([]),
    });
    expect(content.toString('utf-8')).toBe('OUT OF SCOPE\n');
  });

  it('fails closed on a malformed identity rather than degrading to no scope', () => {
    const malformed = [
      [{}],
      [{ realPath: 'relative/path', dev: 1, ino: 2 }],
      [{ realPath: '/abs', dev: 'one', ino: 2 }],
      [{ realPath: '/abs', dev: 1 }],
      [null],
    ];
    for (const identities of malformed) {
      expect(() => pinAllowedRootIdentities(identities))
        .toThrowError(expect.objectContaining({ reason: 'bad-workdir' }));
    }
  });
});

describe('buildFilesDeepLink', () => {
  const WEB = 'https://bridge.easelyte.ai';
  const WORK = '/root/.openclaw/workspace';

  it('mints a token-less #files= hash link for an in-root, non-sensitive file', () => {
    const link = buildFilesDeepLink(`${WORK}/dan-offer.md`, WORK, WEB);
    expect(link).toBe(`${WEB}/#files=${encodeURIComponent(`${WORK}/dan-offer.md`)}`);
    // No token/HMAC in the URL — auth is the operator's web session.
    expect(link).not.toContain('token=');
  });

  it('url-encodes a path with spaces so the fragment stays a single token', () => {
    const p = `${WORK}/my notes.md`;
    const link = buildFilesDeepLink(p, WORK, WEB);
    expect(link).toBe(`${WEB}/#files=${encodeURIComponent(p)}`);
    expect(link).toContain('%20');
  });

  it('strips a trailing slash from the web base URL', () => {
    const link = buildFilesDeepLink(`${WORK}/a.md`, WORK, `${WEB}/`);
    expect(link).toBe(`${WEB}/#files=${encodeURIComponent(`${WORK}/a.md`)}`);
  });

  it('returns null when the web base URL is unset (feature dormant)', () => {
    expect(buildFilesDeepLink(`${WORK}/a.md`, WORK, '')).toBeNull();
    expect(buildFilesDeepLink(`${WORK}/a.md`, WORK, undefined)).toBeNull();
  });

  it('returns null (plain-path fallback) for a target outside the workdir/read-root', () => {
    expect(buildFilesDeepLink('/etc/passwd', WORK, WEB)).toBeNull();
  });

  it('returns null (plain-path fallback) for a sensitive-looking file even inside the root', () => {
    expect(buildFilesDeepLink(`${WORK}/.env`, WORK, WEB)).toBeNull();
    expect(buildFilesDeepLink(`${WORK}/secrets.json`, WORK, WEB)).toBeNull();
  });

  it('returns null for a relative or empty path', () => {
    expect(buildFilesDeepLink('relative/a.md', WORK, WEB)).toBeNull();
    expect(buildFilesDeepLink('', WORK, WEB)).toBeNull();
  });

  it('gates on sensitive names with no workdir given (containment optional, sensitivity always)', () => {
    expect(buildFilesDeepLink(`${WORK}/a.md`, null, WEB)).toBe(
      `${WEB}/#files=${encodeURIComponent(`${WORK}/a.md`)}`,
    );
    expect(buildFilesDeepLink(`${WORK}/id_rsa`, null, WEB)).toBeNull();
  });
});

describe('appendFilesDeepLink', () => {
  const LINK = 'https://bridge.easelyte.ai/#files=%2Fx%2Fa.md';

  it('appends a labelled link line after existing caption text', () => {
    const out = appendFilesDeepLink('here is the doc', LINK);
    expect(out).toBe(`here is the doc\n\n📁 Open in Files: ${LINK}`);
  });

  it('uses the file name in the label when given', () => {
    const out = appendFilesDeepLink('here is the doc', LINK, 'a.md');
    expect(out).toBe(`here is the doc\n\n📁 Open a.md in Files: ${LINK}`);
  });

  it('returns only the link line when the caption is empty', () => {
    expect(appendFilesDeepLink('', LINK)).toBe(`📁 Open in Files: ${LINK}`);
    expect(appendFilesDeepLink(undefined, LINK)).toBe(`📁 Open in Files: ${LINK}`);
  });

  it('returns the text verbatim when there is no link (plain-path fallback)', () => {
    expect(appendFilesDeepLink('plain body', null)).toBe('plain body');
    expect(appendFilesDeepLink('plain body', undefined)).toBe('plain body');
    expect(appendFilesDeepLink('', null)).toBe('');
    expect(appendFilesDeepLink(undefined, null)).toBe('');
  });
});
