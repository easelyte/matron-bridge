import { describe, it, expect, vi } from 'vitest';
import { createMemoryLookup } from '../lib/memory-lookup.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}
function recordingLog() {
  const warns = [];
  return { warns, log: { warn: (m) => warns.push(m), error: () => {} } };
}
const m1 = { id: 'me_1', name: 'a', type: 'feedback', description: 'A' };

describe('createMemoryLookup', () => {
  it('is unknown until the journal answers', () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { memories: [m1] } }));
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(l.snapshot()).toEqual({ known: false, memories: [] });
  });

  it('refresh GETs /memories with the agent bearer and caches the list (a copy per snapshot)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { memories: [m1] } }));
    const l = createMemoryLookup({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await l.refresh({ force: true });
    expect(r).toEqual({ known: true, memories: [m1], fetched: true });
    expect(calls[0].url).toBe('https://j/memories');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    l.snapshot().memories.push('junk');
    expect(l.snapshot().memories).toEqual([m1]);
  });

  it('an unreadable body is a failure, not an empty list', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: {} }));
    const { warns, log } = recordingLog();
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    expect(await l.refresh({ force: true })).toEqual({ known: false, memories: [], fetched: false });
    expect(warns[0]).toMatch(/unreadable response/);
  });

  it('unreachable before it ever answered: stays unknown, warns once, never throws', async () => {
    const { fetchImpl } = fakeFetch(() => new Error('ECONNREFUSED'));
    const { warns, log } = recordingLog();
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: false, memories: [] });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/memories unknown; the Coordinator is told to call memory_list/);
  });

  it('a failure after a good answer keeps the last known list', async () => {
    let fail = false;
    const { fetchImpl } = fakeFetch(() => (fail ? { status: 503, body: {} } : { status: 200, body: { memories: [m1] } }));
    const { warns, log } = recordingLog();
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    fail = true;
    expect(await l.refresh({ force: true })).toEqual({ known: true, memories: [m1], fetched: false });
    expect(warns[0]).toMatch(/HTTP 503.*keeping the last known 1 memories/);
  });

  it('404 (journal predates /memories) is known-none, warned once', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { error: 'not_found' } }));
    const { warns, log } = recordingLog();
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, memories: [] });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/predates GET \/memories/);
  });

  it('throttles unforced refreshes and chains a forced one behind an in-flight request', async () => {
    let t = 0;
    let resolveFirst;
    const { fetchImpl, calls } = fakeFetch(() => new Promise((res) => { resolveFirst = () => res({ status: 200, body: { memories: [m1] } }); }));
    const l = createMemoryLookup({ baseUrl: 'https://j', token: 't', fetchImpl, now: () => t, minRefreshMs: 1000 });
    const p1 = l.refresh();
    const p2 = l.refresh({ force: true });
    expect(calls).toHaveLength(1);
    resolveFirst();
    await p1;
    // The forced refresh issued its own request after the first settled.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    resolveFirst();
    await p2;
    t = 500;
    expect(await l.refresh()).toMatchObject({ fetched: false });
    expect(calls).toHaveLength(2);
    t = 1500;
    const p3 = l.refresh();
    expect(calls).toHaveLength(3);
    resolveFirst();
    await p3;
  });

  it('no journal configured: unknown, no request', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { memories: [] } }));
    const l = createMemoryLookup({ baseUrl: '', token: 't', fetchImpl, log: { warn() {} } });
    await l.refresh({ force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(l.snapshot().known).toBe(false);
  });
});
