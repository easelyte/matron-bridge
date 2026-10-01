// The bare repo name of a working directory (spec 2026-10-01 memory
// scopes): what a `repo:<name>` memory is matched against. The last path
// segment of the git remote `origin` with `.git` stripped — so a worktree,
// a fork and a clone under another directory name all read as the same
// repo — failing that the basename of the git toplevel, failing that the
// basename of the directory itself. Synchronous because createSession is,
// bounded (one git call, 5 s), never throws, and cached per workdir for the
// life of the process: a remote does not change under a running bridge.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const CACHE_MAX = 512;

// 'git@github.com:org/name.git', 'https://host/org/name/', 'ssh://git@host/org/name'
// → 'name'. Null for anything that does not end in a usable segment.
export function repoNameFromRemote(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim().replace(/[/\\]+$/, '');
  if (!s) return null;
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  s = cut >= 0 ? s.slice(cut + 1) : s;
  if (s.toLowerCase().endsWith('.git')) s = s.slice(0, -4);
  return NAME_RE.test(s) ? s : null;
}

const validName = (s) => (typeof s === 'string' && NAME_RE.test(s) ? s : null);

export function createRepoNameLookup({ exec = spawnSync, timeoutMs = 5_000 } = {}) {
  const cache = new Map();

  function git(workdir, args) {
    try {
      const r = exec('git', ['-C', workdir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
      if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return '';
      return r.stdout.trim();
    } catch {
      return '';
    }
  }

  function resolve(workdir) {
    const fromRemote = repoNameFromRemote(git(workdir, ['remote', 'get-url', 'origin']));
    if (fromRemote) return fromRemote;
    const top = git(workdir, ['rev-parse', '--show-toplevel']);
    const fromTop = top ? validName(path.basename(top)) : null;
    if (fromTop) return fromTop;
    return validName(path.basename(path.resolve(workdir)));
  }

  // The repo name for a workdir, or null when there is no usable name
  // (no workdir, or a directory whose name is not one).
  function nameFor(workdir) {
    if (typeof workdir !== 'string' || !workdir) return null;
    if (cache.has(workdir)) return cache.get(workdir);
    const name = resolve(workdir);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(workdir, name);
    return name;
  }

  return { nameFor, forget: (workdir) => cache.delete(workdir) };
}
