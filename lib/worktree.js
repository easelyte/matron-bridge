// `/start --worktree <name>`: start a session in a fresh git worktree.
//
// Strictly opt-in: only that flag creates one. The worktree lives at
// `<repo>/.claude/worktrees/<name>` on branch `wt/<name>`, cut from
// `origin/<default branch>` after a fetch. This module holds the git work
// (create, inspect, remove) and the notice the agent starts with; the setup
// script is lib/worktree-setup.js, the record of what exists is
// lib/worktree-ledger.js. Every git call goes through an injectable `run`
// that never throws: {code, stdout, stderr}.
import { execFile } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stripJournalCreds } from './journal-cred-scope.js';
import { WORKTREE_DIR } from './worktree-ledger.js';

export const BRANCH_PREFIX = 'wt/';
export const DEFAULT_MAX_PER_REPO = 5;
export const MIN_FREE_BYTES = 10 * 1024 ** 3;
export const MIN_FREE_FRACTION = 0.1;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FETCH_TIMEOUT_MS = 60_000;
const POST_STEP_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

export function maxWorktreesPerRepo(env = process.env) {
  const n = Number.parseInt(env.MATRON_WORKTREE_MAX ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PER_REPO;
}

// Variables that tell git where the repository is. Inherited from a hook or
// deploy script they would make git ignore `cwd`, so the child never gets them.
const GIT_LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
];

export function gitEnv(base = process.env) {
  const env = stripJournalCreds(base, { keepProviderKeys: true });
  for (const key of GIT_LOCATION_VARS) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

export function gitRun(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      // Repository hooks and filters run with this environment, so it carries
      // neither the journal credential nor the bridge-only secrets.
      env: gitEnv(),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() || (err && typeof err.code !== 'number' ? err.message : '') });
    });
  });
}

// A `run` that cannot trigger repository hooks: every call gets
// `-c core.hooksPath=<an empty private directory>`, so post-checkout,
// reference-transaction and friends from a repository we have not been told
// to trust do not run. `dispose` removes the directory.
export function withoutHooks(run, { fs = nodeFs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-nohooks-'));
  return {
    run: (args, opts) => run(['-c', `core.hooksPath=${dir}`, ...args], opts),
    dispose() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } },
  };
}

// `--worktree <name>` or `--worktree=<name>` anywhere in the tokens.
// A flag with no name is an error, not a silent no-op: the user asked for
// an isolated checkout and must not get the main one by accident.
export function extractWorktreeFlag(tokens = []) {
  const rest = [];
  let present = false;
  let name = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--worktree' || t.startsWith('--worktree=')) {
      present = true;
      if (t.startsWith('--worktree=')) name = t.slice('--worktree='.length);
      else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) name = tokens[++i];
      continue;
    }
    rest.push(t);
  }
  if (present && !name) return { present, name: null, rest, error: 'Usage: /start --worktree <name> [workdir]' };
  return { present, name, rest, error: null };
}

export async function validateName(name, run = gitRun) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) {
    return { ok: false, error: `Invalid worktree name "${String(name).slice(0, 80)}": use letters, digits, dot, dash and underscore (at most 64, starting with a letter or digit).` };
  }
  const r = await run(['check-ref-format', '--branch', `${BRANCH_PREFIX}${name}`]);
  if (r.code !== 0) return { ok: false, error: `"${BRANCH_PREFIX}${name}" is not a valid git branch name.` };
  return { ok: true };
}

// Free space check. Injectable statfs; fails open to "unknown, allow" only
// when the filesystem cannot be read at all.
export function checkDisk(dir, { statfs = nodeFs.statfsSync } = {}) {
  let s;
  try { s = statfs(dir); } catch { return { ok: true, known: false }; }
  const free = Number(s.bavail) * Number(s.bsize);
  const total = Number(s.blocks) * Number(s.bsize);
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return { ok: true, known: false };
  const gb = (free / 1024 ** 3).toFixed(1);
  if (free < MIN_FREE_BYTES) return { ok: false, known: true, error: `Not enough disk space for a worktree: ${gb} GB free, at least ${MIN_FREE_BYTES / 1024 ** 3} GB needed.` };
  if (free / total < MIN_FREE_FRACTION) return { ok: false, known: true, error: `Not enough disk space for a worktree: ${Math.round((free / total) * 100)}% free, at least ${MIN_FREE_FRACTION * 100}% needed.` };
  return { ok: true, known: true };
}

// The repo's main checkout, even when `dir` is inside a linked worktree or a
// subfolder: worktrees always hang off the main checkout.
export async function findRepo(dir, run = gitRun) {
  const top = await run(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0 || !top.stdout) return { ok: false, error: `${dir} is not inside a git repository.` };
  const common = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  if (common.code !== 0 || !common.stdout) return { ok: false, error: `Cannot find the git directory of ${dir}.` };
  if (path.basename(common.stdout) !== '.git') return { ok: false, error: 'This repository has no main checkout (bare repository); a worktree cannot be started from it.' };
  const root = path.dirname(common.stdout);
  return { ok: true, root, gitCommonDir: common.stdout, rel: path.relative(top.stdout, dir) };
}

export async function defaultBranchOf(root, run = gitRun) {
  const head = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (head.code === 0 && head.stdout.startsWith('origin/')) return head.stdout;
  for (const cand of ['origin/main', 'origin/master']) {
    const r = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${cand}`], { cwd: root });
    if (r.code === 0) return cand;
  }
  return null;
}

// `.claude/worktrees/` goes in .git/info/exclude (local to this clone), never
// in a tracked .gitignore. Idempotent.
export function ensureExcluded(gitCommonDir, { fs = nodeFs } = {}) {
  const file = path.join(gitCommonDir, 'info', 'exclude');
  const line = `${WORKTREE_DIR}/`;
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf-8'); } catch { /* none yet */ }
  if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === `/${line}`)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  return true;
}

async function firstFreeName(root, name, ledgerHas, run) {
  for (let n = 2; n < 100; n++) {
    const cand = `${name}-${n}`;
    const taken = await branchOrPathTaken(root, cand, ledgerHas, run);
    if (!taken) return cand;
  }
  return `${name}-2`;
}

async function branchOrPathTaken(root, name, ledgerHas, run, fs = nodeFs) {
  const b = await run(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${name}`], { cwd: root });
  if (b.code === 0) return true;
  const p = path.join(root, WORKTREE_DIR, name);
  return fs.existsSync(p) || ledgerHas(p);
}

// Create the worktree. Resolves {ok:true, path, cwd, branch, name, root, base, notes}
// or {ok:false, error}. Nothing is left behind on a refusal; the only
// side effect before `git worktree add` is the exclude line.
export async function createWorktree({
  workdir, name, run = gitRun, fs = nodeFs, statfs = nodeFs.statfsSync, env = process.env,
  countExisting = null, ledgerHas = () => false,
}) {
  const valid = await validateName(name, run);
  if (!valid.ok) return valid;
  const repo = await findRepo(workdir, run);
  if (!repo.ok) return repo;
  const { root, gitCommonDir } = repo;

  // The configured URL as written (not `remote get-url`, which applies insteadOf rewrites).
  const origin = await run(['config', '--get', 'remote.origin.url'], { cwd: root });
  if (origin.code !== 0 || !origin.stdout) return { ok: false, error: 'This repository has no "origin" remote, so there is nothing to cut a worktree from. Nothing was created.' };

  const max = maxWorktreesPerRepo(env);
  const existing = countExisting ? countExisting(root) : 0;
  if (existing >= max) return { ok: false, error: `This repository already has ${existing} worktrees (the limit is ${max}; MATRON_WORKTREE_MAX changes it). Archive or delete one first.` };
  const disk = checkDisk(root, { statfs });
  if (!disk.ok) return { ok: false, error: disk.error };

  const safe = withoutHooks(run, { fs });
  try {
    const fetched = await safe.run(['fetch', 'origin'], { cwd: root, timeoutMs: FETCH_TIMEOUT_MS });
    if (fetched.code !== 0) return { ok: false, error: `git fetch origin failed, so the worktree was not created: ${fetched.stderr || 'unknown error'}` };
    const base = await defaultBranchOf(root, run);
    if (!base) return { ok: false, error: 'Cannot tell origin\'s default branch (no origin/HEAD, origin/main or origin/master after fetch).' };

    if (await branchOrPathTaken(root, name, ledgerHas, run, fs)) {
      const suggestion = await firstFreeName(root, name, ledgerHas, run);
      return { ok: false, error: `Branch ${BRANCH_PREFIX}${name} (or the folder ${WORKTREE_DIR}/${name}) already exists. Try --worktree ${suggestion}.` };
    }

    ensureExcluded(gitCommonDir, { fs });
    const wtPath = path.join(root, WORKTREE_DIR, name);
    const branch = `${BRANCH_PREFIX}${name}`;
    const added = await safe.run(['worktree', 'add', '--no-track', '-b', branch, wtPath, base], { cwd: root });
    if (added.code !== 0) return { ok: false, error: `git worktree add failed: ${added.stderr || 'unknown error'}. If it was interrupted (for example a timeout), git may have left the branch ${branch} or the folder ${WORKTREE_DIR}/${name} behind. Check with \`git branch --list ${branch}\` and \`git worktree list\`; if nothing useful is on them, remove with \`git worktree remove --force ${WORKTREE_DIR}/${name}\` and \`git branch -D ${branch}\`, then retry.` };

    const gd = await run(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], { cwd: wtPath });
    const gitDir = gd.code === 0 ? gd.stdout : null;
    const cwd = repo.rel && !repo.rel.startsWith('..') && fs.existsSync(path.join(wtPath, repo.rel)) ? path.join(wtPath, repo.rel) : wtPath;
    return { ok: true, path: wtPath, cwd, branch, name, root, base, gitDir, origin: origin.stdout, notes: [] };
  } finally { safe.dispose(); }
}

// The slow, soft steps after the worktree exists: submodules (only with a
// .gitmodules) and LFS (only when configured). The worktree is usable
// without them, so a failure is a note, never an error. Run in the
// background by the caller, so a start does not wait on them.
export async function finishWorktree({ path: wtPath, run = gitRun, fs = nodeFs }) {
  const notes = [];
  const safe = withoutHooks(run, { fs });
  try {
    if (fs.existsSync(path.join(wtPath, '.gitmodules'))) {
      const sub = await safe.run(['submodule', 'update', '--init'], { cwd: wtPath, timeoutMs: POST_STEP_TIMEOUT_MS });
      if (sub.code !== 0) notes.push(`Submodules were not initialised (${sub.stderr.split('\n')[0] || 'failed'}); run git submodule update --init if you need them.`);
    }
    if (await usesLfs(wtPath, run, fs)) {
      const lfs = await safe.run(['lfs', 'pull'], { cwd: wtPath, timeoutMs: POST_STEP_TIMEOUT_MS });
      if (lfs.code !== 0) notes.push(`git lfs pull failed (${lfs.stderr.split('\n')[0] || 'failed'}); large files may be pointer stubs.`);
    }
  } finally { safe.dispose(); }
  return notes;
}

async function usesLfs(wtPath, _run, fs) {
  try {
    const attrs = fs.readFileSync(path.join(wtPath, '.gitattributes'), 'utf-8');
    return /filter=lfs/.test(attrs);
  } catch { /* no attributes file */ }
  // Only the repository's own attributes count: `filter.lfs.*` in a global
  // config (set by `git lfs install`) says LFS is installed, not that this
  // repository uses it.
  return false;
}

// Commits HEAD has pointed at (its reflog) that no branch or remote
// contains: after a detached-HEAD commit, a reset or an amend they are
// reachable from nowhere else and removal would orphan them. Looks at the
// newest 50 entries.
const REFLOG_LOOKBACK = 50;
async function reflogOnlyCommits(wtPath, run) {
  const log = await run(['reflog', 'show', '--format=%H', `-n${REFLOG_LOOKBACK}`, 'HEAD'], { cwd: wtPath });
  if (log.code !== 0) return 0;
  let stray = 0;
  for (const sha of new Set(log.stdout.split('\n').filter(Boolean))) {
    // for-each-ref, not `branch --contains`: that one also lists a detached HEAD itself.
    const held = await run(['for-each-ref', `--contains=${sha}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: wtPath });
    if (held.code === 0 && !held.stdout.trim()) stray += 1;
  }
  return stray;
}

// What stands between a worktree and removal. `blockers` is empty when it is
// safe to remove: no uncommitted changes, no untracked files other than
// ignored ones (status hides those), no unpushed commits, and the branch is
// merged into the default branch or pushed.
export async function assessWorktree({ path: wtPath, branch, base = null, root, run = gitRun, fs = nodeFs }) {
  if (!fs.existsSync(wtPath)) return { gone: true, removable: true, blockers: [], merged: false };
  const st = await run(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: wtPath });
  if (st.code !== 0) return { error: `git status failed: ${st.stderr}`, removable: false, blockers: ['git status failed'], merged: false };
  const lines = st.stdout.split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const modified = lines.length - untracked;

  const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: wtPath });
  let unpushed;
  if (upstream.code === 0) {
    const c = await run(['rev-list', '--count', `${upstream.stdout}..HEAD`], { cwd: wtPath });
    unpushed = Number.parseInt(c.stdout, 10) || 0;
  } else {
    const c = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: wtPath });
    unpushed = Number.parseInt(c.stdout, 10) || 0;
  }
  const baseRef = base || await defaultBranchOf(root, run);
  let merged = false;
  if (baseRef) merged = (await run(['merge-base', '--is-ancestor', branch, baseRef], { cwd: root })).code === 0;
  const pushed = unpushed === 0;
  const detached = (await run(['symbolic-ref', '-q', 'HEAD'], { cwd: wtPath })).code !== 0;
  const strayCommits = await reflogOnlyCommits(wtPath, run);

  const blockers = [];
  if (modified) blockers.push(`${modified} file${modified === 1 ? '' : 's'} with uncommitted changes`);
  if (untracked) blockers.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`);
  if (unpushed) blockers.push(`${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}`);
  if (!merged && !pushed) blockers.push(`branch ${branch} is neither merged nor pushed`);
  if (detached) blockers.push('HEAD is detached (commits made there belong to no branch)');
  if (strayCommits) blockers.push(`${strayCommits} commit${strayCommits === 1 ? '' : 's'} in the HEAD history that no branch or remote contains`);
  return { removable: blockers.length === 0, blockers, merged, pushed, modified, untracked, unpushed, detached, strayCommits };
}

// Remove the worktree when assessWorktree allows, or when `discard` says
// the user chose to lose what is left (the caller has checked the step-up).
// Then `git worktree prune`; the branch is deleted only when merged.
export async function removeWorktree({ path: wtPath, branch, base = null, root, discard = false, run = gitRun, fs = nodeFs }) {
  const a = await assessWorktree({ path: wtPath, branch, base, root, run, fs });
  if (a.error) return { removed: false, kept: true, blockers: a.blockers, error: a.error };
  if (!a.removable && !discard) return { removed: false, kept: true, blockers: a.blockers, needsStepUp: true, merged: a.merged };
  const safe = withoutHooks(run, { fs });
  try {
    if (!a.gone) {
      const rm = await safe.run(['worktree', 'remove', ...(discard ? ['--force'] : []), wtPath], { cwd: root });
      if (rm.code !== 0) return { removed: false, kept: true, blockers: a.blockers, error: `git worktree remove failed: ${rm.stderr}` };
    }
    await safe.run(['worktree', 'prune'], { cwd: root });
    let branchDeleted = false;
    if (a.merged) branchDeleted = (await safe.run(['branch', '-D', branch], { cwd: root })).code === 0;
    return { removed: true, kept: false, branchDeleted, blockers: [], discarded: !a.removable };
  } finally { safe.dispose(); }
}

// The note the agent starts with, and the one-line header for the user.
export function worktreeNoticeBlock(info) {
  if (!info) return '';
  const lines = [
    '## You are working in a git worktree',
    `Your working directory is ${info.path}, a git worktree of ${info.root} on branch ${info.branch}${info.base ? ` (cut from ${info.base})` : ''}.`,
    `The dev server, the public URL, OAuth callbacks and webhooks point at the main checkout (${info.root}), not at this worktree, so changes made here are not served there. Test in the main checkout, or say exactly what you could not test.`,
  ];
  if (info.setupLine) lines.push(info.setupLine);
  if (info.extra) lines.push(info.extra);
  return lines.join('\n');
}

export function worktreeHeaderLine(info) {
  return info ? `Worktree: ${info.path} on ${info.branch}` : '';
}
