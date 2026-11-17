import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Short links end to end against the real viewer: the bridge side mints with
// createShortLinkWriter / shortenViewerUrl into a store file, the viewer
// resolves /l/<code> from the same file. The bridge API is stubbed with the
// sensitive store's one-time semantics (first fetch wins, the rest get 403).

const SECRET = 'test-secret';
let server, base, apiServer, tmpDir, storeFile, writer;
let sensitive; // Map<id, { content, oneTime, viewed }>
let secretSubmits;

function signed(payload) {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/sensitive\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const s = sensitive.get(m[1]);
        if (!s) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Sensitive data not found or already viewed' })); }
        if (s.oneTime && s.viewed) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Sensitive data has already been viewed (one-time link)' })); }
        s.viewed = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ label: 'k', content: s.content }));
      }
      const sm = req.url.match(/^\/secret\/([^/]+)\/submit$/);
      if (req.method === 'POST' && sm) {
        secretSubmits.push({ id: sm[1], body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));

  tmpDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'viewer-short-links-')));
  storeFile = path.join(tmpDir, 'short-links.json');
  process.env.HMAC_SECRET = SECRET;
  process.env.MATRON_BRIDGE_API_PORT = String(apiServer.address().port);
  process.env.MATRON_SHORT_LINKS_FILE = storeFile;
  process.env.PAGE_RATE_LIMIT = '200';
  process.env.DOWNLOAD_RATE_LIMIT = '200';
  process.env.REVEAL_RATE_LIMIT = '200';
  process.env.SHORT_LINK_RATE_LIMIT = '500';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { createShortLinkWriter } = await import('../lib/short-links.js');
  writer = createShortLinkWriter({ file: storeFile });
});

afterAll(() => {
  server?.close();
  apiServer?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  sensitive = new Map();
  secretSubmits = [];
});

async function shorten(longUrl) {
  const { shortenViewerUrl } = await import('../lib/short-links.js');
  const short = shortenViewerUrl(writer, longUrl);
  expect(short).toMatch(new RegExp(`^${base}/l/[A-Za-z0-9]{12}$`));
  return short;
}
const codeOf = (url) => url.split('/l/')[1];

const PAGE = '<!DOCTYPE html><html><body><h1>Pack</h1></body></html>';

describe('GET /l/<code> for a page', () => {
  it('serves the page in place with the page headers, and the long link still works', async () => {
    const filePath = path.join(tmpDir, 'pack.html');
    writeFileSync(filePath, PAGE);
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    const long = generatePageUrl(base, filePath, SECRET, 600, tmpDir);
    const short = await shorten(long);

    const res = await fetch(short, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);

    const longRes = await fetch(long);
    expect(longRes.status).toBe(200);
    expect(await longRes.text()).toBe(PAGE);
  });

  it('shows the current file on every open', async () => {
    const filePath = path.join(tmpDir, 'live.html');
    writeFileSync(filePath, '<p>one</p>');
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    const short = await shorten(generatePageUrl(base, filePath, SECRET, 600, tmpDir));
    expect(await (await fetch(short)).text()).toBe('<p>one</p>');
    writeFileSync(filePath, '<p>two</p>');
    expect(await (await fetch(short)).text()).toBe('<p>two</p>');
  });
});

describe('codes that do not resolve', () => {
  it('unknown, malformed and expired codes all answer exactly like an expired token', async () => {
    const expiredLong = await fetch(`${base}/sensitive?token=${encodeURIComponent(signed({ sensitiveId: 'x', label: 'k', exp: 1 }))}`);
    const expected = { status: expiredLong.status, body: await expiredLong.text() };
    expect(expected.status).toBe(403);

    // An expired code: stored, but its exp is in the past.
    const expiredCode = writer.add({ route: 'sensitive', token: signed({ sensitiveId: 'x', label: 'k' }), exp: Math.floor(Date.now() / 1000) - 5 });
    for (const code of ['AAAAAAAAAAAA', 'short', expiredCode, 'AAAAAAAAAAAA%2e', '__proto__']) {
      const res = await fetch(`${base}/l/${code}`);
      expect({ status: res.status, body: await res.text() }).toEqual(expected);
    }
  });

  it('a code whose token was minted for another route cannot be replayed there', async () => {
    // A page code posted to the sensitive reveal: rejected like a bad token.
    const filePath = path.join(tmpDir, 'p.html');
    writeFileSync(filePath, PAGE);
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    const code = codeOf(await shorten(generatePageUrl(base, filePath, SECRET, 600, tmpDir)));
    const res = await fetch(`${base}/sensitive/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }),
    });
    expect(res.status).toBe(403);
    const sub = await fetch(`${base}/secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: code, value: 'v' }).toString(),
    });
    expect(sub.status).toBe(403);
    expect(secretSubmits).toHaveLength(0);
  });
});

describe('GET /l/<code> for sensitive data', () => {
  it('serves the shell with the code, never the long token, in it', async () => {
    sensitive.set('s1', { content: 'value-1', oneTime: true });
    const token = signed({ sensitiveId: 's1', label: 'k' });
    const short = await shorten(`${base}/sensitive?token=${token}`);
    const res = await fetch(short);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(JSON.stringify(codeOf(short)));
    expect(html).not.toContain(token);
    expect(html).not.toContain(token.split('.')[0]);
    expect(html).toContain('one-time link');
    // The GET consumed nothing.
    expect(sensitive.get('s1').viewed).toBeUndefined();
  });

  it('serves the download flavour of the shell for a sensitive-download code', async () => {
    const token = signed({ sensitiveId: 's1', label: 'k', dl: true });
    const res = await fetch(await shorten(`${base}/sensitive-download?token=${token}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"download"');
  });

  it('a one-time code is consumed exactly once, even by two concurrent reveals', async () => {
    sensitive.set('s2', { content: 'value-2', oneTime: true });
    const code = codeOf(await shorten(`${base}/sensitive?token=${signed({ sensitiveId: 's2', label: 'k' })}`));
    const reveal = () => fetch(`${base}/sensitive/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }),
    });
    const results = await Promise.all([reveal(), reveal()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);
    const ok = results.find((r) => r.status === 200);
    expect((await ok.json()).content).toBe('value-2');
    // And afterwards it stays consumed.
    expect((await reveal()).status).toBe(403);
  });

  it('a multi-use code reveals until it expires', async () => {
    sensitive.set('s3', { content: 'value-3', oneTime: false });
    const code = codeOf(await shorten(`${base}/sensitive?token=${signed({ sensitiveId: 's3', label: 'k', ot: false })}`));
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/sensitive/reveal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('the long token still reveals directly', async () => {
    sensitive.set('s4', { content: 'value-4', oneTime: true });
    const token = signed({ sensitiveId: 's4', label: 'k' });
    const res = await fetch(`${base}/sensitive/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe('value-4');
  });
});

describe('GET /l/<code> for a secret request', () => {
  it('serves the form posting the code back, and the submission reaches the bridge', async () => {
    const token = signed({ secretId: 'sec-9', label: 'Deploy key' });
    const short = await shorten(`${base}/secret?token=${token}`);
    const res = await fetch(short);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`name="token" value="${codeOf(short)}"`);
    expect(html).not.toContain(token);

    const sub = await fetch(`${base}/secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: codeOf(short), value: 'dummy-not-a-secret' }).toString(),
    });
    expect(sub.status).toBe(200);
    expect(secretSubmits).toEqual([{ id: 'sec-9', body: { value: 'dummy-not-a-secret' } }]);
  });
});

describe('restart persistence', () => {
  it('a code minted before a viewer restart still resolves after it', async () => {
    const filePath = path.join(tmpDir, 'restart.html');
    writeFileSync(filePath, PAGE);
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    const short = await shorten(generatePageUrl(base, filePath, SECRET, 600, tmpDir));
    // A fresh reader on the same file is what a restarted viewer builds.
    const { createShortLinkReader } = await import('../lib/short-links.js');
    expect(createShortLinkReader({ file: storeFile }).resolve(codeOf(short))?.route).toBe('page');
    expect((await fetch(short)).status).toBe(200);
  });
});
