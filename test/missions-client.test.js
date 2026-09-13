import { describe, it, expect, vi } from 'vitest';
import { createMissionsClient } from '../lib/missions-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

describe('createMissionsClient', () => {
  it('start posts to /missions with bearer, idempotency key and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { mission: { id: 'ms_1', num: 61 } } }));
    const c = createMissionsClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.start({ title: 'M', body: 'goal', convo_id: 'c1' }, { idemKey: 'k1' });
    expect(r).toEqual({ status: 201, data: { mission: { id: 'ms_1', num: 61 } } });
    expect(calls[0].url).toBe('https://j/missions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'M', body: 'goal', convo_id: 'c1' });
  });

  it('routes every verb to the documented path', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.get('#61'); await c.update('ms_1', { title: 'x' }); await c.join('ms_1', { convo_id: 'c2' });
    await c.close('ms_1', { summary: 's' }); await c.postMilestone({ convo_id: 'c1', kind: 'progress', title: 't' }, {});
    await c.listMilestones('c1'); await c.list({ state: 'open' });
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'GET https://j/missions/%2361', 'PATCH https://j/missions/ms_1', 'POST https://j/missions/ms_1/join',
      'POST https://j/missions/ms_1/close', 'POST https://j/milestones', 'GET https://j/milestones?convo=c1', 'GET https://j/missions?state=open',
    ]);
  });

  it('non-2xx passes status and error through; transport failure and no base URL are status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict', blocked_by: 'no_mission' } }));
    const c = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.postMilestone({}, {})).toEqual({ status: 409, data: { error: 'conflict', blocked_by: 'no_mission' } });
    const boom = createMissionsClient({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createMissionsClient({ baseUrl: '', token: 't', fetchImpl });
    expect(await none.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
