// HTTP client for the journal's Coordinator consent routes (journal
// docs/protocol.md "Coordinator → Consent approval"): GET /consent/pending
// and POST /consent/answer. Same contract as lib/missions-client.js —
// Bearer against the journal HTTP base, bounded timeout, RETURNS the status
// (the tool layer turns 403 not_coordinator / consent_disabled and 409
// daily_cap / target_offline into sentences). Never throws; never logs the
// token.
export function createConsentClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
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
    pending: (convoId) => request('GET', `/consent/pending?convo_id=${encodeURIComponent(String(convoId))}`),
    answer: (body) => request('POST', '/consent/answer', body),
  };
}
