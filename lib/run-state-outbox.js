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
  // convoId -> { state, rev }. `rev` is a monotonic per-convo revision, and settling matches on
  // it rather than on the state alone. Without it there is an ABA hole: a retirement is selected
  // for an inherited `running` record, the same conversation resumes and re-enters `running`
  // (which note() treats as an idempotent no-op, so the record looks unchanged), and then the
  // retirement's callback deletes the RESUMED session's record. If that session's next frame were
  // evicted, the row would sit at `done` with nothing left to repair it. Same generation guard
  // the subagent path uses for its own same-state ABA.
  const cache = new Map();
  let nextRev = 1;
  for (const [convoId, rec] of store.entries()) {
    if (rec && typeof rec.state === 'string') cache.set(convoId, { state: rec.state, rev: nextRev++ });
  }

  // Persist a CANDIDATE map and commit the in-memory cache only if the disk write succeeded.
  // Mutating the cache first and persisting after would let an ENOSPC/EIO/unreadable-file failure
  // leave the cache claiming a record that disk never received: the session latch and the cache's
  // own idempotency check would then both suppress the retry, and a restart would find nothing to
  // repair from — the exact permanent-stale outcome this store exists to prevent.
  function commit(candidate) {
    const ok = store.mutate((data) => {
      for (const key of Object.keys(data)) delete data[key];
      for (const [convoId, rec] of candidate) data[convoId] = { state: rec.state, notedAt: Date.now() };
    });
    if (!ok) {
      log.warn?.('[run-state-outbox] durable write failed — run-state repair record NOT persisted; a restart before delivery will leave this conversation stale');
      return false;
    }
    cache.clear();
    for (const [convoId, rec] of candidate) cache.set(convoId, rec);
    return true;
  }

  return {
    // Record an attempted transition, immediately BEFORE the publish, so an eviction between
    // enqueue and drain still leaves evidence. A newer transition replaces an older pending one:
    // only the latest state is worth re-offering, and re-offering a superseded one would move the
    // row backwards.
    // Returns a TOKEN to hand back to settle() (revision-bearing), or null when the durable write
    // failed / the input was invalid. Callers treat null as "not protected".
    note(convoId, state) {
      if (typeof convoId !== 'string' || !convoId) return null;
      if (typeof state !== 'string' || !state) return null;
      // NOT short-circuited on an equal state: a repeat of the same state is a NEW incarnation
      // (the convo went running -> done -> running, or resumed after a retirement was selected),
      // and it must get a fresh revision or an in-flight settle for the old one would clear it.
      const candidate = new Map(cache);
      const token = { state, rev: nextRev++ };
      candidate.set(convoId, token);
      if (commit(candidate)) return token;
      // The replacement did not persist. Critically, the PREDECESSOR must not stay eligible for
      // repair: commit() leaves the cache untouched on failure, so a record for an older state
      // would survive and the next sweep would re-offer it — publishing `waiting` and then
      // re-offering the superseded `running` behind it, actively regressing the row into the
      // permanent "Thinking" this store exists to prevent. Re-offering a state we already know is
      // stale is worse than having no record at all, so the entry is dropped.
      cache.delete(convoId);
      return null;
    },

    // Clear a convo's record once the server CONFIRMS that frame. Guarded on the state matching:
    // if a newer transition superseded this one while the old frame was in flight, the old
    // frame's confirmation must not erase the newer record and re-strand the row.
    // `token` is the value returned by the note() this settle corresponds to. Settling matches the
    // exact revision, so a confirmation for a superseded transition cannot clear a newer record.
    settle(convoId, token) {
      if (typeof convoId !== 'string' || !convoId) return false;
      const current = cache.get(convoId);
      if (!current) return false;
      if (!token || current.rev !== token.rev) return false;
      const candidate = new Map(cache);
      candidate.delete(convoId);
      // Report the DISK outcome: a settle that only cleared memory would leave a stale record on
      // disk to be replayed as a spurious repair after the next restart.
      return commit(candidate);
    },

    // Every unconfirmed transition as { convoId, state }. What the reconnect repair and the boot
    // reconcile both read.
    // Every unconfirmed transition as { convoId, state, token }. The token rides along so the
    // epoch sweep can settle the exact revision it acted on.
    list() {
      return [...cache.entries()].map(([convoId, rec]) => ({ convoId, state: rec.state, token: rec }));
    },

    size() {
      return cache.size;
    },
  };
}
