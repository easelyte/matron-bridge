// HTTP client for the journal's contacts and grants routes (journal
// docs/protocol.md "Contacts and grants"; spec: matron-journal
// 2026-10-02 matron-to-matron sharing, phase 1). Same contract as
// lib/missions-client.js: Bearer against the journal HTTP base, bounded
// timeout, RETURNS the status. Never throws; never logs the token.
import { createJournalRequester, enc, qs } from './missions-client.js';

export function createSharingClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    users: () => request('GET', '/contacts/users'),
    contacts: (query) => request('GET', `/contacts${qs(query)}`),
    contactAdd: (body) => request('POST', '/contacts', { body }),
    contactRemove: (id) => request('DELETE', `/contacts/${enc(id)}`),
    contactBlock: (id) => request('POST', `/contacts/${enc(id)}/block`, { body: {} }),
    share: (mission, body) => request('POST', `/missions/${enc(mission)}/shares`, { body }),
    shares: (mission) => request('GET', `/missions/${enc(mission)}/shares`),
    grants: (query) => request('GET', `/grants${qs(query)}`),
    revoke: (id) => request('DELETE', `/grants/${enc(id)}`),
    sharedMissions: () => request('GET', '/missions?scope=shared'),
    mission: (id) => request('GET', `/missions/${enc(id)}`),
    lookup: (user, num) => request('GET', `/lookup${qs({ user, num })}`),
  };
}
