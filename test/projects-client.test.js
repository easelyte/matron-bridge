import { describe, it, expect, vi } from 'vitest';
import { createProjectsClient } from '../lib/projects-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

describe('createProjectsClient', () => {
  it('create posts to /projects with bearer, idempotency key and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { project: { id: 'pj_1', num: 70 } } }));
    const c = createProjectsClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.create({ title: 'Promo launch', convo_id: 'c1' }, { idemKey: 'k1' });
    expect(r).toEqual({ status: 201, data: { project: { id: 'pj_1', num: 70 } } });
    expect(calls[0].url).toBe('https://j/projects');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'Promo launch', convo_id: 'c1' });
  });

  it('routes every verb to the documented path', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.list({ state: 'open' }); await c.list({});
    await c.get(70); await c.get('pj_1');
    await c.update(70, { status: 's', convo_id: 'c1' });
    await c.close(70, { summary: 'done', convo_id: 'c1' });
    await c.merge(70, { into: 71, convo_id: 'c1' });
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'GET https://j/projects?state=open', 'GET https://j/projects',
      'GET https://j/projects/70', 'GET https://j/projects/pj_1',
      'PATCH https://j/projects/70', 'POST https://j/projects/70/close', 'POST https://j/projects/70/merge',
    ]);
    expect(JSON.parse(calls[6].init.body)).toEqual({ into: 71, convo_id: 'c1' });
  });

  it('non-2xx passes status and error through; transport failure and no base URL are status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict', blocked_by: 'open_missions' } }));
    const c = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.close(70, {})).toEqual({ status: 409, data: { error: 'conflict', blocked_by: 'open_missions' } });
    const boom = createProjectsClient({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createProjectsClient({ baseUrl: '', token: 't', fetchImpl });
    expect(await none.get(1)).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
