import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

// One-time sensitive links are click-through: GET /sensitive and
// /sensitive-download serve a shell page with NO secret in it (browser
// prefetch, Safe Browsing, and Matrix URL previewers all GET links, and any
// of those used to consume the one-time view before the user saw it). The
// secret moves only on POST /sensitive/reveal. These tests stub the bridge
// API and drive the real viewer server, mirroring viewer-view.test.js.

let server, port, apiServer, apiPort;
let apiResponse; // set per-test: { status, body }
let apiCalls; // count of bridge-API hits — GETs of the shell must not add any

function sensitiveToken(payload, secret = 'test-secret') {
  const body = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 60,
    ...payload,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    apiCalls++;
    res.writeHead(apiResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(apiResponse.body));
  });
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  apiPort = apiServer.address().port;

  process.env.HMAC_SECRET = 'test-secret';
  process.env.MATRON_BRIDGE_API_PORT = String(apiPort);
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});

afterAll(() => {
  server?.close();
  apiServer?.close();
});

beforeEach(() => {
  apiCalls = 0;
});

async function getPage(route, payload) {
  const token = sensitiveToken(payload);
  return fetch(`http://127.0.0.1:${port}${route}?token=${encodeURIComponent(token)}`);
}

async function postReveal(payload) {
  const token = sensitiveToken(payload);
  return fetch(`http://127.0.0.1:${port}/sensitive/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

describe('sensitiveFilename', () => {
  it('prefers an explicit filename, sanitized to a safe basename', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('any label', 'install-christina.sh')).toBe('install-christina.sh');
    const traversal = sensitiveFilename('any label', '../../evil.sh');
    expect(traversal).not.toContain('/');
    expect(traversal.startsWith('.')).toBe(false);
    expect(traversal.endsWith('evil.sh')).toBe(true);
  });

  it('falls back to a filename-looking token in the label', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('install-jack.sh — dev-j setup script', undefined))
      .toBe('install-jack.sh');
  });

  it('falls back to a label slug with .txt when nothing looks like a filename', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('Database Password', undefined)).toBe('database-password.txt');
    expect(sensitiveFilename('///', undefined)).toBe('sensitive-data.txt');
  });
});

describe('GET /sensitive (shell page)', () => {
  it('serves the shell without touching the one-time store', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'Setup script', content: 'SECRET-CONTENT', filename: 'setup.sh' },
    };
    const res = await getPage('/sensitive', { sensitiveId: 'abc', label: 'Setup script' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Setup script');
    expect(html).toContain('/sensitive/reveal');
    // The whole point: no secret in the GET response, no store consumption.
    expect(html).not.toContain('SECRET-CONTENT');
    expect(apiCalls).toBe(0);
  });

  it('is safe to GET repeatedly (prefetchers, previews)', async () => {
    apiResponse = { status: 200, body: { label: 'x', content: 'y' } };
    for (let i = 0; i < 3; i++) {
      const res = await getPage('/sensitive', { sensitiveId: 'abc', label: 'x' });
      expect(res.status).toBe(200);
    }
    expect(apiCalls).toBe(0);
  });

  it('HTML-escapes a hostile label', async () => {
    const res = await getPage('/sensitive', {
      sensitiveId: 'abc',
      label: '<img src=x onerror=alert(1)>',
    });
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('rejects a token without a sensitiveId', async () => {
    const res = await getPage('/sensitive', { label: 'x' });
    expect(res.status).toBe(400);
  });

  // The shell used to hardcode the one-time warning, so a share created with
  // one_time:false was announced in chat as reusable and then described on
  // its own page as spent-on-first-view. The token now carries the flag (ot,
  // absent = one-time) and it is signed, so the holder cannot flip it.
  it('warns that a one-time link is one-time', async () => {
    const res = await getPage('/sensitive', { sensitiveId: 'abc', label: 'x' });
    expect(await res.text()).toContain('one-time link');
  });

  it('does not call a multi-use link one-time', async () => {
    const res = await getPage('/sensitive', { sensitiveId: 'abc', label: 'x', ot: false });
    const html = await res.text();
    expect(html).not.toContain('one-time link');
    expect(html).toContain('used more than once');
  });

  it('carries the same distinction onto the download-mode shell', async () => {
    const res = await getPage('/sensitive-download', { sensitiveId: 'abc', label: 'x', dl: true, ot: false });
    expect(await res.text()).toContain('used more than once');
  });
});

describe('GET /sensitive-download (shell page)', () => {
  it('serves the download-mode shell without touching the store', async () => {
    apiResponse = { status: 200, body: { label: 'x', content: 'SECRET-CONTENT' } };
    const res = await getPage('/sensitive-download', { sensitiveId: 'abc', label: 'x', dl: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/sensitive/reveal');
    expect(html).not.toContain('SECRET-CONTENT');
    expect(apiCalls).toBe(0);
  });

  it('rejects a page token without the dl flag', async () => {
    const res = await getPage('/sensitive-download', { sensitiveId: 'abc', label: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('POST /sensitive/reveal', () => {
  it('relays the content with the resolved filename', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'Setup script', content: '#!/bin/sh\necho hi\n', filename: 'setup.sh' },
    };
    const res = await postReveal({ sensitiveId: 'abc', label: 'Setup script' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      label: 'Setup script',
      content: '#!/bin/sh\necho hi\n',
      filename: 'setup.sh',
    });
    expect(apiCalls).toBe(1);
  });

  it('derives the filename from the label when the API sends none', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'install-jack.sh — dev-j setup', content: 'x' },
    };
    const res = await postReveal({ sensitiveId: 'abc', label: 'install-jack.sh — dev-j setup' });
    expect((await res.json()).filename).toBe('install-jack.sh');
  });

  it('sanitizes a hostile filename to a safe basename', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'x', content: 'y', filename: '../../</script>evil.sh' },
    };
    const res = await postReveal({ sensitiveId: 'abc', label: 'x' });
    const { filename } = await res.json();
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('<');
  });

  it('accepts a dl-flavoured token too', async () => {
    apiResponse = { status: 200, body: { label: 'x', content: 'y' } };
    const res = await postReveal({ sensitiveId: 'abc', label: 'x', dl: true });
    expect(res.status).toBe(200);
  });

  it('relays bridge API errors as JSON with the upstream status', async () => {
    apiResponse = { status: 403, body: { error: 'Sensitive data has already been viewed (one-time link)' } };
    const res = await postReveal({ sensitiveId: 'gone', label: 'x' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('already been viewed');
  });

  it('rejects a token without a sensitiveId', async () => {
    const res = await postReveal({ label: 'x' });
    expect(res.status).toBe(403);
    expect(apiCalls).toBe(0);
  });
});
