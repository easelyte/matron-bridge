// HTTP client for the journal's missions & milestones routes (spec
// 2026-09-10, "HTTP API"), on the shared requester (lib/journal-http.js):
// it RETURNS the status, so the tool layer tells a 409 no_mission from a
// 409 closed from a 404.
import { createJournalRequester, enc, qs } from './journal-http.js';

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
    // Spec 2026-10-12 unified search: GET /search/all. `kinds` goes over the
    // wire as the comma-joined string the journal expects; qs() already
    // URL-encodes q (and everything else) via URLSearchParams. 404 (older
    // journal) and 400 (bad query) are the tool layer's to turn into
    // sentences — this stays a plain passthrough like every other route here.
    searchAll: ({ q, kinds, limit } = {}) => request('GET', `/search/all${qs({ q, kinds: Array.isArray(kinds) ? kinds.join(',') : kinds, limit })}`),
  };
}
