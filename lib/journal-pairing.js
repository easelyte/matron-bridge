// QR agent pairing against matron-journal's device-authorization flow
// (journal docs/protocol.md "Agent pairing"): the box asks for a pair code
// (POST /pair/start, unauthenticated), a signed-in Matron app approves that
// code and names the agent (POST /pair/approve), and the box polls
// POST /pair/claim with its secret poll_token until the journal hands over
// the agent token — exactly once, straight into the token file. No human
// ever sees the token.
//
// The QR encodes matron://pair?v=1&server=<url-encoded https base>&code=XXXX-XXXX,
// mirroring the journal's matron://link?v=1&server=…&code=… sign-in URI.
//
// Everything here is pure or takes its I/O by injection (fetch, sleep, clock,
// fs) so the whole loop is unit-tested without a journal; setup/pair.mjs and
// setup/wizard.mjs own the terminal side. SECRETS: neither the poll_token nor
// the minted agent token is ever logged, printed, or put into an error
// message — errors carry only the HTTP status and the journal's error code.

import { atomicWriteFileSync } from './atomic-write.js';
import { deriveMediaHttpBaseUrl } from './journal-publisher.js';

// How often to ask /pair/claim. The journal deliberately leaves claim
// un-rate-limited for a box polling "every few seconds".
export const PAIR_POLL_INTERVAL_MS = 2500;
// Back-off when a 429 arrives without a usable Retry-After (the journal's own
// /pair/start 429s carry none).
export const RATE_LIMIT_BACKOFF_MS = 30000;
// Per-request deadline so a stalled connection can't hang the loop forever.
export const PAIR_REQUEST_TIMEOUT_MS = 15000;
// Wait before re-asking /pair/start for a replacement code after a network
// failure (the journal restarting, a Wi-Fi blip).
export const START_RETRY_MS = 5000;

export class PairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingError';
  }
}

// wss://host/ws -> https://host (same derivation the bridge uses for every
// other journal HTTP endpoint, so a reverse-proxied sub-path carries over).
export function pairHttpBase(wsUrl) {
  const base = deriveMediaHttpBaseUrl(wsUrl);
  if (!base) throw new PairingError('JOURNAL_WS_URL is not set');
  return base;
}

export function buildPairUri(httpBase, pairCode) {
  return `matron://pair?v=1&server=${encodeURIComponent(httpBase)}&code=${encodeURIComponent(pairCode)}`;
}

function abortError() {
  const e = new Error('pairing aborted');
  e.name = 'AbortError';
  return e;
}

// Abortable setTimeout: resolves after ms, rejects with AbortError the moment
// the signal fires (so Ctrl-C never waits out a 30 s back-off).
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Seconds from a Retry-After header (delta-seconds form only — the HTTP-date
// form isn't something the journal or a proxy in front of it sends here).
function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  const secs = Number(raw);
  return raw && Number.isFinite(secs) && secs > 0 ? secs * 1000 : RATE_LIMIT_BACKOFF_MS;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

async function postJson(fetchFn, url, body, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    // Only the caller's signal means "cancelled". Our own deadline firing is
    // a network failure and must not look like Ctrl-C to anyone up the stack.
    if (signal?.aborted) throw abortError();
    if (timeout.aborted) throw new Error(`no answer from the journal within ${timeoutMs / 1000} s`, { cause: e });
    throw e;
  }
}

// POST /pair/start. Returns { status: 'started', pairCode, pollToken, expiresInMs }
// or { status: 'rate_limited', retryAfterMs }; throws PairingError otherwise.
export async function startPair({ httpBase, fetch: fetchFn = fetch, signal, timeoutMs = PAIR_REQUEST_TIMEOUT_MS } = {}) {
  const res = await postJson(fetchFn, `${httpBase}/pair/start`, {}, signal, timeoutMs);
  if (res.status === 429) return { status: 'rate_limited', retryAfterMs: retryAfterMs(res) };
  const body = await readJson(res);
  if (res.status !== 200) {
    throw new PairingError(`pair/start failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ''})`);
  }
  const { pair_code: pairCode, poll_token: pollToken, expires_in: expiresIn } = body;
  if (typeof pairCode !== 'string' || !pairCode || typeof pollToken !== 'string' || !pollToken) {
    throw new PairingError('pair/start returned an unexpected response (is this a matron-journal server?)');
  }
  // expires_in is seconds; the journal's TTL is 600 s. Fall back to that if a
  // nonstandard journal omits it rather than polling forever or not at all.
  const secs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600;
  return { status: 'started', pairCode, pollToken, expiresInMs: secs * 1000 };
}

// POST /pair/claim. Returns one of:
//   { status: 'pending' }
//   { status: 'approved', token, deviceId }
//   { status: 'expired' }            — 404: unknown, expired, or already claimed
//   { status: 'rate_limited', retryAfterMs }
// and throws PairingError on anything else.
export async function claimPair({ httpBase, pollToken, fetch: fetchFn = fetch, signal, timeoutMs = PAIR_REQUEST_TIMEOUT_MS } = {}) {
  const res = await postJson(fetchFn, `${httpBase}/pair/claim`, { poll_token: pollToken }, signal, timeoutMs);
  if (res.status === 429) return { status: 'rate_limited', retryAfterMs: retryAfterMs(res) };
  if (res.status === 404) return { status: 'expired' };
  const body = await readJson(res);
  if (res.status !== 200) {
    throw new PairingError(`pair/claim failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ''})`);
  }
  if (body.status === 'pending') return { status: 'pending' };
  if (body.status === 'approved') {
    if (typeof body.token !== 'string' || !body.token) {
      throw new PairingError('pair/claim approved the code but returned no agent token');
    }
    return { status: 'approved', token: body.token, deviceId: body.device_id ?? null };
  }
  throw new PairingError(`pair/claim returned an unexpected status (${JSON.stringify(body.status ?? null)})`);
}

// The whole device-authorization loop. Resolves { token, deviceId } once the
// code is approved and claimed; rejects with AbortError when `signal` fires
// and PairingError on a hard journal refusal.
//
// Callbacks (all optional, all synchronous, none ever receive a secret):
//   onCode({ pairCode, uri, expiresInMs })  — a fresh code to display
//   onExpired()                              — the code died before approval;
//                                              a new one follows immediately
//   onWait({ reason, retryAfterMs })         — rate-limited / transient error
//
// A transient network failure while polling (journal restart, Wi-Fi blip) is
// retried until the code's own expiry; a journal restart forgets pending pairs
// anyway, so the next successful claim 404s and a fresh code is issued. A
// network failure on the replacement /pair/start is retried too (the human may
// be mid-way through the app's flow). Only the FIRST /pair/start fails fast, so
// a wrong URL or a journal that is down is reported instead of waited on.
export async function pairAgent({
  httpBase,
  fetch: fetchFn = fetch,
  sleep = abortableSleep,
  now = Date.now,
  signal,
  pollIntervalMs = PAIR_POLL_INTERVAL_MS,
  requestTimeoutMs = PAIR_REQUEST_TIMEOUT_MS,
  onCode = () => {},
  onExpired = () => {},
  onWait = () => {},
} = {}) {
  let issued = false;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let started;
    try {
      started = await startPair({ httpBase, fetch: fetchFn, signal, timeoutMs: requestTimeoutMs });
    } catch (e) {
      if (signal?.aborted || e instanceof PairingError || !issued) throw e;
      onWait({ reason: 'network', error: e.message, retryAfterMs: START_RETRY_MS });
      await sleep(START_RETRY_MS, signal);
      continue;
    }
    if (started.status === 'rate_limited') {
      onWait({ reason: 'rate_limited', retryAfterMs: started.retryAfterMs });
      await sleep(started.retryAfterMs, signal);
      continue;
    }
    const { pairCode, pollToken, expiresInMs } = started;
    const expiresAt = now() + expiresInMs;
    issued = true;
    onCode({ pairCode, uri: buildPairUri(httpBase, pairCode), expiresInMs });

    for (;;) {
      await sleep(pollIntervalMs, signal);
      if (now() >= expiresAt) break;
      let claim;
      try {
        claim = await claimPair({ httpBase, pollToken, fetch: fetchFn, signal, timeoutMs: requestTimeoutMs });
      } catch (e) {
        if (signal?.aborted || e instanceof PairingError) throw e;
        // Network-level failure: keep trying until the code expires.
        onWait({ reason: 'network', error: e.message, retryAfterMs: pollIntervalMs });
        continue;
      }
      if (claim.status === 'approved') return { token: claim.token, deviceId: claim.deviceId };
      if (claim.status === 'expired') break;
      if (claim.status === 'rate_limited') {
        onWait({ reason: 'rate_limited', retryAfterMs: claim.retryAfterMs });
        await sleep(claim.retryAfterMs, signal);
      }
      // pending: poll again
    }
    onExpired();
  }
}

// Store the agent token: mode 0600 from the instant the file exists (the
// temp sibling is created with that mode, then atomically renamed over the
// target), so a crash mid-write never leaves a truncated or world-readable
// token behind.
export function writeTokenFile(file, token, { fs } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new PairingError('refusing to write an empty agent token');
  atomicWriteFileSync(file, `${token.trim()}\n`, fs ? { fs, mode: 0o600 } : { mode: 0o600 });
}
