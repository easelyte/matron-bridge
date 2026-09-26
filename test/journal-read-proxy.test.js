import { describe, it, expect, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { createJournalReadProxy, isJournalProxyPath } from '../lib/journal-read-proxy.js';

function fakeFetch(impl) {
  return vi.fn(async (url, opts) => impl(url, opts));
}

function okRes(body, contentType = 'application/json') {
  return { status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) }, text: async () => body };
}

const BASE = 'https://journal.example';
const TOKEN = 'full-read-secret';
const CAP = 'cap-token-abc';

function makeProxy(fetchImpl, { capabilityToken = CAP } = {}) {
  return createJournalReadProxy({ baseUrl: BASE, token: TOKEN, capabilityToken, fetchImpl });
}

describe('journal read proxy (loop #765)', () => {
  it('forwards /journal/search to the journal /search with the bridge bearer, query verbatim', async () => {
    const fetchImpl = fakeFetch((url, opts) => {
      expect(url).toBe(`${BASE}/search?q=deploy&limit=5`);
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      return okRes('{"hits":[]}');
    });
    const proxy = makeProxy(fetchImpl);
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=deploy&limit=5', callerToken: CAP });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('application/json');
    expect(r.body).toBe('{"hits":[]}');
  });

  it('forwards /journal/convo/:id/messages, re-encoding the id exactly once', async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(`${BASE}/convo/abc%3A123/messages?around_seq=9`);
      return okRes('{"messages":[]}');
    });
    const proxy = makeProxy(fetchImpl);
    // 'abc%3A123' decodes to 'abc:123' then re-encodes to 'abc%3A123'.
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/convo/abc%3A123/messages', search: '?around_seq=9', callerToken: CAP });
    expect(r.status).toBe(200);
  });

  it('requires the capability token — a caller without it gets 401 and no upstream call', async () => {
    const fetchImpl = fakeFetch(() => okRes('should not happen'));
    const proxy = makeProxy(fetchImpl);
    expect((await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: undefined })).status).toBe(401);
    expect((await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: 'wrong' })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects (never throws on) a same-length token with non-ASCII characters', async () => {
    const fetchImpl = fakeFetch(() => okRes('x'));
    const proxy = makeProxy(fetchImpl);
    // Header values arrive latin1-decoded: 'é' is one UTF-16 unit, two UTF-8 bytes.
    const sameLength = CAP.slice(0, -1) + '\u00e9';
    expect(sameLength.length).toBe(CAP.length);
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: sameLength });
    expect(r.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a raw non-ASCII header byte over real HTTP gets 401 and the server keeps serving', async () => {
    const fetchImpl = fakeFetch(() => okRes('{"hits":[]}'));
    const proxy = makeProxy(fetchImpl);
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const r = await proxy.handle({ method: req.method, pathname: u.pathname, search: u.search, callerToken: req.headers['x-matron-journal-proxy-token'] });
      res.writeHead(r.status, { 'Content-Type': r.contentType });
      res.end(r.body);
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const get = (headerBytes) => new Promise((ok, fail) => {
      const req = request({ host: '127.0.0.1', port, path: '/journal/search?q=x', method: 'GET',
        headers: { 'x-matron-journal-proxy-token': Buffer.from(headerBytes).toString('latin1') } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
      req.on('error', fail);
      req.end();
    });
    try {
      // Same character count as CAP, but the last byte is 0xE9 (latin1 'e-acute').
      const bytes = Buffer.concat([Buffer.from(CAP.slice(0, -1)), Buffer.from([0xe9])]);
      expect(await get(bytes)).toBe(401);
      expect(await get(Buffer.from(CAP))).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });

  it('the API listener wraps the proxy call in try/catch (a throw must not be an unhandled rejection)', () => {
    // index.js is not importable in tests (it starts the bridge), so pin the
    // wiring by source text: the handle() call sits inside a try whose catch
    // answers 500 instead of letting the async listener reject.
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const m = src.match(/try \{\s*proxied = await journalReadProxy\.handle\(\{[\s\S]*?\}\);\s*\} catch \(e\) \{([\s\S]*?)\n    \}/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/status: 500/);
    expect(src.match(/journalReadProxy\.handle\(/g)).toHaveLength(1);
  });

  it('fails closed when no capability token is configured (never unauthenticated)', async () => {
    const fetchImpl = fakeFetch(() => okRes('x'));
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, capabilityToken: '', fetchImpl });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: '' });
    expect(r.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does NOT proxy /journal/help (its upstream digest describes the raw token API)', async () => {
    const proxy = makeProxy(fakeFetch(() => okRes('x')));
    expect(isJournalProxyPath('/journal/help')).toBe(false);
    expect(await proxy.handle({ method: 'GET', pathname: '/journal/help', search: '', callerToken: CAP })).toBeNull();
  });

  it('returns 400 (not a crash) for a malformed percent-escape in the convo id', async () => {
    const fetchImpl = fakeFetch(() => okRes('x'));
    const proxy = makeProxy(fetchImpl);
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/convo/%ZZ/messages', search: '', callerToken: CAP });
    expect(r.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('NEVER exposes non-allowlisted journal routes (no snapshot/roster/items)', async () => {
    const fetchImpl = fakeFetch(() => okRes('should not happen'));
    const proxy = makeProxy(fetchImpl);
    for (const p of ['/journal/snapshot', '/journal/roster', '/journal/items', '/journal', '/journal/search/../roster']) {
      expect(await proxy.handle({ method: 'GET', pathname: p, search: '', callerToken: CAP })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-GET method on a proxy path (405) without forwarding', async () => {
    const fetchImpl = fakeFetch(() => okRes('x'));
    const proxy = makeProxy(fetchImpl);
    const r = await proxy.handle({ method: 'POST', pathname: '/journal/search', search: '?q=x', callerToken: CAP });
    expect(r.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 when no journal is configured (disabled), never forwarding', async () => {
    const proxy = createJournalReadProxy({ baseUrl: '', token: '', capabilityToken: CAP });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: CAP });
    expect(r.status).toBe(503);
    expect(proxy.enabled).toBe(false);
  });

  it('maps an upstream fetch failure to 502 (never leaks an exception)', async () => {
    const fetchImpl = fakeFetch(() => { throw new Error('network down'); });
    const proxy = makeProxy(fetchImpl);
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: CAP });
    expect(r.status).toBe(502);
  });

  it('forwards the upstream status verbatim (e.g. a 403 rate-limit)', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 403, headers: { get: () => 'application/json' }, text: async () => '{"error":"rate_limited"}' }));
    const proxy = makeProxy(fetchImpl);
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x', callerToken: CAP });
    expect(r.status).toBe(403);
  });

  it('isJournalProxyPath recognizes exactly the two allowlisted routes', () => {
    expect(isJournalProxyPath('/journal/search')).toBe(true);
    expect(isJournalProxyPath('/journal/convo/x/messages')).toBe(true);
    expect(isJournalProxyPath('/journal/help')).toBe(false);
    expect(isJournalProxyPath('/journal/snapshot')).toBe(false);
    expect(isJournalProxyPath('/items/create')).toBe(false);
  });
});
