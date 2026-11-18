// Delivery of resume notes after a restart, with retry and a fallback card.
//
// lib/restart-notes.js hands the boot code the notes a session left itself.
// Delivering one is a single attempt: if it fails (the conversation cannot be
// resumed yet, the session refuses the text) the note is gone and nothing
// resumes the chat. This module keeps each note on disk until it has been
// dealt with:
//
//   * a failed delivery is tried again after retryMs, maxAttempts times in
//     all; after the last one the chat gets a "Carry on" card instead (the
//     note replaced the card the chat would otherwise have had);
//   * a note is removed from the notes file as soon as it has been delivered
//     or its card has been published, not when the others have settled; if
//     the card cannot be published the note stays, and the next boot tries
//     again;
//   * once halted() says the bridge is going down (or stop() is called), the
//     pending retries do nothing, and an attempt still in flight that fails is
//     ignored: nothing more is delivered or carded, so a note that was not
//     dealt with is still on disk for the next boot. An attempt in flight that
//     succeeds still removes its note, so the next boot does not deliver it
//     a second time.
//
// Delivery is at-least-once. A crash before a note is delivered leaves it on
// disk, so the next boot delivers it (once). A crash after a successful
// delivery but before that note is removed delivers it a second time: from
// the file alone that cannot be told apart from a failed delivery, and
// nothing on the receiving side deduplicates. Retries live in memory; a
// crash loses the attempt count, not the note.
//
// Everything impure is injected, so the policy tests without timers or a bridge.

export const NOTE_FIRST_DELAY_MS = 15_000;
export const NOTE_RETRY_MS = 60_000;
export const NOTE_MAX_ATTEMPTS = 3;

// deliver(note) -> true (handed to the session) or anything else (failed);
//   a throw or a rejection counts as failed. note = { convoId, text, writtenAt,
//   ageMs, interrupted, attempt }, with ageMs measured at the time of the
//   attempt and attempt counting from 1.
// recover(note) publishes the "Carry on" card for a note that could not be
//   delivered; false or a throw means it was not published and the note is
//   kept.
// discard(entries) removes notes ({ convoId, writtenAt }) from the notes
//   file. A throw is logged; the note is then delivered again at the next boot.
// cancelTimer(handle) cancels what schedule returned.
// halted() -> true once the bridge is shutting down.
export function createNoteDelivery({
  deliver, recover = () => true, discard = () => {},
  schedule = setTimeout, cancelTimer = clearTimeout, halted = () => false, now = Date.now, log = () => {},
  firstDelayMs = NOTE_FIRST_DELAY_MS, retryMs = NOTE_RETRY_MS, maxAttempts = NOTE_MAX_ATTEMPTS,
}) {
  let stopped = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const handle = schedule(() => { timers.delete(handle); if (!stopped && !halted()) fn(); }, ms);
    timers.add(handle);
  };
  const remove = (entries, what) => {
    try { discard(entries); } catch (e) { log(`[restart-note] could not remove ${what}: ${e?.message ?? e}`); }
  };

  return {
    // deliveries: what takeNoteDeliveries chose to deliver. taken: every note
    // that was read from the file; the ones not chosen (too old, not
    // resumable, another person's turn) are removed straight away.
    start(deliveries, taken = []) {
      const startedAt = now();
      const chosen = new Set(deliveries.map(d => `${d.convoId}\u0000${d.writtenAt}`));
      const dropped = taken.filter(t => !chosen.has(`${t.convoId}\u0000${t.writtenAt}`));
      if (dropped.length) remove(dropped, 'the dropped notes');
      const attempt = async (note, n) => {
        let ok;
        try { ok = (await deliver({ ...note, attempt: n, ageMs: (note.ageMs || 0) + (now() - startedAt) })) === true; } catch { ok = false; }
        if (ok) { remove([note], `the delivered note for convo=${note.convoId}`); return; }
        if (stopped || halted()) return;
        if (n < maxAttempts) {
          log(`[restart-note] delivery to convo=${note.convoId} failed (attempt ${n} of ${maxAttempts}); trying again in ${Math.round(retryMs / 1000)}s`);
          later(() => { void attempt(note, n + 1); }, retryMs);
          return;
        }
        log(`[restart-note] delivery to convo=${note.convoId} failed ${maxAttempts} times; publishing the Carry on card`);
        let carded = false;
        try { carded = recover(note) !== false; } catch (e) { log(`[restart-note] recovery card failed for convo=${note.convoId}: ${e?.message ?? e}`); }
        if (carded) remove([note], `the carded note for convo=${note.convoId}`);
        else log(`[restart-note] the card for convo=${note.convoId} was not published; keeping the note for the next boot`);
      };
      for (const note of deliveries) later(() => { void attempt(note, 1); }, firstDelayMs);
    },
    // No more retries, and nothing in flight counts any more.
    stop() {
      stopped = true;
      for (const handle of timers) cancelTimer(handle);
      timers.clear();
    },
  };
}
