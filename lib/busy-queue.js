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
import { runQueuedCleanup } from './queue-flush.js';
import { queueFlushNotice } from './queue-flush-notice.js';

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

function restoreQueueNotifications(session, flushedNotifications) {
  session.queueNotifications = [
    ...flushedNotifications,
    ...(session.queueNotifications || []),
  ];
}

// flushQueue returns a falsy result for two situations that must NOT be
// handled the same way, and its return value alone does not tell them apart:
//   retained — the session is alive but refused this flush, or Codex is busy
//              ('deferred'). restoreQueuedBatch re-prepends the batch, so its
//              notifications have to come back too or the two arrays
//              desynchronise (PR #104) and later positional reads land on the
//              wrong message.
//   dropped  — the session is dead / auto-stopped. flushQueue DROPS the batch
//              and tells the user it could not be delivered; restoring the
//              notification would leave a tile with no queue entry behind it.
// The observable difference is whether the blocks are sitting back at the front
// of the queue, which is exactly what restoreQueuedBatch does and nothing else
// does. Identity, not equality: these are the very arrays we handed over.
function queueBatchWasRestored(session, blocks) {
  const pending = session.queuedMessages;
  return Array.isArray(pending) && pending[0] === blocks;
}

// Remove one queued message and its notification at a known position, in
// lockstep (PR #104). Unlike cancelQueuedItem this commits no durable release:
// the callers that use it are dispatching the message, and a dispatch's `send`
// release is only true once flushQueue has accepted it.
function detachQueuedAt(session, index) {
  const queue = session.queuedMessages;
  const notifs = session.queueNotifications || [];
  const [blocks] = queue.splice(index, 1);
  const notification = index < notifs.length ? notifs.splice(index, 1)[0] : null;
  if (queue.length === 0) session.queuedMessages = null;
  return { blocks, notification };
}

// Undo a refused / deferred dispatch of ONE detached queue entry, putting both
// halves back exactly where they came from.
//
// flushQueue's restoreQueuedBatch PREPENDS the batch it was handed. For every
// other caller that is not a reorder at all: their batch is always a queue
// PREFIX, so the front IS where it belongs. A single entry lifted from an
// arbitrary index is the exception — prepending moves it, and the move is most
// damaging to the one entry whose position is load-bearing. A jumping /compact
// always sits at index 0 and compactBatchSize isolates it ONLY there
// (lib/compact-priority.js); displace it and the next flush merges the whole
// queue into one message with "/compact" mid-body, so compaction never runs and
// the text around it is read as compaction instructions. This is not a rare
// path: every send_one tap on a busy Codex session comes back 'deferred'.
//
// No-op when flushQueue DROPPED the batch (dead session) — there is nothing to
// put back, and re-inserting the tile would leave it with no queue entry.
function restoreDetachedQueueItem(session, { index, blocks, notification }) {
  if (!queueBatchWasRestored(session, blocks)) return;
  session.queuedMessages.splice(0, 1);
  session.queuedMessages.splice(index, 0, blocks);
  if (!notification) return;
  if (!Array.isArray(session.queueNotifications)) session.queueNotifications = [];
  session.queueNotifications.splice(index, 0, notification);
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
      const notice = queueFlushNotice('sendNow', {
        queued: queued.length,
        deferred: deferred.length,
        summary: formatQueueSummary(queued),
      });
      if (sendHtml) {
        await sendHtml(notice.plain, notice.html);
      } else {
        await sendReply(notice.plain);
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
    const [removed] = queue.splice(index, 1);
    runQueuedCleanup(removed); // unlink a saved-media file this cancelled entry wrote to disk
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
  // Can this session dispatch ONE queued message on its own? Codex cannot: a
  // live `codex exec` won't take a forced follow-up, so flushQueue interrupts
  // the turn and returns 'deferred', and the turn-end flush that follows sends
  // the WHOLE queue — the button would silently mean "send all". Better not to
  // offer it than to offer it and quietly do something else. Injected by the
  // call site, which has session.agent in hand, so this module stays ignorant
  // of which agents exist.
  //
  // Defaults to FALSE — opt in, not opt out. The two failure directions are not
  // symmetric: a call site that forgets the flag under a `true` default offers
  // a button that lies to Codex users (taps it, whole queue goes out) and
  // nothing anywhere says so, whereas under a `false` default it merely
  // withholds the button — a visible, benign regression somebody reports. The
  // source-inspection pin below is a second line of defence, not the first: it
  // has to match the call's SHAPE, so a new call site written with differently
  // named arguments slips past it silently.
  allowSendOne = false,
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
  // The only card where "send everything" and "send this one" are different
  // requests AND the session can actually honour the difference. Until send_one
  // existed a queued card was all-or-nothing: `send` flushed the whole batch
  // and `cancel` was the sole per-item action, so "run this one now and keep
  // the rest waiting" was simply unreachable.
  const multi = !single && jumped === 0 && allowSendOne;
  const sendLabel = single || jumped > 0 ? '⚡ Send now' : '⚡ Send all now';
  const cancelLabel = single || jumped > 0 ? '✕ Cancel' : '✕ Cancel this';
  // Without send_one this is the pre-existing two-action wording, unchanged —
  // a card must never advertise an action it is not offering.
  const multiQuestion = multi
    ? `Send all ${count} queued messages now, send just this one, or cancel it?`
    : `Send all ${count} queued messages now, or cancel this one?`;
  const question = jumped > 0
    ? `Run ${preview} now, or cancel it? The other ${jumped} queued message${jumped > 1 ? 's' : ''} will be sent once compaction finishes.`
    : single
      ? 'Send this queued message now, or cancel it?'
      : multiQuestion;
  const actions = multi
    ? [
        { id: 'send', label: sendLabel, intent: 'primary' },
        { id: 'send_one', label: '⚡ Send just this one', intent: 'neutral' },
        { id: 'cancel', label: cancelLabel, intent: 'neutral' },
      ]
    : [
        { id: 'send', label: sendLabel, intent: 'primary' },
        { id: 'cancel', label: cancelLabel, intent: 'neutral' },
      ];
  const queuedReleasePayload = {
    kind: 'queued_release',
    prompt_id: promptId,
    question,
    items: [{ id: itemId, text: fullText }],
    actions,
    // Mirror of `actions` in the classic {question, options, mode} prompt
    // shape. A client that predates `kind: 'queued_release'` ignores
    // `actions` and falls back to a free-text answer box — whose reply the
    // router then refuses as an invalid queue action, leaving the card
    // functionally dead. The option values are the wire action ids the
    // router accepts (QUEUED_RELEASE_ACTIONS), so an option tap from an
    // older client routes exactly like a structured action tap. Derived from
    // `actions` rather than written out again: the two lists were hand-kept
    // in step, which is exactly how a newly added action ends up tappable on
    // new clients and dead on old ones.
    options: actions.map(({ id, label }) => ({ id, label, value: id })),
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
    // Legacy Matrix-shaped values, addressed positionally. `sendone:<n>` is the
    // send_one action's counterpart and is offered on exactly the same cards
    // the structured action is (see `multi` above).
    const buttons = multi
      ? [
          { id: 'cancel', label: '✕ Cancel', value: `cancel:${queueIndex}` },
          { id: 'send_one', label: '⚡ Send just this', value: `sendone:${queueIndex}` },
          { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' },
        ]
      : [
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
      const [removed] = queue.splice(index, 1);
      runQueuedCleanup(removed); // unlink a saved-media file this cancelled card wrote to disk
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
          // The queued_release reply retires the tapped card — and with it the
          // only preview of what was queued — so the tap echoes the batch at
          // the point of sending (#218), the same contract as the turn-end
          // flush and the magic word. A compact split says the OTHER cards are
          // still pending instead; queueFlushNotice encodes that precedence.
          // Unlike the other two paths this one is plain-only: journal notices
          // have no HTML channel. A legacy caller with no formatQueueSummary
          // seam still flushes, just without the echo.
          if (typeof notify === 'function') {
            if (deferred.length) {
              notify(queueFlushNotice('sendNow', { deferred: deferred.length }).plain);
            } else if (typeof formatQueueSummary === 'function') {
              notify(queueFlushNotice('sendNow', {
                queued: queued.length,
                summary: formatQueueSummary(queued),
              }).plain);
            }
          }
        } else {
          restoreQueueNotifications(session, flushedNotifications);
        }
      } else {
        restoreQueueNotifications(session, flushedNotifications);
      }
      return true;
    }
    // "Send just this one" — cancel's mirror image. `send` flushes the whole
    // pending batch as one merged turn, which left no way to run one queued
    // message and keep the others waiting; this resolves the tapped card to
    // exactly one queue position and dispatches only that.
    if (value === 'send_one') {
      const tappedId = Array.isArray(entry.itemIds) ? entry.itemIds[0] : null;
      const queue = session.queuedMessages;
      const notifs = session.queueNotifications;
      if (!tappedId || !Array.isArray(queue) || !Array.isArray(notifs)) return true;
      const index = notifs.findIndex(notification => notification?.id === tappedId);
      // The tile's message already left the queue (flushed, or cancelled from
      // another client). Same stale-tap silence as every other queue action:
      // handled, but nothing happens.
      if (index < 0 || index >= queue.length) return true;

      // Scoped to the tapped item alone: finalizeSentQueue emits one durable
      // `send` release per snapshot entry and retires that card, so a broader
      // snapshot would retire cards whose messages are still queued.
      //
      // Built from `entry` rather than by filtering deps.queueRelease.listLive,
      // which the `send` path uses. That seam is deliberately scoped to
      // pendingFlushBatch(session) — a prefix of the queue, computed before this
      // tap — so once a /compact jumps to index 0 it lists ONLY the compact, and
      // filtering it for any other card yields nothing: the message would be
      // dispatched with no release emitted, leaving its card live forever.
      // `entry` is the live registry record for the tapped card, whose
      // provenance the router already proved, and finalizeSentQueue re-resolves
      // liveness against the real (unscoped) registry before emitting — so this
      // cannot over-emit for an item that has since been resolved.
      const releaseSnapshot = {
        convoId,
        entries: [{ promptId: entry.prompt_id, itemId: tappedId }],
      };

      const { blocks, notification } = detachQueuedAt(session, index);
      const batch = [blocks];
      // No write-ahead, deliberately — the asymmetry with `cancel` right below
      // is the point. A cancel is destructive, so its release must be durable
      // BEFORE the splice or a crash loses the message silently. A send_one is
      // a dispatch: its release says "this went out", which is only true once
      // the dispatch was accepted, and that is precisely what flushQueue's
      // finalizeSentQueue does with the snapshot above.
      const sent = flushQueue(session, batch, releaseSnapshot);
      if (sent === true) {
        // The surviving notifications are deliberately NOT stripped: the
        // messages behind them are still queued, so their cards remain
        // actionable. The tapped card retires via its `send` release — and with
        // it the only preview of what was queued — so echo what went out, plus
        // what is still waiting, or the rest read as swallowed.
        if (typeof notify === 'function' && typeof formatQueueSummary === 'function') {
          notify(queueFlushNotice('sendNow', {
            queued: 1,
            summary: formatQueueSummary(batch),
            remaining: (session.queuedMessages || []).length,
          }).plain);
        }
      } else {
        restoreDetachedQueueItem(session, { index, blocks, notification });
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
  // Positional counterpart of the structured send_one, for a Matrix-shaped tile
  // still on screen from before the structured card existed.
  const sendOneMatch = typeof value === 'string' ? value.match(/^sendone:(\d+)$/) : null;
  if (sendOneMatch) {
    const index = parseInt(sendOneMatch[1], 10);
    const queue = session.queuedMessages;
    // Stale tile — the queue already flushed or shrank under it. Silent no-op,
    // same as the indexed cancel below.
    if (!Array.isArray(queue) || index < 0 || index >= queue.length) return true;

    // Scope the snapshot to this tile's own item, when it has one. Letting
    // flushQueue take its own snapshot would be wrong here: it reads the FIRST
    // queueNotifications entry, which after the detach is a different message's
    // — so a `send` release would retire a card whose message is still queued.
    // A genuinely pre-registry tile has no id and finalizes nothing.
    // finalizeSentQueue re-resolves the promptId from the live registry, so the
    // item id is the whole of what it needs here.
    const notifs = session.queueNotifications || [];
    const tappedId = index < notifs.length ? notifs[index]?.id ?? null : null;
    const releaseSnapshot = { convoId, entries: tappedId ? [{ itemId: tappedId }] : [] };

    const { blocks, notification } = detachQueuedAt(session, index);
    const sent = flushQueue(session, [blocks], releaseSnapshot);
    if (sent === true) {
      if (editMessage && notification?.eventId) {
        editMessage(session.roomId, notification.eventId, `⚡ ${notification.plain} (sent)`);
      }
    } else {
      restoreDetachedQueueItem(session, { index, blocks, notification });
    }
    return true;
  }
  const cancelMatch = typeof value === 'string' ? value.match(/^cancel:(\d+)$/) : null;
  if (!cancelMatch) return false;
  const index = parseInt(cancelMatch[1], 10);
  const queue = session.queuedMessages;
  if (queue && index >= 0 && index < queue.length) {
    const [removed] = queue.splice(index, 1);
    runQueuedCleanup(removed); // unlink a saved-media file this cancelled entry wrote to disk
    const notifs = session.queueNotifications || [];
    if (index < notifs.length) {
      const { eventId, plain } = notifs.splice(index, 1)[0];
      if (editMessage && eventId) editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
    }
    if (queue.length === 0) session.queuedMessages = null;
  }
  return true;
}
