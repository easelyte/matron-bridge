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
import { classifyBusyMagicWord } from './command-dispatch.js';
import { compactBatchSize } from './compact-priority.js';

// Split the pending queue into the batch this flush sends and the entries it
// holds back, with queueNotifications sliced identically so the two arrays
// stay index-aligned. Normally the batch IS the whole queue; a leading
// /compact is pulled out alone (see lib/compact-priority.js), which is the
// only case that produces a non-empty `deferred`.
function splitFlushBatch(session) {
  const queue = session.queuedMessages || [];
  const notifications = session.queueNotifications || [];
  // Empty queue, leftover notifications: those tiles are stale and the
  // caller's success path clears them. Counting them as "flushed" keeps that
  // cleanup working — treating them as deferred would strand them forever.
  if (queue.length === 0) {
    return { queued: [], deferred: [], flushedNotifications: notifications, deferredNotifications: [] };
  }
  const batchSize = compactBatchSize(queue);
  return {
    queued: queue.slice(0, batchSize),
    deferred: queue.slice(batchSize),
    flushedNotifications: notifications.slice(0, batchSize),
    deferredNotifications: notifications.slice(batchSize),
  };
}

// Copy for the case where a /compact went out on its own and the rest of the
// queue is waiting on the compaction turn to end. Nothing else in the system
// tells the user their other messages are still coming.
function deferredNote(prefix, deferredCount) {
  return `${prefix} — the other ${deferredCount} message${deferredCount > 1 ? 's' : ''} will be sent once compaction finishes.`;
}

function restoreQueueNotifications(session, flushedNotifications) {
  session.queueNotifications = [
    ...flushedNotifications,
    ...(session.queueNotifications || []),
  ];
}

function stripFlushedQueueNotifications(session, flushedNotifications, stripLinks) {
  if (!stripLinks) {
    restoreQueueNotifications(session, flushedNotifications);
    return;
  }
  const laterNotifications = session.queueNotifications || [];
  session.queueNotifications = flushedNotifications;
  stripLinks(session);
  session.queueNotifications = [
    ...(session.queueNotifications || []),
    ...laterNotifications,
  ];
}

// The extracted Matrix busy-branch bodies, byte-for-byte where a seam is
// present and skipped where it isn't:
//   'send'  : snapshot + detach the queue first (a concurrently-arriving
//             message must not land in the flushed batch), announce the
//             flush (html sink preferred, plain fallback — the exact Matrix
//             strings), THEN flushQueue(session, queued) — one merged send.
//             Notification links are stripped only after accepted dispatch,
//             so a failed/deferred batch stays actionable. Empty queue:
//             "⚡ No queued messages to send."
//   'cancel': splice the LAST queued message AND its notification — removal is
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
  queueRelease = null,
  convoId = null,
  emitRelease = null,
} = {}) {
  if (action === 'send') {
    // "Send now" still can't merge a /compact with other text — the merge is
    // what corrupts it, whatever triggered the flush — so the batch split
    // applies here exactly as it does at turn end.
    const { queued, deferred, flushedNotifications, deferredNotifications } = splitFlushBatch(session);
    const releaseSnapshot = typeof queueRelease?.listLive === 'function'
      ? {
          convoId,
          entries: queueRelease.listLive(convoId),
        }
      : null;
    session.queuedMessages = deferred.length ? deferred : null;
    session.queueNotifications = deferredNotifications;
    if (queued.length > 0) {
      const summary = formatQueueSummary(queued);
      const plainMsg = deferred.length
        ? deferredNote('⚡ Sending /compact now', deferred.length)
        : `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
      if (sendHtml) {
        const htmlMsg = deferred.length
          ? deferredNote('<b>⚡ Sending /compact now</b>', deferred.length)
          : `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
        await sendHtml(plainMsg, htmlMsg);
      } else {
        await sendReply(plainMsg);
      }
      const sent = releaseSnapshot
        ? flushQueue(session, queued, releaseSnapshot)
        : flushQueue(session, queued);
      if (sent === true) {
        stripFlushedQueueNotifications(
          session,
          flushedNotifications,
          stripQueueNotificationLinks,
        );
      } else {
        restoreQueueNotifications(session, flushedNotifications);
      }
    } else {
      stripFlushedQueueNotifications(
        session,
        flushedNotifications,
        stripQueueNotificationLinks,
      );
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
  const index = queue.length - 1;
  // Peek (don't splice yet) so a durable write-ahead can precede the destructive
  // splice for a tracked queued_release card (spec §3, fail-closed).
  const notification = index < notifs.length ? notifs[index] : null;
  const itemId = notification?.id;
  const liveEntries = itemId && typeof queueRelease?.listLive === 'function'
    ? queueRelease.listLive(convoId)
    : [];
  const releaseEntry = Array.isArray(liveEntries)
    ? liveEntries.find(entry => entry.itemId === itemId)
    : null;

  // Splice both arrays in lockstep (PR #104): queue[index] unconditionally,
  // notifs[index] when present.
  const doSplice = () => {
    queue.splice(index, 1);
    if (index < notifs.length) notifs.splice(index, 1);
  };

  const tracked = releaseEntry
    && typeof queueRelease?.dropItem === 'function'
    && typeof emitRelease === 'function';

  if (tracked) {
    // Write-ahead → splice → publish (durable). A disk-fault fail-closes: the
    // splice never runs, the message stays queued, and we tell the user it did
    // NOT cancel so they can retap.
    const released = emitRelease(convoId, {
      promptId: releaseEntry.promptId,
      action: 'cancel',
      releasedIds: [itemId],
    }, { mutate: doSplice });
    if (released === false) {
      await sendReply("Couldn't cancel the queued message right now — please try again.");
      return;
    }
    queueRelease.dropItem(convoId, itemId);
  } else {
    // Untracked / legacy path — no durable card to reconcile; splice as before.
    doSplice();
  }

  if (notification) {
    const { eventId, plain } = notification;
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
  compactJump = false,
} = {}) {
  if (!session.queueNotifications) session.queueNotifications = [];
  const count = (session.queuedMessages || []).length;
  // A jumping /compact was unshifted onto the queue, so it sits at index 0 and
  // its notification must be unshifted too — the two arrays are read
  // positionally against each other everywhere.
  const queueIndex = compactJump ? 0 : count - 1;
  // How many messages this compact jumped ahead of. Zero when it's the only
  // thing queued, in which case there's nothing to announce and the tile stays
  // exactly as it always was.
  const jumped = compactJump ? count - 1 : 0;
  const plainNotif = jumped > 0
    ? `📨 Queued: ${preview} — jumping ahead of ${jumped} queued message${jumped > 1 ? 's' : ''}; they'll be sent once compaction finishes.`
    : `📨 Queued (${count}): ${preview}`;
  const promptId = `pr_${randomUUID()}`;
  const itemId = `${promptId}::0`;
  // Wording note: the `send` action flushes the ENTIRE queue (flushQueue sends
  // every queued message as one merged turn), while `cancel` drops only THIS
  // item. The card text must not imply "send" is per-item — with three queued
  // messages, tapping "Send all now" on any card sends all three. The labels
  // and question are worded to be honest about that asymmetry — but only when
  // the asymmetry exists: with one queued message "all" is misleading in the
  // other direction, so the single-item card speaks about "this message".
  //
  // A jumping /compact is the third case: it flushes ALONE, so "send all" is
  // wrong even with a full queue behind it. It gets the single-item labels and
  // a question that says where the rest went. Only the label/question STRINGS
  // differ — action ids and values are untouched, so every shipped client
  // renders and routes this card exactly as it does the others.
  const single = count <= 1;
  const sendLabel = single || jumped > 0 ? '⚡ Send now' : '⚡ Send all now';
  const cancelLabel = single || jumped > 0 ? '✕ Cancel' : '✕ Cancel this';
  const question = jumped > 0
    ? `Run ${preview} now, or cancel it? The other ${jumped} queued message${jumped > 1 ? 's' : ''} will be sent once compaction finishes.`
    : single
      ? 'Send this queued message now, or cancel it?'
      : `Send all ${count} queued messages now, or cancel this one?`;
  const queuedReleasePayload = {
    kind: 'queued_release',
    prompt_id: promptId,
    question,
    items: [{ id: itemId, text: fullText }],
    actions: [
      { id: 'send', label: sendLabel, intent: 'primary' },
      { id: 'cancel', label: cancelLabel, intent: 'neutral' },
    ],
    // Mirror of `actions` in the classic {question, options, mode} prompt
    // shape. A client that predates `kind: 'queued_release'` ignores
    // `actions` and falls back to a free-text answer box — whose reply the
    // router then refuses as an invalid queue action, leaving the card
    // functionally dead. The option values are the wire action ids the
    // router accepts (QUEUED_RELEASE_ACTIONS), so an option tap from an
    // older client routes exactly like a structured action tap.
    options: [
      { id: 'send', label: sendLabel, value: 'send' },
      { id: 'cancel', label: cancelLabel, value: 'cancel' },
    ],
    mode: 'pick_one',
    body: plainNotif,
  };
  let notification = null;
  if (queueRelease && typeof queueRelease.noteQueued === 'function' && convoId) {
    // Reserve the lockstep display slot and live identity synchronously. A
    // concurrent notification can now finish publishing first without
    // changing which queuedMessages index this record describes.
    notification = { eventId: null, plain: plainNotif, id: itemId };
    if (compactJump) session.queueNotifications.unshift(notification);
    else session.queueNotifications.push(notification);
    queueRelease.noteQueued(convoId, { promptId, itemId });
  }

  function recordEventId(eventId) {
    if (notification) {
      notification.eventId = eventId || null;
    } else if (eventId) {
      // Backward-compatible path for callers that have not supplied the
      // router registry seam.
      const record = { eventId, plain: plainNotif };
      if (compactJump) session.queueNotifications.unshift(record);
      else session.queueNotifications.push(record);
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

// Remove one queued item by its bridge-owned stable id and commit the
// corresponding durable cancellation in the same synchronous operation.
// Both structured journal taps and positional compatibility endpoints must
// use this primitive once they have resolved the position to an item id, so
// a later queue flush can never finalize the removed item as sent.
export function cancelQueuedItem(session, {
  itemId,
  promptId,
  convoId,
  queueRelease,
  emitRelease,
} = {}) {
  const queue = session?.queuedMessages;
  const notifs = session?.queueNotifications;
  if (!itemId
    || !promptId
    || typeof queueRelease?.dropItem !== 'function'
    || typeof emitRelease !== 'function'
    || !Array.isArray(queue)
    || !Array.isArray(notifs)) return false;

  const index = notifs.findIndex(notification => notification?.id === itemId);
  if (index < 0 || index >= queue.length) return false;

  // Write-ahead precedes the destructive splice (queued-release durability,
  // spec §3): emitRelease persists the durable release record BEFORE running the
  // mutate thunk, and fail-closes (returns false, splice never runs) if the
  // durability write fails — so a disk fault leaves the message queued and the
  // card actionable rather than silently losing it. Both arrays splice inside
  // one thunk so the lockstep invariant (PR #104) holds.
  const released = emitRelease(convoId, {
    promptId,
    action: 'cancel',
    releasedIds: [itemId],
  }, {
    mutate: () => {
      queue.splice(index, 1);
      notifs.splice(index, 1);
      if (queue.length === 0) session.queuedMessages = null;
    },
  });
  if (released === false) return false;
  queueRelease.dropItem(convoId, itemId);
  return true;
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
  notify = null,
  formatQueueSummary = null,
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

      // Same batch split as every other flush path: a leading /compact goes
      // out alone even though the tap asked for the whole queue, because
      // merging it with other text is what corrupts it.
      const { queued, deferred, flushedNotifications, deferredNotifications } = splitFlushBatch(session);
      const releaseSnapshot = typeof queueRelease?.listLive === 'function'
        ? {
            convoId,
            entries: queueRelease.listLive(convoId),
          }
        : null;
      session.queuedMessages = deferred.length ? deferred : null;
      session.queueNotifications = deferredNotifications;
      if (queued.length > 0) {
        const sent = releaseSnapshot
          ? flushQueue(session, queued, releaseSnapshot)
          : flushQueue(session, queued);
        // Codex cannot accept the batch until its interrupted turn exits.
        // Preserve notification identities for a deferred or failed send;
        // the eventual accepted flush clears them after finalization.
        if (sent === true) {
          stripFlushedQueueNotifications(
            session,
            flushedNotifications,
            stripQueueNotificationLinks,
          );
          // The queued_release reply retires the tapped card, but it has no
          // way to say the OTHER cards are still pending on a compaction.
          if (deferred.length && typeof notify === 'function') {
            notify(deferredNote('⚡ Sending /compact now', deferred.length));
          } else if (typeof notify === 'function' && typeof formatQueueSummary === 'function') {
            // Echo the batch content at the point of sending, matching the
            // turn-end flush ("📬 Sending …") and the legacy magic-word
            // path: the release retires the card — and its preview — so
            // without this echo a tapped send delivers silently.
            notify(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${formatQueueSummary(queued).plain}`);
          }
        } else {
          restoreQueueNotifications(session, flushedNotifications);
        }
      } else {
        restoreQueueNotifications(session, flushedNotifications);
      }
      return true;
    }
    if (value !== 'cancel') return false;

    const itemId = Array.isArray(entry.itemIds) ? entry.itemIds[0] : null;
    cancelQueuedItem(session, {
      itemId,
      promptId: entry.prompt_id,
      convoId,
      queueRelease,
      emitRelease,
    });
    return true;
  }

  // Compatibility for legacy Matrix-shaped values. Production journal taps
  // no longer enter this branch; they are classified by target seq above.
  if (value === 'interrupt') {
    const { queued, deferred, flushedNotifications, deferredNotifications } = splitFlushBatch(session);
    session.queuedMessages = deferred.length ? deferred : null;
    session.queueNotifications = deferredNotifications;
    if (queued.length > 0) {
      const sent = flushQueue(session, queued);
      if (sent === true) {
        stripFlushedQueueNotifications(
          session,
          flushedNotifications,
          stripQueueNotificationLinks,
        );
      } else {
        restoreQueueNotifications(session, flushedNotifications);
      }
    } else {
      stripFlushedQueueNotifications(
        session,
        flushedNotifications,
        stripQueueNotificationLinks,
      );
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
