// Shared busy-queue magic-word handling (PR #101 follow-up): the Matrix
// room.message busy branch's send/interrupt/!interrupt (flush the queue now)
// and cancel (pop the last queued message) logic, extracted verbatim so the
// journal session-text route (journalRouteTextToSession, index.js) can reuse
// the SAME implementation instead of queueing those words as literal text.
//
// Injection style follows lib/command-dispatch.js: classification is a pure
// shared predicate (classifyBusyMagicWord there), and everything index.js-
// bound rides in as injected seams — formatQueueSummary and flushQueue are
// the shared queue primitives BOTH transports must go through (one merged
// send + origin-aware mirroring, lib/queue-flush.js; never a second flush
// path). The journal caller skips only the sendHtml sink (its feedback is a
// fresh plain text — the journal protocol has no message editing of its
// own) and passes BOTH Matrix notification seams (PR #104 review findings):
// session.roomId is a real Matrix room, and queuedMessages/
// queueNotifications must move in lockstep on every path — a Matron cancel
// pops-and-edits the cancelled "📨 Queued" tile, and a Matron send clears +
// strips the queued tiles, exactly like their Matrix counterparts. A
// dangling notif entry makes later cancels (typed, or the indexed
// cancel:<n> buttons on stale still-linked tiles) edit or splice against
// the WRONG message.

import { classifyBusyMagicWord } from './command-dispatch.js';

// Provenance discriminator stamped on every queue-action option (⚡ Send now /
// ✕ Cancel) the bridge publishes, and matched on the return path to classify a
// reply as a queue control by the frame it targets rather than by the reply's
// value shape (#493). A bridge-controlled wire constant.
export const QUEUE_ACTION_REPLY_KIND = 'queue_action';

// The extracted Matrix busy-branch bodies, byte-for-byte where a seam is
// present and skipped where it isn't:
//   'send'  : detach the queue first (a concurrently-arriving message must
//             not land in the flushed batch), strip Matrix notification
//             links (seam optional, un-awaited like the original), announce
//             the flush (html sink preferred, plain fallback — the exact
//             Matrix strings), THEN flushQueue(session, queued) — one merged
//             send. Empty queue: "⚡ No queued messages to send."
//   'cancel': pop the LAST queued message AND its notification — the pop is
//             unconditional (PR #104 review finding: the two arrays must
//             shrink in lockstep, or a later cancel's "(cancelled)" edit
//             lands on the wrong tile); only the edit itself is seam-gated,
//             and a notification without an eventId is popped but not
//             edited — same guard the Matrix branch had. Reply with the
//             exact remaining-count strings.
export async function handleBusyQueueMagicWord(session, action, {
  sendReply,
  sendHtml = null,
  formatQueueSummary,
  flushQueue,
  stripQueueNotificationLinks = null,
  editMessage = null,
} = {}) {
  if (action === 'send') {
    const queued = session.queuedMessages || [];
    session.queuedMessages = null;
    if (stripQueueNotificationLinks) stripQueueNotificationLinks(session);
    if (queued.length > 0) {
      const summary = formatQueueSummary(queued);
      if (sendHtml) {
        const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
        const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
        await sendHtml(plainMsg, htmlMsg);
      } else {
        await sendReply(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
      }
      flushQueue(session, queued);
    } else {
      await sendReply('⚡ No queued messages to send.');
    }
    return;
  }

  // action === 'cancel'
  const queue = session.queuedMessages || [];
  const notifs = session.queueNotifications || [];
  if (queue.length === 0) {
    await sendReply('No queued messages to cancel.');
    return;
  }
  queue.pop();
  if (notifs.length > 0) {
    const { eventId, plain } = notifs.pop();
    if (editMessage && eventId) {
      await editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
    }
  }
  const remaining = queue.length;
  if (remaining === 0) {
    session.queuedMessages = null;
  }
  await sendReply(remaining === 0
    ? 'Cancelled queued message (queue empty).'
    : `Cancelled queued message (${remaining} remaining).`);
}

// Classify-and-handle gate, dispatchJournalRescueKeystroke-style: returns
// true if `text` was a busy-queue magic word and has been fully handled,
// false otherwise (not busy, or not magic) — in which case NOTHING was
// touched and the caller queues/routes the text as it always did. The
// not-busy check lives HERE (not just at the call sites) so "these words are
// only magic while busy" is a tested property of the shared module rather
// than a convention each transport re-implements.
export async function dispatchBusyQueueMagicWord(text, session, deps) {
  if (!session || !session.busy) return false;
  const action = classifyBusyMagicWord(text);
  if (!action) return false;
  await handleBusyQueueMagicWord(session, action, deps);
  return true;
}

// The "📨 Queued (N): preview" notification for a message just pushed onto
// session.queuedMessages — extracted from the Matrix busy branch so the
// journal session-text route posts the SAME tile. Before this extraction a
// Matron-origin message queued SILENTLY: the journal branch only pushed the
// blocks and returned, so neither transport ever showed a tile and the app
// had nothing to render.
//
// Pushes onto session.queueNotifications only when a message event id came
// back — the same guard the Matrix branch had — so cancel edits keep landing
// on real tiles. session.sendButtonMessage is the preferred sink (posts the
// Matrix button tile AND journal-publishes the prompt, index.js
// sendButtonMessage); `buildActionLinks(queueIndex)` is the Matrix-only
// signed-link fallback (returns the html link fragment or null) — journal
// callers omit it and fall through to plain sendReply.
export async function notifyQueuedMessage(session, preview, {
  sendReply,
  sendHtml = null,
  htmlEscape = (s) => s,
  buildActionLinks = null,
} = {}) {
  if (!session.queueNotifications) session.queueNotifications = [];
  const count = (session.queuedMessages || []).length;
  const queueIndex = count - 1;
  const plainNotif = `📨 Queued (${count}): ${preview}`;
  if (session.sendButtonMessage) {
    // Explicit provenance discriminator (#493): stamp each option with
    // reply_kind:'queue_action' so the return-path router can recognize a
    // reply as a queue control by the FRAME it targets, not by the reply's
    // value shape. Value shape alone mis-routed an ordinary AskUserQuestion
    // whose option value happened to be `interrupt` / `cancel:<n>`. The ids
    // (`cancel`/`interrupt`) already carried the signal implicitly; this makes
    // it an explicit, checkable contract on the published payload.
    const buttons = [
      { id: 'cancel', label: '✕ Cancel', value: `cancel:${queueIndex}`, reply_kind: QUEUE_ACTION_REPLY_KIND },
      { id: 'interrupt', label: '⚡ Send now', value: 'interrupt', reply_kind: QUEUE_ACTION_REPLY_KIND },
    ];
    const notifEventId = await session.sendButtonMessage(
      plainNotif, buttons, 'pick_one', plainNotif, htmlEscape(plainNotif)
    );
    if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
    return;
  }
  if (buildActionLinks && sendHtml) {
    const links = buildActionLinks(queueIndex);
    if (links) {
      const htmlQueue = `${htmlEscape(plainNotif)}<br/>${links}`;
      const notifEventId = await sendHtml(plainNotif, htmlQueue);
      if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
      return;
    }
  }
  await sendReply(plainNotif);
}

// Queue-tile button actions — the ⚡ Send now (`interrupt`) and ✕ Cancel
// (`cancel:<n>`) values on a "📨 Queued" notification. The values are
// bridge-controlled wire constants, which is what makes shape-matching safe
// (same argument as journal-input-router's option-id classification).
export function isQueueActionValue(value) {
  return value === 'interrupt'
    || (typeof value === 'string' && /^cancel:\d+$/.test(value));
}

// A published queue-action FRAME: every option carries the explicit
// reply_kind:'queue_action' provenance stamp notifyQueuedMessage writes
// (#493). This is what the return-path router keys on to recognize a
// queue-control reply by the frame it targets — an ordinary AskUserQuestion,
// even one whose option value happens to be `interrupt`/`cancel:<n>`, never
// carries the stamp, so it is never mistaken for a queue control.
export function isQueueActionFrame(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  return options.length > 0
    && options.every(o => o && o.reply_kind === QUEUE_ACTION_REPLY_KIND);
}

// Extracted verbatim from the Matrix button_response handler (index.js) so a
// Matron tap — which arrives as a journal prompt_reply whose `choice`
// carries the same wire values (the app's .buttonResponse channel sends
// option VALUES, see MatronShared AskUserSheetViewModel.selectedValues) —
// runs the SAME implementation. Returns true if `value` was a queue action
// and has been handled, false otherwise (nothing touched).
//
// Behavior notes preserved from the button handler, which differs from the
// typed magic words ON PURPOSE: an `interrupt` with an empty queue and a
// `cancel:<n>` whose index no longer exists are SILENT no-ops (they're taps
// on a stale tile — the queue already flushed or shrank), and cancel is
// indexed (splices exactly the tapped message) rather than popping the last.
// Feedback sends are fire-and-forget, like the original.
export function handleQueueActionValue(value, session, {
  sendReply = null,
  sendHtml = null,
  formatQueueSummary,
  flushQueue,
  stripQueueNotificationLinks = null,
  editMessage = null,
} = {}) {
  if (value === 'interrupt') {
    const queued = session.queuedMessages || [];
    session.queuedMessages = null;
    if (stripQueueNotificationLinks) stripQueueNotificationLinks(session);
    if (queued.length > 0) {
      const summary = formatQueueSummary(queued);
      if (sendHtml) {
        const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
        const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
        sendHtml(plainMsg, htmlMsg);
      } else if (sendReply) {
        sendReply(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
      }
      flushQueue(session, queued);
    }
    return true;
  }
  const cancelMatch = typeof value === 'string' ? value.match(/^cancel:(\d+)$/) : null;
  if (!cancelMatch) return false;
  const index = parseInt(cancelMatch[1], 10);
  const queue = session.queuedMessages;
  if (queue && index >= 0 && index < queue.length) {
    queue.splice(index, 1);
    const notifs = session.queueNotifications || [];
    if (index < notifs.length) {
      const { eventId, plain } = notifs.splice(index, 1)[0];
      if (editMessage && eventId) editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
    }
    if (queue.length === 0) session.queuedMessages = null;
    if (sendReply) {
      const remaining = queue.length;
      sendReply(remaining === 0
        ? '✕ Cancelled queued message (queue empty)'
        : `✕ Cancelled queued message (${remaining} remaining)`);
    }
  }
  return true;
}
