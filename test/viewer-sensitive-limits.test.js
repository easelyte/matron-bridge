import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

// The shell GETs and the reveal POST used to share one rate-limit counter.
// Behind the Cloudflare tunnel every request arrives from the loopback IP, so
// that counter is effectively global — and the GETs are the requests nobody
// controls (prefetchers, Safe Browsing, URL previewers, a refresh). Spending
// the window on those would 429 the single POST the user pressed a button
// for. Separate budgets keep guessing bounded per route without letting the
// cheap repeatable route starve the one that matters.
//
// Own file rather than a case in viewer-sensitive.test.js: the limits are
// read at module load, so they have to be in the environment before the
// viewer server is imported, and the caps here are far too small to run the
// rest of that suite under.

let server, port, apiServer, apiPort;

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ label: 'x', content: 'SECRET', filename: 'x.txt' }));
  });
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  apiPort = apiServer.address().port;

  process.env.HMAC_SECRET = 'test-secret';
  process.env.MATRON_BRIDGE_API_PORT = String(apiPort);
  process.env.DOWNLOAD_RATE_LIMIT = '2';
  process.env.REVEAL_RATE_LIMIT = '2';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});

afterAll(() => {
  server?.close();
  apiServer?.close();
});

const token = () => sensitiveToken({ sensitiveId: 'abc', label: 'x' });

const getShell = () =>
  fetch(`http://127.0.0.1:${port}/sensitive?token=${encodeURIComponent(token())}`);

const postReveal = () =>
  fetch(`http://127.0.0.1:${port}/sensitive/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token() }),
  });

describe('sensitive-link rate limits', () => {
  it('does not let exhausted shell GETs 429 the reveal the user actually asked for', async () => {
    // Burn the GET budget several times over — a previewer plus a couple of
    // refreshes gets here without the user doing anything deliberate.
    for (let i = 0; i < 5; i++) await getShell();
    expect((await getShell()).status).toBe(429);

    // The POST has its own window and is untouched by any of that.
    expect((await postReveal()).status).toBe(200);
  });

  it('still caps the reveal POST on its own budget', async () => {
    // Second reveal is the last one inside REVEAL_RATE_LIMIT=2 (the test
    // above spent the first), so the next must be refused.
    expect((await postReveal()).status).toBe(200);
    expect((await postReveal()).status).toBe(429);
  });
});
