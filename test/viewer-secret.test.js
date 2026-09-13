import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

// The secure-input form (item #120). Two shapes now: the masked single-line
// field, and a textarea for `multiline: true` requests (a PEM, a service
// account JSON). The value is the whole point of the page, so the only thing
// asserted about it is that it reaches the bridge API byte-for-byte —
// newlines included. Stubs the bridge API and drives the real viewer server,
// mirroring test/viewer-sensitive.test.js.
//
// No real secret appears anywhere here: DUMMY is a fixed non-secret string.
const DUMMY = 'dummy-value-not-a-secret';

let server, port, apiServer, apiPort;
let apiResponse; // set per-test: { status, body }
let apiRequests; // [{ url, body }] — what the viewer forwarded

function secretToken(payload, { secret = 'test-secret', expIn = 60 } = {}) {
  const body = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expIn,
    ...payload,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      apiRequests.push({ url: req.url, body: raw });
      res.writeHead(apiResponse.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiResponse.body));
    });
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
  apiRequests = [];
  apiResponse = { status: 200, body: { ok: true, path: '/home/u/.secrets/sec-1.txt' } };
});

const getForm = (payload, opts) =>
  fetch(`http://127.0.0.1:${port}/secret?token=${encodeURIComponent(secretToken(payload, opts))}`);

function postValue(token, value) {
  const body = new URLSearchParams();
  body.set('token', token);
  body.set('value', value);
  return fetch(`http://127.0.0.1:${port}/secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

describe('GET /secret', () => {
  it('renders a masked single-line field by default', async () => {
    const res = await getForm({ secretId: 'sec-1', label: 'AWS access key' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="password" name="value"');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('AWS access key');
  });

  it('renders a textarea when the token says the request is multiline', async () => {
    const res = await getForm({ secretId: 'sec-1', label: 'deploy key', multiline: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<textarea name="value"');
    expect(html).toContain('rows="12"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain('<input type="password"');
  });

  it('still promises the 1 h auto-delete on both shapes', async () => {
    for (const multiline of [false, true]) {
      const html = await (await getForm({ secretId: 'sec-1', label: 'k', multiline })).text();
      expect(html).toContain('auto-deleted after 1 hour');
    }
  });

  it('promises LF line endings on the multiline form only', async () => {
    const multi = await (await getForm({ secretId: 'sec-1', label: 'k', multiline: true })).text();
    expect(multi).toContain('Line endings are saved as LF.');
    const single = await (await getForm({ secretId: 'sec-1', label: 'k' })).text();
    expect(single).not.toContain('Line endings are saved as LF.');
  });

  it('escapes the label', async () => {
    const html = await (await getForm({ secretId: 'sec-1', label: '<img src=x onerror=1>' })).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('rejects an expired token with 403', async () => {
    const res = await getForm({ secretId: 'sec-1', label: 'k' }, { expIn: -10 });
    expect(res.status).toBe(403);
  });

  it('rejects a token signed with the wrong key with 403', async () => {
    const res = await getForm({ secretId: 'sec-1', label: 'k' }, { secret: 'not-the-secret' });
    expect(res.status).toBe(403);
  });

  it('rejects a token that is not a secret token with 400', async () => {
    const res = await getForm({ label: 'no id' });
    expect(res.status).toBe(400);
  });
});

describe('POST /secret', () => {
  it('forwards the value to the bridge API byte-for-byte, newlines included', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'deploy key', multiline: true });
    const value = `-----BEGIN KEY-----\r\nline one\nline two\n  indented  \n\n-----END KEY-----\n`;
    const res = await postValue(token, value);
    expect(res.status).toBe(200);
    expect(apiRequests.length).toBe(1);
    expect(apiRequests[0].url).toBe('/secret/sec-1/submit');
    expect(JSON.parse(apiRequests[0].body).value).toBe(value);
  });

  it('round-trips a 16 KB value without truncation', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'json key', multiline: true });
    const value = `${'x'.repeat(16 * 1024)}\n`;
    const res = await postValue(token, value);
    expect(res.status).toBe(200);
    expect(JSON.parse(apiRequests[0].body).value).toBe(value);
  });

  it('does not trim leading or trailing whitespace', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'k' });
    const value = `  ${DUMMY}  \n`;
    await postValue(token, value);
    expect(JSON.parse(apiRequests[0].body).value).toBe(value);
  });

  it('shows the success page when the bridge accepts it', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'k' });
    const html = await (await postValue(token, DUMMY)).text();
    expect(html).toContain('Secret submitted');
    expect(html).not.toContain(DUMMY);
  });

  it('surfaces a bridge rejection instead of claiming success', async () => {
    apiResponse = { status: 404, body: { error: 'Secret request not found or already submitted' } };
    const token = secretToken({ secretId: 'sec-1', label: 'k' });
    const res = await postValue(token, DUMMY);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('already submitted');
  });

  it('rejects an expired token with 403 and forwards nothing', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'k' }, { expIn: -10 });
    const res = await postValue(token, DUMMY);
    expect(res.status).toBe(403);
    expect(apiRequests.length).toBe(0);
  });

  it('leaves the app-wide 100 KB urlencoded ceiling in place for other routes', async () => {
    // The bigger parser is mounted on THIS route only. /sensitive/reveal also
    // accepts urlencoded bodies, and nothing about a secure-input form should
    // widen its ceiling.
    const body = new URLSearchParams();
    body.set('token', 'x');
    body.set('junk', 'y'.repeat(150 * 1024));
    const res = await fetch(`http://127.0.0.1:${port}/sensitive/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(413);
  });

  it('accepts a 64 KB multi-line value, and explains a rejection past the ceiling', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'kubeconfig', multiline: true });
    const big = `${'k'.repeat(64 * 1024)}\r\n`;
    expect((await postValue(token, big)).status).toBe(200);
    expect(JSON.parse(apiRequests[0].body).value).toBe(big);

    apiRequests = [];
    const tooBig = '%'.repeat(256 * 1024); // percent-encodes to 3x
    const res = await postValue(token, tooBig);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('Too large');
    expect(apiRequests.length).toBe(0);
  });

  it('rejects a missing value with 400 and forwards nothing', async () => {
    const token = secretToken({ secretId: 'sec-1', label: 'k' });
    const res = await postValue(token, '');
    expect(res.status).toBe(400);
    expect(apiRequests.length).toBe(0);
  });
});
