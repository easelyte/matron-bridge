import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import {
  cancelQueuedItem,
  dispatchBusyQueueMagicWord,
  handleBusyQueueMagicWord,
  notifyQueuedMessage,
  resolveQueueReleaseTap,
} from '../lib/busy-queue.js';

// Busy-queue magic-word parity (PR #101 follow-up). The Matrix busy branch's
// send/interrupt/!interrupt (flush now) and cancel (pop last) handling is
// extracted into lib/busy-queue.js so the journal session-text route can
// reuse the SAME implementation. Matrix behavior is pinned byte-for-byte via
// the full seam set. Per the PR #104 review findings, the journal caller
// passes BOTH Matrix notification seams too (editMessage AND
// stripQueueNotificationLinks — session.roomId is a real Matrix room, and
// queuedMessages/queueNotifications must move in lockstep on every path or
// later indexed cancels edit the WRONG tile); only sendHtml is omitted,
// because journal feedback stays plain text.

// The real formatQueueSummary lives in index.js (it leans on escapeHtml);
// tests inject a recognizable stand-in so assertions can prove it was fed
// the flushed queue.
function fakeSummary(queued) {
  return {
    plain: `  1. [${queued.length} entries]`,
    html: `<ol><li>[${queued.length} entries]</li></ol>`,
  };
}

function makeSession(overrides = {}) {
  return {
    roomId: '!room:server',
    busy: true,
    queuedMessages: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]],
    queueNotifications: [
      { eventId: '$ev1', plain: '📨 Queued (1): first' },
      { eventId: '$ev2', plain: '📨 Queued (2): second' },
    ],
    ...overrides,
  };
}

function matrixDeps(overrides = {}) {
  return {
    sendReply: vi.fn(async () => {}),
    sendHtml: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(fakeSummary),
    flushQueue: vi.fn(() => true),
    stripQueueNotificationLinks: vi.fn(),
    editMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

// Faithful stand-in for index.js's stripQueueNotificationLinks (index.js
// ~3150): clears session.queueNotifications AND edits every tile back to its
// plain text (removing the action links). Bound to a deps object so the
// per-tile edits are observable on the same editMessage mock.
function realisticStrip(deps) {
  return vi.fn(async (session) => {
    const notifs = session.queueNotifications || [];
    if (notifs.length === 0) return;
    session.queueNotifications = [];
    for (const { eventId, plain } of notifs) {
      await deps.editMessage(session.roomId, eventId, plain);
    }
  });
}

function journalDeps(overrides = {}) {
  // What journalRouteTextToSession passes: a plain reply sink, the shared
  // queue primitives, and BOTH Matrix notification seams (PR #104 review
  // findings) — session.roomId is a real Matrix room, so a Matron cancel
  // pops-and-edits the cancelled tile and a Matron send clears + strips the
  // queued tiles, exactly like their Matrix counterparts. Only sendHtml is
  // omitted (journal feedback stays plain text).
  const deps = {
    sendReply: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(fakeSummary),
    flushQueue: vi.fn(() => true),
    editMessage: vi.fn(async () => {}),
  };
  deps.stripQueueNotificationLinks = realisticStrip(deps);
  return { ...deps, ...overrides };
}

describe('dispatchBusyQueueMagicWord — gating', () => {
  it('is a no-op when the session is not busy: the words route to Claude as normal text', async () => {
    for (const word of ['send', 'interrupt', '!interrupt', 'cancel']) {
      const session = makeSession({ busy: false });
      const deps = journalDeps();
      expect(await dispatchBusyQueueMagicWord(word, session, deps)).toBe(false);
      expect(deps.flushQueue).not.toHaveBeenCalled();
      expect(deps.sendReply).not.toHaveBeenCalled();
      expect(session.queuedMessages).toHaveLength(2); // untouched
    }
  });

  it('is a no-op for non-magic text while busy (queues as ordinary text at the call site)', async () => {
    const session = makeSession();
    const deps = journalDeps();
    expect(await dispatchBusyQueueMagicWord('please send the email', session, deps)).toBe(false);
    expect(deps.flushQueue).not.toHaveBeenCalled();
    expect(session.queuedMessages).toHaveLength(2);
  });

  it('handles a magic word while busy and reports it handled', async () => {
    const session = makeSession();
    const deps = journalDeps();
    expect(await dispatchBusyQueueMagicWord('send', session, deps)).toBe(true);
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });
});

describe('handleBusyQueueMagicWord — send/interrupt (Matrix pin, full seams)', () => {
  it('flushes the whole queue through flushQueue in ONE call, after the summary message', async () => {
    const session = makeSession();
    const queuedRef = session.queuedMessages;
    const order = [];
    const deps = matrixDeps({
      sendHtml: vi.fn(async () => order.push('summary')),
      flushQueue: vi.fn(() => {
        order.push('flush');
        return true;
      }),
    });

    await handleBusyQueueMagicWord(session, 'send', deps);

    // The queue is detached before anything else (a concurrent queueing
    // message must not land in the flushed batch), then flushed once.
    expect(session.queuedMessages).toBeNull();
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue).toHaveBeenCalledWith(session, queuedRef);
    expect(order).toEqual(['summary', 'flush']);
    // Matrix strips its queue-notification links.
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
  });

  it('sends the exact Matrix summary text (html sink present)', async () => {
    const session = makeSession();
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendHtml).toHaveBeenCalledWith(
      '⚡ Sending 2 queued messages now:\n  1. [2 entries]',
      '<b>⚡ Sending 2 queued messages now:</b><ol><li>[2 entries]</li></ol>',
    );
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('uses the singular form for one queued message', async () => {
    const session = makeSession({ queuedMessages: [[{ type: 'text', text: 'only' }]] });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendHtml.mock.calls[0][0]).toMatch(/^⚡ Sending 1 queued message now:/);
  });

  it('replies "no queued messages" when the queue is empty, and never flushes', async () => {
    const session = makeSession({ queuedMessages: null });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('⚡ No queued messages to send.');
    expect(deps.flushQueue).not.toHaveBeenCalled();
    // Matrix still strips notification links on the empty-queue path —
    // pinned: the original ran stripQueueNotificationLinks unconditionally.
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledTimes(1);
  });
});

describe('handleBusyQueueMagicWord — send/interrupt (journal seams)', () => {
  it('flushes via the same flushQueue and falls back to the plain-text summary', async () => {
    const session = makeSession();
    const queuedRef = session.queuedMessages;
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue).toHaveBeenCalledWith(session, queuedRef);
    expect(deps.sendReply).toHaveBeenCalledWith('⚡ Sending 2 queued messages now:\n  1. [2 entries]');
    expect(session.queuedMessages).toBeNull();
  });

  it('a caller that omits the strip seam is guarded (no crash), tiles left as-is', async () => {
    const session = makeSession();
    const deps = journalDeps({ stripQueueNotificationLinks: undefined });
    await expect(handleBusyQueueMagicWord(session, 'send', deps)).resolves.toBeUndefined();
    expect(session.queueNotifications).toHaveLength(2);
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('journal send-flush clears queueNotifications and strips each tile to its plain text (PR #104 Bugbot finding)', async () => {
    const session = makeSession();
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'send', deps);
    // strip is fire-and-forget (un-awaited, like the Matrix original) — let
    // its per-tile edits drain before asserting them.
    await new Promise(r => setTimeout(r, 0));

    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
    expect(session.queueNotifications).toEqual([]);
    expect(deps.editMessage).toHaveBeenCalledWith('!room:server', '$ev1', '📨 Queued (1): first');
    expect(deps.editMessage).toHaveBeenCalledWith('!room:server', '$ev2', '📨 Queued (2): second');
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('Bugbot scenario invariant: after a Matron send-flush, a re-queued message is index-aligned with its tile', async () => {
    // The indexed cancel:<idx> button handler lives in index.js's Matrix
    // button_response path and is not importable in this harness (top-level
    // Matrix/express side effects — see showbashoutput.test.js). What
    // protects it is the invariant asserted here: a Matron send-flush leaves
    // BOTH arrays empty, so post-flush queueing rebuilds them in lockstep
    // from index 0 — cancel:0 then splices queue[0] and notifs[0] for the
    // SAME message. Pre-fix, notifs kept the two stale entries, so
    // notifs[0] was tileA while queue[0] was the new message C.
    const session = makeSession();
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(session.queuedMessages).toBeNull();
    expect(session.queueNotifications).toEqual([]);

    // Re-queue exactly like index.js's busy paths do (push to both arrays).
    session.queuedMessages = [[{ type: 'text', text: 'C' }]];
    session.queueNotifications.push({ eventId: '$evC', plain: '📨 Queued (1): C' });
    expect(session.queueNotifications[0].eventId).toBe('$evC');
    expect(session.queuedMessages).toHaveLength(session.queueNotifications.length);
  });

  it('captures live release identities before detaching and passes them to the shared flush finalizer', async () => {
    const session = makeSession();
    const entries = [
      { promptId: 'pr_first', itemId: 'pr_first::0' },
      { promptId: 'pr_second', itemId: 'pr_second::0' },
    ];
    const queueRelease = { listLive: vi.fn(() => entries) };
    const deps = journalDeps({
      queueRelease,
      convoId: 'convo-1',
    });

    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(queueRelease.listLive).toHaveBeenCalledWith('convo-1');
    expect(deps.flushQueue).toHaveBeenCalledWith(session, expect.any(Array), {
      convoId: 'convo-1',
      entries,
    });
  });

  it('keeps notification identities actionable when dispatch is rejected', async () => {
    const session = makeSession();
    const deps = journalDeps({ flushQueue: vi.fn(() => false) });

    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.stripQueueNotificationLinks).not.toHaveBeenCalled();
    expect(session.queueNotifications).toHaveLength(2);
  });

  it('does not clear a notification queued while the detached batch awaits its summary', async () => {
    const session = makeSession();
    const deps = journalDeps({
      sendReply: vi.fn(async () => {
        session.queueNotifications.push({
          eventId: '$ev3',
          plain: '📨 Queued (1): third',
        });
      }),
    });

    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(session.queueNotifications).toEqual([{
      eventId: '$ev3',
      plain: '📨 Queued (1): third',
    }]);
  });
});

// The wiring half of the PR #104 Bugbot findings: index.js can't be imported
// in-process, so pin by source inspection that the journal busy caller hands
// the shared dispatcher BOTH Matrix notification seams (the lib guards make
// omitting them silently "work" — this is what keeps the wiring honest).
describe('index.js journal busy caller — notification seams wiring (source inspection)', () => {
  it('passes editMessage AND stripQueueNotificationLinks to dispatchBusyQueueMagicWord', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('dispatchBusyQueueMagicWord(trimmed, session, {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/\beditMessage\b/);
    expect(args).toMatch(/\bstripQueueNotificationLinks\b/);
  });

  it('passes notify AND formatQueueSummary to resolveQueueReleaseTap (tap sends must echo the batch)', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('resolveQueueReleaseTap(answer.choice, session, {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/\bnotify\b/);
    expect(args).toMatch(/\bformatQueueSummary\b/);
  });
});

describe('handleBusyQueueMagicWord — cancel (Matrix pin, full seams)', () => {
  it('pops the LAST queued message, edits its notification, and reports the remaining count', async () => {
    const session = makeSession();
    const deps = matrixDeps();

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0]).toEqual([{ type: 'text', text: 'first' }]);
    expect(session.queueNotifications).toHaveLength(1);
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (1 remaining).');
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });

  it('cancelling the only queued message nulls the queue and says "queue empty"', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'solo' }]],
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): solo' }],
    });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(session.queuedMessages).toBeNull();
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('replies "no queued messages" when nothing is queued', async () => {
    const session = makeSession({ queuedMessages: [], queueNotifications: [] });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('No queued messages to cancel.');
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('a notification entry without a Matrix event id is popped but not edited (guard, do not crash)', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'x' }]],
      queueNotifications: [{ eventId: null, plain: '📨 Queued (1): x' }],
    });
    const deps = matrixDeps();
    await expect(handleBusyQueueMagicWord(session, 'cancel', deps)).resolves.toBeUndefined();
    expect(deps.editMessage).not.toHaveBeenCalled();
    // The notif is still popped in lockstep with the queue entry.
    expect(session.queueNotifications).toHaveLength(0);
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('pops the notification in lockstep even when NO editMessage seam is passed (arrays never drift)', async () => {
    // PR #104 review finding: skipping the pop when the edit seam was absent
    // left queueNotifications longer than queuedMessages, so a LATER Matrix
    // cancel edited the wrong tile. The pop must be unconditional; only the
    // edit itself is seam-gated.
    const session = makeSession();
    const deps = journalDeps({ editMessage: undefined });
    await expect(handleBusyQueueMagicWord(session, 'cancel', deps)).resolves.toBeUndefined();
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queueNotifications).toHaveLength(1);
    expect(session.queueNotifications[0].eventId).toBe('$ev1');
  });
});

describe('handleBusyQueueMagicWord — cancel (journal seams)', () => {
  it('pops BOTH arrays in lockstep, edits the popped tile "(cancelled)", and publishes the remaining count', async () => {
    const session = makeSession();
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0]).toEqual([{ type: 'text', text: 'first' }]);
    // Cross-transport display parity (PR #104 review finding): the
    // cancelled message's own notification is popped AND edited, exactly
    // like a Matrix-typed cancel — never left dangling to misalign a later
    // Matrix cancel.
    expect(session.queueNotifications).toHaveLength(1);
    expect(session.queueNotifications[0].eventId).toBe('$ev1');
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (1 remaining).');
  });

  it('mixed sequence: a Matron cancel then a Matrix cancel each edit the CORRECT tile', async () => {
    const session = makeSession();
    const journal = journalDeps();
    const matrix = matrixDeps();

    // Matron cancels the last queued message -> $ev2's tile is edited.
    await handleBusyQueueMagicWord(session, 'cancel', journal);
    expect(journal.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );

    // A subsequent Matrix-typed cancel pops the remaining pair and edits
    // $ev1 — NOT a dangling $ev2 (the pre-fix misalignment).
    await handleBusyQueueMagicWord(session, 'cancel', matrix);
    expect(matrix.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev1', '✕ 📨 Queued (1): first (cancelled)',
    );
    expect(session.queuedMessages).toBeNull();
    expect(session.queueNotifications).toHaveLength(0);
    expect(matrix.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('empty queue: fresh "No queued messages to cancel." text, nothing mutated', async () => {
    const session = makeSession({ queuedMessages: null });
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('No queued messages to cancel.');
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(session.queueNotifications).toHaveLength(2);
  });
});

// --- Queued-tile notification + button actions (journal parity) -----------
// A Matron-origin message used to queue SILENTLY (the journal busy branch
// only pushed the blocks), and a Matron tap on the tile's buttons was
// dropped (journalRoutePromptReply only resolves real pending prompts).
// Both halves are extracted here so the transports share one implementation:
// notifyQueuedMessage posts the tile, resolveQueueReleaseTap runs the taps.

describe('notifyQueuedMessage', () => {
  it('button channel: posts the tile with indexed cancel + interrupt values and records the notif', async () => {
    const sendButtonMessage = vi.fn(async () => '$tile2');
    const session = makeSession({
      sendButtonMessage,
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): first' }],
    });
    await notifyQueuedMessage(session, 'second', { sendReply: vi.fn(), htmlEscape: (s) => s });
    expect(sendButtonMessage).toHaveBeenCalledWith(
      '📨 Queued (2): second',
      [
        { id: 'cancel', label: '✕ Cancel', value: 'cancel:1' },
        { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' },
      ],
      'pick_one', '📨 Queued (2): second', '📨 Queued (2): second',
    );
    expect(session.queueNotifications).toEqual([
      { eventId: '$ev1', plain: '📨 Queued (1): first' },
      { eventId: '$tile2', plain: '📨 Queued (2): second' },
    ]);
  });

  it('button send that returns no event id records nothing (no dangling notif entry)', async () => {
    const session = makeSession({
      sendButtonMessage: vi.fn(async () => null),
      queueNotifications: [],
    });
    await notifyQueuedMessage(session, 'second', { sendReply: vi.fn() });
    expect(session.queueNotifications).toEqual([]);
  });

  it('no button channel, no link builder: plain sendReply fallback (journal caller shape)', async () => {
    const sendReply = vi.fn(async () => {});
    const session = makeSession({ queueNotifications: [] });
    await notifyQueuedMessage(session, 'second', { sendReply });
    expect(sendReply).toHaveBeenCalledWith('📨 Queued (2): second');
    expect(session.queueNotifications).toEqual([]);
  });

  it('Matrix signed-link fallback: html tile via sendHtml, notif recorded on event id', async () => {
    const sendHtml = vi.fn(async () => '$linktile');
    const session = makeSession({ queueNotifications: [] });
    await notifyQueuedMessage(session, 'second', {
      sendReply: vi.fn(),
      sendHtml,
      htmlEscape: (s) => s,
      buildActionLinks: (queueIndex) => `<a href="x?i=${queueIndex}">✕ Cancel</a>`,
    });
    expect(sendHtml).toHaveBeenCalledWith(
      '📨 Queued (2): second',
      '📨 Queued (2): second<br/><a href="x?i=1">✕ Cancel</a>',
    );
    expect(session.queueNotifications).toEqual([
      { eventId: '$linktile', plain: '📨 Queued (2): second' },
    ]);
  });

  it('initializes queueNotifications when the session has none yet', async () => {
    const session = makeSession({ queueNotifications: undefined });
    delete session.queueNotifications;
    await notifyQueuedMessage(session, 'second', { sendReply: vi.fn(async () => {}) });
    expect(session.queueNotifications).toEqual([]);
  });

  // Coverage gap (d): the STRUCTURED registry path — a router queueRelease seam
  // plus convoId reserves a stable identity synchronously and publishes the
  // queued_release card payload carrying the full (untruncated) text.
  it('structured path: reserves a stable id via noteQueued and publishes the queued_release payload with fullText', async () => {
    const sendButtonMessage = vi.fn(async () => '$tile');
    const noteQueued = vi.fn();
    const session = makeSession({ sendButtonMessage, queueNotifications: [] });
    await notifyQueuedMessage(session, 'trunc…', {
      sendReply: vi.fn(),
      htmlEscape: (s) => s,
      queueRelease: { noteQueued },
      convoId: 'convo-1',
      fullText: 'the full untruncated queued message body',
    });

    // Reservation happened synchronously with a matching prompt/item id.
    expect(noteQueued).toHaveBeenCalledTimes(1);
    const { promptId, itemId } = noteQueued.mock.calls[0][1];
    expect(noteQueued.mock.calls[0][0]).toBe('convo-1');
    expect(itemId).toBe(`${promptId}::0`);

    // A display slot with the stable id is reserved on the session up front.
    expect(session.queueNotifications).toEqual([
      { eventId: '$tile', plain: '📨 Queued (2): trunc…', id: itemId },
    ]);

    // The queued_release payload is the LAST button arg and carries the full
    // text (not the truncated preview) under the reserved id.
    const buttonArgs = sendButtonMessage.mock.calls[0];
    const payload = buttonArgs[buttonArgs.length - 1];
    expect(payload).toMatchObject({
      kind: 'queued_release',
      prompt_id: promptId,
      items: [{ id: itemId, text: 'the full untruncated queued message body' }],
      actions: [
        { id: 'send', intent: 'primary' },
        { id: 'cancel', intent: 'neutral' },
      ],
    });
  });

  // A client that predates `kind: 'queued_release'` renders the classic
  // {question, options, mode} prompt shape. Without a mirrored `options`
  // array the card degrades to a free-text answer box whose reply the router
  // refuses as an invalid queue action — a functionally dead card. The
  // option VALUES must be exactly the wire action ids the router accepts
  // ('send' / 'cancel', journal-input-router QUEUED_RELEASE_ACTIONS).
  it('structured path: payload mirrors actions as classic prompt options so older clients render tappable buttons', async () => {
    const sendButtonMessage = vi.fn(async () => '$tile');
    const session = makeSession({ sendButtonMessage, queueNotifications: [] });
    await notifyQueuedMessage(session, 'trunc…', {
      sendReply: vi.fn(),
      queueRelease: { noteQueued: vi.fn() },
      convoId: 'convo-1',
      fullText: 'full body',
    });

    const buttonArgs = sendButtonMessage.mock.calls[0];
    const payload = buttonArgs[buttonArgs.length - 1];
    expect(payload.mode).toBe('pick_one');
    expect(payload.options).toEqual([
      { id: 'send', label: payload.actions[0].label, value: 'send' },
      { id: 'cancel', label: payload.actions[1].label, value: 'cancel' },
    ]);
  });

  // "Send ALL queued messages … cancel this one?" is honest with several
  // queued but absurd for the common single-message case. The wording is
  // count-aware; the wire action ids never change.
  it('structured path: question and labels are singular with one queued message, "all N" with several', async () => {
    async function payloadFor(queuedMessages) {
      const sendButtonMessage = vi.fn(async () => '$tile');
      const session = makeSession({ sendButtonMessage, queueNotifications: [], queuedMessages });
      await notifyQueuedMessage(session, 'p', {
        sendReply: vi.fn(),
        queueRelease: { noteQueued: vi.fn() },
        convoId: 'convo-1',
      });
      const buttonArgs = sendButtonMessage.mock.calls[0];
      return buttonArgs[buttonArgs.length - 1];
    }

    const single = await payloadFor([[{ type: 'text', text: 'only' }]]);
    expect(single.question).toBe('Send this queued message now, or cancel it?');
    expect(single.actions.map(a => a.label)).toEqual(['⚡ Send now', '✕ Cancel']);

    const several = await payloadFor([
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
      [{ type: 'text', text: 'c' }],
    ]);
    expect(several.question).toBe('Send all 3 queued messages now, or cancel this one?');
    expect(several.actions.map(a => a.label)).toEqual(['⚡ Send all now', '✕ Cancel this']);
    expect(several.actions.map(a => a.id)).toEqual(['send', 'cancel']);
  });
});


describe('cancelQueuedItem', () => {
  it('removes by stable id, drops the registry entry, and emits one cancel release', () => {
    const session = makeSession({
      queueNotifications: [
        { eventId: '$ev1', plain: 'first', id: 'pr_1::0' },
        { eventId: '$ev2', plain: 'second', id: 'pr_2::0' },
      ],
    });
    const live = [
      { promptId: 'pr_1', itemId: 'pr_1::0' },
      { promptId: 'pr_2', itemId: 'pr_2::0' },
    ];
    const queueRelease = {
      dropItem: vi.fn((_convoId, itemId) => {
        live.splice(live.findIndex(entry => entry.itemId === itemId), 1);
      }),
    };
    // The real emitRelease write-ahead precedes the destructive splice and runs
    // the mutate thunk only on a durable put (loop #536). The stub mimics a
    // durable emit: run the thunk, return true.
    const emitRelease = vi.fn((_convoId, _fields, { mutate } = {}) => {
      mutate?.();
      return true;
    });

    expect(cancelQueuedItem(session, {
      itemId: 'pr_2::0',
      promptId: 'pr_2',
      convoId: 'convo-1',
      queueRelease,
      emitRelease,
    })).toBe(true);

    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'first' }]]);
    expect(session.queueNotifications).toEqual([
      { eventId: '$ev1', plain: 'first', id: 'pr_1::0' },
    ]);
    expect(live).toEqual([{ promptId: 'pr_1', itemId: 'pr_1::0' }]);
    expect(queueRelease.dropItem).toHaveBeenCalledWith('convo-1', 'pr_2::0');
    expect(emitRelease).toHaveBeenCalledWith('convo-1', {
      promptId: 'pr_2',
      action: 'cancel',
      releasedIds: ['pr_2::0'],
    }, expect.objectContaining({ mutate: expect.any(Function) }));
  });

  it('fail-closed: a non-durable emitRelease (write-ahead failed) leaves the queue intact and drops nothing', () => {
    const session = makeSession({
      queueNotifications: [
        { eventId: '$ev1', plain: 'first', id: 'pr_1::0' },
        { eventId: '$ev2', plain: 'second', id: 'pr_2::0' },
      ],
    });
    const queueRelease = { dropItem: vi.fn() };
    // emitRelease returns false WITHOUT running the mutate thunk (disk fault).
    const emitRelease = vi.fn(() => false);

    expect(cancelQueuedItem(session, {
      itemId: 'pr_2::0',
      promptId: 'pr_2',
      convoId: 'convo-1',
      queueRelease,
      emitRelease,
    })).toBe(false);

    expect(session.queuedMessages).toHaveLength(2);       // nothing spliced
    expect(session.queueNotifications).toHaveLength(2);
    expect(queueRelease.dropItem).not.toHaveBeenCalled(); // card stays actionable
  });

  it('does nothing when the stable id no longer maps to the queue', () => {
    const session = makeSession({
      queueNotifications: [
        { eventId: '$ev1', plain: 'first', id: 'pr_1::0' },
        { eventId: '$ev2', plain: 'second', id: 'pr_2::0' },
      ],
    });
    const queueRelease = { dropItem: vi.fn() };
    const emitRelease = vi.fn();

    expect(cancelQueuedItem(session, {
      itemId: 'pr_missing::0',
      promptId: 'pr_missing',
      convoId: 'convo-1',
      queueRelease,
      emitRelease,
    })).toBe(false);

    expect(session.queuedMessages).toHaveLength(2);
    expect(session.queueNotifications).toHaveLength(2);
    expect(queueRelease.dropItem).not.toHaveBeenCalled();
    expect(emitRelease).not.toHaveBeenCalled();
  });
});

describe('resolveQueueReleaseTap', () => {
  it('interrupt: detaches + strips + flushes without a post-action text line, returns true', () => {
    const session = makeSession();
    const deps = matrixDeps();
    const handled = resolveQueueReleaseTap('interrupt', session, deps);
    expect(handled).toBe(true);
    expect(session.queuedMessages).toBeNull();
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
    expect(deps.sendHtml).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue.mock.calls[0][1]).toHaveLength(2);
  });

  it('interrupt via journal seams: no post-action text line, same flush', () => {
    const session = makeSession();
    const deps = matrixDeps({ sendHtml: null });
    const handled = resolveQueueReleaseTap('interrupt', session, deps);
    expect(handled).toBe(true);
    expect(deps.sendReply).not.toHaveBeenCalled();
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('interrupt on an empty queue is a SILENT no-op (stale-tile tap), still handled', () => {
    const session = makeSession({ queuedMessages: null });
    const deps = matrixDeps();
    expect(resolveQueueReleaseTap('interrupt', session, deps)).toBe(true);
    expect(deps.sendHtml).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });

  it('cancel:<n> splices exactly the indexed message AND its tile without a post-action text line', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(resolveQueueReleaseTap('cancel:0', session, deps)).toBe(true);
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'second' }]]);
    expect(session.queueNotifications).toEqual([{ eventId: '$ev2', plain: '📨 Queued (2): second' }]);
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev1', '✕ 📨 Queued (1): first (cancelled)',
    );
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('cancel of the last remaining message nulls the queue without a post-action text line', () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'solo' }]],
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): solo' }],
    });
    const deps = matrixDeps();
    resolveQueueReleaseTap('cancel:0', session, deps);
    expect(session.queuedMessages).toBeNull();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('cancel with an out-of-range index is a SILENT no-op (stale tile), still handled', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(resolveQueueReleaseTap('cancel:9', session, deps)).toBe(true);
    expect(session.queuedMessages).toHaveLength(2);
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('non-queue values touch nothing and return false', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(resolveQueueReleaseTap('model:opus', session, deps)).toBe(false);
    expect(resolveQueueReleaseTap('opt_a', session, deps)).toBe(false);
    expect(session.queuedMessages).toHaveLength(2);
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });
});

// Coverage gap (a): the STRUCTURED entry path (entry != null), reached in
// production from the router's stable-id classification. Only the legacy
// entry==null branches were exercised above.
describe('resolveQueueReleaseTap — structured entry path (stable-id)', () => {
  function entrySession(overrides = {}) {
    return {
      roomId: '!room:server',
      queuedMessages: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
      queueNotifications: [
        { id: 'pr_1::0', eventId: '$e1', plain: '📨 Queued (1): a' },
        { id: 'pr_1::1', eventId: '$e2', plain: '📨 Queued (2): b' },
      ],
      ...overrides,
    };
  }

  it('send: flushes the WHOLE queue with the live release snapshot and strips notifications on success', () => {
    const flushQueue = vi.fn(() => true);
    const stripQueueNotificationLinks = vi.fn();
    const listLive = vi.fn(() => [
      { promptId: 'pr_1', itemId: 'pr_1::0' },
      { promptId: 'pr_1', itemId: 'pr_1::1' },
    ]);
    const session = entrySession();
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      stripQueueNotificationLinks,
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::1'] },
      convoId: 'convo-1',
      queueRelease: { listLive, dropItem: vi.fn() },
      emitRelease: vi.fn(),
    });
    expect(handled).toBe(true);
    expect(flushQueue).toHaveBeenCalledTimes(1);
    // Whole queue (both items), not just the tapped card's item.
    expect(flushQueue.mock.calls[0][1]).toHaveLength(2);
    // The release snapshot is the LIVE registry entries, taken before detach.
    expect(flushQueue.mock.calls[0][2]).toEqual({
      convoId: 'convo-1',
      entries: [
        { promptId: 'pr_1', itemId: 'pr_1::0' },
        { promptId: 'pr_1', itemId: 'pr_1::1' },
      ],
    });
    expect(session.queuedMessages).toBeNull();
    expect(stripQueueNotificationLinks).toHaveBeenCalledWith(session);
  });

  it('send: guard no-ops (returns true, no flush) when the card\'s item ids are not all present in notifications', () => {
    const flushQueue = vi.fn(() => true);
    const session = entrySession({
      queueNotifications: [{ id: 'pr_1::0', eventId: '$e1', plain: 'a' }],
    });
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      stripQueueNotificationLinks: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::missing'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
    });
    expect(handled).toBe(true);
    expect(flushQueue).not.toHaveBeenCalled();
    expect(session.queuedMessages).toHaveLength(2); // untouched
  });

  it('send: RESTORES notifications (does not strip) when the flush is rejected', () => {
    const flushQueue = vi.fn(() => false);
    const stripQueueNotificationLinks = vi.fn();
    const session = entrySession();
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      stripQueueNotificationLinks,
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::1'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
    });
    expect(handled).toBe(true);
    expect(flushQueue).toHaveBeenCalledTimes(1);
    expect(stripQueueNotificationLinks).not.toHaveBeenCalled();
    // Notifications came back so the card stays actionable for a retry.
    expect(session.queueNotifications).toEqual([
      { id: 'pr_1::0', eventId: '$e1', plain: '📨 Queued (1): a' },
      { id: 'pr_1::1', eventId: '$e2', plain: '📨 Queued (2): b' },
    ]);
  });

  it('send: echoes the batch content at the point of sending (card retires with the preview)', () => {
    const notify = vi.fn();
    const session = entrySession();
    resolveQueueReleaseTap('send', session, {
      flushQueue: vi.fn(() => true),
      stripQueueNotificationLinks: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::1'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
      notify,
      formatQueueSummary: (queued) => ({
        plain: queued.map((e, i) => `  ${i + 1}. ${e.map(b => b.text).join('\n')}`).join('\n'),
        html: '',
      }),
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('⚡ Sending 2 queued messages now:\n  1. a\n  2. b');
  });

  it('send: a rejected flush echoes nothing — the messages did not go out', () => {
    const notify = vi.fn();
    const session = entrySession();
    resolveQueueReleaseTap('send', session, {
      flushQueue: vi.fn(() => false),
      stripQueueNotificationLinks: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::1'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
      notify,
      formatQueueSummary: () => ({ plain: 'x', html: '' }),
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('send: a caller without the summary seam (legacy shape) still flushes, just without the echo', () => {
    const notify = vi.fn();
    const session = entrySession();
    const flushQueue = vi.fn(() => true);
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      stripQueueNotificationLinks: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0', 'pr_1::1'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
      notify,
    });
    expect(handled).toBe(true);
    expect(flushQueue).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('cancel: drops ONLY the tapped item by stable id and emits its cancel release', () => {
    const dropItem = vi.fn();
    // Queued-release durability (loop #536): cancelQueuedItem now write-aheads
    // through emitRelease and runs the destructive splice via the mutate thunk
    // only on a durable put. The stub mimics a successful put by invoking mutate.
    const emitRelease = vi.fn((_convoId, _fields, { mutate } = {}) => { mutate?.(); return true; });
    const session = entrySession();
    const handled = resolveQueueReleaseTap('cancel', session, {
      flushQueue: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem },
      emitRelease,
    });
    expect(handled).toBe(true);
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'b' }]]);
    expect(session.queueNotifications).toEqual([{ id: 'pr_1::1', eventId: '$e2', plain: '📨 Queued (2): b' }]);
    expect(dropItem).toHaveBeenCalledWith('convo-1', 'pr_1::0');
    expect(emitRelease).toHaveBeenCalledWith('convo-1', {
      promptId: 'pr_1',
      action: 'cancel',
      releasedIds: ['pr_1::0'],
    }, expect.objectContaining({ mutate: expect.any(Function) }));
  });

  it('an entry present with an unknown action returns false (not handled)', () => {
    const session = entrySession();
    const handled = resolveQueueReleaseTap('bogus', session, {
      flushQueue: vi.fn(),
      entry: { prompt_id: 'pr_1', itemIds: ['pr_1::0'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
    });
    expect(handled).toBe(false);
    expect(session.queuedMessages).toHaveLength(2);
  });
});

// A queued /compact is flushed ALONE and ahead of everything else
// (lib/compact-priority.js). Merging it into the one-message batch the queue
// normally becomes makes Claude read the following messages as *compaction
// instructions*, so the split has to hold on every flush path — including the
// ones where the user explicitly asked for the whole queue.
describe('compact-first batch split', () => {
  function compactSession() {
    return makeSession({
      queuedMessages: [
        [{ type: 'text', text: '/compact' }],
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'second' }],
      ],
      queueNotifications: [
        { eventId: '$evC', plain: '📨 Queued: /compact', id: 'pr_c::0' },
        { eventId: '$ev1', plain: '📨 Queued (2): first', id: 'pr_1::0' },
        { eventId: '$ev2', plain: '📨 Queued (3): second', id: 'pr_2::0' },
      ],
    });
  }

  it('typed send flushes only the compact and holds the rest in lockstep', async () => {
    const session = compactSession();
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue.mock.calls[0][1]).toEqual([[{ type: 'text', text: '/compact' }]]);
    // Queue and notifications shrink by the same one entry, still aligned.
    expect(session.queuedMessages).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ]);
    expect(session.queueNotifications.map(n => n.id)).toEqual(['pr_1::0', 'pr_2::0']);
  });

  it('typed send says where the held messages went', async () => {
    const session = compactSession();
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    const reply = deps.sendReply.mock.calls[0][0];
    expect(reply).toContain('/compact');
    expect(reply).toContain('other 2 messages');
    expect(reply).toContain('once compaction finishes');
  });

  it('a failed flush puts the compact back at the front, still ahead of the queue', async () => {
    const session = compactSession();
    const deps = journalDeps({ flushQueue: vi.fn(() => false) });
    await handleBusyQueueMagicWord(session, 'send', deps);

    // flushQueue's own restoreQueuedBatch is what re-prepends the entry; the
    // notification half is this module's job and must match it.
    expect(session.queueNotifications.map(n => n.id)).toEqual(['pr_c::0', 'pr_1::0', 'pr_2::0']);
  });

  it('a card tap sends only the compact and notifies about the rest', () => {
    const session = compactSession();
    const flushQueue = vi.fn(() => true);
    const notify = vi.fn();
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      stripQueueNotificationLinks: (s) => { s.queueNotifications = []; },
      entry: { prompt_id: 'pr_c', itemIds: ['pr_c::0'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
      notify,
    });

    expect(handled).toBe(true);
    expect(flushQueue.mock.calls[0][1]).toEqual([[{ type: 'text', text: '/compact' }]]);
    expect(session.queuedMessages).toHaveLength(2);
    expect(session.queueNotifications.map(n => n.id)).toEqual(['pr_1::0', 'pr_2::0']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('other 2 messages');
  });

  it('tapping a NON-compact card still sends the compact first — the merge is what corrupts it', () => {
    const session = compactSession();
    const flushQueue = vi.fn(() => true);
    const handled = resolveQueueReleaseTap('send', session, {
      flushQueue,
      entry: { prompt_id: 'pr_2', itemIds: ['pr_2::0'] },
      convoId: 'convo-1',
      queueRelease: { listLive: vi.fn(() => []), dropItem: vi.fn() },
      emitRelease: vi.fn(),
      notify: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(flushQueue.mock.calls[0][1]).toEqual([[{ type: 'text', text: '/compact' }]]);
  });

  it('leaves an ordinary queue completely alone — one merged batch, nothing held', async () => {
    const session = makeSession();
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.flushQueue.mock.calls[0][1]).toHaveLength(2);
    expect(session.queuedMessages).toBe(null);
    expect(deps.sendReply.mock.calls[0][0]).toContain('Sending 2 queued messages now');
  });

  it('a compact alone in the queue flushes exactly like any single message', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: '/compact' }]],
      queueNotifications: [{ eventId: '$evC', plain: '📨 Queued (1): /compact', id: 'pr_c::0' }],
    });
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.flushQueue.mock.calls[0][1]).toHaveLength(1);
    expect(session.queuedMessages).toBe(null);
    expect(deps.sendReply.mock.calls[0][0]).toContain('Sending 1 queued message now');
  });

  it('still clears stale notifications when the queue is empty', async () => {
    const session = makeSession({
      queuedMessages: null,
      queueNotifications: [{ eventId: '$stale', plain: '📨 Queued (1): gone', id: 'pr_x::0' }],
    });
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(session.queueNotifications).toEqual([]);
    expect(deps.sendReply.mock.calls[0][0]).toBe('⚡ No queued messages to send.');
  });
});

describe('notifyQueuedMessage — compact jump tile', () => {
  it('announces the jump and how many messages are waiting behind it', async () => {
    const session = {
      queuedMessages: [
        [{ type: 'text', text: '/compact' }],
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'second' }],
      ],
      queueNotifications: [
        { eventId: '$ev1', plain: '📨 Queued (1): first', id: 'pr_1::0' },
        { eventId: '$ev2', plain: '📨 Queued (2): second', id: 'pr_2::0' },
      ],
    };
    const sendReply = vi.fn(async () => '$evC');
    await notifyQueuedMessage(session, '/compact', {
      sendReply,
      queueRelease: { noteQueued: vi.fn() },
      convoId: 'convo-1',
      compactJump: true,
    });

    const posted = sendReply.mock.calls[0][0];
    expect(posted).toContain('jumping ahead of 2 queued messages');
    expect(posted).toContain('once compaction finishes');
    // The notification lands at the FRONT, matching where the entry was
    // unshifted — the arrays are read positionally against each other.
    expect(session.queueNotifications.map(n => n.plain)[0]).toBe(posted);
    expect(session.queueNotifications).toHaveLength(3);
  });

  it('says nothing about jumping when the compact is the only queued message', async () => {
    const session = { queuedMessages: [[{ type: 'text', text: '/compact' }]], queueNotifications: [] };
    const sendReply = vi.fn(async () => '$evC');
    await notifyQueuedMessage(session, '/compact', {
      sendReply,
      queueRelease: { noteQueued: vi.fn() },
      convoId: 'convo-1',
      compactJump: true,
    });

    expect(sendReply.mock.calls[0][0]).toBe('📨 Queued (1): /compact');
  });

  it('gives the jumping card single-message labels — a tap sends only the compact', async () => {
    const session = {
      queuedMessages: [
        [{ type: 'text', text: '/compact' }],
        [{ type: 'text', text: 'first' }],
      ],
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): first', id: 'pr_1::0' }],
      sendButtonMessage: vi.fn(async () => '$evC'),
    };
    await notifyQueuedMessage(session, '/compact', {
      sendReply: vi.fn(async () => '$evC'),
      queueRelease: { noteQueued: vi.fn() },
      convoId: 'convo-1',
      compactJump: true,
    });

    const payload = session.sendButtonMessage.mock.calls[0][5];
    expect(payload.actions.map(a => a.label)).toEqual(['⚡ Send now', '✕ Cancel']);
    // Ids and values are untouched, so shipped clients route the card exactly
    // as they always have.
    expect(payload.actions.map(a => a.id)).toEqual(['send', 'cancel']);
    expect(payload.options.map(o => o.value)).toEqual(['send', 'cancel']);
    expect(payload.question).toContain('other 1 queued message will be sent once compaction finishes');
  });
});

describe('queued-release publisher wiring', () => {
  it('emitRelease write-aheads before publishing exactly one structured prompt_reply with a deterministic idem_key', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    // emitRelease now composes the two extracted phases (writeAheadRelease +
    // publishReleaseRecord), so pull all three into the sandbox.
    const start = src.indexOf('function writeAheadRelease(convoId, { promptId, action, releasedIds }');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('// In-process retry driver', start);
    expect(end).toBeGreaterThan(start);

    const publishPromptReply = vi.fn();
    const put = vi.fn(() => true); // durable write-ahead
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_722_000_000_000);
    const emitRelease = runInNewContext(
      `(() => { ${src.slice(start, end)}; return emitRelease; })()`,
      { journalPublisher: { publishPromptReply }, releaseOutbox: { put }, console, Date },
    );

    try {
      const result = emitRelease('convo-1', {
        promptId: 'pr_123',
        action: 'cancel',
        releasedIds: ['pr_123::0'],
      });

      expect(result).toBe(true);
      // Write-ahead persisted a `pending` record keyed (promptId, itemId, action)
      // BEFORE the publish.
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith('pr_123 pr_123::0 cancel', expect.objectContaining({
        convoId: 'convo-1',
        promptId: 'pr_123',
        itemId: 'pr_123::0',
        action: 'cancel',
        status: 'pending',
      }));
      expect(publishPromptReply).toHaveBeenCalledTimes(1);
      expect(publishPromptReply).toHaveBeenCalledWith('convo-1', {
        kind: 'queued_release',
        prompt_id: 'pr_123',
        action: 'cancel',
        released: ['pr_123::0'],
        at: 1_722_000_000_000,
      }, { idemKey: 'qr pr_123 pr_123::0 cancel' });
    } finally {
      now.mockRestore();
    }
  });

  it('emitRelease fail-closes when the write-ahead put returns false: no mutate, no publish', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('function writeAheadRelease(convoId, { promptId, action, releasedIds }');
    const end = src.indexOf('// In-process retry driver', start);
    const publishPromptReply = vi.fn();
    const put = vi.fn(() => false); // disk fault
    const mutate = vi.fn();
    const emitRelease = runInNewContext(
      `(() => { ${src.slice(start, end)}; return emitRelease; })()`,
      { journalPublisher: { publishPromptReply }, releaseOutbox: { put }, console, Date },
    );

    const result = emitRelease('convo-1', {
      promptId: 'pr_9',
      action: 'send',
      releasedIds: ['pr_9::0'],
    }, { mutate });

    expect(result).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(publishPromptReply).not.toHaveBeenCalled();
  });

  it('the durable publisher exposes prompt_reply through safePublish', () => {
    const src = readFileSync(new URL('../lib/journal-publisher.js', import.meta.url), 'utf-8');
    expect(src).toMatch(
      /publishPromptReply\(convoId,\s*payload,\s*options\)\s*\{[\s\S]*?safePublish\(convoId,\s*['"]prompt_reply['"],\s*payload,\s*options\);\s*\}/,
    );
  });

  it('the router rejects agent-authored release echoes at its user-sender guard', () => {
    const src = readFileSync(new URL('../lib/journal-input-router.js', import.meta.url), 'utf-8');
    expect(src).toMatch(
      /if \(typeof sender !== ['"]string['"] \|\| !sender\.startsWith\(['"]user:['"]\)\) return;/,
    );
  });
});

describe('index.js queued-send finalizer', () => {
  function loadFlushHarness({ dispatchResult = true } = {}) {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('function queuedReleaseItemIds(');
    const end = src.indexOf('\nfunction splitMessage(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // The send path now write-aheads each release (durable phase) BEFORE
    // delivery and publishes it (network phase) only after delivery commits.
    const writeAheadRelease = vi.fn((convoId, { promptId, action, releasedIds }) => ({
      recordKey: `${promptId}\0${releasedIds[0]}\0${action}`,
      convoId, promptId, itemId: releasedIds[0], action, releasedIds, at: 1,
    }));
    const publishReleaseRecord = vi.fn();
    const abort = vi.fn();
    const dropItem = vi.fn();
    const journalPublishNotice = vi.fn();
    const listLive = vi.fn(() => [
      { promptId: 'pr_1', itemId: 'pr_1::0' },
      { promptId: 'pr_2', itemId: 'pr_2::0' },
      { promptId: 'pr_drifted', itemId: 'pr_drifted::0' },
    ]);
    const dispatchMergedFlush = vi.fn(() => dispatchResult);
    const flushQueue = runInNewContext(
      `(() => { ${src.slice(start, end)}; return flushQueue; })()`,
      {
        AGENT_CODEX: 'codex',
        console: { log: vi.fn() },
        dispatchMergedFlush,
        writeAheadRelease,
        publishReleaseRecord,
        releaseOutbox: { abort },
        journalConvoIdFor: () => 'convo-1',
        journalPublishNotice,
        journalInputConsumer: {
          queueRelease: { listLive, dropItem },
        },
      },
    );
    return { flushQueue, writeAheadRelease, publishReleaseRecord, abort, dropItem, listLive, dispatchMergedFlush, journalPublishNotice };
  }

  it('write-aheads every release before dispatch, then publishes + drops exactly once each after the batch is accepted', () => {
    const harness = loadFlushHarness();
    const queued = [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]];
    const session = {
      agent: 'claude',
      busy: false,
      queuedMessages: null,
      queueNotifications: [
        { id: 'pr_1::0' },
        { id: 'pr_2::0' },
      ],
      roomId: '!room',
    };

    expect(harness.flushQueue(session, queued)).toBe(true);
    expect(harness.dispatchMergedFlush).toHaveBeenCalledWith(session, queued);
    expect(harness.writeAheadRelease).toHaveBeenCalledTimes(2);
    expect(harness.publishReleaseRecord).toHaveBeenCalledTimes(2);
    expect(harness.dropItem).toHaveBeenCalledTimes(2);
    // The drifted live entry is not in this batch's notifications → never written.
    expect(harness.writeAheadRelease).not.toHaveBeenCalledWith(
      'convo-1',
      expect.objectContaining({ releasedIds: ['pr_drifted::0'] }),
    );
    // Fail-closed ordering: write-ahead precedes delivery; publish follows it.
    expect(harness.writeAheadRelease.mock.invocationCallOrder[0])
      .toBeLessThan(harness.dispatchMergedFlush.mock.invocationCallOrder[0]);
    expect(harness.dispatchMergedFlush.mock.invocationCallOrder[0])
      .toBeLessThan(harness.publishReleaseRecord.mock.invocationCallOrder[0]);
  });

  it('skips a batch notification whose registry entry is no longer live', () => {
    const harness = loadFlushHarness();
    const queued = [[{ type: 'text', text: 'live' }], [{ type: 'text', text: 'stale' }]];
    const session = {
      agent: 'claude',
      busy: false,
      queuedMessages: null,
      queueNotifications: [
        { id: 'pr_1::0' },
        { id: 'pr_missing::0' },
      ],
      roomId: '!room',
    };

    expect(harness.flushQueue(session, queued)).toBe(true);
    expect(harness.writeAheadRelease).toHaveBeenCalledTimes(1);
    expect(harness.writeAheadRelease).toHaveBeenCalledWith('convo-1', {
      promptId: 'pr_1',
      action: 'send',
      releasedIds: ['pr_1::0'],
    });
    expect(harness.dropItem).toHaveBeenCalledTimes(1);
  });

  it('rolls the batch back without emitting or dropping releases when an ALIVE session rejects dispatch', () => {
    // #161 reconcile: retain-for-retry is reserved for a live session that
    // refused this flush. A dead/auto-stopped session takes the notify+drop
    // path instead (covered separately below).
    const harness = loadFlushHarness({ dispatchResult: false });
    const queued = [[{ type: 'text', text: 'retry me' }]];
    const later = [[{ type: 'text', text: 'arrived later' }]];
    const session = { agent: 'claude', alive: true, busy: false, queuedMessages: later, roomId: '!room' };

    expect(harness.flushQueue(session, queued)).toBe(false);
    // Chronological order: the batch being retried was queued before `later`.
    expect(session.queuedMessages).toEqual([...queued, ...later]);
    expect(harness.publishReleaseRecord).not.toHaveBeenCalled();
    expect(harness.dropItem).not.toHaveBeenCalled();
  });

  it('rolls back the written-ahead releases when delivery is refused so none is ever published', () => {
    // A batch WITH live release entries whose delivery is refused: every
    // write-ahead must be undone (releaseOutbox.abort — in-memory authoritative)
    // so the retry driver never republishes a `send` for an undelivered batch.
    const harness = loadFlushHarness({ dispatchResult: false });
    const queued = [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]];
    const session = {
      agent: 'claude',
      alive: true,
      busy: false,
      queuedMessages: null,
      queueNotifications: [{ id: 'pr_1::0' }, { id: 'pr_2::0' }],
      roomId: '!room',
    };

    expect(harness.flushQueue(session, queued)).toBe(false);
    expect(harness.writeAheadRelease).toHaveBeenCalledTimes(2);
    expect(harness.abort).toHaveBeenCalledTimes(2);
    expect(harness.abort).toHaveBeenCalledWith('pr_1\0pr_1::0\0send');
    expect(harness.abort).toHaveBeenCalledWith('pr_2\0pr_2::0\0send');
    expect(harness.publishReleaseRecord).not.toHaveBeenCalled();
    expect(harness.dropItem).not.toHaveBeenCalled();
  });

  it('notifies and drops (no retain) when a DEAD/auto-stopped session rejects dispatch', () => {
    // #161: dead-session flush failure must not strand the batch as a
    // permanent retry; every entry was acknowledged with a "📨 Queued" tile,
    // so drop it AND tell the user (matching merged master).
    const harness = loadFlushHarness({ dispatchResult: false });
    const queued = [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]];
    const session = { agent: 'claude', alive: false, busy: false, queuedMessages: null, roomId: '!room' };

    expect(harness.flushQueue(session, queued)).toBe(false);
    expect(session.queuedMessages).toBeNull(); // dropped, not retained
    expect(harness.publishReleaseRecord).not.toHaveBeenCalled();
    expect(harness.dropItem).not.toHaveBeenCalled();
    expect(harness.journalPublishNotice).toHaveBeenCalledTimes(1);
    expect(harness.journalPublishNotice.mock.calls[0][1]).toMatch(/2 queued messages/);
  });

  it('defers Codex release commitment until the interrupted turn has exited and dispatch succeeds', () => {
    const harness = loadFlushHarness();
    const queued = [[{ type: 'text', text: 'send after exit' }]];
    const snapshot = {
      convoId: 'convo-1',
      entries: [{ promptId: 'pr_1', itemId: 'pr_1::0' }],
    };
    const session = {
      agent: 'codex',
      busy: true,
      queuedMessages: null,
      roomId: '!room',
      codex: { interrupt: vi.fn(() => true) },
    };

    expect(harness.flushQueue(session, queued, snapshot)).toBe('deferred');
    expect(session.queuedMessages).toEqual(queued);
    expect(harness.dispatchMergedFlush).not.toHaveBeenCalled();
    expect(harness.writeAheadRelease).not.toHaveBeenCalled();

    session.busy = false;
    session.queuedMessages = null;
    expect(harness.flushQueue(session, queued, snapshot)).toBe(true);
    expect(harness.writeAheadRelease).toHaveBeenCalledTimes(1);
    expect(harness.dropItem).toHaveBeenCalledTimes(1);
  });
});
describe('index.js journal busy caller — queued-tile notification wiring (source inspection)', () => {
  it('the journal busy branch posts the tile via notifyQueuedMessage with the journal ctx sink', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('const entry = markJournalOrigin([{ type: \'text\', text: trimmed }]);');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start, start + 1200);
    expect(window).toMatch(/notifyQueuedMessage\(session, preview, \{/);
    expect(window).toMatch(/sendReply: ctx\.sendReply/);
  });

  // The jump is only real if the entry AND its notification move to the front
  // together — the two arrays are read positionally against each other, so a
  // queue-front entry with an end-of-list notification mis-targets every later
  // cancel and every release finalization.
  it('a compact command unshifts the entry and flags the tile so its notification unshifts too', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('const compactJump = isCompactCommand(trimmed);');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start, start + 2000);
    expect(window).toMatch(/if \(compactJump\) session\.queuedMessages\.unshift\(entry\);/);
    expect(window).toMatch(/else session\.queuedMessages\.push\(entry\);/);
    expect(window).toMatch(/compactJump,/);
  });

  // Only ONE /compact may wait in the queue. Each flush sends the front
  // compact ALONE (compactBatchSize), so a second queued compact wouldn't
  // merge with the first — it would run a SECOND compaction right after the
  // first finishes. A repeat /compact while one waits is refused with a
  // plain reply, before the entry, the tile, and the release registration.
  it('a repeat /compact is refused while one is already queued', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('const compactJump = isCompactCommand(trimmed);');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start, start + 2000);
    const dedupe = window.indexOf('hasQueuedCompact(session.queuedMessages)');
    const enqueue = window.indexOf('session.queuedMessages.unshift(entry)');
    expect(dedupe).toBeGreaterThan(-1);
    expect(window).toContain('already queued');
    expect(dedupe).toBeLessThan(enqueue);
  });
});

// The turn-end flush lives in index.js and can't be imported, so its half of
// the compact-first rule is pinned by source inspection — the same technique
// the other index.js wiring pins in this file use.
describe('index.js flushPendingSessionQueue — compact-first split (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const start = src.indexOf('function flushPendingSessionQueue(session) {');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  it('splits the batch off the front of the queue', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/const batchSize = compactBatchSize\(queue\)/);
    expect(body).toMatch(/const queued = queue\.slice\(0, batchSize\)/);
    expect(body).toMatch(/const deferred = queue\.slice\(batchSize\)/);
  });

  it('leaves the held entries queued rather than dropping them', () => {
    expect(body).toMatch(/session\.queuedMessages = deferred\.length \? deferred : null/);
  });

  // The old code cleared queueNotifications wholesale on success. With a
  // partial flush that would strand the deferred entries' cards, breaking the
  // positional alignment every later cancel and finalization depends on.
  it('retires only the flushed batch\'s notifications', () => {
    expect(body).toMatch(/if \(sent === true\) session\.queueNotifications = notifications\.slice\(batchSize\)/);
  });

  it('tells the user the rest is waiting on the compaction', () => {
    expect(body).toMatch(/Sending \/compact first/);
    expect(body).toMatch(/once compaction finishes/);
  });
});

describe('index.js flushQueue drop path — undelivered notice wiring (source inspection)', () => {
  // PR #150 follow-up: every queued entry was acknowledged with a
  // success-style "📨 Queued" tile, so a flush that drops the queue (session
  // dead / auto-stopped) must tell the user — a server-side console.log alone
  // leaves them believing the messages were delivered.
  it('a dropped queue publishes a journal notice, not just a server-side log', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('[QUEUE] dropped queued message(s)');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start, start + 1200);
    expect(window).toMatch(/journalPublishNotice\(journalConvoIdFor\(session\)/);
    expect(window).toMatch(/queued message/); // undelivered wording mentions the queue
  });

  // Bugbot on PR #158: dispatchMergedFlush also returns false while the
  // session is still ALIVE (iv non-text-only queue, Codex validation/spawn
  // failure, stdin write error) — paths that already surface their specific
  // reason via reportSessionSendFailure. The "session ended" notice must be
  // reserved for the session actually being gone, or those users get a
  // duplicate AND factually wrong second message.
  it('the "session ended" notice fires only when the session is actually dead/auto-stopped', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const drop = src.indexOf('[QUEUE] dropped queued message(s)');
    expect(drop).toBeGreaterThan(-1);
    // The drop log AND the "session ended" notice both sit inside a
    // dead/auto-stopped gate: the gate opens before the drop log, and the
    // notice follows the log inside the same branch.
    const gate = src.lastIndexOf('if (!session.alive || session._autoStopped)', drop);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(drop);
    const window = src.slice(gate, drop + 1200);
    expect(window).toMatch(/journalPublishNotice\(journalConvoIdFor\(session\)/);
  });
});

describe('#165 index.js prompt-reply handler — value-shape classification retired (source inspection)', () => {
  it('index.js never classifies a queue tap by value shape (no isQueueReleaseTap usage)', () => {
    // The #165 label-hijack fix: a genuine answer whose label is literally
    // `interrupt` or `cancel:2` must NOT be dropped by a value-shape guard.
    // Queue taps are proven by target_seq membership only, so index.js must
    // not reference the retired value-shape predicate at all.
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/isQueueReleaseTap/);
  });

  it('a seq-unclassified, non-picker reply is delivered to the ordinary answer resolver, not dropped', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('function journalOnPromptReply(');
    const end = src.indexOf('\nfunction ', start + 1);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    // Only a 'live' queued-release seq is intercepted as a queue action; every
    // other reply — including one whose label is literally `interrupt` /
    // `cancel:2` — flows through to journalRoutePromptReply and the "answered:"
    // echo. No value-shape early-return sits between classify and route.
    // (easelyte fork: the "answered:" echo is emitted via the shared
    // journalEchoPromptAnswer helper — which permission-cards also reuses —
    // rather than inline, so assert the helper call instead of the string.)
    expect(body).toMatch(/queuedRelease\.state === 'live'/);
    expect(body).toMatch(/journalRoutePromptReply\(session, answer\)/);
    expect(body).toMatch(/journalEchoPromptAnswer\(session, username, label\)/);
    expect(body).not.toMatch(/isQueueReleaseTap/);
  });
});
