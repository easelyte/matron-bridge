import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadMatronMd,
  matronMdDirs,
  matronMdFileList,
  matronMdStatusLine,
  repoInstructionsPointer,
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

describe('repoInstructionsPointer (a workdir outside any repository)', () => {
  const repo = (name, files = {}) => {
    fs.mkdirSync(path.join(tmp, name, '.git'), { recursive: true });
    for (const [f, text] of Object.entries(files)) write(path.join(name, f), text);
  };

  it('names each repository directly below that has a MATRON.md, sorted, and does not load the files', () => {
    repo('beta', { 'MATRON.md': 'BETA RULES' });
    repo('alpha', { 'MATRON.md': 'ALPHA RULES', 'CLAUDE.md': 'x' });
    repo('gamma', { 'CLAUDE.md': 'x' });
    fs.mkdirSync(path.join(tmp, 'plain'));
    write('plain/MATRON.md', 'not a repo');
    const text = repoInstructionsPointer(tmp);
    expect(text).toContain('## Repositories below your working folder');
    expect(text).toContain('`alpha` (MATRON.md), `beta` (MATRON.md).');
    expect(text).not.toContain('gamma');
    expect(text).not.toContain('plain');
    expect(text).not.toContain('RULES');
  });

  it('for Codex also names AGENTS.md and CLAUDE.md, which Codex does not read from below its folder', () => {
    repo('alpha', { 'MATRON.md': 'a', 'CLAUDE.md': 'x' });
    repo('gamma', { 'AGENTS.md': 'x' });
    expect(repoInstructionsPointer(tmp, { agent: 'codex' })).toContain('`alpha` (MATRON.md, CLAUDE.md), `gamma` (AGENTS.md).');
  });

  it('treats a worktree (.git file) below as a repository and skips hidden folders', () => {
    write('wt/.git', 'gitdir: /elsewhere\n');
    write('wt/MATRON.md', 'a');
    repo('.hidden', { 'MATRON.md': 'a' });
    const text = repoInstructionsPointer(tmp);
    expect(text).toContain('`wt` (MATRON.md)');
    expect(text).not.toContain('.hidden');
  });

  it('is empty inside a repository, and when nothing below has instructions', () => {
    repo('alpha', { 'MATRON.md': 'a' });
    expect(repoInstructionsPointer(path.join(tmp, 'alpha'))).toBe('');
    fs.mkdirSync(path.join(tmp, 'alpha/sub/inner/.git'), { recursive: true });
    write('alpha/sub/inner/MATRON.md', 'a');
    expect(repoInstructionsPointer(path.join(tmp, 'alpha/sub'))).toBe('');
    fs.mkdirSync(path.join(tmp, 'empty'));
    expect(repoInstructionsPointer(path.join(tmp, 'empty'))).toBe('');
    expect(repoInstructionsPointer(path.join(tmp, 'missing'))).toBe('');
  });

  it('names at most 25 repositories and counts the rest', () => {
    for (let i = 0; i < 30; i++) repo(`r${String(i).padStart(2, '0')}`, { 'MATRON.md': 'a' });
    const text = repoInstructionsPointer(tmp);
    expect(text).toContain('`r24` (MATRON.md), and 5 more.');
    expect(text).not.toContain('`r25`');
  });

  it('loadMatronMd appends the pointer after the workdir\'s own MATRON.md, without listing it as a loaded file', () => {
    write('MATRON.md', 'FOLDER RULES');
    repo('alpha', { 'MATRON.md': 'ALPHA RULES' });
    const loaded = loadMatronMd(tmp, { log: recordingLog().log });
    expect(loaded.files.map((f) => f.rel)).toEqual(['MATRON.md']);
    expect(loaded.block.indexOf('FOLDER RULES')).toBeLessThan(loaded.block.indexOf('## Repositories below your working folder'));
    expect(loaded.block).not.toContain('ALPHA RULES');
    const bare = loadMatronMd(path.join(tmp, 'alpha'), { log: recordingLog().log });
    expect(bare.block).not.toContain('Repositories below');
  });

  it('loadMatronMd gives only the pointer when the folder has no MATRON.md of its own', () => {
    repo('alpha', { 'AGENTS.md': 'a' });
    expect(loadMatronMd(tmp, { log: recordingLog().log }).block).toBe('');
    const codex = loadMatronMd(tmp, { agent: 'codex', log: recordingLog().log });
    expect(codex.block.startsWith('## Repositories below your working folder')).toBe(true);
    expect(codex.files).toEqual([]);
  });
});

describe('repoInstructionsPointer containment and scan limit', () => {
  it.skipIf(process.platform === 'win32')('does not name an instruction file that is a symlink out of its repository', () => {
    fs.mkdirSync(path.join(tmp, 'work/alpha/.git'), { recursive: true });
    write('outside.md', 'secret');
    fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(tmp, 'work/alpha/MATRON.md'));
    fs.mkdirSync(path.join(tmp, 'work/beta/.git'), { recursive: true });
    write('work/beta/docs/m.md', 'ok');
    fs.symlinkSync(path.join(tmp, 'work/beta/docs/m.md'), path.join(tmp, 'work/beta/MATRON.md'));
    const text = repoInstructionsPointer(path.join(tmp, 'work'));
    expect(text).not.toContain('alpha');
    expect(text).toContain('`beta` (MATRON.md)');
  });

  it('says so when the folder holds more entries than were checked', () => {
    // A fake filesystem: 2001 repositories, each with a MATRON.md, so the
    // check holds whatever order the folder lists them in, without making
    // thousands of real folders (slow on some runners).
    const root = path.join(tmp, 'many');
    const names = Array.from({ length: 2001 }, (_, i) => `r${i}`);
    const notFound = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    const kind = (p) => {
      if (p === root) return 'dir';
      const rel = path.relative(root, p).split(path.sep);
      if (rel.length === 1 && names.includes(rel[0])) return 'dir';
      if (rel.length === 2 && names.includes(rel[0]) && rel[1] === '.git') return 'dir';
      if (rel.length === 2 && names.includes(rel[0]) && rel[1] === 'MATRON.md') return 'file';
      return null;
    };
    const fsImpl = {
      readdirSync: (p) => { if (p !== root) throw notFound(p); return names; },
      realpathSync: (p) => { if (!kind(p)) throw notFound(p); return p; },
      statSync: (p) => {
        const k = kind(p);
        if (!k) throw notFound(p);
        return { isFile: () => k === 'file', isDirectory: () => k === 'dir' };
      },
    };
    const text = repoInstructionsPointer(root, { fsImpl });
    expect(text).toContain(', and 1975 more (the folder holds more than 2000 entries, and the rest were not checked)');
  });
});
