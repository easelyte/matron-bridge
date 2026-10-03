// Unit tests for lib/journal-pairing.js — the box side of the journal's
// device-authorization pairing (pair/start → app approves → pair/claim).
// fetch, sleep and the clock are injected; the token file is written to a
// real temp dir so the 0600 mode is checked on disk.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pairHttpBase,
  buildPairUri,
  startPair,
  claimPair,
  pairAgent,
  writeTokenFile,
  abortableSleep,
  PairingError,
  RATE_LIMIT_BACKOFF_MS,
  START_RETRY_MS,
} from '../lib/journal-pairing.js';

const BASE = 'https://journal.example.com';
const POLL = 'a'.repeat(64);
const TOKEN = 'agent-token-secret';

function res(status, body, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// A scripted fetch: each call shifts the next response off `script`
// (a response object, or an Error to throw), recording [url, parsed body].
function scriptedFetch(script) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push([url.replace(BASE, ''), JSON.parse(init.body)]);
    const next = script.shift();
    if (!next) throw new Error(`unscripted fetch ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  fn.calls = calls;
  return fn;
}

const started = (code = 'BCDF-GHJK', expires = 600) =>
  res(200, { pair_code: code, poll_token: POLL, expires_in: expires });

// Fake clock advanced by the fake sleep, so expiry is deterministic.
function fakeTime() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: vi.fn(async (ms, signal) => {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      sleeps.push(ms);
      t += ms;
    }),
    sleeps,
  };
}

describe('pairHttpBase / buildPairUri', () => {
  it('derives the https base from the bridge websocket URL', () => {
    expect(pairHttpBase('wss://journal.example.com/ws')).toBe('https://journal.example.com');
    expect(pairHttpBase('wss://journal.example.com:8443/ws')).toBe('https://journal.example.com:8443');
    expect(pairHttpBase('ws://127.0.0.1:9810/ws')).toBe('http://127.0.0.1:9810');
  });

  it('throws when there is no URL', () => {
    expect(() => pairHttpBase('')).toThrow(PairingError);
  });

  it('builds the matron://pair URI with the server URL-encoded', () => {
    expect(buildPairUri('https://journal.example.com:8443', 'BCDF-GHJK'))
      .toBe('matron://pair?v=1&server=https%3A%2F%2Fjournal.example.com%3A8443&code=BCDF-GHJK');
  });
});

describe('startPair', () => {
  it('posts an empty JSON body to /pair/start and maps the response', async () => {
    const fetch = scriptedFetch([started('BCDF-GHJK', 600)]);
    const r = await startPair({ httpBase: BASE, fetch });
    expect(fetch.calls).toEqual([['/pair/start', {}]]);
    expect(r).toEqual({ status: 'started', pairCode: 'BCDF-GHJK', pollToken: POLL, expiresInMs: 600_000 });
  });

  it('reports 429 as rate_limited, honouring Retry-After when present', async () => {
    expect(await startPair({ httpBase: BASE, fetch: scriptedFetch([res(429, { error: 'rate_limited' })]) }))
      .toEqual({ status: 'rate_limited', retryAfterMs: RATE_LIMIT_BACKOFF_MS });
    expect(await startPair({ httpBase: BASE, fetch: scriptedFetch([res(429, {}, { 'retry-after': '7' })]) }))
      .toEqual({ status: 'rate_limited', retryAfterMs: 7000 });
  });

  it('throws on any other non-200, naming the status and error code', async () => {
    await expect(startPair({ httpBase: BASE, fetch: scriptedFetch([res(500, { error: 'internal' })]) }))
      .rejects.toThrow(/HTTP 500, internal/);
  });

  it('throws on a 200 that is not a pair response', async () => {
    await expect(startPair({ httpBase: BASE, fetch: scriptedFetch([res(200, { ok: true })]) }))
      .rejects.toThrow(PairingError);
  });

  it('falls back to a 600 s TTL when expires_in is missing', async () => {
    const r = await startPair({ httpBase: BASE, fetch: scriptedFetch([res(200, { pair_code: 'X', poll_token: POLL })]) });
    expect(r.expiresInMs).toBe(600_000);
  });
});

describe('request timeout', () => {
  // A fetch that never answers but honours its abort signal, like real fetch.
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

  it('surfaces the request deadline as a network error, not as a cancel', async () => {
    const err = await startPair({ httpBase: BASE, fetch: hangingFetch, timeoutMs: 20 }).catch((e) => e);
    expect(err.message).toMatch(/no answer from the journal/);
    expect(err.name).not.toBe('AbortError');
    expect(err).not.toBeInstanceOf(PairingError);
  });

  it('still reports a user cancel as AbortError', async () => {
    const ac = new AbortController();
    const p = startPair({ httpBase: BASE, fetch: hangingFetch, signal: ac.signal, timeoutMs: 60_000 });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('claimPair', () => {
  it('sends the poll_token and maps pending', async () => {
    const fetch = scriptedFetch([res(200, { status: 'pending' })]);
    expect(await claimPair({ httpBase: BASE, pollToken: POLL, fetch })).toEqual({ status: 'pending' });
    expect(fetch.calls).toEqual([['/pair/claim', { poll_token: POLL }]]);
  });

  it('maps approved to the token and device id', async () => {
    const fetch = scriptedFetch([res(200, { status: 'approved', token: TOKEN, device_id: 42 })]);
    expect(await claimPair({ httpBase: BASE, pollToken: POLL, fetch }))
      .toEqual({ status: 'approved', token: TOKEN, deviceId: 42 });
  });

  it('maps 404 to expired', async () => {
    expect(await claimPair({ httpBase: BASE, pollToken: POLL, fetch: scriptedFetch([res(404, { error: 'not_found' })]) }))
      .toEqual({ status: 'expired' });
  });

  it('maps 429 to rate_limited', async () => {
    expect(await claimPair({ httpBase: BASE, pollToken: POLL, fetch: scriptedFetch([res(429, {})]) }))
      .toEqual({ status: 'rate_limited', retryAfterMs: RATE_LIMIT_BACKOFF_MS });
  });

  it('throws when an approval carries no token', async () => {
    await expect(claimPair({ httpBase: BASE, pollToken: POLL, fetch: scriptedFetch([res(200, { status: 'approved' })]) }))
      .rejects.toThrow(/no agent token/);
  });

  it('never puts the poll_token into an error message', async () => {
    const err = await claimPair({ httpBase: BASE, pollToken: POLL, fetch: scriptedFetch([res(400, { error: 'bad_request' })]) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect(err.message).not.toContain(POLL);
  });
});

describe('pairAgent', () => {
  it('shows the code, polls until approved, and returns the token', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started('BCDF-GHJK'),
      res(200, { status: 'pending' }),
      res(200, { status: 'pending' }),
      res(200, { status: 'approved', token: TOKEN, device_id: 7 }),
    ]);
    const onCode = vi.fn();
    const r = await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, pollIntervalMs: 2500, onCode });
    expect(r).toEqual({ token: TOKEN, deviceId: 7 });
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(onCode).toHaveBeenCalledWith({
      pairCode: 'BCDF-GHJK',
      uri: 'matron://pair?v=1&server=https%3A%2F%2Fjournal.example.com&code=BCDF-GHJK',
      expiresInMs: 600_000,
    });
    expect(time.sleeps).toEqual([2500, 2500, 2500]);
  });

  it('issues a fresh code when the journal reports the old one gone (404)', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started('AAAA-AAAA'),
      res(404, { error: 'not_found' }),
      started('BBBB-BBBB'),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onCode = vi.fn();
    const onExpired = vi.fn();
    const r = await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onCode, onExpired });
    expect(r.token).toBe(TOKEN);
    expect(onCode.mock.calls.map((c) => c[0].pairCode)).toEqual(['AAAA-AAAA', 'BBBB-BBBB']);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('issues a fresh code once the local expiry passes, without claiming the dead one', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started('AAAA-AAAA', 5), // 5 s TTL, 2.5 s polls: one claim, then expiry
      res(200, { status: 'pending' }),
      started('BBBB-BBBB', 600),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onExpired = vi.fn();
    const r = await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onExpired });
    expect(r.token).toBe(TOKEN);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(fetch.calls.map((c) => c[0])).toEqual(['/pair/start', '/pair/claim', '/pair/start', '/pair/claim']);
  });

  it('backs off on a rate-limited start, then retries', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      res(429, { error: 'rate_limited' }),
      started(),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onWait = vi.fn();
    await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onWait });
    expect(onWait).toHaveBeenCalledWith({ reason: 'rate_limited', retryAfterMs: RATE_LIMIT_BACKOFF_MS });
    expect(time.sleeps[0]).toBe(RATE_LIMIT_BACKOFF_MS);
  });

  it('backs off on a rate-limited claim and keeps the same code', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started(),
      res(429, {}, { 'retry-after': '10' }),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onCode = vi.fn();
    await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, pollIntervalMs: 2500, onCode });
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([2500, 10_000, 2500]);
  });

  it('rides out a transient network failure while polling', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started(),
      new TypeError('fetch failed'),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onWait = vi.fn();
    const r = await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onWait });
    expect(r.token).toBe(TOKEN);
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ reason: 'network' }));
  });

  it('fails fast when the very first pair/start cannot reach the journal', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([new TypeError('fetch failed')]);
    await expect(pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now }))
      .rejects.toThrow(/fetch failed/);
  });

  it('retries a replacement pair/start that hits a network failure', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started('AAAA-AAAA'),
      res(404, {}),
      new Error('no answer from the journal within 15 s'),
      started('BBBB-BBBB'),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const onWait = vi.fn();
    const r = await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onWait });
    expect(r.token).toBe(TOKEN);
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ reason: 'network', retryAfterMs: START_RETRY_MS }));
  });

  it('fails hard on an unexpected journal refusal', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([started(), res(500, { error: 'internal' })]);
    await expect(pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now }))
      .rejects.toThrow(PairingError);
  });

  it('aborts when the signal fires (Ctrl-C)', async () => {
    const time = fakeTime();
    const ac = new AbortController();
    const fetch = scriptedFetch([started(), res(200, { status: 'pending' })]);
    const sleep = vi.fn(async (ms, signal) => {
      if (fetch.calls.length === 2) ac.abort(); // after the first pending claim
      return time.sleep(ms, signal);
    });
    const err = await pairAgent({ httpBase: BASE, fetch, sleep, now: time.now, signal: ac.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(fetch.calls).toHaveLength(2);
  });

  it('never hands a secret to any callback', async () => {
    const time = fakeTime();
    const fetch = scriptedFetch([
      started(),
      new TypeError('fetch failed'),
      res(404, {}),
      started(),
      res(200, { status: 'approved', token: TOKEN, device_id: 1 }),
    ]);
    const seen = [];
    const rec = (...a) => seen.push(JSON.stringify(a));
    await pairAgent({ httpBase: BASE, fetch, sleep: time.sleep, now: time.now, onCode: rec, onExpired: rec, onWait: rec });
    const all = seen.join('\n');
    expect(all).not.toContain(POLL);
    expect(all).not.toContain(TOKEN);
  });
});

describe('abortableSleep', () => {
  it('rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(60_000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects promptly when aborted mid-sleep', async () => {
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('writeTokenFile', () => {
  it('writes the trimmed token with a newline, mode 0600, atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-token-'));
    const file = path.join(dir, '.journal-token');
    const oldUmask = process.umask(0o022);
    try {
      writeTokenFile(file, `  ${TOKEN}\n`);
    } finally {
      process.umask(oldUmask);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    // Windows has no POSIX mode bits (stat reports 0o666 regardless).
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.journal-token']); // no temp left behind
    fs.rmSync(dir, { recursive: true });
  });

  it.skipIf(process.platform === 'win32')('tightens an existing looser file to 0600 on overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-token-'));
    const file = path.join(dir, '.journal-token');
    fs.writeFileSync(file, 'old\n', { mode: 0o644 });
    writeTokenFile(file, TOKEN);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });

  it('refuses an empty token', () => {
    expect(() => writeTokenFile('/nonexistent/x', '  ')).toThrow(PairingError);
  });
});
