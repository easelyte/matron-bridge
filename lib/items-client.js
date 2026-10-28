// HTTP client for the journal's task & decision tracker routes (spec:
// 2026-09-08 task-decision-tracker, "HTTP API"), on the shared requester
// (lib/journal-http.js). It RETURNS the status: the tool layer tells a 404
// (no such item) from a 409 (already closed) from a 400.
import { createJournalRequester, enc, qs } from './journal-http.js';

export function createItemsClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    list: (query) => request('GET', `/items${qs(query)}`),
    get: (idOrNum) => request('GET', `/items/${enc(idOrNum)}`),
    create: (body, { idemKey = null } = {}) => request('POST', '/items', { body, idemKey }),
    comment: (id, body, { idemKey = null } = {}) => request('POST', `/items/${enc(id)}/comments`, { body, idemKey }),
    setTranscript: (id, commentId, body) => request('PATCH', `/items/${enc(id)}/comments/${enc(commentId)}`, { body }),
    update: (id, body) => request('PATCH', `/items/${enc(id)}`, { body }),
    close: (id, body) => request('POST', `/items/${enc(id)}/close`, { body }),
    reopen: (id, body) => request('POST', `/items/${enc(id)}/reopen`, { body }),
    rank: (id, body) => request('POST', `/items/${enc(id)}/rank`, { body }),
    // Item handover: offer (op null), or accept / decline / withdraw.
    handover: (id, op, body) => request('POST', `/items/${enc(id)}/handover${op ? `/${op}` : ''}`, { body }),
  };
}
