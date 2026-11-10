// Edit holds on queued messages.
//
// A queued message (one the user sent while the agent was mid-turn) can be
// edited from its card before it is delivered. While the user edits it, the
// message is HELD: no flush may deliver it, or the agent would get the old
// text the moment its turn ends, half-way through the edit. Saving the edit
// replaces the text in place and releases the hold; cancelling the edit just
// releases it.
//
// The hold rides on the queued blocks array itself, as a non-enumerable
// property (the same trick lib/queue-flush.js uses for journal origin), so it
// follows the entry wherever the array goes — queuedMessages, a carried queue,
// a restored batch — and never leaks into JSON. A bridge restart drops it,
// which releases the hold: the message keeps its original text and goes out
// as usual.
//
// Order is kept: every flush path sizes its batch with compactBatchSize
// (lib/compact-priority.js), which stops at the first held entry. Messages
// queued ahead of a held one still go out; the held one and everything behind
// it wait until the hold is released.
//
// A hold left open (the app closed mid-edit, the device went offline) must
// not block the queue for good, so each hold expires after holdMs (ten
// minutes by default). On expiry the message stays queued with its original
// text and is delivered at the next idle point like any other.

const HOLD_KEY = '_queueEditHold';

export const DEFAULT_EDIT_HOLD_MS = 10 * 60 * 1000;

export function isEditHeld(blocks) {
  return !!(blocks && blocks[HOLD_KEY]);
}

// Index of the first held entry in a queue, or -1.
export function firstHeldIndex(queue) {
  if (!Array.isArray(queue)) return -1;
  return queue.findIndex(isEditHeld);
}

// Hold one queued entry. Re-holding an entry that is already held renews its
// timer (a second Edit tap, or the same edit reopened on another device).
// `onExpire(blocks)` runs once if the hold is still in place when the timer
// fires; it is never called after releaseEntry.
export function holdEntry(blocks, {
  holdMs = DEFAULT_EDIT_HOLD_MS,
  onExpire = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Array.isArray(blocks)) return false;
  releaseEntry(blocks, { clearTimer });
  const hold = { timer: null };
  hold.timer = setTimer(() => {
    if (blocks[HOLD_KEY] !== hold) return;
    clearHold(blocks);
    if (typeof onExpire === 'function') {
      try { onExpire(blocks); } catch { /* the release itself already happened */ }
    }
  }, holdMs);
  // An expiry timer must never keep the bridge process alive on its own.
  if (hold.timer && typeof hold.timer.unref === 'function') hold.timer.unref();
  try {
    Object.defineProperty(blocks, HOLD_KEY, {
      value: hold, enumerable: false, configurable: true, writable: true,
    });
  } catch {
    if (typeof clearTimer === 'function') clearTimer(hold.timer);
    return false;
  }
  return true;
}

// Release a hold. Returns true when there was one.
export function releaseEntry(blocks, { clearTimer = clearTimeout } = {}) {
  const hold = blocks && blocks[HOLD_KEY];
  if (!hold) return false;
  if (hold.timer != null && typeof clearTimer === 'function') clearTimer(hold.timer);
  clearHold(blocks);
  return true;
}

function clearHold(blocks) {
  try { delete blocks[HOLD_KEY]; } catch { /* frozen — nothing to clear */ }
}
