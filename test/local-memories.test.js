import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createLocalMemories,
  parseMemoryFrontmatter,
  parseMemoryIndex,
  LOCAL_MEMORIES_RESULT_MAX_BYTES,
} from '../lib/local-memories.js';
import { encodeProjectSegment } from '../lib/transcript-dir.js';

// Real temp directories: the allow-list, traversal and symlink rules are
// about what the filesystem actually resolves, so a fake fs would only test
// the fake.
let root;
let home;
const write = (p, body, mtimeMs = null) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtimeMs !== null) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
};
const memory = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${extra}Body of ${name}.\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-memories-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const make = (overrides = {}) => createLocalMemories({ homeDir: home, ...overrides });
const memDir = (dir) => path.join(home, '.claude', 'projects', dir, 'memory');

describe('parseMemoryFrontmatter', () => {
  it('reads name, description and metadata.type', () => {
    const fm = parseMemoryFrontmatter('---\nname: my-rule\ndescription: Do the thing\nmetadata:\n  type: feedback\n---\nbody');
    expect(fm).toEqual({ name: 'my-rule', description: 'Do the thing', type: 'feedback' });
  });

  it('unquotes a quoted description and unescapes \\" inside it', () => {
    const fm = parseMemoryFrontmatter('---\ndescription: "~/x is the \\"live\\" checkout; merge with --admin"\n---\n');
    expect(fm.description).toBe('~/x is the "live" checkout; merge with --admin');
  });

  it('accepts a top-level type and CRLF line endings; no frontmatter reads as empty', () => {
    expect(parseMemoryFrontmatter('---\r\nname: a\r\ntype: user\r\n---\r\n')).toEqual({ name: 'a', description: '', type: 'user' });
    expect(parseMemoryFrontmatter('# just a heading\n')).toEqual({ name: '', description: '', type: '' });
    expect(parseMemoryFrontmatter('---\nname: unterminated\n')).toEqual({ name: '', description: '', type: '' });
  });
});

describe('parseMemoryIndex', () => {
  it('maps each `- [Title](file.md) — hook` line by file name', () => {
    const idx = parseMemoryIndex([
      '# Memory index',
      '- [Unicode escapes get mangled](unicode-escapes-get-mangled.md) — heredocs turn them into literals',
      '* [Bridge worktree](bridge-live-checkout-use-worktree.md) - use a worktree',
      '- [No hook](no-hook.md)',
      '- plain text line without a link',
      '',
    ].join('\n'));
    expect(idx.get('unicode-escapes-get-mangled.md')).toEqual({ title: 'Unicode escapes get mangled', hook: 'heredocs turn them into literals' });
    expect(idx.get('bridge-live-checkout-use-worktree.md')).toEqual({ title: 'Bridge worktree', hook: 'use a worktree' });
    expect(idx.get('no-hook.md')).toEqual({ title: 'No hook', hook: '' });
    expect(idx.size).toBe(3);
  });
});

describe('index()', () => {
  it('lists the global CLAUDE.md and each known folder\'s CLAUDE.md files with size and mtime', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# global\n', 1_700_000_000_000);
    const repo = path.join(root, 'repo');
    write(path.join(repo, 'CLAUDE.md'), 'repo rules', 1_700_000_001_000);
    write(path.join(repo, '.claude', 'CLAUDE.md'), 'more', 1_700_000_002_000);
    const other = path.join(root, 'other'); // known folder, no CLAUDE.md
    fs.mkdirSync(other);
    const result = make().index({ folders: [repo, other, path.join(root, 'missing')] });
    expect(result.home).toBe(home);
    expect(result.claude_md).toEqual([
      { path: path.join(home, '.claude', 'CLAUDE.md'), size: 9, mtime: 1_700_000_000_000 },
      { path: path.join(repo, 'CLAUDE.md'), size: 10, mtime: 1_700_000_001_000, folder: repo },
      { path: path.join(repo, '.claude', 'CLAUDE.md'), size: 4, mtime: 1_700_000_002_000, folder: repo },
    ]);
    expect(result.projects).toEqual([]);
  });

  it('lists each project\'s memories with frontmatter fields, index title/hook, newest first', () => {
    const repo = path.join(root, 'work', 'matron-bridge');
    fs.mkdirSync(repo, { recursive: true });
    const dir = memDir(encodeProjectSegment(repo));
    write(path.join(dir, 'older.md'), memory('older-rule', 'The older rule'), 1_700_000_000_000);
    write(path.join(dir, 'newer.md'), memory('newer-rule', '"Quoted \\"desc\\""'), 1_700_000_005_000);
    write(path.join(dir, 'MEMORY.md'), '- [Older rule](older.md) — its hook\n- [Gone](gone.md) — stale line\n', 1_700_000_006_000);
    write(path.join(dir, 'notes.txt'), 'not a memory');
    fs.mkdirSync(path.join(dir, 'sub'));
    const result = make().index({ folders: [repo] });
    expect(result.projects).toHaveLength(1);
    const p = result.projects[0];
    expect(p.dir).toBe(encodeProjectSegment(repo));
    expect(p.path).toBe(repo);
    expect(p.memory_dir).toBe(dir);
    expect(p.index).toEqual({ path: path.join(dir, 'MEMORY.md'), size: fs.statSync(path.join(dir, 'MEMORY.md')).size, mtime: 1_700_000_006_000 });
    expect(p.more).toBe(0);
    expect(p.offset).toBe(0);
    expect(p.memories).toEqual([
      { file: 'newer.md', name: 'newer-rule', title: 'Newer rule', description: 'Quoted "desc"', type: 'project', hook: '', size: fs.statSync(path.join(dir, 'newer.md')).size, mtime: 1_700_000_005_000 },
      { file: 'older.md', name: 'older-rule', title: 'Older rule', description: 'The older rule', type: 'project', hook: 'its hook', size: fs.statSync(path.join(dir, 'older.md')).size, mtime: 1_700_000_000_000 },
    ]);
  });

  it('lists the home dir\'s CLAUDE.md once when home is itself a known folder', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), 'g');
    const result = make().index({ folders: [home, home] });
    expect(result.claude_md).toEqual([{ path: path.join(home, '.claude', 'CLAUDE.md'), size: 1, mtime: expect.any(Number) }]);
  });

  it('matches a known folder to its project dir by realpath (symlinked folder) and with the long-path hash suffix', () => {
    const real = path.join(root, 'real-repo');
    fs.mkdirSync(real);
    const link = path.join(root, 'link-repo');
    fs.symlinkSync(real, link);
    write(path.join(memDir(encodeProjectSegment(real)), 'a.md'), memory('a', 'A'));
    const long = path.join(root, 'x'.repeat(210));
    fs.mkdirSync(long);
    expect(encodeProjectSegment(long)).toMatch(/-[0-9a-z]+$/);
    expect(encodeProjectSegment(long).length).toBeGreaterThan(200);
    write(path.join(memDir(encodeProjectSegment(long)), 'b.md'), memory('b', 'B'));
    const result = make().index({ folders: [link, long] });
    expect(result.projects.map((p) => [p.dir, p.path])).toEqual(expect.arrayContaining([
      [encodeProjectSegment(real), link],
      [encodeProjectSegment(long), long],
    ]));
  });

  it('leaves path null for a project dir no known folder encodes to, and omits empty memory dirs', () => {
    fs.mkdirSync(memDir('-tmp-empty-proj'), { recursive: true });
    write(path.join(memDir('-home-x-unknown'), 'a.md'), memory('a', 'A'));
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'no-memory-dir'), { recursive: true });
    const result = make().index({ folders: [] });
    expect(result.projects.map((p) => [p.dir, p.path])).toEqual([['-home-x-unknown', null]]);
    expect(result.projects[0].index).toBe(null);
  });

  it('falls back to the file stem as name and a humanized title when frontmatter and index are absent', () => {
    write(path.join(memDir('-p'), 'plain-note.md'), 'Just a body line.\n\nMore.\n');
    const [p] = make().index({ folders: [] }).projects;
    expect(p.memories[0]).toMatchObject({ name: 'plain-note', title: 'Plain note', description: 'Just a body line.', type: '' });
  });

  it('a `project` filter lists only that project', () => {
    write(path.join(memDir('-a'), 'a.md'), memory('a', 'A'));
    write(path.join(memDir('-b'), 'b.md'), memory('b', 'B'));
    const lm = make();
    expect(lm.index({ folders: [], project: '-b' }).projects.map((p) => p.dir)).toEqual(['-b']);
    expect(lm.index({ folders: [], project: 'nope' }).projects).toEqual([]);
    expect(lm.index({ folders: [], project: '../-a' }).projects).toEqual([]);
  });

  it('never exceeds the frame budget: trims the fullest project first and reports `more`', () => {
    const big = memDir('-big');
    const small = memDir('-small');
    for (let i = 0; i < 80; i++) {
      write(path.join(big, `m${String(i).padStart(2, '0')}.md`), memory(`rule-${i}`, 'x'.repeat(150)), 1_700_000_000_000 + i * 1000);
    }
    for (let i = 0; i < 3; i++) write(path.join(small, `s${i}.md`), memory(`s-${i}`, 'small'));
    const result = make().index({ folders: [] });
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(bytes).toBeLessThanOrEqual(LOCAL_MEMORIES_RESULT_MAX_BYTES);
    const bigP = result.projects.find((p) => p.dir === '-big');
    const smallP = result.projects.find((p) => p.dir === '-small');
    expect(bigP.more).toBeGreaterThan(0);
    expect(bigP.memories.length + bigP.more).toBe(80);
    // Newest kept, oldest trimmed.
    expect(bigP.memories[0].name).toBe('rule-79');
    expect(smallP.memories).toHaveLength(3);
    expect(smallP.more).toBe(0);
  });

  it('`offset` skips the newest memories so a project can be paged past `more`', () => {
    const big = memDir('-big');
    for (let i = 0; i < 80; i++) {
      write(path.join(big, `m${String(i).padStart(2, '0')}.md`), memory(`rule-${i}`, 'x'.repeat(150)), 1_700_000_000_000 + i * 1000);
    }
    const lm = make();
    const seen = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      const [p] = lm.index({ folders: [], project: '-big', offset }).projects;
      expect(Buffer.byteLength(JSON.stringify(p), 'utf8')).toBeLessThanOrEqual(LOCAL_MEMORIES_RESULT_MAX_BYTES);
      expect(p.offset).toBe(offset);
      seen.push(...p.memories.map((m) => m.name));
      expect(p.memories.length + p.more).toBe(80 - offset);
      if (p.more === 0) break;
      offset += p.memories.length;
      if (++guard > 10) throw new Error('paging did not converge');
    }
    expect(seen).toHaveLength(80);
    expect(new Set(seen).size).toBe(80);
    expect(seen[0]).toBe('rule-79');
    expect(seen[79]).toBe('rule-0');
    // Past the end: an empty page, offset clamped, nothing more.
    const [past] = lm.index({ folders: [], project: '-big', offset: 500 }).projects;
    expect(past).toMatchObject({ offset: 80, memories: [], more: 0 });
    // A junk offset reads as 0.
    expect(lm.index({ folders: [], project: '-big', offset: -3 }).projects[0].offset).toBe(0);
  });

  it('a single-project page carries no claude_md (the full reply already did)', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), 'g');
    write(path.join(memDir('-a'), 'a.md'), memory('a', 'A'));
    const lm = make();
    expect(lm.index({ folders: [] }).claude_md).toHaveLength(1);
    expect(lm.index({ folders: [], project: '-a' }).claude_md).toEqual([]);
  });

  it('when memories alone cannot fit, drops whole projects by name, then CLAUDE.md entries by count', () => {
    // 40 projects with only a MEMORY.md each (~250 bytes of record apiece)
    // and 30 folders with a CLAUDE.md, against a 4 KiB budget.
    for (let i = 0; i < 40; i++) write(path.join(memDir(`-proj-${String(i).padStart(2, '0')}`), 'MEMORY.md'), '- index', 1_700_000_000_000 + i * 1000);
    const folders = [];
    for (let i = 0; i < 30; i++) {
      const f = path.join(root, `repo-${String(i).padStart(2, '0')}`);
      write(path.join(f, 'CLAUDE.md'), 'r');
      folders.push(f);
    }
    const budget = 4 * 1024;
    const result = make({ maxResultBytes: budget }).index({ folders });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(budget);
    // Every project is either listed or named as omitted — nothing vanishes.
    expect(result.projects.length + result.more_projects.length).toBe(40);
    const all = [...result.projects.map((p) => p.dir), ...result.more_projects].sort();
    expect(all).toEqual(Array.from({ length: 40 }, (_, i) => `-proj-${String(i).padStart(2, '0')}`));
    // Least recently active projects go first; each omitted one is fetchable alone.
    expect(result.more_projects[0]).toBe('-proj-00');
    const single = make({ maxResultBytes: budget }).index({ folders, project: result.more_projects[0] });
    expect(single.projects.map((p) => p.dir)).toEqual(['-proj-00']);
    // Every project had to go before a CLAUDE.md entry did.
    expect(result.projects).toEqual([]);
    expect(result.claude_md.length + result.more_claude_md).toBe(30);
    expect(result.more_claude_md).toBeGreaterThan(0);
    expect(result.claude_md[0].folder).toBe(folders[0]);
    // The dropped CLAUDE.md entries are read back with claude_md_offset pages
    // (no projects on those), each within budget, none missed or repeated.
    const seen = [...result.claude_md.map((e) => e.path)];
    let more = result.more_claude_md;
    let guard = 0;
    while (more) {
      const page = make({ maxResultBytes: budget }).index({ folders, claudeMdOffset: seen.length });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(budget);
      expect(page.projects).toEqual([]);
      expect(page.claude_md_offset).toBe(seen.length);
      expect(page.claude_md.length).toBeGreaterThan(0);
      seen.push(...page.claude_md.map((e) => e.path));
      more = page.more_claude_md ?? 0;
      if (++guard > 10) throw new Error('claude_md paging did not converge');
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    // Past the end: empty page, offset clamped, nothing more.
    expect(make().index({ folders, claudeMdOffset: 500 })).toMatchObject({ claude_md_offset: 30, claude_md: [], projects: [] });
  });

  it('caps description, title and hook lengths', () => {
    write(path.join(memDir('-c'), 'long.md'), memory('long', 'd'.repeat(500)));
    write(path.join(memDir('-c'), 'MEMORY.md'), `- [${'t'.repeat(300)}](long.md) — ${'h'.repeat(500)}\n`);
    const [p] = make().index({ folders: [] }).projects;
    expect(p.memories[0].description.length).toBeLessThanOrEqual(200);
    expect(p.memories[0].title.length).toBeLessThanOrEqual(120);
    expect(p.memories[0].hook.length).toBeLessThanOrEqual(200);
  });
});

describe('get()', () => {
  it('returns the body of an allow-listed memory file', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'a.md'), memory('a', 'A'), 1_700_000_000_000);
    const out = make().get({ path: path.join(dir, 'a.md'), folders: [] });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({
      path: path.join(dir, 'a.md'),
      size: Buffer.byteLength(memory('a', 'A')),
      mtime: 1_700_000_000_000,
      offset: 0,
      body: memory('a', 'A'),
      next_offset: null,
    });
  });

  it('serves the global CLAUDE.md, MEMORY.md, and a known folder\'s CLAUDE.md files', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), 'g');
    write(path.join(memDir('-p'), 'MEMORY.md'), 'i');
    const repo = path.join(root, 'repo');
    write(path.join(repo, 'CLAUDE.md'), 'r');
    write(path.join(repo, '.claude', 'CLAUDE.md'), 'rc');
    const lm = make();
    expect(lm.get({ path: path.join(home, '.claude', 'CLAUDE.md'), folders: [] }).result.body).toBe('g');
    expect(lm.get({ path: path.join(memDir('-p'), 'MEMORY.md'), folders: [] }).result.body).toBe('i');
    expect(lm.get({ path: path.join(repo, 'CLAUDE.md'), folders: [repo] }).result.body).toBe('r');
    expect(lm.get({ path: path.join(repo, '.claude', 'CLAUDE.md'), folders: [repo] }).result.body).toBe('rc');
    // The same file is forbidden when the folder is not a known one.
    expect(lm.get({ path: path.join(repo, 'CLAUDE.md'), folders: [] })).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses malformed paths as bad_request without touching the filesystem', () => {
    const lm = make({ fs: { ...fs, realpathSync: () => { throw new Error('must not be called'); } } });
    for (const bad of [undefined, null, 42, '', 'relative/CLAUDE.md', '~/.claude/CLAUDE.md', `${home}/.claude/CLAUDE.md\u0000x`, 'a'.repeat(2000)]) {
      expect(lm.get({ path: bad, folders: [] })).toEqual({ ok: false, error: { code: 'bad_request' } });
    }
  });

  it('refuses anything outside the allow-list, including traversal, nested and non-.md files', () => {
    write(path.join(home, '.bashrc'), 'secret');
    write(path.join(home, '.claude', 'settings.json'), '{}');
    const dir = memDir('-p');
    write(path.join(dir, 'a.md'), 'a');
    write(path.join(dir, 'sub', 'b.md'), 'b');
    write(path.join(dir, 'c.txt'), 'c');
    write(path.join(home, '.claude', 'projects', '-p', 'other.md'), 'o');
    const lm = make();
    const forbidden = [
      path.join(home, '.bashrc'),
      path.join(dir, '..', '..', '..', '..', '.bashrc'),
      `${dir}/../../../../.bashrc`,
      path.join(home, '.claude', 'settings.json'),
      path.join(dir, 'sub', 'b.md'),
      path.join(dir, 'c.txt'),
      path.join(home, '.claude', 'projects', '-p', 'other.md'),
      path.join(home, '.claude', 'projects', '-p', 'memory'),
      '/etc/passwd',
    ];
    for (const p of forbidden) {
      expect(lm.get({ path: p, folders: [] }), p).toEqual({ ok: false, error: { code: 'forbidden' } });
    }
  });

  it('resolves symlinks and re-checks the target: a link out of the allow-list is forbidden', () => {
    write(path.join(home, '.bashrc'), 'secret');
    const dir = memDir('-p');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(home, '.bashrc'), path.join(dir, 'evil.md'));
    // A whole memory dir that is a link elsewhere is refused too.
    const outside = path.join(root, 'outside');
    write(path.join(outside, 'x.md'), 'x');
    fs.mkdirSync(path.dirname(memDir('-linked')), { recursive: true });
    fs.symlinkSync(outside, memDir('-linked'));
    const lm = make();
    expect(lm.get({ path: path.join(dir, 'evil.md'), folders: [] })).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(lm.get({ path: path.join(memDir('-linked'), 'x.md'), folders: [] })).toEqual({ ok: false, error: { code: 'forbidden' } });
    // The index skips a linked-out memory file for the same reason.
    const listed = lm.index({ folders: [] }).projects.find((p) => p.dir === '-p');
    expect(listed).toBeUndefined();
  });

  it('a symlink whose target is itself allow-listed is served', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'real.md'), 'real');
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'alias.md'));
    const out = make().get({ path: path.join(dir, 'alias.md'), folders: [] });
    expect(out.ok).toBe(true);
    expect(out.result.body).toBe('real');
    expect(out.result.path).toBe(path.join(dir, 'alias.md'));
  });

  it('answers not_found for a missing or non-regular allow-listed path', () => {
    const dir = memDir('-p');
    fs.mkdirSync(path.join(dir, 'dir.md'), { recursive: true });
    const lm = make();
    expect(lm.get({ path: path.join(dir, 'missing.md'), folders: [] })).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(lm.get({ path: path.join(dir, 'dir.md'), folders: [] })).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(lm.get({ path: path.join(home, '.claude', 'CLAUDE.md'), folders: [] })).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses a file over the read cap as too_large', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'huge.md'), 'x'.repeat(100));
    const out = make({ maxFileBytes: 50 }).get({ path: path.join(dir, 'huge.md'), folders: [] });
    expect(out).toEqual({ ok: false, error: { code: 'too_large', detail: '100 bytes; cap 50' } });
  });

  it('pages a body that would not fit the frame, in whole characters, with next_offset', () => {
    const dir = memDir('-p');
    const body = `${'é'.repeat(30)}${'😀'.repeat(10)}end`;
    write(path.join(dir, 'p.md'), body);
    const lm = make({ maxBodyBytes: 41 });
    const first = lm.get({ path: path.join(dir, 'p.md'), folders: [] });
    expect(first.ok).toBe(true);
    expect(Buffer.byteLength(first.result.body, 'utf8')).toBeLessThanOrEqual(41);
    expect(first.result.next_offset).toBe(first.result.body.length);
    let assembled = first.result.body;
    let next = first.result.next_offset;
    let guard = 0;
    while (next !== null && guard++ < 20) {
      const page = lm.get({ path: path.join(dir, 'p.md'), folders: [], offset: next });
      expect(page.ok).toBe(true);
      expect(page.result.offset).toBe(next);
      expect(Buffer.byteLength(page.result.body, 'utf8')).toBeLessThanOrEqual(41);
      // Never splits a surrogate pair.
      expect(page.result.body).not.toMatch(/^[\uDC00-\uDFFF]/);
      assembled += page.result.body;
      next = page.result.next_offset;
    }
    expect(assembled).toBe(body);
  });

  it('an offset on the trail half of a surrogate pair steps back so the pair goes whole', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'p.md'), 'a😀b');
    const out = make().get({ path: path.join(dir, 'p.md'), folders: [], offset: 2 });
    expect(out.result).toMatchObject({ offset: 1, body: '😀b', next_offset: null });
    // A well-formed offset is untouched.
    expect(make().get({ path: path.join(dir, 'p.md'), folders: [], offset: 3 }).result).toMatchObject({ offset: 3, body: 'b' });
  });

  it('rejects a bad offset and clamps one past the end to an empty last page', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'p.md'), 'abc');
    const lm = make();
    expect(lm.get({ path: path.join(dir, 'p.md'), folders: [], offset: -1 })).toEqual({ ok: false, error: { code: 'bad_request' } });
    expect(lm.get({ path: path.join(dir, 'p.md'), folders: [], offset: 1.5 })).toEqual({ ok: false, error: { code: 'bad_request' } });
    expect(lm.get({ path: path.join(dir, 'p.md'), folders: [], offset: 99 }).result).toMatchObject({ offset: 3, body: '', next_offset: null });
  });

  it('a get result fits the RPC frame at the default body budget', () => {
    const dir = memDir('-p');
    write(path.join(dir, 'big.md'), 'ü'.repeat(40_000));
    const out = make().get({ path: path.join(dir, 'big.md'), folders: [] });
    expect(out.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.result), 'utf8')).toBeLessThanOrEqual(LOCAL_MEMORIES_RESULT_MAX_BYTES);
    expect(out.result.next_offset).not.toBe(null);
  });
});
