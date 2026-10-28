// HTTP client for the journal's memories routes (spec: 2026-09-27 memories),
// on the shared requester (lib/journal-http.js). It RETURNS the status: the
// tool layer tells a 404 (no such memory) from a 409 (at the cap) from a 400.
import { createJournalRequester, enc } from './journal-http.js';

export function createMemoryClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    list: () => request('GET', '/memories'),
    get: (key) => request('GET', `/memories/${enc(key)}`),
    save: (name, body) => request('PUT', `/memories/${enc(name)}`, { body }),
    remove: (key) => request('DELETE', `/memories/${enc(key)}`),
  };
}
