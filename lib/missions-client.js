// HTTP client for the journal's missions & milestones routes (spec
// 2026-09-10, "HTTP API"). Same contract as lib/items-client.js: Bearer
// against the derived HTTP base URL, bounded timeout, RETURNS the status
// (the tool layer tells a 409 no_mission from a 409 closed from a 404).
// Never throws; never logs the token.
//
// createJournalRequester is shared with lib/projects-client.js (spec
// 2026-09-30 projects §5): one request function, one error contract.
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

export function createMissionsClient(opts = {}) {
  const request = createJournalRequester(opts);

  // mission_create goes to the journal's create route, POST /missions
  // (src/missions-http.js handleCreate), with attach:false in the body. The
  // journal also mounts /missions/create as an alias; the canonical route is
  // used so the bridge works against the same path start() already uses.
  const MISSIONS_CREATE_PATH = '/missions';

  return {
    start: (body, { idemKey = null } = {}) => request('POST', '/missions', { body, idemKey }),
    create: (body, { idemKey = null } = {}) => request('POST', MISSIONS_CREATE_PATH, { body, idemKey }),
    list: (query) => request('GET', `/missions${qs(query)}`),
    // { history: true } appends ?history=1 (spec 2026-09-30 §5, ruling R6):
    // the journal's conversation rows include ended links only then, which is
    // what "· left <time>" rendering needs.
    get: (idOrNum, { history = false } = {}) => request('GET', `/missions/${enc(idOrNum)}${history ? '?history=1' : ''}`),
    update: (id, body) => request('PATCH', `/missions/${enc(id)}`, { body }),
    join: (id, body) => request('POST', `/missions/${enc(id)}/join`, { body }),
    // Spec 2026-09-30 §3: end this conversation's link to a mission.
    leave: (id, body) => request('POST', `/missions/${enc(id)}/leave`, { body }),
    close: (id, body) => request('POST', `/missions/${enc(id)}/close`, { body }),
    postMilestone: (body, { idemKey = null } = {}) => request('POST', '/milestones', { body, idemKey }),
    listMilestones: (convoId) => request('GET', `/milestones${qs({ convo: convoId })}`),
    // Spec 2026-09-30 §3: this conversation's mission links, current first.
    // 404 on a journal from before mission links (the tool layer falls back).
    conversationMissions: (convoId) => request('GET', `/conversations/${enc(convoId)}/missions`),
  };
}
