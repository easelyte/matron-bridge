import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Rate limits on short links, at the boundary. The counters live for the
// whole viewer process, so the steps below run in order and each one counts
// on the requests the earlier ones made:
//   SHORT_LINK_RATE_LIMIT=4 — every GET /l/<code>, resolved or not
//   PAGE_RATE_LIMIT=2       — shared by /page?token= and /l/<page code>
//   the reveal POST keeps its own budget, untouched by either.

const SECRET = 'test-secret';
let server, base, apiServer, tmpDir, writer;

function signed(payload) {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ label: 'k', content: 'v' }));
  });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  tmpDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'viewer-short-limits-')));
  const storeFile = path.join(tmpDir, 'short-links.json');
  process.env.HMAC_SECRET = SECRET;
  process.env.MATRON_BRIDGE_API_PORT = String(apiServer.address().port);
  process.env.MATRON_SHORT_LINKS_FILE = storeFile;
  process.env.SHORT_LINK_RATE_LIMIT = '4';
  process.env.PAGE_RATE_LIMIT = '2';
  process.env.REVEAL_RATE_LIMIT = '5';
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

describe('short-link rate limits', () => {
  let sensitiveCode;

  it('a page code spends the page budget the long link spends', async () => {
    const filePath = path.join(tmpDir, 'p.html');
    writeFileSync(filePath, '<p>x</p>');
    const { generatePageUrl } = await import('../lib/viewer-tokens.js');
    const long = generatePageUrl(base, filePath, SECRET, 600, tmpDir);
    const { shortenViewerUrl } = await import('../lib/short-links.js');
    const short = shortenViewerUrl(writer, long);
    sensitiveCode = writer.add({ route: 'sensitive', token: signed({ sensitiveId: 's1', label: 'k' }), exp: Math.floor(Date.now() / 1000) + 300 });

    expect((await fetch(long)).status).toBe(200); // page 1
    expect((await fetch(short)).status).toBe(200); // page 2, lookup 1
    expect((await fetch(short)).status).toBe(429); // page budget spent, lookup 2
    expect((await fetch(long)).status).toBe(429);
  });

  it('every lookup spends the lookup budget, found or not: request 4 passes, request 5 is refused', async () => {
    expect((await fetch(`${base}/l/AAAAAAAAAAAA`)).status).toBe(403); // lookup 3
    expect((await fetch(`${base}/l/BBBBBBBBBBBB`)).status).toBe(403); // lookup 4
    expect((await fetch(`${base}/l/${sensitiveCode}`)).status).toBe(429); // lookup 5
  });

  it('the reveal POST keeps its own budget, so a spent lookup budget cannot block it', async () => {
    const res = await fetch(`${base}/sensitive/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sensitiveCode }),
    });
    expect(res.status).toBe(200);
  });
});
