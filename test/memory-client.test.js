import { describe, it, expect, vi } from 'vitest';
import { createMemoryClient } from '../lib/memory-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.body === undefined) throw new Error('no json'); return r.body; } };
  });
  return { fetchImpl, calls };
}

describe('createMemoryClient', () => {
  it('save PUTs /memories/:name with bearer, JSON body and the status', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { memory: { id: 'me_1', name: 'avoid-eric' } } }));
    const c = createMemoryClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.save('avoid-eric', { description: 'x', convo_id: 'c1' });
    expect(r).toEqual({ status: 201, data: { memory: { id: 'me_1', name: 'avoid-eric' } } });
    expect(calls[0].url).toBe('https://j/memories/avoid-eric');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ description: 'x', convo_id: 'c1' });
  });

  it('routes every verb to the documented path and encodes the key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createMemoryClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.list(); await c.get('me_1'); await c.remove('a b');
    expect(calls.map((x) => [x.init.method, x.url])).toEqual([
      ['GET', 'https://j/memories'], ['GET', 'https://j/memories/me_1'], ['DELETE', 'https://j/memories/a%20b'],
    ]);
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers['Content-Type']).toBeUndefined();
  });

  it('a transport failure is status 0 / journal unreachable; never throws', async () => {
    const { fetchImpl } = fakeFetch(() => new Error('ECONNREFUSED'));
    const c = createMemoryClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.list()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });

  it('a non-JSON error body becomes HTTP <status>; a JSON error is passed through', async () => {
    const { fetchImpl } = fakeFetch((url) => (url.endsWith('/x') ? { status: 500 } : { status: 409, body: { error: 'too_many' } }));
    const c = createMemoryClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.get('x')).toEqual({ status: 500, data: { error: 'HTTP 500' } });
    expect(await c.save('y', { description: 'd' })).toEqual({ status: 409, data: { error: 'too_many' } });
  });

  it('no base URL: status 0 without calling fetch', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createMemoryClient({ baseUrl: '', token: 't', fetchImpl });
    expect((await c.list()).status).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
