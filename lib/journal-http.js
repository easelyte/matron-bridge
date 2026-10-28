// The one request function behind the journal HTTP clients (items, memory,
// missions, projects, sharing, briefings, consent, routines, unseen): Bearer
// auth against the derived journal HTTP base URL, a bounded timeout, an
// optional Idempotency-Key. It RETURNS {status, data} rather than throwing,
// so each tool layer can tell a 404 from a 409 from a 400 and turn them into
// sentences; status 0 means the journal could not be reached. Never throws;
// never logs the token.
export function createJournalRequester({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  return async function request(method, path, { body = null, idemKey = null } = {}) {
    if (!base) return { status: 0, data: { error: 'journal unreachable' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { Authorization: `Bearer ${token}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (idemKey) headers['Idempotency-Key'] = idemKey;
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
  };
}

export const enc = (s) => encodeURIComponent(String(s));
export const qs = (query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) { if (v === undefined || v === null || v === '') continue; p.set(k, String(v)); }
  const s = p.toString();
  return s ? `?${s}` : '';
};
