// HTTP client for the journal's read-state routes (journal docs/protocol.md
// "Read state"): GET /unseen and POST /unseen/flags, on the shared requester
// (lib/journal-http.js). It RETURNS the status: the tool layer turns 403
// not_coordinator into a sentence.
import { createJournalRequester } from './journal-http.js';

export function createUnseenClient(opts = {}) {
  const request = createJournalRequester(opts);
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
    flag: (convoId, refs) => request('POST', '/unseen/flags', { body: { convo_id: convoId, refs } }),
  };
}
