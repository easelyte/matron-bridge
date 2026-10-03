// HTTP client for the journal's Coordinator routines routes (journal
// docs/protocol.md "Coordinator routines"): GET /routines, POST /routines,
// PATCH and DELETE /routines/:name, and POST /routines/:name/run. Same contract as
// lib/consent-client.js — Bearer against the journal HTTP base, bounded
// timeout, RETURNS the status (the tool layer turns 403 not_coordinator,
// 404 and 409 into sentences). Never throws; never logs the token.
export function createRoutinesClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  async function request(method, path, body = null) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetchImpl(`${base}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal });
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

  const key = (name) => encodeURIComponent(String(name));
  return {
    list: () => request('GET', '/routines'),
    update: (name, body) => request('PATCH', `/routines/${key(name)}`, body),
    run: (name, body) => request('POST', `/routines/${key(name)}/run`, body),
    create: (body) => request('POST', '/routines', body),
    remove: (name, body) => request('DELETE', `/routines/${key(name)}`, body),
  };
}
