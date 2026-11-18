// Fork: reports what became of each resume note to the restart record.
//
// The delivery itself (retry, "Carry on" card, notes kept on disk until dealt
// with) is upstream's lib/restart-note-delivery.js, used unchanged. This wraps
// it only to learn each note's outcome, so the restart request layer can close
// the record it is waiting on (lib/restart-request.js settleNotes: its
// `results` and history line, which the rollback tooling reads):
//
//   resumed  the note was handed to its chat
//   failed   delivery failed to the end; the chat got (or was owed) the card
//   stale    the note was read but not chosen (too old, chat not resumable,
//            another person's turn)
//
// The outcomes are reported once, when intake is complete (the boot code has
// taken every note it will take) and every chosen note has an outcome. A
// shutdown before then reports nothing: the notes not dealt with are still on
// disk, and the restart record stays open for the next boot. Upstream's
// delivery is at-least-once, so the fork's `possibly_delivered` outcome no
// longer exists.
import { createNoteDelivery } from './restart-note-delivery.js';

export const SETTLE_RETRY_MS = 60_000;
export const SETTLE_MAX_TRIES = 5;

// owner() -> the id of the restart record notes taken now belong to, or null.
// onSettled(outcomes, ownerId) -> true when the record was closed with
//   { [convoId]: { outcome, at } }; anything else is tried again.
export function createOutcomeNoteDelivery({
  deliver, recover = () => true, discard = () => {}, owner = () => null, onSettled = () => true,
  createDelivery = createNoteDelivery, schedule = setTimeout, now = Date.now, log = () => {},
  settleRetryMs = SETTLE_RETRY_MS, settleMaxTries = SETTLE_MAX_TRIES, ...rest
}) {
  const outcomes = {};
  const expected = new Set();
  let ownerId = null;
  let ownerRead = false;
  let intake = false;
  let settled = false;
  let tries = 0;
  const readOwner = () => { if (!ownerRead) { ownerRead = true; try { ownerId = owner() ?? null; } catch { ownerId = null; } } };
  const note = (convoId, outcome) => { outcomes[convoId] = { outcome, at: now() }; };

  function attemptSettle() {
    if (settled) return;
    tries += 1;
    let ok = false;
    try { ok = onSettled({ ...outcomes }, ownerId) === true; } catch (e) { log(`[restart-note] settle failed: ${e?.message ?? e}`); }
    if (ok) { settled = true; return; }
    if (tries >= settleMaxTries) { log('[restart-note] the restart record was not closed; giving up'); return; }
    const handle = schedule(attemptSettle, settleRetryMs);
    try { handle?.unref?.(); } catch { /* a timer handle without unref */ }
  }
  function check() {
    if (settled || !intake || tries > 0) return;
    for (const id of expected) if (!outcomes[id]) return;
    attemptSettle();
  }

  const inner = createDelivery({
    ...rest,
    deliver: async (n) => {
      const ok = await deliver(n);
      if (ok === true) { note(n.convoId, 'resumed'); check(); }
      return ok;
    },
    recover: (n) => {
      note(n.convoId, 'failed');
      let r;
      try { r = recover(n); } finally { check(); }
      return r;
    },
    discard, log,
  });

  return {
    // deliveries: what takeNoteDeliveries chose; taken: every note read.
    start(deliveries, taken = []) {
      readOwner();
      const chosen = new Set(deliveries.map(d => d.convoId));
      for (const t of taken) if (!chosen.has(t.convoId)) note(t.convoId, 'stale');
      for (const d of deliveries) expected.add(d.convoId);
      inner.start(deliveries, taken);
    },
    // The boot code has taken every note it is going to take (also when that
    // is none): the record can close as soon as they all have an outcome.
    intakeComplete() { readOwner(); intake = true; check(); },
    stop() { inner.stop(); },
  };
}
