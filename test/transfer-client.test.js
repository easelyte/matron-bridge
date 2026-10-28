import { describe, it, expect, vi } from 'vitest';
import { createTransferClient, completeTimeoutMs } from '../lib/transfer-client.js';

function stub(status = 200, json = { ok: 1 }) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));
  return fetchImpl;
}
const mk = (fetchImpl, extra = {}) => createTransferClient({ baseUrl: 'https://journal.example.com/', token: 'tok-secret', fetchImpl, ...extra });

describe('transfer client', () => {
  it('create posts JSON with bearer auth', async () => {
    const f = stub(201, { id: 't1' });
    const causes = [{ kind: 'user_message', ref: 'c:1', at: 1 }];
    const r = await mk(f).create({ room_id: 'r', name: 'a.txt', causes });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://journal.example.com/transfers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ room_id: 'r', name: 'a.txt', causes });
    expect(r).toEqual({ ok: true, status: 201, body: { id: 't1' } });
  });

  it('putChunk sends bytes with chunk sha header', async () => {
    const f = stub();
    const bytes = Buffer.from('hello');
    await mk(f).putChunk('t 1', 3, bytes, 'abc123');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://journal.example.com/transfers/t%201/chunks/3');
    expect(init.method).toBe('PUT');
    expect(init.headers['x-chunk-sha256']).toBe('abc123');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(init.body).toBe(bytes);
  });

  it('chunk timeout is longer than JSON timeout and overridable', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
      const c = mk(fetchImpl, { timeoutMs: 1000, chunkTimeoutMs: 5000 });
      const j = c.status('t1');
      const p = c.putChunk('t1', 0, Buffer.from('x'), 'h');
      await vi.advanceTimersByTimeAsync(1001);
      expect(await j).toEqual({ ok: false, status: 0, body: { error: 'journal unreachable' } });
      let settled = false; p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await p).status).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('simple routes use the right method and path', async () => {
    const f = stub();
    const c = mk(f);
    await c.status('t1');
    await c.complete('t1');
    await c.cancel('t1');
    await c.received('t1', 'dead');
    await c.listPending();
    const calls = f.mock.calls.map(([u, i]) => [i.method, u.replace('https://journal.example.com', '')]);
    expect(calls).toEqual([
      ['GET', '/transfers/t1'],
      ['POST', '/transfers/t1/complete'],
      ['DELETE', '/transfers/t1'],
      ['POST', '/transfers/t1/received'],
      ['GET', '/transfers?for=me'],
    ]);
    expect(JSON.parse(f.mock.calls[3][1].body)).toEqual({ sha256: 'dead' });
  });

  it('complete waits for the journal to hash the file: at least 60 s, scaled by size, at most 15 min', () => {
    const MB = 1024 * 1024;
    expect(completeTimeoutMs()).toBe(60_000);
    expect(completeTimeoutMs(100 * MB)).toBe(60_000);
    // 10 GB at 50 MB/s, doubled.
    expect(completeTimeoutMs(10 * 1024 * MB)).toBe(Math.ceil((10 * 1024 / 50) * 2 * 1000));
    expect(completeTimeoutMs(1024 * 1024 * MB)).toBe(15 * 60_000);
  });

  it('complete uses the size-scaled timeout, not the JSON one', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
      const c = mk(fetchImpl, { timeoutMs: 1000 });
      const size = 10 * 1024 * 1024 * 1024;
      const p = c.complete('t1', { size });
      let settled = false; p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(completeTimeoutMs(size) - 61_000 + 10);
      expect((await p).status).toBe(0);
      // Without a size it still waits the 60 s floor.
      const q = c.complete('t1');
      let qSettled = false; q.then(() => { qSettled = true; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(qSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(30_010);
      expect((await q).status).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('failed posts the reason to /transfers/:id/failed', async () => {
    const f = stub(200, { phase: 'failed' });
    const r = await mk(f).failed('t 1', 'the disk is full');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://journal.example.com/transfers/t%201/failed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'the disk is full' });
    expect(r.ok).toBe(true);
  });

  it('returns HTTP errors without throwing', async () => {
    const r = await mk(stub(409, { error: 'closed' })).complete('t1');
    expect(r).toEqual({ ok: false, status: 409, body: { error: 'closed' } });
  });

  it('non-JSON error body yields an error object', async () => {
    const f = vi.fn(async () => new Response('oops', { status: 502 }));
    const r = await mk(f).status('t1');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('HTTP 502');
  });

  it('network errors and missing baseUrl resolve status 0', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED tok-secret'); });
    const r = await mk(f).status('t1');
    expect(r).toEqual({ ok: false, status: 0, body: { error: 'journal unreachable' } });
    expect(JSON.stringify(r)).not.toContain('tok-secret');
    const g = vi.fn();
    const r2 = await createTransferClient({ baseUrl: null, token: 't', fetchImpl: g }).create({});
    expect(r2.status).toBe(0);
    expect(g).not.toHaveBeenCalled();
  });

  it('download sends Range from start and returns the raw Response', async () => {
    const res = new Response('abc', { status: 206 });
    const f = vi.fn(async () => res);
    const ac = new AbortController();
    const out = await mk(f).download('t1', { start: 100, signal: ac.signal });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://journal.example.com/transfers/t1/content');
    expect(init.method).toBe('GET');
    expect(init.headers.Range).toBe('bytes=100-');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(init.signal).toBe(ac.signal);
    expect(out).toBe(res);
  });

  it('download without start sends no Range', async () => {
    const f = vi.fn(async () => new Response('x'));
    await mk(f).download('t1');
    expect(f.mock.calls[0][1].headers.Range).toBeUndefined();
  });
});
