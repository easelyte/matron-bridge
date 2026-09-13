import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

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

// Sign an arbitrary payload with the viewer's HMAC, bypassing the minters —
// the only way to present a token shape the minters refuse to produce.
const forgedUrl = (payload) => {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, ...payload })).toString('base64url');
  const sig = createHmac('sha256', 'test-secret').update(body).digest('base64url');
  return `http://127.0.0.1:${port}/view?token=${body}.${sig}`;
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

  it('refuses a token that claims a workdir scope without pinning it', async () => {
    // The mutable-pathname scope is GONE, not merely deprecated: a token with
    // a workdir and no roots is refused rather than served under the weaker
    // boundary. Forged by hand because both minters now refuse to emit one —
    // in production this shape only exists in tokens minted by a previous
    // process, so the cost is a dead link for at most one token lifetime.
    const res = await fetch(forgedUrl({ path: path.join(work, 'report.txt'), workdir: work }));
    expect(res.status).toBe(404);
  });

  it('mints pinned roots even when the caller only supplies a workdir', async () => {
    const { generateSignedUrl, verifyToken } = await import('../lib/viewer-tokens.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      path: path.join(work, 'report.txt'),
      workdir: work,
    });
    const payload = verifyToken(url.split('token=')[1]);
    expect(Array.isArray(payload.roots)).toBe(true);
    expect(payload.roots[0]).toMatchObject({ realPath: work });
    expect((await fetch(url)).status).toBe(200);
  });
});

// index.js boots the bridge on import, so its wiring is pinned by source
// inspection — the same pattern the context-command and session-status tests
// use. WHEN the root is pinned is the security property here, not just THAT
// it is: pinning at tool-event time would capture whatever the agent had
// already moved into the workdir's place.
describe('index.js pins the viewer root at session creation', () => {
  let src;
  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
  });

  it('pins at every session-creation site, next to the show_file pin', () => {
    const pins = src.match(/const viewerRootIdentities = pinViewerRootIdentities\(cwd\);/g) || [];
    const showFilePins = src.match(/showFilePinnedRoots = pinAllowedRootsSync\(/g) || [];
    expect(pins.length).toBe(showFilePins.length);
    expect(pins.length).toBeGreaterThanOrEqual(3);
    // ...and each pinned identity reaches the session object.
    const carried = src.match(/^ {4}viewerRootIdentities,$/gm) || [];
    expect(carried.length).toBe(pins.length);
  });

  it('signs the session-pinned identity into the link, resolving nothing itself', () => {
    expect(src).toMatch(/JSON\.stringify\(\{ path: absTarget, exp, workdir: absWorkdir, roots \}\)/);
    expect(src).toMatch(/generateFileLink\(absPath, session\.workdir, session\.viewerRootIdentities\)/);
    // generateFileLink runs synchronously per Edit/Write/MultiEdit event: no
    // filesystem call may appear in its body, or a stalled mount wedges the
    // whole bridge.
    const body = src.slice(
      src.indexOf('function generateFileLink('),
      src.indexOf('// The secure-input link.'),
    );
    expect(body).not.toMatch(/pinAllowedRootsSync|realpathSync|statSync|readFileSync/);
  });
});

describe('token scope fails closed', () => {
  // These shapes cannot be produced by the minters any more, so they are
  // signed by hand: the point is that the VERIFIER refuses them, independently
  // of any minter staying well-behaved.
  it.each([
    ['null roots', null],
    ['empty roots', []],
    ['roots missing dev/ino', [{ realPath: '/tmp' }]],
    ['roots with a relative realPath', [{ realPath: 'work', dev: 1, ino: 2 }]],
    ['roots that is not an array', { realPath: '/tmp', dev: 1, ino: 2 }],
  ])('refuses a token whose %s cannot be honoured, rather than falling back to the pathname', async (_label, roots) => {
    const res = await fetch(forgedUrl({ path: path.join(work, 'report.txt'), workdir: work, roots }));
    expect(res.status).toBe(404);
  });

  it('generateDownloadUrl cannot mint a pathname-only scope even when roots is omitted', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    // The five-argument form — a workdir and no roots — must still produce a
    // pinned scope, not the weaker pathname one.
    const url = generateDownloadUrl(
      `http://127.0.0.1:${port}`, path.join(work, 'report.txt'), undefined, 60, work,
    );
    const token = url.split('token=')[1];
    const { verifyToken } = await import('../lib/viewer-tokens.js');
    const payload = verifyToken(token);
    expect(Array.isArray(payload.roots)).toBe(true);
    expect(payload.roots[0]).toMatchObject({ realPath: work });
    expect(typeof payload.roots[0].ino).toBe('number');

    swapWorkdir();
    try {
      expect((await fetch(url)).status).toBe(404);
    } finally {
      restoreWorkdir();
    }
  });

  it('leaves an unscoped download token free of a roots assertion', async () => {
    const { generateDownloadUrl, verifyToken } = await import('../lib/viewer-tokens.js');
    const url = generateDownloadUrl(
      `http://127.0.0.1:${port}`, path.join(work, 'report.txt'), undefined, 60,
    );
    const payload = verifyToken(url.split('token=')[1]);
    expect('roots' in payload).toBe(false);
    expect((await fetch(url)).status).toBe(200);
  });
});
