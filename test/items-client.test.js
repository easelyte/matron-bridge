import { describe, it, expect, vi } from 'vitest';
import { createItemsClient } from '../lib/items-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  });
  return { fetchImpl, calls };
}

describe('createItemsClient', () => {
  it('lists with a filtered query string and bearer auth', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.list({ convo: 'c1', state: 'open', kind: undefined, since: null });
    expect(r).toEqual({ status: 200, data: { items: [], next_cursor: null } });
    expect(calls[0].url).toBe('https://j/items?convo=c1&state=open');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.method).toBe('GET');
  });

  it('get URL-encodes #num', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { item: {}, comments: [] } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.get('#12');
    expect(calls[0].url).toBe('https://j/items/%2312');
  });

  it('create posts JSON with an idempotency key header', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { item: { id: 'it_1', num: 1 } } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.create({ kind: 'task', title: 'T', convo_id: 'c1' }, { idemKey: 'k' });
    expect(r.status).toBe(201);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k');
    expect(JSON.parse(calls[0].init.body)).toEqual({ kind: 'task', title: 'T', convo_id: 'c1' });
  });

  it('setTranscript PATCHes the comment sub-route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { comment: {} } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.setTranscript('it_1', 'ic_2', { blob_ref: 'b', transcript: 'hi' });
    expect(calls[0].url).toBe('https://j/items/it_1/comments/ic_2');
    expect(calls[0].init.method).toBe('PATCH');
  });

  it('update PATCHes the item route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { item: { id: 'it_1', status: 'in_progress' } } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.update('it_1', { status: 'in_progress' });
    expect(r.status).toBe(200);
    expect(calls[0].url).toBe('https://j/items/it_1');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ status: 'in_progress' });
  });

  it('non-2xx passes status and error body through; transport failure is status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict' } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    expect(await c.close('it_1', { resolution: 'done' })).toEqual({ status: 409, data: { error: 'conflict' } });
    const boom = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createItemsClient({ baseUrl: '', token: 'tok', fetchImpl });
    expect(await none.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });

  it('handles non-JSON response bodies gracefully', async () => {
    // A real 204 has no body, so json() rejects — the shared fakeFetch helper
    // can't express that, hence the hand-rolled stubs here.
    const mockFetch204 = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => { throw new Error('No content'); },
    }));
    const c204 = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: mockFetch204 });
    expect(await c204.list({})).toEqual({ status: 204, data: {} });

    const mockFetch502 = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('Not JSON'); },
    }));
    const c502 = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: mockFetch502 });
    expect(await c502.get('it_1')).toEqual({ status: 502, data: { error: 'HTTP 502' } });
  });

  it('aborts and returns status 0 on timeout', async () => {
    let capturedSignal = null;
    const mockFetch = vi.fn(async (url, init) => {
      capturedSignal = init.signal;
      // Return a promise that rejects when the signal aborts
      return new Promise((resolve, reject) => {
        if (capturedSignal.aborted) {
          reject(new Error('AbortError'));
        }
        capturedSignal.addEventListener('abort', () => {
          reject(new Error('AbortError'));
        });
        // Otherwise never resolve
      });
    });
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: mockFetch, timeoutMs: 20 });
    const start = Date.now();
    const result = await c.list({});
    const elapsed = Date.now() - start;
    expect(result).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    expect(elapsed).toBeLessThan(200); // Should resolve quickly (within ~20ms timeout + overhead)
    expect(capturedSignal.aborted).toBe(true); // Signal should have been aborted
  });
});
