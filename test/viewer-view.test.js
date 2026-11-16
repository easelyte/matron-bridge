import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server, port, tmpDir;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0); // 0 = ephemeral port
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-view-test-'));
});
afterAll(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('GET /view', () => {
  it('HTML-escapes the filename (title, header, language class)', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const evilName = 'x<img src=q onerror=alert(1)>.j"s';
    const filePath = path.join(tmpDir, evilName);
    writeFileSync(filePath, 'hello world\n');

    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
    // The dirty extension must not leak into the class attribute.
    expect(body).not.toContain('language-j"s');
    expect(body).toContain('hello world');
  });

  it('still renders a normal file with its language class', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'plain.js');
    writeFileSync(filePath, 'const a = 1;\n');

    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('language-js');
    expect(body).toContain('plain.js');
    expect(body).toContain('const a = 1;');
  });

  it('rejects a repeated token query param (array) without crashing', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'plain2.js');
    writeFileSync(filePath, 'ok\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const token = url.split('token=')[1];

    const res = await fetch(`http://127.0.0.1:${port}/view?token=${token}&token=${token}`);
    expect(res.status).toBe(403);
    // Server must still be alive and serving.
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
  });
});

describe('GET /view (hardened)', () => {
  it('serves a normal file inside the token workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'guarded-ok.js');
    writeFileSync(filePath, 'const ok = true;\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('const ok = true;');
  });

  it('404s a sensitive file even inside the workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, '.env');
    writeFileSync(filePath, 'SECRET=1\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRET');
  });

  it('404s a file outside the token workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const inner = path.join(tmpDir, 'inner-workdir');
    mkdirSync(inner, { recursive: true });
    const filePath = path.join(tmpDir, 'outside-inner.txt');
    writeFileSync(filePath, 'outside inner\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: inner });
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('404s a symlink pointing outside the workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const inner = path.join(tmpDir, 'sym-workdir');
    mkdirSync(inner, { recursive: true });
    const target = path.join(tmpDir, 'sym-target.txt');
    writeFileSync(target, 'reached through symlink\n');
    const linkPath = path.join(inner, 'link.txt');
    symlinkSync(target, linkPath);
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, linkPath, undefined, 60, { path: linkPath, workdir: inner });
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('reached through symlink');
  });

  it('404s an oversized file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'huge.txt');
    writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('legacy token without workdir: still serves a normal file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'legacy-ok.txt');
    writeFileSync(filePath, 'legacy fine\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('legacy fine');
  });

  it('legacy token without workdir: still 404s a sensitive file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'service-account-prod.json');
    writeFileSync(filePath, '{"private_key":"x"}\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('private_key');
  });
});

describe('GET /secret', () => {
  it('HTML-escapes the label in the secret form', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      secretId: 's1',
      label: '"><script>alert(1)</script>',
    }).replace('/view', '/secret');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
