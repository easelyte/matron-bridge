import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConsentStore, isFork, normalizeOrigin, originAllowed, parseAllowlist, planSetup,
  readNoticeExtra, runSetup, setupSummary, setupTimeoutMs, NOTICE_FILE_NAME,
} from '../lib/worktree-setup.js';
import { git, makeRepo } from './helpers/worktree-repo.js';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wts-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('origins and the allowlist', () => {
  it.each([
    ['git@example.com:Owner/Repo.git', 'example.com/owner/repo'],
    ['https://example.com/Owner/Repo', 'example.com/owner/repo'],
    ['https://user@example.com/owner/repo.git/', 'example.com/owner/repo'],
    ['ssh://git@example.com:22/owner/repo.git', 'example.com/owner/repo'],
  ])('normalizes %s', (url, expected) => expect(normalizeOrigin(url)).toBe(expected));

  it('rejects junk', () => {
    expect(normalizeOrigin('')).toBe(null);
    expect(normalizeOrigin(undefined)).toBe(null);
    expect(normalizeOrigin('not a url')).toBe(null);
  });

  it('empty allowlist allows nothing; exact and owner/* entries match', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist(' Example.com/a/b , example.com/c/* ,')).toEqual(['example.com/a/b', 'example.com/c/*']);
    expect(originAllowed('example.com/a/b', [])).toBe(false);
    const list = parseAllowlist('example.com/a/b,example.com/c/*');
    expect(originAllowed('example.com/a/b', list)).toBe(true);
    expect(originAllowed('example.com/a/other', list)).toBe(false);
    expect(originAllowed('example.com/c/anything', list)).toBe(true);
    expect(originAllowed('example.com/c/x/y', list)).toBe(false);
    expect(originAllowed('example.com/cc/x', list)).toBe(false);
    expect(originAllowed(null, list)).toBe(false);
  });
});

describe('consent store', () => {
  it('persists the approved sha per repository', () => {
    const file = path.join(tmp(), 'consent.json');
    const a = createConsentStore({ file });
    expect(a.get('example.com/a/b')).toBe(null);
    a.set('example.com/a/b', 'abc');
    expect(createConsentStore({ file }).get('example.com/a/b')).toBe('abc');
    expect(createConsentStore({ file }).get('example.com/a/other')).toBe(null);
  });
  it('survives a corrupt file', () => {
    const file = path.join(tmp(), 'consent.json');
    fs.writeFileSync(file, '{nope');
    expect(createConsentStore({ file }).get('x')).toBe(null);
  });
});

describe('setupTimeoutMs', () => {
  it('is 10 minutes unless configured', () => {
    expect(setupTimeoutMs({})).toBe(600000);
    expect(setupTimeoutMs({ MATRON_WORKTREE_SETUP_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(setupTimeoutMs({ MATRON_WORKTREE_SETUP_TIMEOUT_MS: '-1' })).toBe(600000);
  });
});

const repos = [];
afterEach(() => { while (repos.length) repos.pop().cleanup(); });
function repoWithScript(script = '#!/bin/sh\necho hi\n') {
  const r = makeRepo({ files: { 'README.md': 'x\n', '.matron/worktree-setup': script } });
  repos.push(r);
  fs.chmodSync(path.join(r.repo, '.matron', 'worktree-setup'), 0o755);
  return r;
}

describe('planSetup', () => {
  const ALLOW = ['example.com/owner/repo'];
  const origin = 'git@example.com:owner/repo.git';
  const plan = (r, over = {}) => planSetup({ worktree: r.repo, root: r.repo, origin, allowlist: ALLOW, consent: createConsentStore({ file: path.join(tmp(), 'c.json') }), ...over });

  it('is none without a script', async () => {
    const r = makeRepo();
    repos.push(r);
    expect((await plan(r)).state).toBe('none');
  });

  it('refuses an origin that is not on the allowlist, and an empty allowlist', async () => {
    const r = repoWithScript();
    const off = await plan(r, { allowlist: [] });
    expect(off.state).toBe('refused');
    expect(off.reason).toMatch(/allowlist/);
    expect((await plan(r, { allowlist: ['example.com/other/*'] })).state).toBe('refused');
  });

  it('refuses a fork (an upstream remote that is not origin), even when allowlisted', async () => {
    const r = repoWithScript();
    git(r.repo, 'remote', 'add', 'upstream', 'https://example.com/someone-else/repo.git');
    const p = await plan(r);
    expect(p.state).toBe('refused');
    expect(p.reason).toMatch(/fork/);
  });

  it('asks first, runs only with the approved sha, and asks again when the script changes', async () => {
    const r = repoWithScript();
    const consent = createConsentStore({ file: path.join(tmp(), 'c.json') });
    const first = await plan(r, { consent });
    expect(first.state).toBe('needs_consent');
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.changed).toBe(false);
    expect(first.content).toContain('echo hi');

    consent.set(first.key, first.sha256);
    const ready = await plan(r, { consent });
    expect(ready.state).toBe('ready');

    fs.appendFileSync(path.join(r.repo, '.matron', 'worktree-setup'), 'echo changed\n');
    const again = await plan(r, { consent });
    expect(again.state).toBe('needs_consent');
    expect(again.changed).toBe(true);
    expect(again.sha256).not.toBe(first.sha256);
  });

  it('does not follow a symlinked script', async () => {
    const r = makeRepo();
    repos.push(r);
    fs.mkdirSync(path.join(r.repo, '.matron'));
    fs.writeFileSync(path.join(r.repo, 'elsewhere.sh'), 'echo x\n');
    fs.symlinkSync(path.join(r.repo, 'elsewhere.sh'), path.join(r.repo, '.matron', 'worktree-setup'));
    expect((await plan(r)).state).toBe('refused');
  });

  it('refuses a .matron folder that is a symlink to somewhere outside the worktree', async () => {
    const r = makeRepo();
    repos.push(r);
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'worktree-setup'), '#!/bin/sh\necho outside\n');
    fs.symlinkSync(outside, path.join(r.repo, '.matron'));
    const p = await plan(r);
    expect(p.state).toBe('refused');
    expect(p.reason).toMatch(/outside the worktree/);
  });

  it('is refused on Windows', async () => {
    const r = repoWithScript();
    const p = await plan(r, { platform: 'win32' });
    expect(p).toMatchObject({ state: 'refused' });
    expect(p.reason).toMatch(/Windows/);
  });

  it('a read error is a refusal, not a throw (the worktree already exists)', async () => {
    const r = repoWithScript();
    const flaky = { ...fs, readFileSync: (f, ...a) => { if (String(f).endsWith('worktree-setup')) throw Object.assign(new Error('io'), { code: 'EIO' }); return fs.readFileSync(f, ...a); } };
    const p = await plan(r, { fs: flaky });
    expect(p.state).toBe('refused');
    expect(p.reason).toMatch(/could not be read \(EIO\)/);
  });

  it('hands back the exact bytes it hashed', async () => {
    const r = repoWithScript('#!/bin/sh\necho hi\n');
    const p = await plan(r);
    expect(createHash('sha256').update(p.buffer).digest('hex')).toBe(p.sha256);
  });

  it('isFork is false with no upstream or with upstream equal to origin', async () => {
    const r = makeRepo();
    repos.push(r);
    expect(await isFork(r.repo, 'example.com/owner/repo')).toBe(false);
    git(r.repo, 'remote', 'add', 'upstream', 'https://example.com/Owner/Repo.git');
    expect(await isFork(r.repo, 'example.com/owner/repo')).toBe(false);
  });
});

describe('runSetup', () => {
  function setup(body) {
    const wt = tmp();
    const gitDir = tmp();
    return { wt, gitDir, buffer: Buffer.from(body), logFile: path.join(tmp(), 'logs', 'setup.log') };
  }
  const run = (s, over = {}) => runSetup({ buffer: s.buffer, worktree: s.wt, root: '/main/checkout', name: 'x', gitDir: s.gitDir, logFile: s.logFile, ...over });

  it('runs inside the worktree with MATRON_MAIN_CHECKOUT, logs output, and reads the notice file', async () => {
    const s = setup(`#!/bin/sh
echo "cwd=$(pwd)"
echo "main=$MATRON_MAIN_CHECKOUT name=$MATRON_WORKTREE_NAME"
echo "Use port 4001 here." > "$MATRON_WORKTREE_NOTICE_FILE"
`);
    const res = await run(s);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    const log = fs.readFileSync(s.logFile, 'utf-8');
    expect(log).toContain(`cwd=${fs.realpathSync(s.wt)}`);
    expect(log).toContain('main=/main/checkout name=x');
    expect(readNoticeExtra(s.gitDir)).toBe('Use port 4001 here.');
    expect(fs.existsSync(path.join(s.gitDir, NOTICE_FILE_NAME))).toBe(true);
  });

  it('does not follow a notice file that is a symlink', () => {
    const gitDir = tmp();
    const secret = path.join(tmp(), 'secret.txt');
    fs.writeFileSync(secret, 'do not leak');
    fs.symlinkSync(secret, path.join(gitDir, NOTICE_FILE_NAME));
    expect(readNoticeExtra(gitDir)).toBe('');
  });

  it('caps the notice text', () => {
    const gitDir = tmp();
    fs.writeFileSync(path.join(gitDir, NOTICE_FILE_NAME), 'x'.repeat(5000));
    expect(readNoticeExtra(gitDir)).toHaveLength(2000);
    expect(readNoticeExtra(null)).toBe('');
  });

  it('passes no journal or bridge-only secrets to the script', async () => {
    const s = setup('#!/bin/sh\necho "token=[$JOURNAL_TOKEN] hmac=[$HMAC_SECRET] home=[$KEEP_ME]"\n');
    const res = await run(s, { env: { ...process.env, JOURNAL_TOKEN: 'secret-a', HMAC_SECRET: 'secret-b', KEEP_ME: 'yes' } });
    expect(res.ok).toBe(true);
    const log = fs.readFileSync(s.logFile, 'utf-8');
    expect(log).toContain('token=[] hmac=[] home=[yes]');
  });

  it('reports a non-zero exit as a failure with the output tail', async () => {
    const s = setup('#!/bin/sh\necho boom >&2\nexit 3\n');
    const res = await run(s);
    expect(res).toMatchObject({ ok: false, code: 3, timedOut: false });
    expect(res.tail).toContain('boom');
    expect(setupSummary({ state: 'failed', code: 3 })).toMatch(/exit 3/);
  });

  it('kills a script that outlives the timeout', async () => {
    const s = setup('#!/bin/sh\nsleep 30\n');
    const t0 = Date.now();
    const res = await run(s, { timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(setupSummary({ state: 'failed', timedOut: true })).toMatch(/timed out/);
  });

  it('runs a script without a shebang through sh', async () => {
    const s = setup('echo plain\n');
    const res = await run(s);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(s.logFile, 'utf-8')).toContain('plain');
  });

  it('never rejects when the script cannot be staged', async () => {
    const fsBroken = { ...fs, mkdtempSync: () => { throw new Error('no space'); } };
    const res = await run(setup('echo x\n'), { fs: fsBroken });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not stage/);
  });

  it('runs the approved bytes from a private temp copy outside the worktree, then removes it', async () => {
    const s = setup('#!/bin/sh\necho staged\n');
    let seen;
    const spawnFn = (cmd, args, opts) => {
      const fd = fs.openSync(cmd, 'r');
      const st = fs.fstatSync(fd);
      const body = fs.readFileSync(fd, 'utf-8');
      fs.closeSync(fd);
      seen = { cmd, args, opts, mode: st.mode & 0o777, dir: fs.statSync(path.dirname(cmd)).mode & 0o777, body };
      return spawn('true', [], opts);
    };
    const res = await run(s, { spawnFn });
    expect(res.ok).toBe(true);
    expect(seen.body).toBe('#!/bin/sh\necho staged\n');
    expect(seen.cmd.startsWith(fs.realpathSync(s.wt))).toBe(false);
    expect(seen.mode & 0o077).toBe(0);
    expect(seen.dir & 0o077).toBe(0);
    expect(fs.existsSync(seen.cmd)).toBe(false);
  });

  it('what runs is what was approved, even when the file on disk changes after the hash', async () => {
    const r = repoWithScript('#!/bin/sh\necho approved > "$MATRON_WORKTREE_PATH/out.txt"\n');
    const consent = createConsentStore({ file: path.join(tmp(), 'c.json') });
    const p = await planSetup({ worktree: r.repo, root: r.repo, origin: 'git@example.com:owner/repo.git', allowlist: ['example.com/owner/repo'], consent });
    expect(p.state).toBe('needs_consent');
    // The repository's file is swapped between the hash and the run.
    fs.writeFileSync(path.join(r.repo, '.matron', 'worktree-setup'), '#!/bin/sh\necho swapped > "$MATRON_WORKTREE_PATH/out.txt"\n');
    const wt = tmp();
    const res = await runSetup({ buffer: p.buffer, worktree: wt, root: r.repo, name: 'x', gitDir: tmp(), logFile: path.join(tmp(), 'l.log') });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'out.txt'), 'utf-8').trim()).toBe('approved');
  });

  it('is refused on Windows with a clear reason, without spawning anything', async () => {
    let spawned = false;
    const res = await run(setup('echo x\n'), { platform: 'win32', spawnFn: () => { spawned = true; } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Windows/);
    expect(spawned).toBe(false);
  });
});
