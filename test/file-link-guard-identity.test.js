import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitivePath, validateAndOpen, pinAllowedRootsSync, pinAllowedRootIdentities, FileLinkDenied,
} from '../lib/file-link-guard.js';

describe('isSensitivePath: credential files and directories', () => {
  it.each([
    '/root/.secrets', '/root/.secrets/req-abc.txt', '/root/.supabase/access-token',
    '/etc/x/agent-token', '/w/agent_token.json', '/w/bridge-agent-creds.txt',
    '/root/.claude-matrix-sessions.json', '/root/.matron-bridge-secrets.json',
    '/w/journal-cursor.json', '/root/.bash_history',
    '/root/.codex/auth.json', '/root/.config/gh/hosts.yml', '/root/auth.json',
    '/root/.git-credentials', '/root/.pgpass', '/root/.claude.json',
    '/home/u/.gcloud/x', '/home/u/.azure/y',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it.each([
    '/w/tokenizer.js', '/w/docs/agent-token.md', '/w/src/credit.js', '/w/history.md',
    '/w/lib/journal-cursor.js', '/w/configure.js', '/w/.claude/skills/x/SKILL.md',
  ])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

describe('fdRealPath (platforms without procfs)', () => {
  let dir, outside;
  const asDarwin = async (fn) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
  };
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-race-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-race-outside-'));
    mkdirSync(path.join(dir, 'decoy'));
    writeFileSync(path.join(dir, 'decoy', 'doc.txt'), 'harmless decoy\n');
    writeFileSync(path.join(outside, 'doc.txt'), 'STOLEN SECRET\n');
    symlinkSync(outside, path.join(dir, 'swap'));
  });
  afterAll(() => {
    for (const d of [dir, outside]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('serves a normal in-scope file when there is no race', async () => {
    await asDarwin(async () => {
      const { content } = await validateAndOpen(path.join(dir, 'decoy', 'doc.txt'), { workdir: dir });
      expect(content.toString('utf-8')).toBe('harmless decoy\n');
    });
  });

  it('refuses when a parent directory is swapped after open', async () => {
    const swapLink = path.join(dir, 'swap');
    const actualOpen = fsp.open.bind(fsp);
    // Swap inside open() so the race is deterministic: the descriptor already
    // holds the out-of-scope file while every later pathname walk looks in scope.
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const fd = await actualOpen(...args);
      rmSync(swapLink, { force: true });
      symlinkSync(path.join(dir, 'decoy'), swapLink);
      return fd;
    });
    try {
      await asDarwin(async () => {
        let denial;
        try { await validateAndOpen(path.join(dir, 'swap', 'doc.txt'), { workdir: dir }); } catch (e) { denial = e; }
        expect(denial).toBeInstanceOf(FileLinkDenied);
        expect(denial.reason).toBe('path-race');
      });
    } finally {
      openSpy.mockRestore();
      rmSync(swapLink, { force: true });
      symlinkSync(outside, swapLink);
    }
  });
});

describe('pinAllowedRootIdentities', () => {
  let dir, outside;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-ident-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-ident-outside-'));
    writeFileSync(path.join(dir, 'ok.txt'), 'in scope\n');
    writeFileSync(path.join(outside, 'ok.txt'), 'OUT OF SCOPE\n');
  });
  afterAll(() => {
    for (const d of [dir, outside]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const identitiesFor = (p) => pinAllowedRootsSync([p]).roots.map(({ realPath, dev, ino }) => ({ realPath, dev, ino }));

  it('works like pinAllowedRootsSync for an unchanged root, across a JSON round-trip', async () => {
    const allowedRoots = pinAllowedRootIdentities(JSON.parse(JSON.stringify(identitiesFor(dir))));
    const { content } = await validateAndOpen(path.join(dir, 'ok.txt'), { allowedRoots });
    expect(content.toString('utf-8')).toBe('in scope\n');
  });

  it('rejects the root once its directory is replaced by a symlink elsewhere', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'flg-ident-swap-'));
    const realDir = path.join(base, 'work');
    mkdirSync(realDir);
    writeFileSync(path.join(realDir, 'ok.txt'), 'in scope\n');
    const allowedRoots = pinAllowedRootIdentities(identitiesFor(realDir));
    renameSync(realDir, path.join(base, 'work.bak'));
    symlinkSync(outside, realDir);
    try {
      let denial;
      try { await validateAndOpen(path.join(realDir, 'ok.txt'), { allowedRoots }); } catch (e) { denial = e; }
      expect(denial).toBeInstanceOf(FileLinkDenied);
      expect(denial.reason).toBe('bad-workdir');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [[]], [null], [undefined], [[{}]], [[null]],
    [[{ realPath: 'relative/path', dev: 1, ino: 2 }]],
    [[{ realPath: '/abs', dev: 'one', ino: 2 }]],
    [[{ realPath: '/abs', dev: 1 }]],
  ])('fails closed on unusable identities %j', (identities) => {
    expect(() => pinAllowedRootIdentities(identities))
      .toThrowError(expect.objectContaining({ reason: 'bad-workdir' }));
  });
});
