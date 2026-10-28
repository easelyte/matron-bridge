// HTTP client for the journal's Coordinator briefings route (journal
// docs/protocol.md "Coordinator briefings"): POST /briefings. Uses the
// shared requester (lib/journal-http.js): Bearer against the journal
// HTTP base, bounded timeout, an optional Idempotency-Key, RETURNS the
// status (the tool layer turns 403 not_coordinator, 404 and 400 into
// sentences). Never throws; never logs the token.
import { createJournalRequester } from './journal-http.js';

export function createBriefingsClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    publishBriefing: (body, { idemKey = null } = {}) => request('POST', '/briefings', { body, idemKey }),
  };
}
