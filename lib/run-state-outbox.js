import { createKeyedRecordStore } from './keyed-record-store.js';

// Durable record of session_state transitions that the journal server has not CONFIRMED.
//
// index.js's journalSessionState marks a transition sent on ENQUEUE, not on acceptance, and the
// publisher queue drops its oldest frame on overflow. Without a record that outlives both the
// session object and the process, an evicted transition is lost: the conversation's durable row
// stays at the pre-transition state forever, and a stranded `running` renders as a permanent
// "Thinking" in every client (the web reconcile trusts that state, so it cannot correct it).
//
// Keyed by CONVO id, not session id: the terminal paths delete the session from the live map
// immediately BEFORE publishing `done`, so a session-keyed record would miss exactly the case
// this exists to repair.
//
// Write volume is low by construction: journalSessionState is change-gated, so this persists only
// on an actual state flip (a couple per turn per session), and each entry is removed as soon as
// the server confirms it. The steady state is an empty file.
// SINGLE-WRITER INVARIANT: exactly one bridge process may own a given file. This is not a
// nicety. A second bridge reading the first's records would not have those conversations in its
// own `sessions` map, so its epoch sweep would classify the first bridge's LIVE convos as
// stranded and publish `done` against them — one bridge silently retiring another's active
// sessions — and two whole-map writers would discard each other's records.
//
// The caller therefore owns the path, and index.js derives it the same way JOURNAL_CURSOR_FILE is
// derived: env override, else a file inside the bridge's OWN directory. That default is
// instance-scoped by construction, so a dev bridge running from a different checkout is isolated
// without anyone having to remember a variable. Two bridges launched from the SAME directory
// would already be sharing the journal cursor, which is an operator error this store cannot and
// should not paper over.
//
// No home-directory fallback is offered on purpose: a shared default is exactly the failure mode
// above, and defaulting to it quietly would make correctness depend on configuration.

export function createRunStateOutbox({ file, log = console } = {}) {
  if (typeof file !== 'string' || !file) {
    // Fail loud rather than reaching for a shared default (project convention: missing config
    // errors, it does not silently fall back).
    throw new Error('createRunStateOutbox requires an explicit, instance-scoped `file` path');
  }
  const store = createKeyedRecordStore({ file, label: 'run-state-outbox', log });

  // In-memory mirror so the hot paths (note/settle/list) do not re-read the file each time. Disk
  // stays authoritative: it is loaded once here, and every mutation is write-through.
  const cache = new Map();
  for (const [convoId, rec] of store.entries()) {
    if (rec && typeof rec.state === 'string') cache.set(convoId, rec.state);
  }

  // Persist a CANDIDATE map and commit the in-memory cache only if the disk write succeeded.
  // Mutating the cache first and persisting after would let an ENOSPC/EIO/unreadable-file failure
  // leave the cache claiming a record that disk never received: the session latch and the cache's
  // own idempotency check would then both suppress the retry, and a restart would find nothing to
  // repair from — the exact permanent-stale outcome this store exists to prevent.
  function commit(candidate) {
    const ok = store.mutate((data) => {
      for (const key of Object.keys(data)) delete data[key];
      for (const [convoId, state] of candidate) data[convoId] = { state, notedAt: Date.now() };
    });
    if (!ok) {
      log.warn?.('[run-state-outbox] durable write failed — run-state repair record NOT persisted; a restart before delivery will leave this conversation stale');
      return false;
    }
    cache.clear();
    for (const [convoId, state] of candidate) cache.set(convoId, state);
    return true;
  }

  return {
    // Record an attempted transition, immediately BEFORE the publish, so an eviction between
    // enqueue and drain still leaves evidence. A newer transition replaces an older pending one:
    // only the latest state is worth re-offering, and re-offering a superseded one would move the
    // row backwards.
    note(convoId, state) {
      if (typeof convoId !== 'string' || !convoId) return false;
      if (typeof state !== 'string' || !state) return false;
      if (cache.get(convoId) === state) return true; // idempotent
      const candidate = new Map(cache);
      candidate.set(convoId, state);
      return commit(candidate);
    },

    // Clear a convo's record once the server CONFIRMS that frame. Guarded on the state matching:
    // if a newer transition superseded this one while the old frame was in flight, the old
    // frame's confirmation must not erase the newer record and re-strand the row.
    settle(convoId, state) {
      if (typeof convoId !== 'string' || !convoId) return false;
      if (!cache.has(convoId)) return false;
      if (cache.get(convoId) !== state) return false;
      const candidate = new Map(cache);
      candidate.delete(convoId);
      // Report the DISK outcome: a settle that only cleared memory would leave a stale record on
      // disk to be replayed as a spurious repair after the next restart.
      return commit(candidate);
    },

    // Every unconfirmed transition as { convoId, state }. What the reconnect repair and the boot
    // reconcile both read.
    list() {
      return [...cache.entries()].map(([convoId, state]) => ({ convoId, state }));
    },

    size() {
      return cache.size;
    },
  };
}
