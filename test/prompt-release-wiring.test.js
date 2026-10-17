import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createQueuedDispatcher } from '../lib/queued-dispatch.js';
import { createQueuedReleaseLifecycle } from '../lib/queued-release-lifecycle.js';

// Prompts the bridge resolves by itself must not stay "unanswered" in the
// user's unseen list. Queued-message cards are released with a
// queued_release prompt_reply naming the card's prompt_id (any sender
// counts); timer and reminder cards, which nothing waits on, are published
// with `blocking: false` so they never count as unanswered at all.
// index.js cannot be imported in-process, so timer wiring is pinned by source inspection (as in test/memory-wiring.test.js); the store
// side is unit-tested in test/timer-command.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('timer and reminder cards', () => {
  it('both Send-now / Cancel cards are published non-blocking, with the timer\'s prompt_id', () => {
    const payload = body('function timerCardPayload(', '\n}\n');
    expect(payload).toContain('prompt_id: timerPromptId(record),');
    expect(payload).toContain('blocking: false,');
    expect(payload).toContain("mode: 'pick_one',");
    const cards = index.match(/'pick_one', summary, escapeHtml\(summary\), timerCardPayload\(record, summary\)\);/g) || [];
    // The typed /timer confirmation and the agent's reminder_create card.
    expect(cards).toHaveLength(2);
    expect(index).not.toMatch(/\[timerSendNowButton\(record\.id\), timerCancelButton\(record\.id\)\],\s*'pick_one', summary, escapeHtml\(summary\)\);/);
  });

  // Today's apps render an unknown bridge prompt_reply as an "Answered"
  // bubble, so the card itself says it blocks nothing instead.
  it('no prompt_reply is published for a timer firing or being cancelled', () => {
    expect(index).not.toContain('timer_release');
    expect(index).not.toContain('publishTimerRelease');
  });
});

describe('queued-message cards', () => {
  function setup(delivered, alive = true) {
    const entries = [
      { itemId: 'message-a', promptId: 'prompt-a' },
      { itemId: 'message-b', promptId: 'prompt-b' },
      { itemId: 'message-c', promptId: 'prompt-c' },
    ];
    const queueRelease = {
      listLive: () => entries,
      dropItem: vi.fn((convoId, itemId) => {
        entries.splice(entries.findIndex(entry => entry.itemId === itemId), 1);
      }),
    };
    const publishPromptReply = vi.fn();
    const lifecycle = createQueuedReleaseLifecycle({
      releaseOutbox: { put: vi.fn(() => true) },
      journalPublisher: { publishPromptReply }, now: () => 123,
    });
    const emitRelease = vi.fn(lifecycle.emitRelease);
    const dispatchMergedFlush = vi.fn(() => delivered);
    const journalPublishNotice = vi.fn();
    const runQueuedCleanup = vi.fn();
    const dispatcher = createQueuedDispatcher({
      queueRelease, emitRelease, journalConvoIdFor: () => 'convo',
      dispatchMergedFlush, journalPublishNotice, runQueuedCleanup,
      log: { log: vi.fn() },
    });
    const queued = ['first', 'second'].map(text => [{ type: 'text', text }]);
    const session = { alive, roomId: 'room', queuedMessages: [],
      queueNotifications: entries.map(entry => ({ id: entry.itemId })) };
    return { dispatcher, session, queued, emitRelease, publishPromptReply,
      dispatchMergedFlush, journalPublishNotice, runQueuedCleanup, entries };
  }

  it('the turn-end flush releases the batch\'s cards as sent (queued_release naming each prompt_id)', () => {
    const h = setup(true);
    expect(h.dispatcher.flushQueue(h.session, h.queued)).toBe(true);
    expect(h.dispatchMergedFlush).toHaveBeenCalledExactlyOnceWith(h.session, h.queued);
    expect(h.dispatchMergedFlush.mock.invocationCallOrder[0])
      .toBeLessThan(h.emitRelease.mock.invocationCallOrder[0]);
    expect(h.emitRelease.mock.calls).toEqual([
      ['convo', { promptId: 'prompt-a', action: 'send', releasedIds: ['message-a'] }],
      ['convo', { promptId: 'prompt-b', action: 'send', releasedIds: ['message-b'] }],
    ]);
    expect(h.publishPromptReply.mock.calls).toEqual([
      ['convo', { kind: 'queued_release', prompt_id: 'prompt-a', action: 'send', released: ['message-a'], at: 123 },
        { idemKey: 'qr\0prompt-a\0message-a\0send' }],
      ['convo', { kind: 'queued_release', prompt_id: 'prompt-b', action: 'send', released: ['message-b'], at: 123 },
        { idemKey: 'qr\0prompt-b\0message-b\0send' }],
    ]);
    expect(h.entries).toEqual([{ itemId: 'message-c', promptId: 'prompt-c' }]);
    expect(h.journalPublishNotice).not.toHaveBeenCalled();
  });

  it('a batch dropped because the session ended releases its cards as expired', () => {
    const h = setup(false, false);
    expect(h.dispatcher.flushQueue(h.session, h.queued)).toBe(false);
    expect(h.dispatchMergedFlush).toHaveBeenCalledExactlyOnceWith(h.session, h.queued);
    expect(h.emitRelease.mock.calls).toEqual([
      ['convo', { promptId: 'prompt-a', action: 'expired', releasedIds: ['message-a'] }],
      ['convo', { promptId: 'prompt-b', action: 'expired', releasedIds: ['message-b'] }],
    ]);
    expect(h.publishPromptReply.mock.calls.map(([convoId, payload]) => [convoId, payload])).toEqual([
      ['convo', { kind: 'queued_release', prompt_id: 'prompt-a', action: 'expired', released: ['message-a'], at: 123 }],
      ['convo', { kind: 'queued_release', prompt_id: 'prompt-b', action: 'expired', released: ['message-b'], at: 123 }],
    ]);
    expect(h.runQueuedCleanup.mock.calls).toEqual(h.queued.map(entry => [entry]));
    expect(h.session.queuedMessages).toEqual([]);
    expect(h.entries).toEqual([{ itemId: 'message-c', promptId: 'prompt-c' }]);
    expect(h.journalPublishNotice).toHaveBeenCalledExactlyOnceWith('convo',
      "⚠️ Couldn't deliver 2 queued messages — the session ended before they were sent.");
  });
});

it('reads the default release clock at emission time', () => {
  const publishPromptReply = vi.fn();
  const lifecycle = createQueuedReleaseLifecycle({
    releaseOutbox: { put: vi.fn(() => true) },
    journalPublisher: { publishPromptReply },
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(456);
  try {
    expect(lifecycle.emitRelease('convo', {
      promptId: 'prompt-a', action: 'send', releasedIds: ['message-a'],
    })).toBe(true);
    expect(publishPromptReply).toHaveBeenCalledWith('convo', {
      kind: 'queued_release', prompt_id: 'prompt-a', action: 'send', released: ['message-a'], at: 456,
    }, { idemKey: 'qr\0prompt-a\0message-a\0send' });
  } finally {
    clock.mockRestore();
  }
});
