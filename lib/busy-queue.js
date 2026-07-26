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

import { randomUUID } from 'node:crypto';
import { AGENT_CODEX } from './agent-backend.js';
import { classifyBusyMagicWord } from './command-dispatch.js';

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
  queueRelease = null,
  convoId = null,
  fullText = preview,
} = {}) {
  if (!session.queueNotifications) session.queueNotifications = [];
  const count = (session.queuedMessages || []).length;
  const queueIndex = count - 1;
  const plainNotif = `📨 Queued (${count}): ${preview}`;
  const promptId = `pr_${randomUUID()}`;
  const itemId = `${promptId}::0`;
  const queuedReleasePayload = {
    kind: 'queued_release',
    prompt_id: promptId,
    question: 'Send this now, or cancel and keep editing?',
    items: [{ id: itemId, text: fullText }],
    actions: [
      { id: 'send', label: 'Send now', intent: 'primary' },
      { id: 'cancel', label: 'Cancel', intent: 'neutral' },
    ],
    body: plainNotif,
  };
  let notification = null;
  if (queueRelease && typeof queueRelease.noteQueued === 'function' && convoId) {
    // Reserve the lockstep display slot and live identity synchronously. A
    // concurrent notification can now finish publishing first without
    // changing which queuedMessages index this record describes.
    notification = { eventId: null, plain: plainNotif, id: itemId };
    session.queueNotifications.push(notification);
    queueRelease.noteQueued(convoId, { promptId, itemId });
  }

  function recordEventId(eventId) {
    if (notification) {
      notification.eventId = eventId || null;
    } else if (eventId) {
      // Backward-compatible path for callers that have not supplied the
      // router registry seam.
      session.queueNotifications.push({ eventId, plain: plainNotif });
    }
  }

  if (session.sendButtonMessage) {
    const buttons = [
      { id: 'cancel', label: '✕ Cancel', value: `cancel:${queueIndex}` },
      { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' },
    ];
    const buttonArgs = [
      plainNotif, buttons, 'pick_one', plainNotif, htmlEscape(plainNotif),
    ];
    if (notification) buttonArgs.push(queuedReleasePayload);
    const notifEventId = await session.sendButtonMessage(...buttonArgs);
    recordEventId(notifEventId);
    return;
  }
  if (buildActionLinks && sendHtml) {
    const links = buildActionLinks(queueIndex);
    if (links) {
      const htmlQueue = `${htmlEscape(plainNotif)}<br/>${links}`;
      const notifEventId = await sendHtml(plainNotif, htmlQueue);
      recordEventId(notifEventId);
      return;
    }
  }
  const notifEventId = await sendReply(plainNotif);
  recordEventId(notifEventId);
}

// Queue-tile button actions — the ⚡ Send now (`interrupt`) and ✕ Cancel
// (`cancel:<n>`) values on a "📨 Queued" notification. The values are
// bridge-controlled wire constants, which is what makes shape-matching safe
// (same argument as journal-input-router's option-id classification).
export function isQueueReleaseTap(value) {
  return value === 'interrupt'
    || (typeof value === 'string' && /^cancel:\d+$/.test(value));
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
// The durable queued_release prompt_reply replaces the old post-action text.
export function resolveQueueReleaseTap(value, session, {
  flushQueue,
  stripQueueNotificationLinks = null,
  editMessage = null,
  entry = null,
  convoId = null,
  queueRelease = null,
  emitRelease = null,
} = {}) {
  // Structured journal cards are resolved by stable item id. The router has
  // already proven provenance from target_seq membership and supplied the
  // corresponding live registry entry; never derive identity from a queue
  // position carried by the client.
  if (entry) {
    if (value === 'send') {
      const itemIds = Array.isArray(entry.itemIds) ? entry.itemIds : [];
      const notifs = session.queueNotifications;
      if (itemIds.length === 0
        || !Array.isArray(notifs)
        || !itemIds.every(itemId => notifs.some(notification => notification?.id === itemId))) {
        return true;
      }

      const queued = session.queuedMessages || [];
      session.queuedMessages = null;
      // Codex cannot accept the batch until its interrupted turn exits.
      // Preserve the notification identities during that window so a later
      // cancel can still remove the corresponding live registry entry.
      if (stripQueueNotificationLinks && !(session.agent === AGENT_CODEX && session.busy)) {
        stripQueueNotificationLinks(session);
      }
      if (queued.length > 0) {
        flushQueue(session, queued);
      }
      return true;
    }
    if (value !== 'cancel') return false;

    const itemId = Array.isArray(entry.itemIds) ? entry.itemIds[0] : null;
    const queue = session.queuedMessages;
    const notifs = session.queueNotifications;
    if (!itemId
      || typeof queueRelease?.dropItem !== 'function'
      || typeof emitRelease !== 'function'
      || !Array.isArray(queue)
      || !Array.isArray(notifs)) return true;

    const index = notifs.findIndex(notification => notification?.id === itemId);
    if (index < 0 || index >= queue.length) return true;

    queue.splice(index, 1);
    notifs.splice(index, 1);
    if (queue.length === 0) session.queuedMessages = null;
    queueRelease.dropItem(convoId, itemId);
    emitRelease(convoId, {
      promptId: entry.prompt_id,
      action: 'cancel',
      releasedIds: [itemId],
    });
    return true;
  }

  // Compatibility for legacy Matrix-shaped values. Production journal taps
  // no longer enter this branch; they are classified by target seq above.
  if (value === 'interrupt') {
    const queued = session.queuedMessages || [];
    session.queuedMessages = null;
    if (stripQueueNotificationLinks) stripQueueNotificationLinks(session);
    if (queued.length > 0) {
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
  }
  return true;
}

// Temporary compatibility export for journal-input-router.js. T-2.2 moves
// that separately-scoped consumer to seq-membership routing, after which
// this legacy name can be deleted without crossing this task's file list.
export const isQueueActionValue = isQueueReleaseTap;
