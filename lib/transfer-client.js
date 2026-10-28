// HTTP client for the journal's /transfers routes (agent-to-agent file
// transfer). Same stance as items-client: Bearer auth against the derived
// HTTP base URL, bounded timeouts, never logs the token. JSON methods never
// throw; they resolve { ok, status, body } and a network failure is
// { ok: false, status: 0 }. Chunk uploads carry up to 32 MiB, so they get a
// much longer timeout than JSON calls.
//
// download() returns the raw fetch Response so the caller can stream it. It
// has no timeout of its own (the caller passes an AbortSignal) and, unlike
// the JSON methods, lets a network failure reject.
//
// complete() makes the journal hash the whole file before it answers, so it
// waits by size: twice the time at 50 MB/s, at least 60 s, at most 15 min.
const COMPLETE_MIN_MS = 60_000;
const COMPLETE_MAX_MS = 15 * 60_000;
const HASH_BYTES_PER_SEC = 50 * 1024 * 1024;
export function completeTimeoutMs(size = 0) {
  const scaled = Number.isFinite(size) && size > 0 ? Math.ceil((size / HASH_BYTES_PER_SEC) * 2 * 1000) : 0;
  return Math.min(COMPLETE_MAX_MS, Math.max(COMPLETE_MIN_MS, scaled));
}

export function createTransferClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  chunkTimeoutMs = 10 * 60_000,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  const enc = (s) => encodeURIComponent(String(s));
  const unreachable = () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } });

  async function request(method, path, { json = null, raw = null, headers = {}, timeout = timeoutMs } = {}) {
    if (!base) return unreachable();
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeout);
    if (typeof timer.unref === 'function') timer.unref();
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let body;
    if (json != null) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (raw != null) { body = raw; }
    try {
      const res = await fetchImpl(`${base}${path}`, { method, headers: h, body, signal: controller.signal });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data || typeof data !== 'object') data = res.ok ? {} : { error: `HTTP ${res.status}` };
      if (!res.ok && typeof data.error !== 'string') data = { ...data, error: `HTTP ${res.status}` };
      return { ok: res.ok, status: res.status, body: data };
    } catch {
      return unreachable();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // body: { room_id, from_convo_id, name, size, sha256, content_type?,
    // reason?, scan, causes? }. causes is the asking turn's, in the shape
    // chat asks carry (lib/turn-cause.js); the journal shows it on the
    // pending row, and leaves it out when absent.
    create: (body) => request('POST', '/transfers', { json: body }),
    putChunk: (id, n, bytes, sha256, { timeoutMs: t = chunkTimeoutMs } = {}) => request(
      'PUT', `/transfers/${enc(id)}/chunks/${enc(n)}`,
      { raw: bytes, headers: { 'Content-Type': 'application/octet-stream', 'x-chunk-sha256': sha256 }, timeout: t },
    ),
    status: (id) => request('GET', `/transfers/${enc(id)}`),
    complete: (id, { size = 0 } = {}) => request('POST', `/transfers/${enc(id)}/complete`, { timeout: completeTimeoutMs(size) }),
    cancel: (id) => request('DELETE', `/transfers/${enc(id)}`),
    // The receiving side could not save it: the journal fails the transfer
    // and tells the sender.
    failed: (id, reason) => request('POST', `/transfers/${enc(id)}/failed`, { json: { reason } }),
    received: (id, sha256) => request('POST', `/transfers/${enc(id)}/received`, { json: { sha256 } }),
    listPending: () => request('GET', '/transfers?for=me'),
    download(id, { start = 0, signal } = {}) {
      const headers = { Authorization: `Bearer ${token}` };
      if (start > 0) headers.Range = `bytes=${start}-`;
      return fetchImpl(`${base}/transfers/${enc(id)}/content`, { method: 'GET', headers, signal });
    },
  };
}
