import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import {
  DEFAULT_EDIT_HOLD_MS,
  firstHeldIndex,
  holdEntry,
  isEditHeld,
  releaseEntry,
} from '../lib/queue-edit-hold.js';
import { batchDeferralReason, compactBatchSize } from '../lib/compact-priority.js';
import { queueFlushNotice } from '../lib/queue-flush-notice.js';
import {
  handleBusyQueueMagicWord,
  notifyQueuedMessage,
  QUEUE_EDIT_HELD_REPLY,
  resolveQueueReleaseTap,
} from '../lib/busy-queue.js';
import { markJournalOrigin, isJournalOrigin } from '../lib/queue-flush.js';

// Edit on a queued message: the message is held while the user edits it, so
// no flush delivers the half-edited original, and a saved edit replaces the
// text in the same queue slot.

const text = (t) => [{ type: 'text', text: t }];

afterEach(() => { vi.useRealTimers(); });

describe('queue-edit-hold', () => {
  it('holds and releases an entry without leaking into JSON', () => {
    const entry = text('hello');
    expect(isEditHeld(entry)).toBe(false);
    expect(holdEntry(entry)).toBe(true);
    expect(isEditHeld(entry)).toBe(true);
    expect(JSON.stringify(entry)).toBe('[{"type":"text","text":"hello"}]');
    expect(releaseEntry(entry)).toBe(true);
    expect(isEditHeld(entry)).toBe(false);
    expect(releaseEntry(entry)).toBe(false);
  });

  it('keeps other non-enumerable tags (journal origin) on the entry', () => {
    const entry = markJournalOrigin(text('hello'));
    holdEntry(entry);
    releaseEntry(entry);
    expect(isJournalOrigin(entry)).toBe(true);
  });

  it('expires after the hold length, calling onExpire once', () => {
    vi.useFakeTimers();
    const entry = text('hello');
    const onExpire = vi.fn();
    holdEntry(entry, { holdMs: 1000, onExpire });
    vi.advanceTimersByTime(999);
    expect(isEditHeld(entry)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isEditHeld(entry)).toBe(false);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith(entry);
  });

  it('never calls onExpire after a release, and a re-hold renews the timer', () => {
    vi.useFakeTimers();
    const entry = text('hello');
    const onExpire = vi.fn();
    holdEntry(entry, { holdMs: 1000, onExpire });
    vi.advanceTimersByTime(800);
    holdEntry(entry, { holdMs: 1000, onExpire });
    vi.advanceTimersByTime(800);
    expect(isEditHeld(entry)).toBe(true);
    releaseEntry(entry);
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('defaults to a ten-minute hold', () => {
    expect(DEFAULT_EDIT_HOLD_MS).toBe(10 * 60 * 1000);
  });

  it('firstHeldIndex finds the first held entry', () => {
    const queue = [text('a'), text('b'), text('c')];
    expect(firstHeldIndex(queue)).toBe(-1);
    holdEntry(queue[2]);
    holdEntry(queue[1]);
    expect(firstHeldIndex(queue)).toBe(1);
    expect(firstHeldIndex(null)).toBe(-1);
    releaseEntry(queue[1]); releaseEntry(queue[2]);
  });
});

describe('compactBatchSize — edit holds', () => {
  it('stops the batch just before the first held entry', () => {
    const queue = [text('a'), text('b'), text('c')];
    holdEntry(queue[1]);
    expect(compactBatchSize(queue)).toBe(1);
    releaseEntry(queue[1]);
    expect(compactBatchSize(queue)).toBe(3);
  });

  it('is empty when the front entry is held', () => {
    const queue = [text('a'), text('b')];
    holdEntry(queue[0]);
    expect(compactBatchSize(queue)).toBe(0);
    releaseEntry(queue[0]);
  });

  it('still sends a leading /compact alone ahead of a held message', () => {
    const queue = [text('/compact'), text('b')];
    holdEntry(queue[1]);
    expect(compactBatchSize(queue)).toBe(1);
    releaseEntry(queue[1]);
  });
});

function cardSession(texts) {
  const sendButtonMessage = vi.fn(async () => '$tile');
  return {
    roomId: '!room',
    busy: true,
    alive: true,
    queuedMessages: [],
    queueNotifications: [],
    sendButtonMessage,
    _texts: texts,
  };
}

// Queues each text with its card, as the journal text path does, against a
// small fake of the router's release registry.
async function queueAll(session, texts, registry, extra = {}) {
  for (const t of texts) {
    session.queuedMessages.push(markJournalOrigin(text(t)));
    await notifyQueuedMessage(session, t, {
      sendReply: vi.fn(),
      queueRelease: registry,
      convoId: 'c1',
      fullText: t,
      allowSendOne: true,
      editMode: 'replace',
      ...extra,
    });
  }
}

function fakeRegistry() {
  const live = new Map(); // itemId -> promptId
  return {
    live,
    noteQueued: vi.fn((convoId, { promptId, itemId }) => { live.set(itemId, promptId); }),
    dropItem: vi.fn((convoId, itemId) => { live.delete(itemId); }),
    listLive: vi.fn(() => [...live].map(([itemId, promptId]) => ({ itemId, promptId }))),
  };
}

const entryFor = (session, i) => {
  const id = session.queueNotifications[i].id;
  return { prompt_id: id.replace(/::0$/, ''), itemIds: [id], seq: 10 + i };
};

describe('notifyQueuedMessage — edit', () => {
  it('names the edit mode and hold on the card, outside actions and options', async () => {
    const session = cardSession();
    await queueAll(session, ['hello'], fakeRegistry(), { editHoldMs: 600000 });
    const args = session.sendButtonMessage.mock.calls[0];
    const payload = args[args.length - 1];
    expect(payload.edit).toEqual({ mode: 'replace', hold_seconds: 600 });
    expect(payload.actions.map(a => a.id)).not.toContain('edit');
    expect(payload.options.map(o => o.value)).not.toContain('edit');
    expect(session.queueNotifications[0].editMode).toBe('replace');
  });

  it('offers no edit when the call site gives no edit mode', async () => {
    const session = cardSession();
    await queueAll(session, ['hello'], fakeRegistry(), { editMode: null });
    const args = session.sendButtonMessage.mock.calls[0];
    expect('edit' in args[args.length - 1]).toBe(false);
    expect('editMode' in session.queueNotifications[0]).toBe(false);
  });

  it('a resend-mode card (a tracker reply) says so', async () => {
    const session = cardSession();
    await queueAll(session, ['reply'], fakeRegistry(), {
      editMode: 'resend', source: { item_id: 'it_1', comment_id: 'ic_1' },
    });
    const args = session.sendButtonMessage.mock.calls[0];
    expect(args[args.length - 1].edit.mode).toBe('resend');
  });

  it('insertAt puts the replacement card in the old slot', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b', 'c'], registry);
    const [first, , third] = session.queueNotifications;
    session.queueNotifications.splice(1, 1);
    await notifyQueuedMessage(session, 'B!', {
      sendReply: vi.fn(), queueRelease: registry, convoId: 'c1', fullText: 'B!',
      allowSendOne: true, editMode: 'replace', insertAt: 1,
    });
    expect(session.queueNotifications).toHaveLength(3);
    expect(session.queueNotifications[0]).toBe(first);
    expect(session.queueNotifications[2]).toBe(third);
    expect(session.queueNotifications[1].plain).toBe('📨 Queued (edited): B!');
    const args = session.sendButtonMessage.mock.calls[3];
    expect(args[args.length - 1].items[0].text).toBe('B!');
  });
});

function tapDeps(session, registry, overrides = {}) {
  return {
    flushQueue: vi.fn(() => true),
    // index.js's clearQueueNotifications, as the send path is given it.
    stripQueueNotificationLinks: vi.fn((s) => { s.queueNotifications = []; }),
    convoId: 'c1',
    queueRelease: registry,
    emitRelease: vi.fn((convoId, release, { mutate } = {}) => { mutate?.(); return true; }),
    notify: vi.fn(),
    onHoldExpired: vi.fn(),
    onHoldReleased: vi.fn(),
    postEditedCard: vi.fn((s, { index, text: t }) => notifyQueuedMessage(s, t, {
      sendReply: vi.fn(), queueRelease: registry, convoId: 'c1', fullText: t,
      allowSendOne: true, editMode: 'replace', insertAt: index,
    })),
    ...overrides,
  };
}

describe('resolveQueueReleaseTap — edit', () => {
  it('edit holds the tapped message, so flushes stop before it', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b'], registry);
    const deps = tapDeps(session, registry);
    expect(resolveQueueReleaseTap('edit', session, { ...deps, entry: entryFor(session, 1) })).toBe(true);
    expect(isEditHeld(session.queuedMessages[1])).toBe(true);
    expect(compactBatchSize(session.queuedMessages)).toBe(1);
    expect(deps.notify).not.toHaveBeenCalled();
    releaseEntry(session.queuedMessages[1]);
  });

  it('send (all) holds back a message being edited and everything after it', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b', 'c'], registry);
    const deps = tapDeps(session, registry);
    resolveQueueReleaseTap('edit', session, { ...deps, entry: entryFor(session, 1) });
    resolveQueueReleaseTap('send', session, { ...deps, entry: entryFor(session, 0) });
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue.mock.calls[0][1].map(e => e[0].text)).toEqual(['a']);
    expect(session.queuedMessages.map(e => e[0].text)).toEqual(['b', 'c']);
    expect(session.queueNotifications).toHaveLength(2);
    releaseEntry(session.queuedMessages[0]);
  });

  it('edit_cancel releases the hold with the original text and reports the release', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 0);
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('edit_cancel', session, { ...deps, entry });
    expect(isEditHeld(session.queuedMessages[0])).toBe(false);
    expect(session.queuedMessages[0][0].text).toBe('a');
    expect(deps.onHoldReleased).toHaveBeenCalledWith(session);
    expect(deps.emitRelease).not.toHaveBeenCalled();
  });

  it('edit_save replaces the text in place, retires the card as edited and posts a new one in its slot', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b', 'c'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 1);
    const held = session.queuedMessages[1];
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: '  b, edited  ' });

    expect(session.queuedMessages.map(e => e[0].text)).toEqual(['a', 'b, edited', 'c']);
    // Same array: its journal origin and turn causes ride along.
    expect(session.queuedMessages[1]).toBe(held);
    expect(isJournalOrigin(held)).toBe(true);
    expect(isEditHeld(held)).toBe(false);
    expect(deps.emitRelease).toHaveBeenCalledWith('c1', {
      promptId: entry.prompt_id, action: 'edited', releasedIds: [entry.itemIds[0]],
    }, expect.any(Object));
    expect(registry.dropItem).toHaveBeenCalledWith('c1', entry.itemIds[0]);
    // Aligned again, with a fresh card id in the edited slot.
    expect(session.queueNotifications).toHaveLength(3);
    expect(session.queueNotifications[1].id).not.toBe(entry.itemIds[0]);
    expect(session.queueNotifications[1].plain).toBe('📨 Queued (edited): b, edited');
    // The idle flush waits for the replacement card to be published.
    await vi.waitFor(() => expect(deps.onHoldReleased).toHaveBeenCalledWith(session));
  });

  it('edit_save releases the queue only after the replacement card is published', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    let publish;
    const deps = tapDeps(session, registry, {
      postEditedCard: vi.fn(() => new Promise((resolve) => { publish = resolve; })),
    });
    const entry = entryFor(session, 0);
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: 'new' });
    await Promise.resolve();
    expect(deps.onHoldReleased).not.toHaveBeenCalled();
    publish('$card');
    await vi.waitFor(() => expect(deps.onHoldReleased).toHaveBeenCalledTimes(1));
  });

  it('cancelling a held message releases the queue behind it', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 0);
    const held = session.queuedMessages[0];
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('cancel', session, { ...deps, entry });
    expect(session.queuedMessages.map(e => e[0].text)).toEqual(['b']);
    expect(isEditHeld(held)).toBe(false);
    expect(compactBatchSize(session.queuedMessages)).toBe(1);
    expect(deps.onHoldReleased).toHaveBeenCalledWith(session);
  });

  it('edit_save that cannot write its release changes nothing', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    const deps = tapDeps(session, registry, { emitRelease: vi.fn(() => false) });
    const entry = entryFor(session, 0);
    const card = session.queueNotifications[0];
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: 'new' });
    expect(session.queuedMessages[0][0].text).toBe('a');
    expect(session.queueNotifications).toEqual([card]);
    expect(deps.postEditedCard).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/Couldn't save the edit/));
    releaseEntry(session.queuedMessages[0]);
  });

  it('an empty edit_save keeps the original and the hold', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 0);
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: '   ' });
    expect(session.queuedMessages[0][0].text).toBe('a');
    expect(isEditHeld(session.queuedMessages[0])).toBe(true);
    expect(deps.emitRelease).not.toHaveBeenCalled();
    releaseEntry(session.queuedMessages[0]);
  });

  it('edit_save on a message that already left the queue says the edit was not used', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 0);
    session.queuedMessages = null;
    session.queueNotifications = [];
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: 'new' });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/already gone/));
    expect(deps.emitRelease).not.toHaveBeenCalled();
  });

  it('a resend-mode card can be held but not saved in place', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['reply'], registry, {
      editMode: 'resend', source: { item_id: 'it_1', comment_id: 'ic_1' },
    });
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 0);
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    expect(isEditHeld(session.queuedMessages[0])).toBe(true);
    resolveQueueReleaseTap('edit_save', session, { ...deps, entry, text: 'x' });
    expect(session.queuedMessages[0][0].text).toBe('reply');
    expect(deps.emitRelease).not.toHaveBeenCalled();
    // The app's cancel then drops it as usual.
    resolveQueueReleaseTap('cancel', session, { ...deps, entry });
    expect(session.queuedMessages).toBeNull();
  });

  it('a card offering no edit refuses one', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry, { editMode: null });
    const deps = tapDeps(session, registry);
    resolveQueueReleaseTap('edit', session, { ...deps, entry: entryFor(session, 0) });
    expect(isEditHeld(session.queuedMessages[0])).toBe(false);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/can't be edited/));
  });

  it('send_one on a held message sends it as it stands', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b'], registry);
    const deps = tapDeps(session, registry);
    const entry = entryFor(session, 1);
    resolveQueueReleaseTap('edit', session, { ...deps, entry });
    resolveQueueReleaseTap('send_one', session, { ...deps, entry });
    const sent = deps.flushQueue.mock.calls[0][1][0];
    expect(sent[0].text).toBe('b');
    expect(isEditHeld(sent)).toBe(false);
  });

  it('a hold that expires calls onHoldExpired with the entry', async () => {
    vi.useFakeTimers();
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a'], registry);
    const deps = tapDeps(session, registry, { editHoldMs: 5000 });
    resolveQueueReleaseTap('edit', session, { ...deps, entry: entryFor(session, 0) });
    vi.advanceTimersByTime(5000);
    expect(isEditHeld(session.queuedMessages[0])).toBe(false);
    expect(deps.onHoldExpired).toHaveBeenCalledWith(session.queuedMessages[0]);
  });
});

describe('flush notices for a hold split', () => {
  it('echoes what went and says the rest wait for an edit, not a compaction', () => {
    const n = queueFlushNotice('turnEnd', {
      queued: 1, deferred: 2, deferredBy: batchDeferralReason([text('a')]),
      summary: { plain: '  1. a', html: '<ol><li>a</li></ol>' },
    });
    expect(n.plain).toBe('📬 Sending 1 queued message:\n  1. a\n— the other 2 queued messages wait while a queued message is being edited.');
    expect(n.plain).not.toMatch(/compact/);
  });

  it('a lone leading /compact is still a compaction split', () => {
    expect(batchDeferralReason([text('/compact')])).toBe('compact');
    expect(batchDeferralReason([text('a')])).toBe('edit');
    expect(batchDeferralReason([text('/compact'), text('a')])).toBe('edit');
  });

  it('a card tap that sends the batch ahead of a held message says why the rest stayed', async () => {
    const session = cardSession();
    const registry = fakeRegistry();
    await queueAll(session, ['a', 'b'], registry);
    const deps = tapDeps(session, registry, { formatQueueSummary: (q) => ({ plain: `[${q.length}]`, html: '' }) });
    resolveQueueReleaseTap('edit', session, { ...deps, entry: entryFor(session, 1) });
    resolveQueueReleaseTap('send', session, { ...deps, entry: entryFor(session, 0) });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/being edited/));
    releaseEntry(session.queuedMessages[0]);
  });
});

describe('handleBusyQueueMagicWord — send with a held message', () => {
  it('says the next message is being edited instead of "no queued messages"', async () => {
    const session = {
      busy: true,
      queuedMessages: [text('a')],
      queueNotifications: [{ eventId: '$1', plain: 'p' }],
    };
    holdEntry(session.queuedMessages[0]);
    const sendReply = vi.fn(async () => {});
    const flushQueue = vi.fn(() => true);
    await handleBusyQueueMagicWord(session, 'send', {
      sendReply, flushQueue, formatQueueSummary: () => ({ plain: '', html: '' }),
    });
    expect(flushQueue).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(QUEUE_EDIT_HELD_REPLY);
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queueNotifications).toHaveLength(1);
    releaseEntry(session.queuedMessages[0]);
  });
});

describe('wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const router = readFileSync(new URL('../lib/journal-input-router.js', import.meta.url), 'utf-8');

  it('the router accepts the three edit actions on a queue card', () => {
    expect(router).toMatch(/QUEUED_RELEASE_ACTIONS = new Set\(\[[^\]]*'edit', 'edit_save', 'edit_cancel'/);
  });

  it('the queue-card tap passes the reply text and the hold seams', () => {
    const start = src.indexOf('resolveQueueReleaseTap(answer.choice, session, {');
    const args = src.slice(start, src.indexOf('});', start));
    expect(args).toMatch(/text: answer\?\.text/);
    expect(args).toMatch(/onHoldExpired: queueEditHoldExpired/);
    expect(args).toMatch(/onHoldReleased: queueEditHoldReleased/);
    expect(args).toMatch(/postEditedCard: postEditedQueueCard/);
  });

  it('the turn-end flush sends nothing while the front message is held', () => {
    const start = src.indexOf('function flushPendingSessionQueue(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/if \(batchSize === 0\) return false;/);
  });

  it('a released hold flushes only when the session is genuinely free', () => {
    const start = src.indexOf('function queueEditHoldReleased(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/sessionOccupiedForRoomDelivery\(session\)/);
  });

  it('the /cancel-queued endpoint releases the queue behind a cancelled held message', () => {
    const start = src.indexOf("url.pathname === '/cancel-queued'");
    const body = src.slice(start, src.indexOf("url.pathname === '/message'", start));
    expect(body).toMatch(/queueEditHoldReleased\(session\)/);
  });

  it('typed text offers in-place edit (not a jumping /compact); tracker replies offer resend', () => {
    expect(src).toMatch(/editMode: compactJump \? null : 'replace'/);
    expect(src).toMatch(/editMode: source\?\.item_id && source\?\.comment_id \? 'resend' : null/);
  });
});
