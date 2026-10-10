import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeEditDiff } from '../lib/edit-diff.js';

// Temp dirs are removed after each test so the suite leaves nothing in /tmp.
const tmpDirs = [];
async function mkTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editdiff-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('computeEditDiff', () => {
  it('Edit: line diff of old_string -> new_string with hunk header and counts', async () => {
    const r = await computeEditDiff('Edit', {
      file_path: '/tmp/x.swift',
      old_string: 'let a = 1\nlet b = 2\nlet c = 3',
      new_string: 'let a = 1\nlet b = 99\nlet b2 = 100\nlet c = 3',
    }, '/tmp');
    expect(r).not.toBeNull();
    expect(r.diff).toMatch(/^@@ /m);
    expect(r.diff).toContain('-let b = 2');
    expect(r.diff).toContain('+let b = 99');
    expect(r.diff).toContain('+let b2 = 100');
    expect(r.diff).not.toMatch(/^---|^\+\+\+/m); // no file header lines
    expect(r.added).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.newFile).toBe(false);
  });

  it('Edit: identical strings (no-op) -> null', async () => {
    const r = await computeEditDiff('Edit', {
      file_path: '/tmp/x', old_string: 'same', new_string: 'same',
    }, '/tmp');
    expect(r).toBeNull();
  });

  it('Write: diffs against existing on-disk content', async () => {
    const dir = await mkTmp();
    const f = path.join(dir, 'a.txt');
    await fs.writeFile(f, 'one\ntwo\nthree\n');
    const r = await computeEditDiff('Write', { file_path: f, content: 'one\nTWO\nthree\n' }, dir);
    expect(r.newFile).toBe(false);
    expect(r.diff).toContain('-two');
    expect(r.diff).toContain('+TWO');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('Write: absent file -> newFile all-additions', async () => {
    const dir = await mkTmp();
    const r = await computeEditDiff('Write', {
      file_path: path.join(dir, 'nope.txt'), content: 'hello\nworld\n',
    }, dir);
    expect(r.newFile).toBe(true);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.diff).toContain('+hello');
    expect(r.diff).toContain('+world');
  });

  it('Write: relative file_path resolves against workdir', async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, 'rel.txt'), 'a\n');
    const r = await computeEditDiff('Write', { file_path: 'rel.txt', content: 'b\n' }, dir);
    expect(r.newFile).toBe(false);
    expect(r.diff).toContain('-a');
    expect(r.diff).toContain('+b');
  });

  it('MultiEdit: one hunk per edit, concatenated in order', async () => {
    const r = await computeEditDiff('MultiEdit', {
      file_path: '/tmp/x',
      edits: [
        { old_string: 'foo', new_string: 'bar' },
        { old_string: 'baz\nqux', new_string: 'baz\nQUX' },
      ],
    }, '/tmp');
    expect(r.diff.match(/^@@ /gm).length).toBe(2);
    expect(r.diff.indexOf('+bar')).toBeLessThan(r.diff.indexOf('+QUX'));
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
  });

  it('caps at 400 lines with truncated=true and pre-truncation counts', async () => {
    const oldLines = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n');
    const newLines = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n');
    const r = await computeEditDiff('Edit', {
      file_path: '/tmp/x', old_string: oldLines, new_string: newLines,
    }, '/tmp');
    expect(r.truncated).toBe(true);
    expect(r.diff.split('\n').length).toBeLessThanOrEqual(400);
    expect(r.added).toBe(600);   // counted before the cap
    expect(r.removed).toBe(600);
    expect(r.diff.endsWith('\n')).toBe(false); // whole-line cut, no dangling newline
  });

  it('caps at 64 KB even under 400 lines', async () => {
    const bigLine = 'x'.repeat(2048);
    const oldStr = Array.from({ length: 50 }, () => bigLine).join('\n');
    const r = await computeEditDiff('Edit', {
      file_path: '/tmp/x', old_string: oldStr, new_string: 'tiny',
    }, '/tmp');
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.diff, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('returns synchronously — not a Promise — so diff publishes keep stream order', async () => {
    const dir = await mkTmp();
    const f = path.join(dir, 'sync.txt');
    await fs.writeFile(f, 'old\n');
    // Write is the only path with file I/O; if it ever goes async again,
    // publishEditDiff would enqueue the journal diff event after later
    // stream events and reorder cards against their tool_use.
    const r = computeEditDiff('Write', { file_path: f, content: 'new\n' }, dir);
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.diff).toContain('-old');
    expect(r.diff).toContain('+new');
  });

  it('Write over a file larger than 1 MB -> null (sync read cap)', async () => {
    const dir = await mkTmp();
    const f = path.join(dir, 'big.txt');
    await fs.writeFile(f, 'x'.repeat(1024 * 1024 + 1));
    const r = computeEditDiff('Write', { file_path: f, content: 'tiny\n' }, dir);
    expect(r).toBeNull();
  });

  it('unknown tool / missing fields -> null', async () => {
    expect(await computeEditDiff('Bash', { command: 'ls' }, '/tmp')).toBeNull();
    expect(await computeEditDiff('Edit', { file_path: '/tmp/x' }, '/tmp')).toBeNull();
    expect(await computeEditDiff('Write', { file_path: '/tmp/x' }, '/tmp')).toBeNull();
    expect(await computeEditDiff('MultiEdit', { file_path: '/tmp/x', edits: [] }, '/tmp')).toBeNull();
  });
});
