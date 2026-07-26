import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dispatchBusyQueueMagicWord, handleBusyQueueMagicWord, notifyQueuedMessage, isQueueActionValue, isQueueActionFrame, handleQueueActionValue, QUEUE_ACTION_REPLY_KIND } from '../lib/busy-queue.js';

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
    flushQueue: vi.fn(),
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
    flushQueue: vi.fn(),
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
      flushQueue: vi.fn(() => order.push('flush')),
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
// notifyQueuedMessage posts the tile, handleQueueActionValue runs the taps.

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
        { id: 'cancel', label: '✕ Cancel', value: 'cancel:1', reply_kind: 'queue_action' },
        { id: 'interrupt', label: '⚡ Send now', value: 'interrupt', reply_kind: 'queue_action' },
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
});

describe('isQueueActionValue', () => {
  it('matches exactly the bridge-controlled wire values', () => {
    expect(isQueueActionValue('interrupt')).toBe(true);
    expect(isQueueActionValue('cancel:0')).toBe(true);
    expect(isQueueActionValue('cancel:12')).toBe(true);
    expect(isQueueActionValue('cancel')).toBe(false);
    expect(isQueueActionValue('cancel:x')).toBe(false);
    expect(isQueueActionValue('send')).toBe(false);
    expect(isQueueActionValue('opt_a')).toBe(false);
    expect(isQueueActionValue(null)).toBe(false);
    expect(isQueueActionValue(undefined)).toBe(false);
  });
});

describe('isQueueActionFrame', () => {
  it('is true for a published queue-action tile (every option stamped reply_kind:queue_action)', () => {
    expect(isQueueActionFrame({
      options: [
        { id: 'cancel', label: '✕ Cancel', value: 'cancel:0', reply_kind: QUEUE_ACTION_REPLY_KIND },
        { id: 'interrupt', label: '⚡ Send now', value: 'interrupt', reply_kind: QUEUE_ACTION_REPLY_KIND },
      ],
    })).toBe(true);
  });

  it('is false for an ordinary AskUserQuestion, even one whose option value looks like a queue value (#493)', () => {
    // The exact mis-route #493 guards against: an ordinary prompt offering an
    // option literally valued `interrupt` / `cancel:3` carries NO provenance
    // stamp, so it is not a queue-action frame.
    expect(isQueueActionFrame({
      options: [
        { id: 'opt_a', label: 'Interrupt the run', value: 'interrupt' },
        { id: 'opt_b', label: 'Cancel item 3', value: 'cancel:3' },
      ],
    })).toBe(false);
  });

  it('is false when only some options are stamped, or for empty/missing option sets', () => {
    expect(isQueueActionFrame({
      options: [
        { id: 'cancel', value: 'cancel:0', reply_kind: QUEUE_ACTION_REPLY_KIND },
        { id: 'interrupt', value: 'interrupt' },
      ],
    })).toBe(false);
    expect(isQueueActionFrame({ options: [] })).toBe(false);
    expect(isQueueActionFrame({})).toBe(false);
    expect(isQueueActionFrame(null)).toBe(false);
  });
});

describe('handleQueueActionValue', () => {
  it('interrupt: detaches + strips + announces (html preferred) + flushes, returns true', () => {
    const session = makeSession();
    const deps = matrixDeps();
    const handled = handleQueueActionValue('interrupt', session, deps);
    expect(handled).toBe(true);
    expect(session.queuedMessages).toBeNull();
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
    expect(deps.sendHtml).toHaveBeenCalledWith(
      '⚡ Sending 2 queued messages now:\n  1. [2 entries]',
      '<b>⚡ Sending 2 queued messages now:</b><ol><li>[2 entries]</li></ol>',
    );
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue.mock.calls[0][1]).toHaveLength(2);
  });

  it('interrupt via journal seams: plain sendReply announcement, same flush', () => {
    const session = makeSession();
    const deps = matrixDeps({ sendHtml: null });
    const handled = handleQueueActionValue('interrupt', session, deps);
    expect(handled).toBe(true);
    expect(deps.sendReply).toHaveBeenCalledWith('⚡ Sending 2 queued messages now:\n  1. [2 entries]');
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('interrupt on an empty queue is a SILENT no-op (stale-tile tap), still handled', () => {
    const session = makeSession({ queuedMessages: null });
    const deps = matrixDeps();
    expect(handleQueueActionValue('interrupt', session, deps)).toBe(true);
    expect(deps.sendHtml).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });

  it('cancel:<n> splices exactly the indexed message AND its tile, edits it, reports remaining', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(handleQueueActionValue('cancel:0', session, deps)).toBe(true);
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'second' }]]);
    expect(session.queueNotifications).toEqual([{ eventId: '$ev2', plain: '📨 Queued (2): second' }]);
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev1', '✕ 📨 Queued (1): first (cancelled)',
    );
    expect(deps.sendReply).toHaveBeenCalledWith('✕ Cancelled queued message (1 remaining)');
  });

  it('cancel of the last remaining message nulls the queue and says so', () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'solo' }]],
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): solo' }],
    });
    const deps = matrixDeps();
    handleQueueActionValue('cancel:0', session, deps);
    expect(session.queuedMessages).toBeNull();
    expect(deps.sendReply).toHaveBeenCalledWith('✕ Cancelled queued message (queue empty)');
  });

  it('cancel with an out-of-range index is a SILENT no-op (stale tile), still handled', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(handleQueueActionValue('cancel:9', session, deps)).toBe(true);
    expect(session.queuedMessages).toHaveLength(2);
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('non-queue values touch nothing and return false', () => {
    const session = makeSession();
    const deps = matrixDeps();
    expect(handleQueueActionValue('model:opus', session, deps)).toBe(false);
    expect(handleQueueActionValue('opt_a', session, deps)).toBe(false);
    expect(session.queuedMessages).toHaveLength(2);
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });
});

describe('index.js journal busy caller — queued-tile notification wiring (source inspection)', () => {
  it('the journal busy branch posts the tile via notifyQueuedMessage with the journal ctx sink', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('session.queuedMessages.push(markJournalOrigin(');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start, start + 800);
    expect(window).toMatch(/notifyQueuedMessage\(session, preview, \{/);
    expect(window).toMatch(/sendReply: ctx\.sendReply/);
  });
});

// #493: the journal prompt_reply router must dispatch a queue control on the
// router's explicit `queue_action` provenance flag — set only when the reply
// targeted a published queue-action FRAME — and NOT re-guess by the reply's
// value shape (which mis-routed ordinary answers whose value happened to be
// `interrupt`/`cancel:<n>`). index.js can't be imported in-process, so pin by
// source inspection.
describe('index.js journalOnPromptReply — queue-action routing prefers explicit provenance (#493)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('gates queue-action dispatch on answer.queue_action, not on a value-shape predicate', () => {
    const start = src.indexOf('function journalOnPromptReply(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('if (answer?.queue_action)');
    expect(body).toContain('handleQueueActionValue(answer.choice, session,');
    // The old value-shape classifier must no longer gate the queue branch.
    expect(body).not.toContain('isQueueActionValue(answer');
  });

  it('no longer imports isQueueActionValue (unused after the provenance switch)', () => {
    const importLine = src.match(/import \{[^}]*\} from '\.\/lib\/busy-queue\.js'/);
    expect(importLine).not.toBeNull();
    expect(importLine[0]).not.toContain('isQueueActionValue');
    expect(importLine[0]).toContain('handleQueueActionValue');
  });

  it('flushQueue ties frame lifecycle to the queue: it resolves the convo\'s queue-action frames after an actual flush (#493 blocker 2)', () => {
    const start = src.indexOf('function flushQueue(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('journalInputConsumer.resolveQueueActionFrames(');
    // The resolve call must live AFTER the Codex-busy early-return (which
    // re-queues and keeps the tiles live), i.e. below dispatchMergedFlush.
    const codexReturn = body.indexOf('session.codex?.interrupt');
    const resolveCall = body.indexOf('resolveQueueActionFrames(');
    expect(codexReturn).toBeGreaterThan(-1);
    expect(resolveCall).toBeGreaterThan(codexReturn);
  });
});
