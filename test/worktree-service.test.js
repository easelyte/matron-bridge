import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorktreeLedger, parseWorktreePath } from '../lib/worktree-ledger.js';
import { createWorktreeService, WorktreeRemovedError } from '../lib/worktree-service.js';
import { gitRun } from '../lib/worktree.js';
import { git, makeRepo, roomyStatfs } from './helpers/worktree-repo.js';

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function harness({ files, env = {}, run } = {}) {
  const r = makeRepo({ files });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wtsvc-'));
  cleanups.push(() => { r.cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
  const ledger = createWorktreeLedger({ file: path.join(home, 'worktrees.json') });
  const service = createWorktreeService({ ledger, statfs: roomyStatfs, env, ...(run ? { run } : {}) });
  return { r, home, ledger, service, start: (name, workdir = r.repo) => service.start({ workdir, name }) };
}

describe('parseWorktreePath', () => {
  it('finds the worktree root from the root or any folder below it', () => {
    expect(parseWorktreePath('/r/.claude/worktrees/a')).toEqual({ root: '/r', name: 'a', path: '/r/.claude/worktrees/a' });
    expect(parseWorktreePath('/r/.claude/worktrees/a/pkg/x')).toMatchObject({ name: 'a', path: '/r/.claude/worktrees/a' });
  });
  it('treats a Windows path as forward slashes with a lower-case drive letter', () => {
    expect(parseWorktreePath('C:\\r\\.claude\\worktrees\\a')).toMatchObject({ root: 'c:/r', name: 'a', path: 'c:/r/.claude/worktrees/a' });
    expect(parseWorktreePath('c:/r/.claude/worktrees/a')).toMatchObject({ root: 'c:/r' });
  });
  it('is null elsewhere', () => {
    expect(parseWorktreePath('/r/.claude/worktrees')).toBe(null);
    expect(parseWorktreePath('/r/src')).toBe(null);
    expect(parseWorktreePath('')).toBe(null);
  });
});

describe('ledger lookups ignore drive-letter case', () => {
  it('finds a worktree recorded as C:\\ when asked as c:/', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wtl-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const ledger = createWorktreeLedger({ file: path.join(home, 'l.json') });
    ledger.add('C:\\r\\.claude\\worktrees\\a', { name: 'a', branch: 'wt/a', root: 'C:\\r' });
    expect(ledger.get('c:/r/.claude/worktrees/a/pkg')).toMatchObject({ branch: 'wt/a' });
    expect(ledger.get('C:/R/.claude/worktrees/a')).toBe(null); // the rest of the path is case-sensitive
    expect(ledger.list('c:/r')).toHaveLength(1);
    ledger.markRemoved('c:\\r\\.claude\\worktrees\\a');
    expect(ledger.removedFor('C:\\r\\.claude\\worktrees\\a', { exists: () => true })).toBeTruthy();
  });
});

describe('start', () => {
  it('records the worktree and gives the spawn what it needs', async () => {
    const h = harness();
    const out = await h.start('fix-1');
    expect(out.ok).toBe(true);
    expect(h.ledger.get(out.cwd)).toMatchObject({ name: 'fix-1', branch: 'wt/fix-1', root: h.r.repo });
    expect(h.service.info(out.cwd)).toMatchObject({ branch: 'wt/fix-1', path: out.entry.path });
    expect(h.service.noticeBlock(out.cwd)).toMatch(/point at the main checkout/);
  });

  it('keeps the remote URL out of the ledger file, and the file owner-only', async () => {
    const h = harness();
    const url = 'https://alice:example-token@example.com/x.git';
    // Report a credentialed URL for origin; every other git call is real.
    const run = async (args, opts) => {
      const out = await gitRun(args, opts);
      return args.join(' ') === 'config --get remote.origin.url' ? { ...out, stdout: url } : out;
    };
    const svc = createWorktreeService({ ledger: h.ledger, statfs: roomyStatfs, env: {}, run });
    const out = await svc.start({ workdir: h.r.repo, name: 'secret-check' });
    expect(out.ok).toBe(true);
    const file = path.join(h.home, 'worktrees.json');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('example-token');
    expect(h.ledger.get(out.cwd)).not.toHaveProperty('origin');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('is not a worktree session for any other workdir', async () => {
    const h = harness();
    await h.start('fix-1');
    expect(h.service.info(h.r.repo)).toBe(null);
    expect(h.service.noticeBlock(h.r.repo)).toBe('');
  });

  it('refuses a taken branch without recording anything', async () => {
    const h = harness();
    git(h.r.repo, 'branch', 'wt/dup');
    const out = await h.start('dup');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/dup-2/);
    expect(h.ledger.list()).toEqual([]);
  });

  it('refuses beyond the per-repo limit (default 5, or the configured one)', async () => {
    const h = harness({ env: { MATRON_WORKTREE_MAX: '2' } });
    expect((await h.start('a')).ok).toBe(true);
    expect((await h.start('b')).ok).toBe(true);
    const third = await h.start('c');
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/limit is 2/);
  });

  it('a worktree whose folder is gone no longer counts toward the limit', async () => {
    const h = harness({ env: { MATRON_WORKTREE_MAX: '1' } });
    const a = await h.start('a');
    expect((await h.start('b')).ok).toBe(false);
    fs.rmSync(a.entry.path, { recursive: true, force: true });
    git(h.r.repo, 'worktree', 'prune');
    git(h.r.repo, 'branch', '-D', 'wt/a');
    expect((await h.start('b')).ok).toBe(true);
  });

  it('does not wait for submodules or LFS: they come back in background()', async () => {
    const files = { 'README.md': 'x\n', '.gitmodules': '[submodule "m"]\n\tpath = m\n\turl = ./nowhere\n' };
    const calls = [];
    const real = (await import('../lib/worktree.js')).gitRun;
    const run = (args, opts) => (args.includes('submodule')
      ? (calls.push('submodule'), Promise.resolve({ code: 1, stdout: '', stderr: 'fatal: no url found' }))
      : real(args, opts));
    const h = harness({ files, run });
    const out = await h.start('s');
    expect(out.ok).toBe(true);
    expect(calls).toEqual([]);
    const notes = await out.background();
    expect(calls).toEqual(['submodule']);
    expect(notes.join(' ')).toMatch(/Submodules were not initialised/);
  });

  it('a throwing post-create step is a note, never a failed start', async () => {
    const h = harness();
    const out = await h.start('t');
    fs.rmSync(out.entry.path, { recursive: true, force: true });
    await expect(out.background()).resolves.toBeInstanceOf(Array);
  });
});

describe('resuming in a removed worktree', () => {
  it('is refused once the worktree is marked removed, and the folder is not recreated', async () => {
    const h = harness();
    const out = await h.start('a');
    expect(h.service.removedFor(out.cwd)).toBe(null);
    fs.rmSync(out.entry.path, { recursive: true, force: true });
    git(h.r.repo, 'worktree', 'prune');
    h.ledger.markRemoved(out.entry.path);
    const gone = h.service.removedFor(out.cwd);
    expect(gone).toMatchObject({ branch: 'wt/a' });
    expect(h.service.removedFor(path.join(out.cwd, 'sub'))).toBeTruthy();
    expect(new WorktreeRemovedError(gone).message).toMatch(/was removed, so this session cannot be resumed/);
    expect(fs.existsSync(out.entry.path)).toBe(false);
  });

  it('a worktree deleted by hand is refused on resume too', async () => {
    const h = harness();
    const out = await h.start('a');
    fs.rmSync(out.entry.path, { recursive: true, force: true });
    expect(h.service.removedFor(out.cwd)).toBeTruthy();
    expect(h.service.info(out.cwd)).toBe(null);
  });

  it('a folder that was never one of ours is left to the existing fallbacks', () => {
    const h = harness();
    expect(h.service.removedFor('/somewhere/.claude/worktrees/not-ours')).toBe(null);
    expect(h.service.removedFor('/home/alice/project')).toBe(null);
  });
});
