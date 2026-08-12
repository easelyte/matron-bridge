// In-flight turn markers — the detection half of restart carry-on prompts
// (docs/superpowers/specs/2026-08-11-restart-carry-on-design.md).
//
// A bridge restart SIGTERMs every live session (index.js signal handlers), so
// a turn that was running is destroyed. Nothing was published into the chat,
// so the interruption is silent. This store is what lets the next boot know
// which conversations were mid-turn.
//
// The marker is written at TURN START and removed at turn end — deliberately
// not snapshotted in the SIGTERM handler. A shutdown snapshot is cheaper (one
// write per restart instead of one per turn boundary) but writes nothing on an
// OOM, a crash, or kill -9, which are exactly the cases where the user has no
// other signal. Writing at turn start means nothing has to run at shutdown for
// the record to survive.
//
// Boot discrimination is by `bootId`: a randomUUID generated once per bridge
// process and stamped into every record. At boot, any record carrying a
// DIFFERENT bootId belongs to a run that no longer exists. That is the whole
// mechanism — no transcript scanning, no inference about what a partial
// transcript means.
//
// Pure with every impure edge injected (load/save/now/bootId/log), the same
// shape as createTimerStore in lib/timer-command.js, so it unit-tests without
// a live bridge.

// Age is measured from `touchedAt`, refreshed as the turn makes progress,
// rather than from `startedAt`. The question being asked is "how long has this
// conversation been dangling", not "how long did the turn run" — a legitimate
// three-hour turn still working one minute before the crash must be carded,
// and measuring from turn start would suppress it as ancient.
const DEFAULT_TOUCH_DEBOUNCE_MS = 60_000;

function isUsableRecord(rec) {
  return !!rec && typeof rec === 'object'
    && typeof rec.bootId === 'string'
    && Number.isFinite(rec.touchedAt);
}

export function createInflightMarker({
  load,
  save,
  now,
  bootId,
  touchDebounceMs = DEFAULT_TOUCH_DEBOUNCE_MS,
  log = () => {},
}) {
  let records = (() => {
    try {
      const raw = load();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    } catch (e) {
      log(`inflight marker load failed: ${e.message}`);
    }
    return {};
  })();

  // Returns whether the write reached disk. Turn-boundary callers ignore it —
  // a lost marker means a missed card, never a broken turn, and the caller is
  // on the turn-start path and must not be disturbed by a disk problem.
  // takeStale is the one caller that must know, because it clears state that
  // cannot be reconstructed if the clear never lands.
  function persist() {
    try {
      save(records);
      return true;
    } catch (e) {
      log(`inflight marker save failed: ${e.message}`);
      return false;
    }
  }

  return {
    noteTurnStart(convoId, roomId) {
      if (!convoId) return;
      const at = now();
      records[convoId] = { roomId: roomId ?? null, bootId, startedAt: at, touchedAt: at };
      persist();
    },

    touch(convoId) {
      const rec = records[convoId];
      if (!isUsableRecord(rec)) return;
      const at = now();
      if (at - rec.touchedAt < touchDebounceMs) return;
      rec.touchedAt = at;
      persist();
    },

    noteTurnEnd(convoId) {
      if (!records[convoId]) return;
      delete records[convoId];
      persist();
    },

    // Previous-boot markers within the window, newest information first-hand.
    // ALL previous-boot markers are cleared, including out-of-window ones:
    // this is what makes the feature fire once. Without it the same dangling
    // turn from three restarts ago would resurface on every subsequent boot —
    // the "don't dig up old dead conversations" failure in a different costume.
    takeStale(maxAgeMs) {
      const at = now();
      const stale = [];
      const kept = {};
      for (const [convoId, rec] of Object.entries(records)) {
        if (!isUsableRecord(rec)) continue;           // malformed: drop
        if (rec.bootId === bootId) { kept[convoId] = rec; continue; }  // ours: keep
        const ageMs = at - rec.touchedAt;
        if (ageMs <= maxAgeMs) {
          stale.push({
            convoId,
            roomId: rec.roomId ?? null,
            startedAt: Number.isFinite(rec.startedAt) ? rec.startedAt : rec.touchedAt,
            touchedAt: rec.touchedAt,
            ageMs,
          });
        }
      }
      // Clear-then-return, and the caller publishes cards only AFTER this
      // returns. So the clear+persist lands BEFORE any card exists: if the
      // process dies in that window, or the publisher drops the frame, those
      // interruptions are lost permanently — the marker is gone and no card
      // was ever seen. That is inherent to firing once and is ACCEPTED, not an
      // oversight. The alternative (clear only after a confirmed publish) buys
      // durability at the price of duplicate cards on every crashy boot, which
      // is the failure the fire-once rule exists to prevent. Not a bug — see
      // publishRestartCarryOnCards in index.js.
      //
      // A FAILED clear is the one case that is not accepted. If the write never
      // reaches disk, the markers are still there for the next boot to find, so
      // reporting them now would card the same interruption again on every
      // subsequent boot — unbounded, because a persistent disk fault never
      // resolves itself. Fail closed instead: restore the pre-clear state and
      // report nothing. The interruption is deferred to a boot whose clear
      // lands (or aged out of the window by then), rather than repeated.
      // Restoring matters as much as returning []: leaving `kept` in place
      // would let the next successful persist — from any turn boundary — write
      // the cleared set to disk, erasing interruptions no card was ever
      // published for.
      const beforeClear = records;
      records = kept;
      if (!persist()) {
        records = beforeClear;
        log('inflight marker: stale clear did not reach disk — deferring carry-on cards to a later boot');
        return [];
      }
      return stale;
    },
  };
}
