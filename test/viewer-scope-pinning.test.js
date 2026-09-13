import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A viewer token used to carry its scope as a bare workdir PATHNAME, which the
// viewer re-resolved on every request. That is not an authorization boundary:
// anything able to write the workdir's parent could rename the workdir away,
// drop a symlink to another session's directory in its place, and the
// re-resolve would follow it — containment passed against the attacker's
// directory and /view served the other session's file under the original
// token. These tests pin the fix: the token carries the workdir's filesystem
// IDENTITY, and the guard re-stats it on every serve.
let server, port, base, work, other;

beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise((r) => server.on('listening', r));
  port = server.address().port;

  base = mkdtempSync(path.join(tmpdir(), 'viewer-scope-'));
  work = path.join(base, 'work');
  other = path.join(base, 'other-session');
  mkdirSync(work);
  mkdirSync(other);
  writeFileSync(path.join(work, 'report.txt'), 'MY OWN FILE\n');
  writeFileSync(path.join(other, 'report.txt'), 'ANOTHER SESSION PRIVATE\n');
});

afterAll(() => {
  server?.close();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

// Mint exactly what index.js generateFileLink now mints, without importing
// index.js (it boots the bridge on import).
const pinnedRootsFor = async (dir) => {
  const { pinAllowedRootsSync } = await import('../lib/file-link-guard.js');
  return pinAllowedRootsSync([dir]).roots.map(({ realPath, dev, ino }) => ({ realPath, dev, ino }));
};

const viewUrl = async (extra) => {
  const { generateSignedUrl } = await import('../lib/viewer-tokens.js');
  return generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, extra);
};

// Rename the workdir away and put a symlink to the other session in its place.
const swapWorkdir = () => {
  renameSync(work, path.join(base, 'work.bak'));
  symlinkSync(other, work);
};
const restoreWorkdir = () => {
  rmSync(work, { force: true });
  renameSync(path.join(base, 'work.bak'), work);
};

describe('viewer scope pinning', () => {
  it('serves an in-scope file normally through a pinned token', async () => {
    const url = await viewUrl({
      path: path.join(work, 'report.txt'),
      workdir: work,
      roots: await pinnedRootsFor(work),
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MY OWN FILE');
  });

  it('refuses to serve after the workdir is renamed and replaced by a symlink', async () => {
    const url = await viewUrl({
      path: path.join(work, 'report.txt'),
      workdir: work,
      roots: await pinnedRootsFor(work),
    });
    swapWorkdir();
    try {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('ANOTHER SESSION');
    } finally {
      restoreWorkdir();
    }
  });

  it('refuses a /download token the same way — both routes share the pinning', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const url = generateDownloadUrl(
      `http://127.0.0.1:${port}`,
      path.join(work, 'report.txt'),
      undefined,
      60,
      work,
      await pinnedRootsFor(work),
    );
    swapWorkdir();
    try {
      const res = await fetch(url);
      expect(res.status).toBe(404);
    } finally {
      restoreWorkdir();
    }
  });

  it('refuses a token whose pinned roots were tampered into a malformed shape', async () => {
    const url = await viewUrl({
      path: path.join(work, 'report.txt'),
      workdir: work,
      roots: [{ realPath: work }], // dev/ino stripped
    });
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('still honours a legacy token that predates pinned roots (drains at expiry)', async () => {
    // Documented residual, not an oversight: tokens minted before this change
    // carry only the pathname and keep the old identity-free containment until
    // they expire. Asserting it keeps the compatibility path deliberate.
    const url = await viewUrl({ path: path.join(work, 'report.txt'), workdir: work });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MY OWN FILE');
  });
});

describe('index.js mints pinned roots', () => {
  it('signs the workdir identity into every file link', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    // The link payload must carry roots, and they must come from the SYNC
    // pinning helper (generateFileLink is synchronous).
    expect(src).toMatch(/pinAllowedRootsSync\(\[absWorkdir\]\)/);
    expect(src).toMatch(/JSON\.stringify\(\{ path: absTarget, exp, workdir: absWorkdir, roots \}\)/);
  });
});
