import { describe, it, expect, vi } from 'vitest';
import { repoNameFromRemote, createRepoNameLookup } from '../lib/repo-name.js';

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
    expect(repoNameFromRemote('git@github.com:yearbook/yearbook-app.git')).toBe('yearbook-app');
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
    const r1 = fakeGit({ 'remote get-url origin': 'git@github.com:yearbook/yearbook-app.git', 'rev-parse --show-toplevel': '/home/d/yearbook-app-wt/feature' });
    expect(createRepoNameLookup({ exec: r1.exec }).nameFor('/home/d/yearbook-app-wt/feature/sub')).toBe('yearbook-app');
    expect(r1.calls[0]).toEqual(['git', ['-C', '/home/d/yearbook-app-wt/feature/sub', 'remote', 'get-url', 'origin']]);
    const r2 = fakeGit({ 'rev-parse --show-toplevel': '/home/d/local-only' });
    expect(createRepoNameLookup({ exec: r2.exec }).nameFor('/home/d/local-only/src')).toBe('local-only');
    const r3 = fakeGit({});
    expect(createRepoNameLookup({ exec: r3.exec }).nameFor('/home/danbarker')).toBe('danbarker');
    expect(createRepoNameLookup({ exec: r3.exec }).nameFor('/home/danbarker/')).toBe('danbarker');
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
