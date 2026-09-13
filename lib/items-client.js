// HTTP client for the journal's task & decision tracker routes (spec:
// 2026-09-08 task-decision-tracker, "HTTP API"). Same stance as
// journal-publisher's fetchJson — Bearer auth against the derived HTTP base
// URL, a bounded timeout — but it RETURNS the status: the tool layer needs
// to tell a 404 (no such item) from a 409 (already closed) from a 400.
// Never throws; never logs the token.
export function createItemsClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  async function request(method, path, { body = null, idemKey = null } = {}) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data || typeof data !== 'object') data = res.ok ? {} : { error: `HTTP ${res.status}` };
      if (!res.ok && typeof data.error !== 'string') data = { ...data, error: `HTTP ${res.status}` };
      return { status: res.status, data };
    } catch {
      return { status: 0, data: { error: 'journal unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  const enc = (s) => encodeURIComponent(String(s));
  const qs = (query) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    list: (query) => request('GET', `/items${qs(query)}`),
    get: (idOrNum) => request('GET', `/items/${enc(idOrNum)}`),
    create: (body, { idemKey = null } = {}) => request('POST', '/items', { body, idemKey }),
    comment: (id, body, { idemKey = null } = {}) => request('POST', `/items/${enc(id)}/comments`, { body, idemKey }),
    setTranscript: (id, commentId, body) => request('PATCH', `/items/${enc(id)}/comments/${enc(commentId)}`, { body }),
    update: (id, body) => request('PATCH', `/items/${enc(id)}`, { body }),
    close: (id, body) => request('POST', `/items/${enc(id)}/close`, { body }),
    reopen: (id, body) => request('POST', `/items/${enc(id)}/reopen`, { body }),
    rank: (id, body) => request('POST', `/items/${enc(id)}/rank`, { body }),
  };
}
