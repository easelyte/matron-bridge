import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import {
  dispatchBusyQueueMagicWord,
  handleBusyQueueMagicWord,
  notifyQueuedMessage,
  isQueueReleaseTap,
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
});

describe('isQueueReleaseTap', () => {
  it('matches exactly the bridge-controlled wire values', () => {
    expect(isQueueReleaseTap('interrupt')).toBe(true);
    expect(isQueueReleaseTap('cancel:0')).toBe(true);
    expect(isQueueReleaseTap('cancel:12')).toBe(true);
    expect(isQueueReleaseTap('cancel')).toBe(false);
    expect(isQueueReleaseTap('cancel:x')).toBe(false);
    expect(isQueueReleaseTap('send')).toBe(false);
    expect(isQueueReleaseTap('opt_a')).toBe(false);
    expect(isQueueReleaseTap(null)).toBe(false);
    expect(isQueueReleaseTap(undefined)).toBe(false);
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

describe('queued-release publisher wiring', () => {
  it('emitRelease publishes exactly one structured prompt_reply per call', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('function emitRelease(convoId, { promptId, action, releasedIds })');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n\nfunction journalUpsertConvo', start);
    expect(end).toBeGreaterThan(start);

    const publishPromptReply = vi.fn();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_722_000_000_000);
    const emitRelease = runInNewContext(
      `(${src.slice(start, end + 2)})`,
      { journalPublisher: { publishPromptReply }, Date },
    );

    try {
      emitRelease('convo-1', {
        promptId: 'pr_123',
        action: 'cancel',
        releasedIds: ['pr_123::0'],
      });

      expect(publishPromptReply).toHaveBeenCalledTimes(1);
      expect(publishPromptReply).toHaveBeenCalledWith('convo-1', {
        kind: 'queued_release',
        prompt_id: 'pr_123',
        action: 'cancel',
        released: ['pr_123::0'],
        at: 1_722_000_000_000,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('the durable publisher exposes prompt_reply through safePublish', () => {
    const src = readFileSync(new URL('../lib/journal-publisher.js', import.meta.url), 'utf-8');
    expect(src).toMatch(
      /publishPromptReply\(convoId,\s*payload\)\s*\{\s*safePublish\(convoId,\s*['"]prompt_reply['"],\s*payload\);\s*\}/,
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
    const start = src.indexOf('function finalizeSentQueue(');
    const end = src.indexOf('\nfunction splitMessage(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const emitRelease = vi.fn();
    const dropItem = vi.fn();
    const listLive = vi.fn(() => [
      { promptId: 'pr_1', itemId: 'pr_1::0' },
      { promptId: 'pr_2', itemId: 'pr_2::0' },
    ]);
    const dispatchMergedFlush = vi.fn(() => dispatchResult);
    const flushQueue = runInNewContext(
      `(() => { ${src.slice(start, end)}; return flushQueue; })()`,
      {
        AGENT_CODEX: 'codex',
        console: { log: vi.fn() },
        dispatchMergedFlush,
        emitRelease,
        journalConvoIdFor: () => 'convo-1',
        journalInputConsumer: {
          queueRelease: { listLive, dropItem },
        },
      },
    );
    return { flushQueue, emitRelease, dropItem, listLive, dispatchMergedFlush };
  }

  it('commits every release exactly once, only after merged dispatch accepts the batch', () => {
    const harness = loadFlushHarness();
    const queued = [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]];
    const session = { agent: 'claude', busy: false, queuedMessages: null, roomId: '!room' };

    expect(harness.flushQueue(session, queued)).toBe(true);
    expect(harness.dispatchMergedFlush).toHaveBeenCalledWith(session, queued);
    expect(harness.emitRelease).toHaveBeenCalledTimes(2);
    expect(harness.dropItem).toHaveBeenCalledTimes(2);
    expect(harness.dispatchMergedFlush.mock.invocationCallOrder[0])
      .toBeLessThan(harness.emitRelease.mock.invocationCallOrder[0]);
  });

  it('rolls the batch back without emitting or dropping releases when dispatch rejects it', () => {
    const harness = loadFlushHarness({ dispatchResult: false });
    const queued = [[{ type: 'text', text: 'retry me' }]];
    const later = [[{ type: 'text', text: 'arrived later' }]];
    const session = { agent: 'claude', busy: false, queuedMessages: later, roomId: '!room' };

    expect(harness.flushQueue(session, queued)).toBe(false);
    expect(session.queuedMessages).toEqual([...queued, ...later]);
    expect(harness.emitRelease).not.toHaveBeenCalled();
    expect(harness.dropItem).not.toHaveBeenCalled();
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
    expect(harness.emitRelease).not.toHaveBeenCalled();

    session.busy = false;
    session.queuedMessages = null;
    expect(harness.flushQueue(session, queued, snapshot)).toBe(true);
    expect(harness.emitRelease).toHaveBeenCalledTimes(1);
    expect(harness.dropItem).toHaveBeenCalledTimes(1);
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
