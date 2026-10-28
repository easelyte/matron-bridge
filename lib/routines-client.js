// HTTP client for the journal's Coordinator routines routes (journal
// docs/protocol.md "Coordinator routines"): GET /routines, POST /routines,
// PATCH and DELETE /routines/:name, and POST /routines/:name/run, on the
// shared requester (lib/journal-http.js). It RETURNS the status: the tool
// layer turns 403 not_coordinator, 404 and 409 into sentences.
import { createJournalRequester, enc } from './journal-http.js';

export function createRoutinesClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    list: () => request('GET', '/routines'),
    update: (name, body) => request('PATCH', `/routines/${enc(name)}`, { body }),
    run: (name, body) => request('POST', `/routines/${enc(name)}/run`, { body }),
    create: (body) => request('POST', '/routines', { body }),
    remove: (name, body) => request('DELETE', `/routines/${enc(name)}`, { body }),
  };
}
