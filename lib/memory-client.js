// HTTP client for the journal's memories routes (spec: 2026-09-27 memories,
// matron-journal PR #94). Same stance as lib/items-client.js — Bearer auth
// against the derived HTTP base URL, a bounded timeout — and it RETURNS the
// status: the tool layer tells a 404 (no such memory) from a 409 (at the
// cap) from a 400. Never throws; never logs the token.
export function createMemoryClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  async function request(method, path, { body = null } = {}) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
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
  return {
    list: () => request('GET', '/memories'),
    get: (key) => request('GET', `/memories/${enc(key)}`),
    save: (name, body) => request('PUT', `/memories/${enc(name)}`, { body }),
    remove: (key) => request('DELETE', `/memories/${enc(key)}`),
  };
}
