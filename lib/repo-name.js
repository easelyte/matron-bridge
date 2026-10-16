// The bare repo name of a working directory (spec 2026-10-01 memory
// scopes): what a `repo:<name>` memory is matched against. The last path
// segment of the git remote `origin` with `.git` stripped — so a worktree,
// a fork and a clone under another directory name all read as the same
// repo — failing that the basename of the git toplevel, failing that the
// basename of the directory itself. Synchronous because createSession is,
// bounded (one git call, 5 s), never throws, and cached per workdir for the
// life of the process: a remote does not change under a running bridge.
//
// The same remote also gives the canonical `host/org/name` the journal keys
// shared visibility on (repoFor), reported on a session's convo_upsert.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const CACHE_MAX = 512;

// The journal's convo_upsert `repo` shape: lower-case host and org, name
// as-is, at most 256 characters. Anything else the journal answers with
// bad_request — and drops the whole upsert with it — so nothing that fails
// this is ever sent.
const CANONICAL_RE = /^[a-z0-9.-]+\/[a-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CANONICAL_MAX = 256;
const NETWORK_SCHEMES = /^(?:https?|ssh|git|git\+ssh|ssh\+git)$/i;

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

// 'git@github.com:Org/name.git', 'https://user@host:443/org/name/',
// 'ssh://git@host:2222/org/name' → 'github.com/org/name' / 'host/org/name'.
// User info and ports are dropped (so a token embedded in an https remote
// can never be reported), host and org lower-cased. Null for a local path, a
// file:// remote, or a path that is not exactly org/name (nested groups).
export function canonicalRepoFromRemote(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  let host;
  let rest;
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (withScheme) {
    if (!NETWORK_SCHEMES.test(withScheme[1])) return null;
    const slash = withScheme[2].indexOf('/');
    if (slash < 0) return null;
    const authority = withScheme[2].slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
    rest = withScheme[2].slice(slash + 1);
  } else {
    // scp-like `[user@]host:path`; a `host:/abs` path is not a repo on a host.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
    if (!scp) return null;
    [, host, rest] = scp;
  }
  rest = rest.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const repo = `${host.toLowerCase()}/${parts[0].toLowerCase()}/${parts[1]}`;
  return repo.length <= CANONICAL_MAX && CANONICAL_RE.test(repo) ? repo : null;
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

  // One git round for both answers: the remote feeds the name and the
  // canonical repo; only a directory without a usable remote asks for the
  // toplevel too.
  function resolve(workdir) {
    const remote = git(workdir, ['remote', 'get-url', 'origin']);
    const repo = canonicalRepoFromRemote(remote);
    const fromRemote = repoNameFromRemote(remote);
    if (fromRemote) return { name: fromRemote, repo };
    const top = git(workdir, ['rev-parse', '--show-toplevel']);
    const fromTop = top ? validName(path.basename(top)) : null;
    if (fromTop) return { name: fromTop, repo };
    return { name: validName(path.basename(path.resolve(workdir))), repo };
  }

  function lookup(workdir) {
    if (typeof workdir !== 'string' || !workdir) return null;
    if (cache.has(workdir)) return cache.get(workdir);
    const entry = resolve(workdir);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(workdir, entry);
    return entry;
  }

  // The repo name for a workdir, or null when there is no usable name
  // (no workdir, or a directory whose name is not one).
  const nameFor = (workdir) => lookup(workdir)?.name ?? null;

  // The canonical `host/org/name` of the workdir's origin remote, or null
  // when it has none the journal would accept (no remote, a local or file://
  // remote, a nested group path). Never derived from the directory name: a
  // guessed repo would widen who can read the conversation.
  const repoFor = (workdir) => lookup(workdir)?.repo ?? null;

  return { nameFor, repoFor, forget: (workdir) => cache.delete(workdir) };
}
