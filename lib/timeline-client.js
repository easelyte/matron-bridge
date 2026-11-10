// HTTP client for the journal's Projects timeline routes (journal
// docs/protocol.md "Projects timeline"): the weekly stories the Coordinator
// writes and the raw week it writes them from. Uses the shared requester
// (lib/journal-http.js): Bearer against the journal HTTP base, bounded
// timeout, RETURNS {status, data} (status 0 = unreachable) so the tool layer
// can turn 400/403/404/409 into sentences. Never throws; never logs the token.
import { createJournalRequester, enc, qs } from './journal-http.js';

export function createTimelineClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    // One week with the raw material a story is written from, and what is
    // already stored for it.
    readWeekRaw: (week) => request('GET', `/timeline/weeks/${enc(week)}?raw=1`),
    // Newest first; the first entry is the current week.
    listWeeks: ({ limit } = {}) => request('GET', `/timeline/weeks${qs({ limit })}`),
    // The Went quiet list, sieved the way the raw week read is (raw=1), since
    // the Coordinator may run on a private device.
    wentQuiet: () => request('GET', '/timeline/quiet?raw=1'),
    writeWeek: (week, body) => request('POST', `/timeline/weeks/${enc(week)}`, { body }),
  };
}
