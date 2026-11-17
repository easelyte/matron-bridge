import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { assessWorktree, createWorktree, removeWorktree } from '../lib/worktree.js';
import { git, makeRepo, roomyStatfs } from './helpers/worktree-repo.js';

const repos = [];
const fresh = (opts) => { const r = makeRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) repos.pop().cleanup(); });

describe('cleanup decision matrix', () => {
  async function wt(name = 'm') {
    const r = fresh();
    const out = await createWorktree({ workdir: r.repo, name, statfs: roomyStatfs });
    const args = { path: out.path, branch: out.branch, base: out.base, root: r.repo };
    return { r, out, args };
  }
  const commit = (dir, file = 'work.txt') => {
    fs.writeFileSync(path.join(dir, file), 'work\n');
    git(dir, 'add', file);
    git(dir, 'commit', '-m', `add ${file}`);
  };

  it('a fresh worktree is removable (merged, nothing to lose)', async () => {
    const { args } = await wt();
    const a = await assessWorktree(args);
    expect(a).toMatchObject({ removable: true, blockers: [], merged: true });
  });

  it('uncommitted changes block', async () => {
    const { out, args } = await wt();
    fs.appendFileSync(path.join(out.path, 'README.md'), 'edit\n');
    const a = await assessWorktree(args);
    expect(a.removable).toBe(false);
    expect(a.blockers.join()).toMatch(/uncommitted/);
  });

  it('untracked files block, ignored ones do not', async () => {
    const { out, args } = await wt();
    fs.writeFileSync(path.join(out.path, '.gitignore'), 'build/\n');
    git(out.path, 'add', '.gitignore');
    git(out.path, 'commit', '-m', 'ignore build');
    git(out.path, 'push', 'origin', 'wt/m');
    fs.mkdirSync(path.join(out.path, 'build'));
    fs.writeFileSync(path.join(out.path, 'build', 'out.js'), 'x\n');
    expect((await assessWorktree(args)).removable).toBe(true);
    fs.writeFileSync(path.join(out.path, 'notes.txt'), 'x\n');
    const a = await assessWorktree(args);
    expect(a.removable).toBe(false);
    expect(a.blockers.join()).toMatch(/untracked/);
  });

  it('an unpushed commit blocks; pushing it (unmerged) makes it removable', async () => {
    const { out, args } = await wt();
    commit(out.path);
    let a = await assessWorktree(args);
    expect(a.removable).toBe(false);
    expect(a.blockers.join()).toMatch(/1 unpushed commit/);
    expect(a.blockers.join()).toMatch(/neither merged nor pushed/);
    git(out.path, 'push', 'origin', 'wt/m');
    a = await assessWorktree(args);
    expect(a).toMatchObject({ removable: true, merged: false, pushed: true });
  });

  it('commits made after a push are unpushed again (upstream configured)', async () => {
    const { out, args } = await wt();
    commit(out.path, 'one.txt');
    git(out.path, 'push', '-u', 'origin', 'wt/m');
    commit(out.path, 'two.txt');
    const a = await assessWorktree(args);
    expect(a.blockers.join()).toMatch(/1 unpushed commit/);
  });

  it('a branch merged into origin/main counts as merged', async () => {
    const { r, out, args } = await wt();
    commit(out.path);
    git(out.path, 'push', 'origin', 'wt/m');
    git(r.seed, 'fetch', 'origin');
    git(r.seed, 'merge', '--ff-only', 'origin/wt/m');
    git(r.seed, 'push', 'origin', 'main');
    git(r.repo, 'fetch', 'origin');
    expect((await assessWorktree(args)).merged).toBe(true);
  });

  it('removeWorktree removes a clean worktree, prunes, and deletes a merged branch', async () => {
    const { r, out, args } = await wt();
    const res = await removeWorktree(args);
    expect(res).toMatchObject({ removed: true, branchDeleted: true });
    expect(fs.existsSync(out.path)).toBe(false);
    expect(git(r.repo, 'worktree', 'list', '--porcelain')).not.toContain('worktrees/m');
    expect(() => git(r.repo, 'rev-parse', '--verify', 'refs/heads/wt/m')).toThrow();
  });

  it('removeWorktree keeps an unmerged but pushed branch', async () => {
    const { r, out, args } = await wt();
    commit(out.path);
    git(out.path, 'push', 'origin', 'wt/m');
    const res = await removeWorktree(args);
    expect(res).toMatchObject({ removed: true, branchDeleted: false });
    expect(git(r.repo, 'rev-parse', '--verify', 'refs/heads/wt/m')).toBeTruthy();
  });

  it('removeWorktree keeps a dirty worktree and says a step-up could discard it', async () => {
    const { out, args } = await wt();
    fs.writeFileSync(path.join(out.path, 'wip.txt'), 'x\n');
    const res = await removeWorktree(args);
    expect(res).toMatchObject({ removed: false, kept: true, needsStepUp: true });
    expect(res.blockers.join()).toMatch(/untracked/);
    expect(fs.existsSync(out.path)).toBe(true);
  });

  it('discard removes it anyway and leaves an unmerged branch alone', async () => {
    const { r, out, args } = await wt();
    commit(out.path);
    fs.writeFileSync(path.join(out.path, 'wip.txt'), 'x\n');
    const res = await removeWorktree({ ...args, discard: true });
    expect(res).toMatchObject({ removed: true, discarded: true, branchDeleted: false });
    expect(fs.existsSync(out.path)).toBe(false);
    expect(git(r.repo, 'rev-parse', '--verify', 'refs/heads/wt/m')).toBeTruthy();
  });

  it('a worktree whose folder is already gone is simply pruned', async () => {
    const { r, out, args } = await wt();
    fs.rmSync(out.path, { recursive: true, force: true });
    const res = await removeWorktree(args);
    expect(res.removed).toBe(true);
    expect(git(r.repo, 'worktree', 'list', '--porcelain')).not.toContain('worktrees/m');
  });
});


describe('commits that only the HEAD history holds', () => {
  async function wt() {
    const r = fresh();
    const out = await createWorktree({ workdir: r.repo, name: 'd', statfs: roomyStatfs });
    return { r, out, args: { path: out.path, branch: out.branch, base: out.base, root: r.repo } };
  }
  const commit = (dir, file) => { fs.writeFileSync(path.join(dir, file), 'w\n'); git(dir, 'add', file); git(dir, 'commit', '-m', file); };

  it('a commit made on a detached HEAD blocks removal, pushed or not elsewhere', async () => {
    const { out, args } = await wt();
    git(out.path, 'checkout', '--detach');
    commit(out.path, 'orphan.txt');
    const a = await assessWorktree(args);
    expect(a.removable).toBe(false);
    expect(a.blockers.join()).toMatch(/HEAD is detached/);
    expect(a.blockers.join()).toMatch(/1 commit in the HEAD history that no branch or remote contains/);
  });

  it('a detached HEAD at a commit some branch holds is still flagged detached', async () => {
    const { out, args } = await wt();
    git(out.path, 'checkout', '--detach');
    const a = await assessWorktree(args);
    expect(a.detached).toBe(true);
    expect(a.strayCommits).toBe(0);
  });

  it('a commit left behind by a reset or amend (reflog only) blocks removal', async () => {
    const { out, args } = await wt();
    commit(out.path, 'a.txt');
    git(out.path, 'push', 'origin', 'wt/d');
    commit(out.path, 'b.txt');
    git(out.path, 'reset', '--hard', 'HEAD~1');
    // Branch and remote hold the pushed commit; the reset-away one is in the reflog only.
    const a = await assessWorktree(args);
    expect(a.removable).toBe(false);
    expect(a.strayCommits).toBe(1);
  });

  it('removal keeps such a worktree, and discard still removes it', async () => {
    const { r, out, args } = await wt();
    git(out.path, 'checkout', '--detach');
    commit(out.path, 'orphan.txt');
    expect(await removeWorktree(args)).toMatchObject({ removed: false, kept: true, needsStepUp: true });
    expect(fs.existsSync(out.path)).toBe(true);
    const res = await removeWorktree({ ...args, discard: true });
    expect(res.removed).toBe(true);
    expect(git(r.repo, 'worktree', 'list', '--porcelain')).not.toContain('worktrees/d');
  });

  it('a clean fresh worktree and a normal pushed branch are not flagged', async () => {
    const { out, args } = await wt();
    expect(await assessWorktree(args)).toMatchObject({ removable: true, detached: false, strayCommits: 0 });
    commit(out.path, 'c.txt');
    git(out.path, 'push', 'origin', 'wt/d');
    expect((await assessWorktree(args)).removable).toBe(true);
  });
});

describe('removal runs no repository hooks', () => {
  it('reference-transaction does not fire when the merged branch is deleted', async () => {
    const r = fresh();
    const out = await createWorktree({ workdir: r.repo, name: 'h', statfs: roomyStatfs });
    const marker = path.join(r.dir, 'hook-ran');
    fs.writeFileSync(path.join(r.repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    const res = await removeWorktree({ path: out.path, branch: out.branch, base: out.base, root: r.repo });
    expect(res.removed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
