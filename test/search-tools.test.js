import { describe, it, expect, vi } from 'vitest';
import { createSearchHandlers } from '../lib/search-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s' };
  const sessions = new Map([['!r:s', session]]);
  const client = {
    searchAll: vi.fn(async () => ({ status: 200, data: { results: [], chats: [], semantic: 'ready' } })),
    ...clientOverrides,
  };
  const h = createSearchHandlers({ sessions, client });
  return { h, client, session };
}

describe('search handlers', () => {
  it('requires a known roomId, same as every other loopback route', async () => {
    const { h } = fixture();
    expect((await h.all({ q: 'x' })).status).toBe(400);
    expect((await h.all({ roomId: '!unknown', q: 'x' })).status).toBe(404);
  });

  it('validates q and passes kinds/limit straight through to the client', async () => {
    const { h, client } = fixture();
    expect((await h.all({ roomId: '!r:s', q: '' })).status).toBe(400);
    expect((await h.all({ roomId: '!r:s', q: 'x'.repeat(257) })).status).toBe(400);
    expect((await h.all({ roomId: '!r:s', q: 'ok', kinds: ['bogus'] })).status).toBe(400);
    expect((await h.all({ roomId: '!r:s', q: 'ok', limit: 0 })).status).toBe(400);
    expect((await h.all({ roomId: '!r:s', q: 'ok', limit: 51 })).status).toBe(400);

    const r = await h.all({ roomId: '!r:s', q: ' refund export ', kinds: ['mission', 'item'], limit: 10 });
    expect(r.status).toBe(200);
    expect(client.searchAll).toHaveBeenCalledWith({ q: 'refund export', kinds: ['mission', 'item'], limit: 10 });
  });

  it('maps a 404 (older journal) and a 400 (bad query) to one-line sentences; never throws', async () => {
    const notReady = fixture({ searchAll: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const notReadyResult = await notReady.h.all({ roomId: '!r:s', q: 'x' });
    expect(notReadyResult.status).toBe(404);
    expect(notReadyResult.body.error).toMatch(/no unified search yet/);

    const badQuery = fixture({ searchAll: vi.fn(async () => ({ status: 400, data: { error: 'bad_request' } })) });
    const badQueryResult = await badQuery.h.all({ roomId: '!r:s', q: 'x' });
    expect(badQueryResult.status).toBe(400);
    expect(badQueryResult.body.error).toMatch(/bad query|rejected the query/);
  });

  it('an unreachable journal (status 0) becomes a 502, not a thrown error', async () => {
    const { h } = fixture({ searchAll: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    const r = await h.all({ roomId: '!r:s', q: 'x' });
    expect(r).toEqual({ status: 502, body: { error: 'journal unreachable' } });
  });

  it('a 200 passes the journal body straight through', async () => {
    const data = { results: [{ kind: 'mission', num: 1 }], chats: [], semantic: 'ready' };
    const { h } = fixture({ searchAll: vi.fn(async () => ({ status: 200, data })) });
    expect(await h.all({ roomId: '!r:s', q: 'x' })).toEqual({ status: 200, body: data });
  });
});
