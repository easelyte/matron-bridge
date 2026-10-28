import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createJournalPublisher } from '../lib/journal-publisher.js';

// A plain HTTP server standing in for the journal's media routes. The
// publisher's WS connect to the same port fails and retries in the
// background, which these tests do not care about.
function startFakeHttpServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers };
      received.push(entry);
      handler(entry, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const FAST_BACKOFF = { backoffBaseMs: 15, backoffCapMs: 60 };

describe('journal publisher transcript requests', () => {
  let server;
  let pub;
  let warnings;

  async function setup(handler) {
    server = await startFakeHttpServer(handler);
    warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    pub = createJournalPublisher({ url: `ws://127.0.0.1:${server.port}/ws`, token: 'tok-r', log, ...FAST_BACKOFF });
  }

  afterEach(async () => {
    pub?.close();
    await server?.close();
    pub = undefined;
    server = undefined;
  });

  const transcriptWarnings = () => warnings.filter((w) => /requestTranscript/.test(w));

  it('requestTranscript POSTs to /media/<ref>/transcript with the bearer and returns the JSON', async () => {
    const answer = { status: 'pending' };
    await setup((entry, res) => {
      if (entry.method === 'POST' && entry.url.split('?')[0] === '/media/vn%2F1/transcript') json(res, 200, answer);
      else json(res, 404, {});
    });
    expect(await pub.requestTranscript('vn/1')).toEqual(answer);
    const reqs = server.received.filter((r) => r.url.startsWith('/media/'));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].method).toBe('POST');
    expect(reqs[0].url).toBe('/media/vn%2F1/transcript?wait=0');
    expect(reqs[0].headers.authorization).toBe('Bearer tok-r');
  });

  it('requestTranscript passes waitS through as ?wait= and returns segments', async () => {
    const answer = { status: 'done', transcript: 'hi', segments: [{ start_ms: 0, text: 'hi' }] };
    await setup((_entry, res) => json(res, 200, answer));
    expect(await pub.requestTranscript('vn-2', { waitS: 5 })).toEqual(answer);
    expect(server.received.filter((r) => r.url.startsWith('/media/')).map((r) => r.url)).toEqual(['/media/vn-2/transcript?wait=5']);
  });

  it('requestTranscript: a network failure is null and warns, never throws', async () => {
    await setup((_entry, res) => res.socket.destroy());
    await expect(pub.requestTranscript('x')).resolves.toBeNull();
    expect(transcriptWarnings()).toHaveLength(1);
  });

  it('requestTranscript: 404 → null', async () => {
    await setup((_entry, res) => json(res, 404, {}));
    expect(await pub.requestTranscript('old')).toBeNull();
    expect(transcriptWarnings()).toHaveLength(0);
  });

  it('requestTranscript: 500 → null and warns', async () => {
    await setup((_entry, res) => json(res, 500, { error: 'boom' }));
    expect(await pub.requestTranscript('x')).toBeNull();
    expect(transcriptWarnings()).toHaveLength(1);
  });

  it('requestTranscript: a body without a string status is null; a blank ref makes no call', async () => {
    await setup((_entry, res) => json(res, 200, { transcript: 'no status' }));
    expect(await pub.requestTranscript('vn-3')).toBeNull();
    const before = server.received.length;
    expect(await pub.requestTranscript('')).toBeNull();
    expect(server.received.length).toBe(before);
  });

  it('fetchTranscript returns segments when present', async () => {
    const answer = { status: 'done', transcript: 'one two', segments: [{ start_ms: 0, text: 'one' }, { start_ms: 1200, text: 'two' }] };
    await setup((entry, res) => {
      if (entry.method === 'GET' && entry.url === '/media/vn-4/transcript?wait=20') json(res, 200, answer);
      else json(res, 404, {});
    });
    expect(await pub.fetchTranscript('vn-4')).toEqual(answer);
  });

  it('a disabled publisher resolves requestTranscript to null', async () => {
    const disabled = createJournalPublisher({ url: '', token: '', log: { warn: () => {}, error: () => {} } });
    await expect(disabled.requestTranscript('vn-5')).resolves.toBeNull();
  });
});
