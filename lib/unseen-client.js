// HTTP client for the journal's read-state routes (journal docs/protocol.md
// "Read state"): GET /unseen and POST /unseen/flags. Same contract as
// lib/consent-client.js — Bearer against the journal HTTP base, bounded
// timeout, RETURNS the status (the tool layer turns 403 not_coordinator into
// a sentence). Never throws; never logs the token.
export function createUnseenClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
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

  return {
    // params: {older_than_ms, since_ms, importance, in_convo_id, mission, include_flagged, limit, mine}
    list: (convoId, params = {}) => {
      const q = new URLSearchParams({ convo_id: String(convoId) });
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === false) continue;
        q.set(k, v === true ? '1' : String(v));
      }
      return request('GET', `/unseen?${q}`);
    },
    flag: (convoId, refs) => request('POST', '/unseen/flags', { convo_id: convoId, refs }),
  };
}
