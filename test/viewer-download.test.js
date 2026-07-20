import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server, port, tmpDir;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  process.env.DOWNLOAD_RATE_LIMIT = '10';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-download-test-'));
});
afterAll(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('GET /download', () => {
  it('serves exact binary bytes with attachment disposition', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    const filePath = path.join(tmpDir, 'app.zip');
    writeFileSync(filePath, bytes);

    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('app.zip');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it('serves a file larger than the /view cap', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'big.zip');
    writeFileSync(filePath, Buffer.alloc(6 * 1024 * 1024, 0x42));

    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(6 * 1024 * 1024);
  });

  it('rejects a /view token pasted onto /download (no dl flag)', async () => {
    const { generateSignedUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'not-dl.txt');
    writeFileSync(filePath, 'plain\n');
    const token = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60).split('token=')[1];

    const res = await fetch(`http://127.0.0.1:${port}/download?token=${token}`);
    expect(res.status).toBe(403);
  });

  it('404s a sensitive file', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'credentials.json');
    writeFileSync(filePath, '{"k":"v"}\n');

    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('404s a file outside the token workdir', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const inner = path.join(tmpDir, 'dl-workdir');
    mkdirSync(inner, { recursive: true });
    const filePath = path.join(tmpDir, 'outside.zip');
    writeFileSync(filePath, Buffer.alloc(16, 1));

    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, inner);
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('sanitizes hostile basenames in the disposition header', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'we"ird;na\rme.zip');
    writeFileSync(filePath, Buffer.alloc(4, 2));

    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).not.toContain('"we"');
    expect(cd).not.toContain('\r');
  });

  // Last in the file: exhausts the shared per-IP budget for this window.
  it('429s after the per-window request limit', async () => {
    const { generateDownloadUrl } = await import('../lib/viewer-tokens.js');
    const filePath = path.join(tmpDir, 'limited.zip');
    writeFileSync(filePath, Buffer.alloc(8, 3));
    const url = generateDownloadUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);

    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await fetch(url)).status);
    expect(statuses.filter(s => s === 200).length).toBeLessThanOrEqual(10);
    expect(statuses.at(-1)).toBe(429);
  });
});
