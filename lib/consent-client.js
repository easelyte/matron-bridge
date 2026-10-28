// HTTP client for the journal's Coordinator consent routes (journal
// docs/protocol.md "Coordinator → Consent approval"): GET /consent/pending
// and POST /consent/answer, on the shared requester (lib/journal-http.js).
// It RETURNS the status: the tool layer turns 403 not_coordinator /
// consent_disabled and 409 daily_cap / target_offline into sentences.
import { createJournalRequester, enc } from './journal-http.js';

export function createConsentClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    pending: (convoId) => request('GET', `/consent/pending?convo_id=${enc(convoId)}`),
    answer: (body) => request('POST', '/consent/answer', { body }),
  };
}
