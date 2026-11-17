// A throwaway origin + clone for the worktree tests, built with real git in a
// temp dir. Identity comes from the environment so no global git config is
// read or needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Repository-location variables inherited from a hook or shell would point git
// at the developer's own repository instead of the temp one.
const REPO_LOCATION_VARS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
]);
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPO_LOCATION_VARS.has(k))),
  GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com',
  GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com',
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull,
};

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function makeRepo({ files = { 'README.md': 'hello\n' } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wt-')));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
    fs.writeFileSync(path.join(seed, name), body);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'main');
  git(dir, 'clone', origin, repo);
  return {
    dir, origin, seed, repo,
    commitOnOrigin(name, body) {
      fs.writeFileSync(path.join(seed, name), body);
      git(seed, 'add', name);
      git(seed, 'commit', '-m', `add ${name}`);
      git(seed, 'push', 'origin', 'main');
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// statfs with plenty of room, for tests that are not about the disk check.
export const roomyStatfs = () => ({ bavail: 1_000_000, bsize: 1024 * 1024, blocks: 2_000_000 });
