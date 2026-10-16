import { describe, it, expect, vi } from 'vitest';
import { repoNameFromRemote, canonicalRepoFromRemote, createRepoNameLookup } from '../lib/repo-name.js';

function fakeGit(answers) {
  // answers: { 'remote get-url origin': stdout | null, 'rev-parse --show-toplevel': stdout | null }
  const calls = [];
  const exec = vi.fn((cmd, args) => {
    calls.push([cmd, args]);
    const key = args.slice(2).join(' ');
    const out = answers[key];
    if (out === undefined || out === null) return { status: 128, stdout: '', stderr: 'fatal' };
    if (out instanceof Error) return { error: out, status: null, stdout: '' };
    return { status: 0, stdout: `${out}\n` };
  });
  return { exec, calls };
}

describe('repoNameFromRemote', () => {
  it('takes the last segment of any remote form and strips .git', () => {
    expect(repoNameFromRemote('git@github.com:acme/acme-app.git')).toBe('acme-app');
    expect(repoNameFromRemote('https://github.com/Matronhq/matron-bridge')).toBe('matron-bridge');
    expect(repoNameFromRemote('https://github.com/Matronhq/matron-bridge.git/')).toBe('matron-bridge');
    expect(repoNameFromRemote('ssh://git@host:2222/org/Name.v2.GIT')).toBe('Name.v2');
    expect(repoNameFromRemote('/srv/git/bare-repo.git')).toBe('bare-repo');
    expect(repoNameFromRemote('  plain  ')).toBe('plain');
  });
  it('returns null for nothing usable', () => {
    for (const bad of ['', '   ', '/', 'https://host/org/a b', null, 42, undefined]) expect(repoNameFromRemote(bad), String(bad)).toBeNull();
  });
});

describe('createRepoNameLookup', () => {
  it('prefers the origin remote, then the toplevel basename, then the directory name', () => {
    const r1 = fakeGit({ 'remote get-url origin': 'git@github.com:acme/acme-app.git', 'rev-parse --show-toplevel': '/home/d/acme-app-wt/feature' });
    expect(createRepoNameLookup({ exec: r1.exec }).nameFor('/home/d/acme-app-wt/feature/sub')).toBe('acme-app');
    expect(r1.calls[0]).toEqual(['git', ['-C', '/home/d/acme-app-wt/feature/sub', 'remote', 'get-url', 'origin']]);
    const r2 = fakeGit({ 'rev-parse --show-toplevel': '/home/d/local-only' });
    expect(createRepoNameLookup({ exec: r2.exec }).nameFor('/home/d/local-only/src')).toBe('local-only');
    const r3 = fakeGit({});
    expect(createRepoNameLookup({ exec: r3.exec }).nameFor('/home/developer')).toBe('developer');
    expect(createRepoNameLookup({ exec: r3.exec }).nameFor('/home/developer/')).toBe('developer');
  });

  it('never throws: a git error, a throwing exec or an unusable name is null or the directory name', () => {
    const broken = fakeGit({ 'remote get-url origin': new Error('ETIMEDOUT') });
    expect(createRepoNameLookup({ exec: broken.exec }).nameFor('/x/some dir')).toBeNull();
    expect(createRepoNameLookup({ exec: () => { throw new Error('boom'); } }).nameFor('/x/plain')).toBe('plain');
    const l = createRepoNameLookup({ exec: broken.exec });
    expect(l.nameFor('')).toBeNull();
    expect(l.nameFor(null)).toBeNull();
  });

  it('caches per workdir (one git round per directory) and forgets on request', () => {
    const r = fakeGit({ 'remote get-url origin': 'https://github.com/o/app' });
    const l = createRepoNameLookup({ exec: r.exec });
    expect(l.nameFor('/w')).toBe('app');
    expect(l.nameFor('/w')).toBe('app');
    expect(r.exec).toHaveBeenCalledTimes(1);
    l.forget('/w');
    l.nameFor('/w');
    expect(r.exec).toHaveBeenCalledTimes(2);
  });
});

describe('canonicalRepoFromRemote', () => {
  it('normalises every network remote form to host/org/name, lower-casing host and org only', () => {
    expect(canonicalRepoFromRemote('git@github.com:Acme/Acme-App.git')).toBe('github.com/acme/Acme-App');
    expect(canonicalRepoFromRemote('https://GitHub.com/Acme/acme-app')).toBe('github.com/acme/acme-app');
    expect(canonicalRepoFromRemote('https://github.com/acme/acme-app.git/')).toBe('github.com/acme/acme-app');
    expect(canonicalRepoFromRemote('ssh://git@git.example.com:2222/org/Name.v2.GIT')).toBe('git.example.com/org/Name.v2');
    expect(canonicalRepoFromRemote('git+ssh://git@example.com/org/app')).toBe('example.com/org/app');
    expect(canonicalRepoFromRemote('  example.com:org/app  ')).toBe('example.com/org/app');
  });

  it('drops user info, so a token embedded in an https remote is never reported', () => {
    const repo = canonicalRepoFromRemote('https://x-access-token:not-a-real-token@github.com/acme/app.git');
    expect(repo).toBe('github.com/acme/app');
    expect(repo).not.toContain('token');
  });

  it('returns null for anything the journal would reject or that is not a hosted repo', () => {
    for (const bad of [
      '', '   ', null, undefined, 42,
      '/srv/git/bare-repo.git', 'file:///srv/git/org/app.git', '../sibling',
      'https://gitlab.example.com/group/sub/project', // nested group: not org/name
      'https://example.com/app', 'example.com:/abs/org/app', 'ftp://example.com/org/app',
      'https://example.com/org/a b', 'https://exa_mple.com/org/app',
      `https://example.com/org/${'n'.repeat(260)}`,
    ]) expect(canonicalRepoFromRemote(bad), String(bad)).toBeNull();
  });

  it('only ever produces what the journal accepts', () => {
    const journalShape = /^[a-z0-9.-]+\/[a-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
    for (const url of ['git@GITHUB.COM:Org_1/x.y-z.git', 'https://h.example/O.rg/N_ame']) {
      expect(canonicalRepoFromRemote(url)).toMatch(journalShape);
    }
  });
});

describe('createRepoNameLookup repoFor', () => {
  it('reads the canonical repo off the same single git call as the name', () => {
    const r = fakeGit({ 'remote get-url origin': 'git@github.com:Acme/acme-app.git' });
    const l = createRepoNameLookup({ exec: r.exec });
    expect(l.repoFor('/w')).toBe('github.com/acme/acme-app');
    expect(l.nameFor('/w')).toBe('acme-app');
    expect(r.exec).toHaveBeenCalledTimes(1);
  });

  it('is null without a usable remote, never guessed from the directory name', () => {
    const local = fakeGit({ 'rev-parse --show-toplevel': '/home/d/local-only' });
    const l = createRepoNameLookup({ exec: local.exec });
    expect(l.nameFor('/home/d/local-only')).toBe('local-only');
    expect(l.repoFor('/home/d/local-only')).toBeNull();
    const fileRemote = fakeGit({ 'remote get-url origin': '/srv/git/app.git' });
    expect(createRepoNameLookup({ exec: fileRemote.exec }).repoFor('/w')).toBeNull();
    expect(l.repoFor('')).toBeNull();
    expect(l.repoFor(undefined)).toBeNull();
    expect(createRepoNameLookup({ exec: () => { throw new Error('boom'); } }).repoFor('/w')).toBeNull();
  });
});
