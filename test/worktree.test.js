import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  checkDisk, createWorktree, ensureExcluded, extractWorktreeFlag, finishWorktree, gitEnv, gitRun,
  maxWorktreesPerRepo, validateName, withoutHooks, worktreeHeaderLine, worktreeNoticeBlock,
} from '../lib/worktree.js';
import { git, makeRepo, roomyStatfs } from './helpers/worktree-repo.js';

const repos = [];
const fresh = (opts) => { const r = makeRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) repos.pop().cleanup(); });

describe('extractWorktreeFlag', () => {
  it('takes the next token, or --worktree=<name>, from anywhere', () => {
    expect(extractWorktreeFlag(['--worktree', 'fix-1', '/repo'])).toMatchObject({ present: true, name: 'fix-1', rest: ['/repo'], error: null });
    expect(extractWorktreeFlag(['/repo', '--worktree=fix-1'])).toMatchObject({ present: true, name: 'fix-1', rest: ['/repo'] });
  });
  it('is absent without the flag, and an error without a name', () => {
    expect(extractWorktreeFlag(['/repo'])).toMatchObject({ present: false, name: null, rest: ['/repo'], error: null });
    expect(extractWorktreeFlag(['--worktree']).error).toMatch(/Usage/);
    expect(extractWorktreeFlag(['--worktree', '--browser']).error).toMatch(/Usage/);
    expect(extractWorktreeFlag(['--worktree=']).error).toMatch(/Usage/);
  });
});

describe('validateName', () => {
  it.each(['', 'a b', '../x', 'a..b', '-x', 'x.lock', 'x.', 'a/b', 'a~b', 'a:b', 'x'.repeat(65)])('rejects %j', async (name) => {
    const r = await validateName(name);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid worktree name|not a valid git branch/);
  });
  it.each(['fix-1', 'feature_x', 'v1.2', 'A9'])('accepts %j', async (name) => {
    expect((await validateName(name)).ok).toBe(true);
  });
  it('asks git whether wt/<name> is a valid branch', async () => {
    const calls = [];
    const run = async (args) => { calls.push(args); return { code: 1, stdout: '', stderr: '' }; };
    const r = await validateName('ok-name', run);
    expect(r.ok).toBe(false);
    expect(calls[0]).toEqual(['check-ref-format', '--branch', 'wt/ok-name']);
  });
});

describe('limits', () => {
  it('maxWorktreesPerRepo defaults to 5 and is configurable', () => {
    expect(maxWorktreesPerRepo({})).toBe(5);
    expect(maxWorktreesPerRepo({ MATRON_WORKTREE_MAX: '2' })).toBe(2);
    expect(maxWorktreesPerRepo({ MATRON_WORKTREE_MAX: '0' })).toBe(5);
    expect(maxWorktreesPerRepo({ MATRON_WORKTREE_MAX: 'x' })).toBe(5);
  });
  const GB = 1024 ** 3;
  const statfs = (freeGb, totalGb) => () => ({ bavail: freeGb, bsize: GB, blocks: totalGb });
  it('refuses under 10 GB free', () => {
    const r = checkDisk('/x', { statfs: statfs(9, 1000) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/9\.0 GB free/);
  });
  it('refuses under 10% free even with plenty of GB', () => {
    const r = checkDisk('/x', { statfs: statfs(50, 1000) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/5% free/);
  });
  it('allows enough room, and an unreadable filesystem', () => {
    expect(checkDisk('/x', { statfs: statfs(100, 200) }).ok).toBe(true);
    expect(checkDisk('/x', { statfs: () => { throw new Error('nope'); } })).toEqual({ ok: true, known: false });
  });
});

describe('ensureExcluded', () => {
  it('writes .claude/worktrees/ to info/exclude once, never to .gitignore', () => {
    const r = fresh();
    const common = path.join(r.repo, '.git');
    expect(ensureExcluded(common)).toBe(true);
    expect(ensureExcluded(common)).toBe(false);
    const text = fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf-8');
    expect(text.match(/\.claude\/worktrees\//g)).toHaveLength(1);
    expect(fs.existsSync(path.join(r.repo, '.gitignore'))).toBe(false);
  });
  it('keeps what is already in the file', () => {
    const r = fresh();
    const file = path.join(r.repo, '.git', 'info', 'exclude');
    fs.writeFileSync(file, '*.log');
    ensureExcluded(path.join(r.repo, '.git'));
    expect(fs.readFileSync(file, 'utf-8')).toBe('*.log\n.claude/worktrees/\n');
  });
});

describe('createWorktree', () => {
  const make = (r, name, extra = {}) => createWorktree({ workdir: r.repo, name, statfs: roomyStatfs, ...extra });

  it('cuts wt/<name> from a freshly fetched origin/main under .claude/worktrees', async () => {
    const r = fresh();
    r.commitOnOrigin('later.txt', 'pushed after the clone\n');
    const out = await make(r, 'fix-1');
    expect(out.ok).toBe(true);
    expect(out.path).toBe(path.join(r.repo, '.claude', 'worktrees', 'fix-1'));
    expect(out.branch).toBe('wt/fix-1');
    expect(out.base).toBe('origin/main');
    // The fetch happened first: the commit made after the clone is there.
    expect(fs.existsSync(path.join(out.path, 'later.txt'))).toBe(true);
    expect(git(out.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/fix-1');
    // No upstream is configured, so nothing can be pushed by accident to main.
    expect(() => git(out.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    // Excluded locally; the main checkout stays clean.
    expect(fs.readFileSync(path.join(r.repo, '.git', 'info', 'exclude'), 'utf-8')).toContain('.claude/worktrees/');
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
  });

  it('starts from a subfolder of a linked worktree in the same repo', async () => {
    const r = fresh({ files: { 'README.md': 'x\n', 'pkg/a.txt': 'a\n' } });
    const first = await make(r, 'one');
    const second = await createWorktree({ workdir: path.join(first.path, 'pkg'), name: 'two', statfs: roomyStatfs });
    expect(second.ok).toBe(true);
    expect(second.path).toBe(path.join(r.repo, '.claude', 'worktrees', 'two'));
    expect(second.cwd).toBe(path.join(second.path, 'pkg'));
  });

  it('refuses a taken branch, suggests <name>-2 and never reuses it', async () => {
    const r = fresh();
    git(r.repo, 'branch', 'wt/fix-1');
    const out = await make(r, 'fix-1');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already exists/);
    expect(out.error).toMatch(/--worktree fix-1-2/);
    expect(fs.existsSync(path.join(r.repo, '.claude', 'worktrees', 'fix-1'))).toBe(false);
  });

  it('suggests the first free suffix', async () => {
    const r = fresh();
    git(r.repo, 'branch', 'wt/a');
    git(r.repo, 'branch', 'wt/a-2');
    const out = await make(r, 'a');
    expect(out.error).toMatch(/--worktree a-3/);
  });

  it('refuses a name git cannot use as a branch, creating nothing', async () => {
    const r = fresh();
    const out = await make(r, 'bad..name');
    expect(out.ok).toBe(false);
    expect(fs.existsSync(path.join(r.repo, '.claude'))).toBe(false);
  });

  it('refuses with no origin remote', async () => {
    const r = fresh();
    git(r.repo, 'remote', 'remove', 'origin');
    const out = await make(r, 'x');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no "origin" remote/);
  });

  it('refuses when the fetch fails, rather than cutting from a stale base', async () => {
    const r = fresh();
    git(r.repo, 'remote', 'set-url', 'origin', path.join(r.dir, 'does-not-exist.git'));
    const out = await make(r, 'x');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/git fetch origin failed/);
  });

  it('refuses at the per-repo limit (counted by the caller) and on a full disk', async () => {
    const r = fresh();
    const atLimit = await make(r, 'x', { countExisting: () => 5 });
    expect(atLimit.error).toMatch(/already has 5 worktrees \(the limit is 5/);
    const small = await make(r, 'x', { env: { MATRON_WORKTREE_MAX: '1' }, countExisting: () => 1 });
    expect(small.error).toMatch(/limit is 1/);
    const full = await createWorktree({ workdir: r.repo, name: 'x', statfs: () => ({ bavail: 1, bsize: 1024, blocks: 100 }) });
    expect(full.error).toMatch(/Not enough disk space/);
    expect(fs.existsSync(path.join(r.repo, '.claude'))).toBe(false);
  });

  it('passes git\'s own error through when worktree add fails', async () => {
    const r = fresh();
    const run = (args, opts) => (args.includes('worktree') && args.includes('add')
      ? Promise.resolve({ code: 128, stdout: '', stderr: "fatal: 'wt/x' is already checked out at '/elsewhere'" })
      : gitRun(args, opts));
    const out = await make(r, 'x', { run });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("'wt/x' is already checked out at '/elsewhere'");
    // and says how to clear a leftover branch or folder before retrying
    expect(out.error).toContain('git branch -D wt/x');
    expect(out.error).toContain('git worktree list');
  });

  it('gives the git child no repository-location variables, and keeps the prompt/lock guards', () => {
    const env = gitEnv({ GIT_DIR: '/a', GIT_WORK_TREE: '/b', GIT_INDEX_FILE: '/c', GIT_COMMON_DIR: '/d', PATH: '/bin', GIT_TERMINAL_PROMPT: '1' });
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) expect(env).not.toHaveProperty(k);
    expect(env).toMatchObject({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  });
});

describe('finishWorktree (submodules and LFS, after the start)', () => {
  const made = async (r, name, extra = {}) => createWorktree({ workdir: r.repo, name, statfs: roomyStatfs, ...extra });

  it('initialises submodules only when there is a .gitmodules, and a failure is a note', async () => {
    const r = fresh();
    const calls = [];
    const run = (args, opts) => { calls.push(args.join(' ')); return gitRun(args, opts); };
    const plain = await made(r, 'plain');
    expect(await finishWorktree({ path: plain.path, run })).toEqual([]);
    expect(calls.some((c) => c.includes('submodule'))).toBe(false);

    const r2 = fresh({ files: { 'README.md': 'x\n', '.gitmodules': '[submodule "m"]\n\tpath = m\n\turl = ./nowhere\n' } });
    const failing = (args, opts) => (args.includes('submodule')
      ? (calls.push(args.join(' ')), Promise.resolve({ code: 1, stdout: '', stderr: 'fatal: no url found for submodule path' }))
      : gitRun(args, opts));
    const sub = await made(r2, 'with-sub');
    const notes = await finishWorktree({ path: sub.path, run: failing });
    expect(calls.some((c) => c.includes('submodule update --init'))).toBe(true);
    expect(notes.join(' ')).toMatch(/Submodules were not initialised/);
  });

  it('runs git lfs pull only when .gitattributes says lfs', async () => {
    const r = fresh({ files: { 'README.md': 'x\n', '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' } });
    const calls = [];
    const run = (args, opts) => (args.includes('lfs')
      ? (calls.push('lfs'), Promise.resolve({ code: 1, stdout: '', stderr: 'git: lfs is not a git command' }))
      : gitRun(args, opts));
    const wt = await made(r, 'with-lfs');
    const notes = await finishWorktree({ path: wt.path, run });
    expect(calls).toEqual(['lfs']);
    expect(notes.join(' ')).toMatch(/lfs pull failed/);
    const r2 = fresh();
    const calls2 = [];
    const plain = await made(r2, 'no-lfs');
    await finishWorktree({ path: plain.path, run: (a, o) => { calls2.push(a.join(' ')); return gitRun(a, o); } });
    expect(calls2.some((c) => /lfs pull/.test(c))).toBe(false);
  });
});

describe('repository hooks and the environment', () => {
  const hook = (r, name, body) => {
    const file = path.join(r.repo, '.git', 'hooks', name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };

  it('a repository hook cannot run during create (post-checkout, reference-transaction)', async () => {
    const r = fresh();
    const marker = path.join(r.dir, 'hook-ran');
    hook(r, 'post-checkout', `echo ran >> "${marker}"`);
    hook(r, 'reference-transaction', `echo ran >> "${marker}"`);
    // Control: without the guard, git runs the hook.
    const control = path.join(r.dir, 'control');
    git(r.repo, 'worktree', 'add', '--detach', control);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    git(r.repo, 'worktree', 'remove', '--force', control);
    fs.rmSync(marker, { force: true });

    const out = await createWorktree({ workdir: r.repo, name: 'guarded', statfs: roomyStatfs });
    expect(out.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('git runs get no journal credential or bridge-only secret', async () => {
    const saved = { j: process.env.JOURNAL_TOKEN, h: process.env.HMAC_SECRET };
    process.env.JOURNAL_TOKEN = 'secret-token';
    process.env.HMAC_SECRET = 'secret-hmac';
    try {
      const r = await gitRun(['-c', 'alias.envdump=!env', 'envdump']);
      expect(r.stdout).not.toContain('secret-token');
      expect(r.stdout).not.toContain('secret-hmac');
      expect(r.stdout).toContain('GIT_TERMINAL_PROMPT=0');
    } finally {
      if (saved.j === undefined) delete process.env.JOURNAL_TOKEN; else process.env.JOURNAL_TOKEN = saved.j;
      if (saved.h === undefined) delete process.env.HMAC_SECRET; else process.env.HMAC_SECRET = saved.h;
    }
  });

  it('withoutHooks puts core.hooksPath at an empty private directory and removes it after', () => {
    const calls = [];
    const h = withoutHooks((args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); });
    h.run(['fetch']);
    const dir = calls[0][1].replace('core.hooksPath=', '');
    expect(calls[0][0]).toBe('-c');
    expect(fs.readdirSync(dir)).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o077).toBe(0);
    h.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('notice', () => {
  const info = { path: '/repo/.claude/worktrees/x', root: '/repo', branch: 'wt/x', base: 'origin/main' };
  it('tells the agent where it is and where the servers point', () => {
    const text = worktreeNoticeBlock({ ...info, setupLine: 'Setup ran.', extra: 'Run npm test here.' });
    expect(text).toContain('/repo/.claude/worktrees/x');
    expect(text).toContain('wt/x');
    expect(text).toMatch(/dev server, the public URL, OAuth callbacks and webhooks point at the main checkout \(\/repo\)/);
    expect(text).toMatch(/say exactly what you could not test/);
    expect(text).toContain('Setup ran.');
    expect(text.endsWith('Run npm test here.')).toBe(true);
  });
  it('is empty outside a worktree and has a one-line header', () => {
    expect(worktreeNoticeBlock(null)).toBe('');
    expect(worktreeHeaderLine(null)).toBe('');
    expect(worktreeHeaderLine(info)).toBe('Worktree: /repo/.claude/worktrees/x on wt/x');
  });
});
