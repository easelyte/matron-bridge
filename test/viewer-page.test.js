import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server, port, tmpDir, base;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  process.env.PAGE_RATE_LIMIT = '100';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  tmpDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'viewer-page-test-')));
});
afterAll(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const PAGE = '<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><h1>Pack</h1><script>document.title="x"</script></body></html>';

async function pageUrl(filePath, { workdir = tmpDir, expiry = 600 } = {}) {
  const { generatePageUrl } = await import('../lib/viewer-tokens.js');
  return generatePageUrl(base, filePath, undefined, expiry, workdir);
}

describe('GET /page', () => {
  it('serves the HTML verbatim as text/html', async () => {
    const filePath = path.join(tmpDir, 'pack.html');
    writeFileSync(filePath, PAGE);
    const res = await fetch(await pageUrl(filePath));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe(PAGE);
  });

  it('sandboxes the page into an opaque origin and locks down the rest', async () => {
    const filePath = path.join(tmpDir, 'headers.html');
    writeFileSync(filePath, PAGE);
    const res = await fetch(await pageUrl(filePath));
    const csp = res.headers.get('content-security-policy');
    const directives = csp.split(';').map(d => d.trim());
    const sandbox = directives.find(d => d.startsWith('sandbox'));
    expect(sandbox).toBeTruthy();
    // The whole point: never same-origin with the viewer.
    expect(sandbox).not.toMatch(/allow-same-origin/);
    expect(sandbox).not.toMatch(/allow-top-navigation/);
    expect(sandbox).toMatch(/allow-scripts/);
    expect(sandbox).toMatch(/allow-popups-to-escape-sandbox/);
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("default-src 'none'");
    expect(directives.find(d => d.startsWith('connect-src'))).not.toMatch(/https|\*|'self'/);
    // Inline script only: no third-party code that could read the token.
    expect(directives.find(d => d.startsWith('script-src'))).not.toMatch(/https|\*|'self'|data:|blob:/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('cache-control')).toMatch(/no-transform/);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('can be opened many times', async () => {
    const filePath = path.join(tmpDir, 'many.html');
    writeFileSync(filePath, PAGE);
    const url = await pageUrl(filePath);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      await res.text();
    }
  });

  it('serves a page larger than the /view cap (a pack with inline media)', async () => {
    const filePath = path.join(tmpDir, 'big.html');
    writeFileSync(filePath, `<html><body><img src="data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}"></body></html>`);
    const res = await fetch(await pageUrl(filePath));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('404s a page over the page cap', async () => {
    const { MAX_PAGE_BYTES } = await import('../lib/file-link-guard.js');
    const filePath = path.join(tmpDir, 'huge.html');
    writeFileSync(filePath, Buffer.alloc(MAX_PAGE_BYTES + 1, 0x41));
    const res = await fetch(await pageUrl(filePath));
    expect(res.status).toBe(404);
  });

  it('rejects a /view token (no page flag)', async () => {
    const { generateSignedUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'viewtok.html');
    writeFileSync(filePath, PAGE);
    const token = generateSignedUrl(base, filePath, undefined, 60).split('token=')[1];
    const res = await fetch(`${base}/page?token=${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects a /download token (no page flag)', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'dltok.html');
    writeFileSync(filePath, PAGE);
    const token = generateDownloadUrl(base, filePath, undefined, 60, tmpDir).split('token=')[1];
    const res = await fetch(`${base}/page?token=${token}`);
    expect(res.status).toBe(403);
  });

  it('a page token does not open /download', async () => {
    const filePath = path.join(tmpDir, 'nodl.html');
    writeFileSync(filePath, PAGE);
    const token = (await pageUrl(filePath)).split('token=')[1];
    const res = await fetch(`${base}/download?token=${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects an expired token', async () => {
    const filePath = path.join(tmpDir, 'old.html');
    writeFileSync(filePath, PAGE);
    const res = await fetch(await pageUrl(filePath, { expiry: -10 }));
    expect(res.status).toBe(403);
  });

  it('rejects a tampered token', async () => {
    const filePath = path.join(tmpDir, 'tamper.html');
    writeFileSync(filePath, PAGE);
    const url = await pageUrl(filePath);
    const res = await fetch(url.slice(0, -2) + 'xx');
    expect(res.status).toBe(403);
  });

  it('400s without a token', async () => {
    const res = await fetch(`${base}/page`);
    expect(res.status).toBe(400);
  });

  it('404s a file that is not .html', async () => {
    const filePath = path.join(tmpDir, 'image.svg');
    writeFileSync(filePath, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const res = await fetch(await pageUrl(filePath));
    expect(res.status).toBe(404);
  });

  it('404s a file outside the token workdir', async () => {
    const inner = path.join(tmpDir, 'workdir');
    mkdirSync(inner, { recursive: true });
    const filePath = path.join(tmpDir, 'outside.html');
    writeFileSync(filePath, PAGE);
    const res = await fetch(await pageUrl(filePath, { workdir: inner }));
    expect(res.status).toBe(404);
  });

  it('404s a sensitive-named path', async () => {
    const dir = path.join(tmpDir, 'secrets');
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'page.html');
    writeFileSync(filePath, PAGE);
    const res = await fetch(await pageUrl(filePath));
    expect(res.status).toBe(404);
  });

  it('404s a symlink', async () => {
    const target = path.join(tmpDir, 'target.html');
    writeFileSync(target, PAGE);
    const link = path.join(tmpDir, 'link.html');
    symlinkSync(target, link);
    const res = await fetch(await pageUrl(link));
    expect(res.status).toBe(404);
  });

  it('404s a missing file', async () => {
    const res = await fetch(await pageUrl(path.join(tmpDir, 'gone.html')));
    expect(res.status).toBe(404);
  });
});
