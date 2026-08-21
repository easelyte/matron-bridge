import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileGuarded, MAX_READ_BYTES, MAX_RESPONSE_BODY_BYTES } from '../lib/read-file.js';
import { applyFileEdit } from '../lib/edit-file.js';
import { pinAllowedRootsSync } from '../lib/file-link-guard.js';

// Real temp dirs (like edit-file.test.js) so the fd-pinned / O_NOFOLLOW /
// realpath containment is exercised for real, not mocked.
let root;
let outside;
let roots; // pinned root set scoped to `root`

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'read-root-'));
  outside = mkdtempSync(path.join(tmpdir(), 'read-out-'));
  roots = pinAllowedRootsSync([root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('readFileGuarded — happy paths', () => {
  it('returns the current content, sha256 over the bytes, size, mode, and the real path', async () => {
    const file = path.join(root, 'config.txt');
    const body = 'PORT=3000\nDEBUG=false\n';
    writeFileSync(file, body);
    const res = await readFileGuarded({ path: file }, { allowedRoots: roots });
    expect(res.path).toBe(file);
    expect(res.content).toBe(body);
    expect(res.bytes).toBe(Buffer.byteLength(body));
    expect(res.sha256).toBe(createHash('sha256').update(Buffer.from(body)).digest('hex'));
    // permission bits are an octal number, not the edit-mode string
    expect(typeof res.mode).toBe('number');
  });

  it('reads an empty file (content "", sha of empty)', async () => {
    const file = path.join(root, 'empty.txt');
    writeFileSync(file, '');
    const res = await readFileGuarded({ path: file }, { allowedRoots: roots });
    expect(res.content).toBe('');
    expect(res.bytes).toBe(0);
    expect(res.sha256).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  });

  it('the returned sha256 satisfies edit_file\'s expected_sha256 CAS on an unchanged file (round-trip)', async () => {
    const file = path.join(root, 'settings.conf');
    writeFileSync(file, 'A=1\nB=2\n');
    const read = await readFileGuarded({ path: file }, { allowedRoots: roots });
    // read -> edit with the returned sha; the CAS must PASS (file unchanged).
    const edited = await applyFileEdit(
      { path: file, content: 'A=1\nB=3\n', expected_sha256: read.sha256 },
      { allowedRoots: roots },
    );
    expect(edited.mode).toBe('content');
  });

  it('a stale sha (file changed after read) makes the subsequent edit fail the CAS', async () => {
    const file = path.join(root, 'race.conf');
    writeFileSync(file, 'v1');
    const read = await readFileGuarded({ path: file }, { allowedRoots: roots });
    writeFileSync(file, 'v2-changed-underneath'); // someone else edits
    await expect(
      applyFileEdit({ path: file, content: 'v3', expected_sha256: read.sha256 }, { allowedRoots: roots }),
    ).rejects.toMatchObject({ code: 'stale' });
  });
});

describe('readFileGuarded — path-safety rejections (same vocabulary as edit_file)', () => {
  it('rejects a plain absolute path outside the allowed root (outside-scope)', async () => {
    const outsideFile = path.join(outside, 'elsewhere.txt');
    writeFileSync(outsideFile, 'do not read');
    await expect(readFileGuarded({ path: outsideFile }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'ReadFileError', code: 'outside-scope' });
  });

  it('rejects a ../ traversal that climbs out of the root (outside-scope)', async () => {
    const outsideFile = path.join(outside, 'target.txt');
    writeFileSync(outsideFile, 'secret-ish');
    const traversal = path.join(root, '..', path.basename(outside), 'target.txt');
    await expect(readFileGuarded({ path: traversal }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'outside-scope' });
  });

  it('rejects a symlink whose target escapes the root (O_NOFOLLOW -> symlink)', async () => {
    const outsideFile = path.join(outside, 'real.txt');
    writeFileSync(outsideFile, 'escape target');
    const link = path.join(root, 'link.txt');
    symlinkSync(outsideFile, link);
    await expect(readFileGuarded({ path: link }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'ReadFileError', code: 'symlink' });
  });

  it('rejects a sensitive file even inside the root (.env)', async () => {
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, 'API_KEY=abc\n');
    await expect(readFileGuarded({ path: envFile }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'sensitive' });
  });

  it('rejects a directory target (not-a-file)', async () => {
    const dir = path.join(root, 'subdir');
    mkdirSync(dir);
    await expect(readFileGuarded({ path: dir }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'not-a-file' });
  });

  it('rejects a relative path outright (relative-path)', async () => {
    await expect(readFileGuarded({ path: 'relative/config.txt' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'relative-path' });
  });

  it('rejects reading a non-existent file (unreadable)', async () => {
    await expect(readFileGuarded({ path: path.join(root, 'ghost.txt') }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'ReadFileError', code: 'unreadable' });
  });
});

describe('readFileGuarded — size guard', () => {
  it('rejects a file over the max-size guard (too_large)', async () => {
    const file = path.join(root, 'big.txt');
    writeFileSync(file, 'x'.repeat(64));
    await expect(readFileGuarded({ path: file }, { allowedRoots: roots, maxBytes: 32 }))
      .rejects.toMatchObject({ code: 'too_large' });
  });

  it('is bounded to the 16 KiB relay frame cap, NOT edit_file\'s 5 MiB (content is returned inline)', () => {
    // read_file returns content inline in an agent_response frame, so it is
    // bounded to the relay's 16 KiB cap, not edit_file's 5 MiB raw budget.
    expect(MAX_RESPONSE_BODY_BYTES).toBe(15 * 1024);
    expect(MAX_READ_BYTES).toBe(MAX_RESPONSE_BODY_BYTES);
    expect(MAX_READ_BYTES).toBeLessThan(16 * 1024);
  });

  it('rejects a file whose SERIALIZED response would exceed the frame budget (F3), even under the raw cap', async () => {
    // A file just under the raw read cap but whose JSON-escaped body exceeds the
    // response budget must fail loud as too_large, not produce a droppable frame.
    // Control chars expand ~6x under JSON escaping (\u00XX), so a modest raw file
    // blows the encoded budget.
    const file = path.join(root, 'ctrl.txt');
    writeFileSync(file, String.fromCharCode(1).repeat(4 * 1024)); // 4 KiB raw -> ~24 KiB encoded (6 bytes each)
    await expect(readFileGuarded({ path: file }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('readFileGuarded — fail closed on scope + malformed input', () => {
  it('rejects when no allowed roots are pinned (bad_workdir)', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'hi');
    const empty = pinAllowedRootsSync([]);
    await expect(readFileGuarded({ path: file }, { allowedRoots: empty }))
      .rejects.toMatchObject({ code: 'bad_workdir' });
  });

  it('rejects when allowedRoots is absent (bad_workdir)', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'hi');
    await expect(readFileGuarded({ path: file }, {}))
      .rejects.toMatchObject({ code: 'bad_workdir' });
  });

  it('rejects a missing/empty path (bad_request)', async () => {
    await expect(readFileGuarded({}, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(readFileGuarded({ path: '' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('does NOT mutate the file (read-only)', async () => {
    const file = path.join(root, 'ro.txt');
    writeFileSync(file, 'unchanged');
    await readFileGuarded({ path: file }, { allowedRoots: roots });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file, 'utf8')).toBe('unchanged');
  });
});
