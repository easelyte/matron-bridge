import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { preflightSupport } from '../lib/preflight-support.js';
import { defaultPreflight } from '../lib/code-update-restart.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const helper = fileURLToPath(new URL('../lib/preflight-support.js', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const marker = "export const PREFLIGHT_PROTOCOL = 'gate/1';";

// Build disposable fixture commits directly, without invoking git write commands.
function fixture(source = marker, includeHelper = true) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-support-'));
  roots.push(repo);
  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs'));
  function object(type, value) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const data = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const sha = createHash('sha1').update(data).digest('hex');
    const dir = path.join(gitDir, 'objects', sha.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sha.slice(2)), deflateSync(data));
    return sha;
  }
  const entry = (mode, name, sha) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
  const entries = [entry('100644', 'index.js', object('blob', source + '\n'))];
  if (includeHelper) {
    const blob = object('blob', fs.readFileSync(helper));
    entries.push(entry('40000', 'lib', object('tree', entry('100644', 'preflight-support.js', blob))));
  }
  const tree = object('tree', Buffer.concat(entries));
  const sha = object('commit', `tree ${tree}\nauthor alice <alice> 1 +0000\ncommitter alice <alice> 1 +0000\n\nfixture\n`);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), sha + '\n');
  fs.writeFileSync(path.join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  return { repo, sha };
}

it('recognizes only an exact protocol line at the requested commit through function and CLI', () => {
  for (const [source, expected] of [
    [marker, 'gate/1'], ["const mode = process.env.MATRON_BRIDGE_PREFLIGHT;", 'unsupported'],
    [marker.replace('gate/1', 'gate/2'), 'unsupported'], [' ' + marker, 'unsupported'],
    [marker.replace(' = ', '  = '), 'unsupported'], ['// ' + marker, 'unsupported'],
    [marker + ' // comment', 'unsupported'],
  ]) {
    const { repo, sha } = fixture(source);
    expect(preflightSupport(repo, sha)).toBe(expected);
    const home = fs.mkdtempSync(path.join(repo, 'home-'));
    expect(execFileSync(process.execPath, [helper, '--repo', repo, '--sha', sha], {
      env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8',
    }).trim()).toBe(expected);
  }
  // Inserting whitespace anywhere changes the protocol line and must remove support.
  for (let i = 0; i <= marker.length; i++) {
    const { repo, sha } = fixture(marker.slice(0, i) + ' ' + marker.slice(i));
    expect(preflightSupport(repo, sha)).toBe('unsupported');
  }
}, 15000);

it('fails closed for missing helper, commit, repository and invalid arguments', () => {
  const { repo, sha } = fixture(marker, false);
  expect(preflightSupport(repo, sha)).toBe('unsupported');
  expect(preflightSupport(repo, 'f'.repeat(40))).toBe('unsupported');
  expect(preflightSupport(path.join(repo, 'missing'), sha)).toBe('unsupported');
  expect(preflightSupport(null, null)).toBe('unsupported');
  expect(preflightSupport(repo, '--help')).toBe('unsupported');
  execFileSync.mockImplementationOnce(() => { throw new Error('timeout'); });
  expect(preflightSupport(repo, sha)).toBe('unsupported');
  const home = fs.mkdtempSync(path.join(repo, 'home-'));
  expect(execFileSync(process.execPath, [helper, '--repo', repo, '--sha', sha], {
    env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8',
  }).trim()).toBe('unsupported');
  // A target tree without the helper cannot execute its CLI; callers must treat this as unsupported.
  let missing;
  try { execFileSync(process.execPath, [path.join(repo, 'lib/preflight-support.js'), '--repo', repo, '--sha', sha], {
    env: { HOME: fs.mkdtempSync(path.join(repo, 'home-')), PATH: process.env.PATH }, stdio: 'pipe',
  }); } catch (error) { missing = error.status; }
  expect(missing).toBe(1);
});

it('checks support before spawning gate mode and inherits config with checkout cwd', async () => {
  const { repo, sha } = fixture();
  const calls = [];
  const exec = (bin, args, options, callback) => { calls.push({ bin, args, options }); callback(null, '', ''); };
  expect(await defaultPreflight(repo, { mode: 'gate', exec })).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual(['index.js']);
  expect(calls[0].options.cwd).toBe(repo);
  expect(calls[0].options.env).toEqual({ ...process.env, MATRON_BRIDGE_PREFLIGHT: 'gate' });
  expect(preflightSupport(repo, sha)).toBe('gate/1');
  const old = fixture(marker, false);
  calls.length = 0;
  expect(await defaultPreflight(old.repo, { mode: 'gate', exec })).toEqual({ ok: false, error: 'mode unsupported at HEAD' });
  expect(calls).toHaveLength(0);
});

it('refuses gate child errors, timeouts and spawn exceptions', async () => {
  const { repo } = fixture();
  for (const message of ['exit 1', 'timeout']) {
    const result = await defaultPreflight(repo, { mode: 'gate', timeoutMs: 1,
      exec: (_bin, _args, options, callback) => {
        expect(options.timeout).toBe(1);
        callback(new Error(message), '', '');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(message);
  }
  expect((await defaultPreflight(repo, { mode: 'gate', exec: () => { throw new Error('spawn failed'); } })).ok).toBe(false);
});

it('recognizes the exact protocol line in an entry point larger than one megabyte', () => {
  const { repo, sha } = fixture('// padding\n'.repeat(120000) + marker);
  expect(preflightSupport(repo, sha)).toBe('gate/1');
});
