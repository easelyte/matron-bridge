// HTTP client for the journal's /projects routes (spec 2026-09-30 projects
// §4.2). The same request function and error contract as the missions
// client: RETURNS {status, data}, status 0 = unreachable, never throws,
// never logs the token. project_status is a PATCH with {status, convo_id},
// so it goes through update().
import { createJournalRequester, enc, qs } from './missions-client.js';

export function createProjectsClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    list: (query) => request('GET', `/projects${qs(query)}`),
    get: (idOrNum) => request('GET', `/projects/${enc(idOrNum)}`),
    create: (body, { idemKey = null } = {}) => request('POST', '/projects', { body, idemKey }),
    update: (idOrNum, body) => request('PATCH', `/projects/${enc(idOrNum)}`, { body }),
    close: (idOrNum, body) => request('POST', `/projects/${enc(idOrNum)}/close`, { body }),
    merge: (idOrNum, body) => request('POST', `/projects/${enc(idOrNum)}/merge`, { body }),
  };
}
