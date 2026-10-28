// HTTP client for the journal's contacts and grants routes (journal
// docs/protocol.md "Contacts and grants"; spec: matron-journal
// 2026-10-02 matron-to-matron sharing, phase 1). Same contract as
// lib/journal-http.js: Bearer against the journal HTTP base, bounded
// timeout, RETURNS the status. Never throws; never logs the token.
import { createJournalRequester, enc, qs } from './journal-http.js';

export function createSharingClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    users: () => request('GET', '/contacts/users'),
    contacts: (query) => request('GET', `/contacts${qs(query)}`),
    contactAdd: (body) => request('POST', '/contacts', { body }),
    contactRemove: (id) => request('DELETE', `/contacts/${enc(id)}`),
    contactBlock: (id) => request('POST', `/contacts/${enc(id)}/block`, { body: {} }),
    // body {contact, level:'read'|'contribute'|'owner', brief?, convo_id}.
    share: (mission, body) => request('POST', `/missions/${enc(mission)}/shares`, { body }),
    // Phase 3 hand-over of a whole project: owner level only, brief required.
    shareProject: (project, body) => request('POST', `/projects/${enc(project)}/shares`, { body }),
    shares: (mission) => request('GET', `/missions/${enc(mission)}/shares`),
    grants: (query) => request('GET', `/grants${qs(query)}`),
    revoke: (id) => request('DELETE', `/grants/${enc(id)}`),
    sharedMissions: () => request('GET', '/missions?scope=shared'),
    mission: (id) => request('GET', `/missions/${enc(id)}`),
    lookup: (user, num) => request('GET', `/lookup${qs({ user, num })}`),
    // Phase 3: a contributor's writes on another person's mission (journal
    // docs/protocol.md "Contributors"). The mission is addressed by its ms_
    // id (from lookup), never by number: a number is the caller's own
    // numbering. Items go by id through the ordinary item routes; the
    // journal checks the contribute grant on every one of them. Bodies:
    // milestone {kind, title, body?, convo_id?}; item {kind, title, body?,
    // labels?, links?, convo_id}; comment {body}; close {resolution,
    // comment?}; reopen {comment?}; status {status}.
    contribMilestone: (missionId, body) => request('POST', '/milestones', { body: { ...body, mission: missionId } }),
    contribItem: (missionId, body) => request('POST', '/items', { body: { ...body, mission: missionId } }),
    contribStatus: (missionId, body) => request('PATCH', `/missions/${enc(missionId)}`, { body }),
    itemComment: (id, body) => request('POST', `/items/${enc(id)}/comments`, { body }),
    itemClose: (id, body) => request('POST', `/items/${enc(id)}/close`, { body }),
    itemReopen: (id, body) => request('POST', `/items/${enc(id)}/reopen`, { body }),
    // Phase 2: rooms between people and the sessions offered to contacts.
    personRoom: (roomId) => request('GET', `/person-rooms${qs({ room_id: roomId })}`),
    sessionShares: (query) => request('GET', `/session-shares${qs(query)}`),
    sessionShare: (body) => request('POST', '/session-shares', { body }),
    sessionUnshare: (id) => request('DELETE', `/session-shares/${enc(id)}`),
  };
}
