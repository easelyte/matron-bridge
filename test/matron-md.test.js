import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadMatronMd,
  matronMdDirs,
  matronMdFileList,
  matronMdStatusLine,
  MATRON_MD_MAX_BYTES,
  MATRON_MD_TRUNCATED,
} from '../lib/matron-md.js';

function recordingLog() {
  const warns = [];
  return { warns, log: { warn: (m) => warns.push(m) } };
}

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-md-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

describe('matronMdDirs', () => {
  it('walks from the repository root down to the workdir, root first', () => {
    fs.mkdirSync(path.join(tmp, 'repo/.git'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'repo/a/b'), { recursive: true });
    expect(matronMdDirs(path.join(tmp, 'repo/a/b'))).toEqual([
      path.join(tmp, 'repo'), path.join(tmp, 'repo/a'), path.join(tmp, 'repo/a/b'),
    ]);
  });

  it('treats a .git file (a worktree or submodule) as the root too', () => {
    write('wt/.git', 'gitdir: /elsewhere\n');
    fs.mkdirSync(path.join(tmp, 'wt/sub'));
    expect(matronMdDirs(path.join(tmp, 'wt/sub'))).toEqual([path.join(tmp, 'wt'), path.join(tmp, 'wt/sub')]);
  });

  it('stops at the nearest root, so an outer repository is not read', () => {
    fs.mkdirSync(path.join(tmp, 'outer/.git'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'outer/inner/.git'), { recursive: true });
    expect(matronMdDirs(path.join(tmp, 'outer/inner'))).toEqual([path.join(tmp, 'outer/inner')]);
  });

  it('reads only the workdir itself outside any repository', () => {
    fs.mkdirSync(path.join(tmp, 'plain/deeper'), { recursive: true });
    const dirs = matronMdDirs(path.join(tmp, 'plain/deeper'));
    // The tmp dir is not in a repo on any sane machine; if it is, the walk
    // legitimately reaches that repo's root, which this test cannot control.
    if (dirs.length === 1) expect(dirs).toEqual([path.join(tmp, 'plain/deeper')]);
    else expect(dirs[dirs.length - 1]).toBe(path.join(tmp, 'plain/deeper'));
  });

  it('is empty for no workdir', () => {
    expect(matronMdDirs('')).toEqual([]);
    expect(matronMdDirs(undefined)).toEqual([]);
  });
});

describe('loadMatronMd', () => {
  beforeEach(() => { fs.mkdirSync(path.join(tmp, 'repo/.git'), { recursive: true }); });

  it('finds nothing and renders nothing when the repository has no MATRON.md', () => {
    fs.mkdirSync(path.join(tmp, 'repo/src'));
    expect(loadMatronMd(path.join(tmp, 'repo/src'))).toEqual({ files: [], block: '', truncated: false });
  });

  it('renders every file root first, under its path from the repository root', () => {
    write('repo/MATRON.md', '# Root rules\n\nFile items for questions.\n');
    write('repo/editor/MATRON.md', 'Editor rules.');
    const r = loadMatronMd(path.join(tmp, 'repo/editor'));
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md', path.join('editor', 'MATRON.md')]);
    expect(r.files[0].bytes).toBe(Buffer.byteLength('# Root rules\n\nFile items for questions.\n'));
    expect(r.truncated).toBe(false);
    expect(r.block.startsWith('## Repository instructions for Matron sessions (MATRON.md)')).toBe(true);
    const root = r.block.indexOf('### MATRON.md\n\n# Root rules');
    const editor = r.block.indexOf(`### ${path.join('editor', 'MATRON.md')}\n\nEditor rules.`);
    expect(root).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(root);
  });

  it('says where the file stands against CLAUDE.md, the memories and the bridge rules', () => {
    write('repo/MATRON.md', 'x');
    const { block } = loadMatronMd(path.join(tmp, 'repo'));
    expect(block).toContain('only to Matron sessions');
    expect(block).toMatch(/CLAUDE\.md and AGENTS\.md/);
    expect(block).toMatch(/memories .* take precedence/);
    expect(block).toMatch(/sensitive data/);
  });

  it('does not read a subdirectory below the workdir', () => {
    write('repo/MATRON.md', 'root');
    write('repo/editor/MATRON.md', 'editor');
    const r = loadMatronMd(path.join(tmp, 'repo'));
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(r.block).not.toContain('editor');
  });

  it('lists an empty file but adds no section for it', () => {
    write('repo/MATRON.md', '  \n');
    const r = loadMatronMd(path.join(tmp, 'repo'));
    expect(r.files).toEqual([{ path: path.join(tmp, 'repo/MATRON.md'), rel: 'MATRON.md', bytes: 3 }]);
    expect(r.block).toBe('');
  });

  it('skips a MATRON.md that is a directory, silently', () => {
    fs.mkdirSync(path.join(tmp, 'repo/MATRON.md'));
    const { warns, log } = recordingLog();
    expect(loadMatronMd(path.join(tmp, 'repo'), { log }).files).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('skips an unreadable file with a warning and still loads the others', () => {
    write('repo/MATRON.md', 'root');
    write('repo/sub/MATRON.md', 'sub');
    const real = fs;
    const fsImpl = {
      ...real,
      openSync: (p, flags) => {
        if (p === path.join(tmp, 'repo/MATRON.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return real.openSync(p, flags);
      },
    };
    const { warns, log } = recordingLog();
    const r = loadMatronMd(path.join(tmp, 'repo/sub'), { fsImpl, log });
    expect(r.files.map((f) => f.rel)).toEqual([path.join('sub', 'MATRON.md')]);
    expect(r.block).toContain('sub');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('EACCES');
  });

  it('cuts the instructions at the cap, says so in the block, and warns', () => {
    write('repo/MATRON.md', 'a'.repeat(60));
    write('repo/sub/MATRON.md', 'b'.repeat(60));
    const { warns, log } = recordingLog();
    const r = loadMatronMd(path.join(tmp, 'repo/sub'), { maxBytes: 100, log });
    expect(r.truncated).toBe(true);
    expect(r.block).toContain('a'.repeat(60));
    expect(r.block).toContain(`\n\n${'b'.repeat(40)}\n\n`);
    expect(r.block).not.toContain('b'.repeat(41));
    expect(r.block.endsWith(MATRON_MD_TRUNCATED)).toBe(true);
    expect(r.files.map((f) => f.bytes)).toEqual([60, 60]);
    expect(warns).toHaveLength(1);
  });

  it('neither reads nor lists a deeper file once the cap is reached', () => {
    write('repo/MATRON.md', 'a'.repeat(200));
    write('repo/sub/MATRON.md', 'b');
    const r = loadMatronMd(path.join(tmp, 'repo/sub'), { maxBytes: 100, log: { warn() {} } });
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(r.block).not.toContain('### sub');
    expect(matronMdStatusLine(r)).toBe('MATRON.md: MATRON.md (200 B), truncated');
  });

  it('treats a cap filled exactly by one file as reached', () => {
    write('repo/MATRON.md', 'a'.repeat(100));
    write('repo/sub/MATRON.md', 'b');
    const r = loadMatronMd(path.join(tmp, 'repo/sub'), { maxBytes: 100, log: { warn() {} } });
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(r.block).toContain('a'.repeat(100));
    expect(r.truncated).toBe(true);
  });

  it('reports the cap reached when the next MATRON.md is several directories deeper', () => {
    write('repo/MATRON.md', 'a'.repeat(100));
    write('repo/a/b/MATRON.md', 'b');
    const r = loadMatronMd(path.join(tmp, 'repo/a/b'), { maxBytes: 100, log: { warn() {} } });
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(r.truncated).toBe(true);
  });

  it('does not report a cap filled exactly when no deeper file exists', () => {
    write('repo/MATRON.md', 'a'.repeat(100));
    fs.mkdirSync(path.join(tmp, 'repo/a/b'), { recursive: true });
    const r = loadMatronMd(path.join(tmp, 'repo/a/b'), { maxBytes: 100, log: { warn() {} } });
    expect(r.truncated).toBe(false);
  });

  it('reads no more than the cap from a huge file', () => {
    write('repo/MATRON.md', 'x'.repeat(1024 * 1024));
    const reads = [];
    const fsImpl = { ...fs, readSync: (...a) => { reads.push(a[3]); return fs.readSync(...a); } };
    const r = loadMatronMd(path.join(tmp, 'repo'), { fsImpl, maxBytes: 100, log: { warn() {} } });
    expect(reads.reduce((n, x) => n + x, 0)).toBeLessThanOrEqual(104);
    expect(r.files[0].bytes).toBe(1024 * 1024);
    expect(r.truncated).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('follows a symlinked MATRON.md inside the repository, but not one pointing outside it', () => {
    write('repo/docs/matron.md', 'shared rules');
    write('outside-secret.txt', 'not for the prompt');
    fs.symlinkSync(path.join(tmp, 'repo/docs/matron.md'), path.join(tmp, 'repo/MATRON.md'));
    fs.mkdirSync(path.join(tmp, 'repo/sub'));
    fs.symlinkSync(path.join(tmp, 'outside-secret.txt'), path.join(tmp, 'repo/sub/MATRON.md'));
    const { warns, log } = recordingLog();
    const r = loadMatronMd(path.join(tmp, 'repo/sub'), { log });
    expect(r.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(r.block).toContain('shared rules');
    expect(r.block).not.toContain('not for the prompt');
    expect(warns.some((w) => w.includes('points outside'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('finds the repository through a symlinked workdir', () => {
    write('repo/MATRON.md', 'root rules');
    fs.mkdirSync(path.join(tmp, 'repo/sub'));
    fs.symlinkSync(path.join(tmp, 'repo/sub'), path.join(tmp, 'link'));
    const r = loadMatronMd(path.join(tmp, 'link'));
    expect(r.block).toContain('root rules');
  });

  it('never splits a multi-byte character at the cap', () => {
    write('repo/MATRON.md', 'é'.repeat(10)); // 20 bytes
    const r = loadMatronMd(path.join(tmp, 'repo'), { maxBytes: 7, log: { warn() {} } });
    expect(r.block).toContain(`### MATRON.md\n\nééé\n\n${MATRON_MD_TRUNCATED}`);
    expect(r.block).not.toContain('\uFFFD');
  });

  it('caps at 24 KB by default', () => {
    expect(MATRON_MD_MAX_BYTES).toBe(24 * 1024);
    write('repo/MATRON.md', 'x'.repeat(MATRON_MD_MAX_BYTES + 10));
    const r = loadMatronMd(path.join(tmp, 'repo'), { log: { warn() {} } });
    expect(r.truncated).toBe(true);
    expect(r.block).toContain('x'.repeat(MATRON_MD_MAX_BYTES));
    expect(r.block).not.toContain('x'.repeat(MATRON_MD_MAX_BYTES + 1));
  });
});

describe('matronMdStatusLine', () => {
  it('lists each file with its size, and says when the cap cut it', () => {
    const files = [{ rel: 'MATRON.md', bytes: 3174 }, { rel: 'editor/MATRON.md', bytes: 410 }];
    expect(matronMdStatusLine({ files, truncated: false })).toBe('MATRON.md: MATRON.md (3.1 KB), editor/MATRON.md (410 B)');
    expect(matronMdFileList({ files, truncated: true })).toBe('MATRON.md (3.1 KB), editor/MATRON.md (410 B), truncated');
  });

  it('is empty when nothing was found or nothing is known', () => {
    expect(matronMdStatusLine({ files: [], truncated: false })).toBe('');
    expect(matronMdStatusLine(undefined)).toBe('');
    expect(matronMdFileList(null)).toBe('');
  });
});
