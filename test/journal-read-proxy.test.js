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

describe('journal read proxy (loop #765)', () => {
  it('forwards /journal/search to the journal /search with the bridge bearer, query verbatim', async () => {
    const fetchImpl = fakeFetch((url, opts) => {
      expect(url).toBe(`${BASE}/search?q=deploy&limit=5`);
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      return okRes('{"hits":[]}');
    });
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=deploy&limit=5' });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('application/json');
    expect(r.body).toBe('{"hits":[]}');
  });

  it('forwards /journal/convo/:id/messages, re-encoding the id exactly once', async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(`${BASE}/convo/abc%3A123/messages?around_seq=9`);
      return okRes('{"messages":[]}');
    });
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    // 'abc%3A123' decodes to 'abc:123' then re-encodes to 'abc%3A123'.
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/convo/abc%3A123/messages', search: '?around_seq=9' });
    expect(r.status).toBe(200);
  });

  it('forwards /journal/help and passes through the markdown content-type', async () => {
    const fetchImpl = fakeFetch(() => okRes('# Journal API', 'text/markdown'));
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/help', search: '' });
    expect(r.contentType).toBe('text/markdown');
    expect(r.body).toBe('# Journal API');
  });

  it('NEVER exposes non-allowlisted journal routes (no snapshot/roster/items)', async () => {
    const fetchImpl = fakeFetch(() => okRes('should not happen'));
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    for (const p of ['/journal/snapshot', '/journal/roster', '/journal/items', '/journal', '/journal/search/../roster']) {
      // Not a proxy route -> handle returns null (caller falls through), and no
      // upstream request is ever made under the bridge token.
      expect(await proxy.handle({ method: 'GET', pathname: p, search: '' })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-GET method on a proxy path (405) without forwarding', async () => {
    const fetchImpl = fakeFetch(() => okRes('x'));
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await proxy.handle({ method: 'POST', pathname: '/journal/search', search: '?q=x' });
    expect(r.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 when no journal is configured (disabled), never forwarding', async () => {
    const proxy = createJournalReadProxy({ baseUrl: '', token: '' });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x' });
    expect(r.status).toBe(503);
    expect(proxy.enabled).toBe(false);
  });

  it('maps an upstream fetch failure to 502 (never leaks an exception)', async () => {
    const fetchImpl = fakeFetch(() => { throw new Error('network down'); });
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x' });
    expect(r.status).toBe(502);
  });

  it('forwards the upstream status verbatim (e.g. a 403 rate-limit)', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 403, headers: { get: () => 'application/json' }, text: async () => '{"error":"rate_limited"}' }));
    const proxy = createJournalReadProxy({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await proxy.handle({ method: 'GET', pathname: '/journal/search', search: '?q=x' });
    expect(r.status).toBe(403);
  });

  it('isJournalProxyPath recognizes exactly the three allowlisted routes', () => {
    expect(isJournalProxyPath('/journal/search')).toBe(true);
    expect(isJournalProxyPath('/journal/convo/x/messages')).toBe(true);
    expect(isJournalProxyPath('/journal/help')).toBe(true);
    expect(isJournalProxyPath('/journal/snapshot')).toBe(false);
    expect(isJournalProxyPath('/items/create')).toBe(false);
  });
});
