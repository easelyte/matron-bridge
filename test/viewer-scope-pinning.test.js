import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

// A viewer token used to carry its scope as a bare workdir pathname that the
// viewer re-resolved on every request. Anything able to write the workdir's
// parent could rename the workdir away and drop a symlink to another
// directory in its place; the re-resolve followed it and containment passed
// against the wrong directory. The token now carries the workdir's filesystem
// identity and the guard re-stats it on every serve.
let server, port, base, work, other;

beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise((r) => server.on('listening', r));
  port = server.address().port;
  base = mkdtempSync(path.join(tmpdir(), 'viewer-scope-'));
  work = path.join(base, 'work');
  other = path.join(base, 'other');
  mkdirSync(work);
  mkdirSync(other);
  writeFileSync(path.join(work, 'report.txt'), 'MY OWN FILE\n');
  writeFileSync(path.join(other, 'report.txt'), 'SOMEONE ELSES FILE\n');
});

afterAll(() => {
  server?.close();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

const swapWorkdir = () => {
  renameSync(work, path.join(base, 'work.bak'));
  symlinkSync(other, work);
};
const restoreWorkdir = () => {
  rmSync(work, { force: true });
  renameSync(path.join(base, 'work.bak'), work);
};

// Sign an arbitrary payload, to present token shapes the minters never emit.
const forgedUrl = (route, payload) => {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, ...payload })).toString('base64url');
  const sig = createHmac('sha256', 'test-secret').update(body).digest('base64url');
  return `http://127.0.0.1:${port}/${route}?token=${body}.${sig}`;
};

describe('viewer scope pinning', () => {
  it('serves an in-scope file through a pinned /view token', async () => {
    const { generateSignedUrl } = await import('../lib/viewer-tokens.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      path: path.join(work, 'report.txt'),
      workdir: work,
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('MY OWN FILE');
  });

  it('refuses /view after the workdir is renamed and replaced by a symlink', async () => {
    const { generateSignedUrl } = await import('../lib/viewer-tokens.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      path: path.join(work, 'report.txt'),
      workdir: work,
    });
    swapWorkdir();
    try {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('SOMEONE ELSES');
    } finally {
      restoreWorkdir();
    }
  });

  it('refuses /download after the swap', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, path.join(work, 'report.txt'), undefined, 60, work);
    swapWorkdir();
    try {
      expect((await fetch(url)).status).toBe(404);
    } finally {
      restoreWorkdir();
    }
  });

  it('refuses /page after the swap', async () => {
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    writeFileSync(path.join(work, 'index.html'), '<p>mine</p>');
    writeFileSync(path.join(other, 'index.html'), '<p>theirs</p>');
    const url = generatePageUrl(`http://127.0.0.1:${port}`, path.join(work, 'index.html'), undefined, 60, work);
    swapWorkdir();
    try {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('theirs');
    } finally {
      restoreWorkdir();
    }
  });

  it('leaves an unscoped download token without a roots assertion', async () => {
    const { generateDownloadUrl, verifyToken } = await import('../lib/viewer-tokens.js');
    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, path.join(work, 'report.txt'), undefined, 60);
    expect('roots' in verifyToken(url.split('token=')[1])).toBe(false);
    expect((await fetch(url)).status).toBe(200);
  });

  it('still serves a legacy workdir-only token minted before roots existed', async () => {
    const res = await fetch(forgedUrl('view', { path: path.join(work, 'report.txt'), workdir: work }));
    expect(res.status).toBe(200);
  });
});

describe('token scope fails closed', () => {
  it.each([
    ['null roots', null],
    ['empty roots', []],
    ['roots missing dev/ino', [{ realPath: '/tmp' }]],
    ['roots with a relative realPath', [{ realPath: 'work', dev: 1, ino: 2 }]],
    ['roots that is not an array', { realPath: '/tmp', dev: 1, ino: 2 }],
  ])('refuses a token whose %s cannot be honoured, rather than using the pathname', async (_label, roots) => {
    const res = await fetch(forgedUrl('view', { path: path.join(work, 'report.txt'), workdir: work, roots }));
    expect(res.status).toBe(404);
  });
});

describe('GET /view token kinds', () => {
  it.each(['page', 'download'])('rejects a token minted for %s use', async (kind) => {
    const tokens = await import('../lib/viewer-tokens.js');
    const filePath = path.join(work, 'scoped.html');
    writeFileSync(filePath, '<p>x</p>');
    const url = kind === 'page'
      ? tokens.generatePageUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, work)
      : tokens.generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, work);
    const res = await fetch(`http://127.0.0.1:${port}/view?token=${url.split('token=')[1]}`);
    expect(res.status).toBe(403);
  });
});
