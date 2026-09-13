// One-time gating for the boot "Bridge online" announcement.
//
// The bridge used to publish the command-help message to its control convo on
// every boot. That was fine when boots were rare, but idle-stopped dev guests
// now wake several times a day, and each wake bumped "<hostname> bridge" to
// the top of every Matron chat list. The help text is only worth a message
// once per control convo — after that, boots should be silent (the `help`
// command prints the same text on demand).
//
// The marker is keyed by convo id, not just presence: if the control convo id
// changes (JOURNAL_CONTROL_CONVO_ID override, hostname change), the new convo
// has never seen the intro and gets its one message.
//
// fs is injectable in the style of the other lib modules; the default is the
// real node:fs.

import realFs from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';

/**
 * True when the boot announcement should be published: no marker yet, an
 * unreadable/corrupt marker (worst case is one repeat message), or a marker
 * recorded for a different control convo.
 */
export function shouldAnnounceOnline(markerFile, convoId, { fs = realFs } = {}) {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf-8')).convoId !== convoId;
  } catch {
    return true;
  }
}

/**
 * Records that the announcement was published for this convo id. Atomic so a
 * crash mid-write can't leave a corrupt marker (which would only cost one
 * extra announcement, but the helper is free).
 *
 * Fail-open on write errors (ENOSPC/EACCES/EROFS/...), same policy as the
 * sessions and recent-folders stores: the caller runs during top-level module
 * evaluation in index.js, so a rethrow would abort boot before main() ever
 * runs. A lost marker only costs one repeat announcement on the next boot —
 * never a dead bridge.
 */
export function recordOnlineAnnounced(markerFile, convoId, { fs = realFs, log = console } = {}) {
  const marker = { convoId, announcedAt: new Date().toISOString() };
  try {
    atomicWriteFileSync(markerFile, JSON.stringify(marker, null, 2) + '\n', { fs });
  } catch (e) {
    log.warn?.(`[announce-once] marker write failed (will re-announce next boot): ${e?.message || e}`);
  }
}
