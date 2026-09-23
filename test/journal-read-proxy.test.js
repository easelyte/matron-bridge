import { describe, it, expect, vi } from 'vitest';
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
