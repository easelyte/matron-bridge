import { describe, it, expect, vi } from 'vitest';
import { handleBusyQueueMagicWord, scopedQueueRelease } from '../lib/busy-queue.js';
import { holdEntry, isEditHeld } from '../lib/queue-edit-hold.js';

// A typed `cancel` removes the LAST message the user queued. The release
// seam it is handed lists only the cards of the next flush batch, which is a
// prefix of the queue: just the /compact when one has jumped to the front.
// The cancelled message's card is then outside that list, and must still be
// retired with a durable `cancel` release.

function registryOf(entries) {
  const live = [...entries];
  return {
    listLive: vi.fn(() => [...live]),
    dropItem: vi.fn((convoId, itemId) => {
      const i = live.findIndex(entry => entry.itemId === itemId);
      if (i >= 0) live.splice(i, 1);
    }),
  };
}

// "a", "b" queued, then a /compact that jumped to the front.
function compactJumpedSession() {
  return {
    busy: true,
    queuedMessages: [
      [{ type: 'text', text: '/compact' }],
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
    ],
    queueNotifications: [
      { id: 'pr_c::0', eventId: '$c', plain: 'compact' },
      { id: 'pr_a::0', eventId: '$a', plain: 'a' },
      { id: 'pr_b::0', eventId: '$b', plain: 'b' },
    ],
  };
}

function depsFor(registry, batchItemIds, overrides = {}) {
  return {
    sendReply: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(),
    flushQueue: vi.fn(() => true),
    queueRelease: scopedQueueRelease(registry, new Set(batchItemIds)),
    convoId: 'convo-1',
    emitRelease: vi.fn((convoId, release, { mutate }) => { mutate(); return true; }),
    ...overrides,
  };
}

describe('typed cancel with a release seam scoped to the next flush batch', () => {
  it('retires the cancelled card when a /compact has jumped the queue', async () => {
    const registry = registryOf([
      { promptId: 'pr_c', itemId: 'pr_c::0' },
      { promptId: 'pr_a', itemId: 'pr_a::0' },
      { promptId: 'pr_b', itemId: 'pr_b::0' },
    ]);
    const session = compactJumpedSession();
    const deps = depsFor(registry, ['pr_c::0']);

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages.map(blocks => blocks[0].text)).toEqual(['/compact', 'a']);
    expect(session.queueNotifications.map(n => n.id)).toEqual(['pr_c::0', 'pr_a::0']);
    expect(deps.emitRelease).toHaveBeenCalledTimes(1);
    expect(deps.emitRelease.mock.calls[0][0]).toBe('convo-1');
    expect(deps.emitRelease.mock.calls[0][1]).toEqual({
      promptId: 'pr_b',
      action: 'cancel',
      releasedIds: ['pr_b::0'],
    });
    expect(registry.dropItem).toHaveBeenCalledWith('convo-1', 'pr_b::0');
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (2 remaining).');
  });

  it('keeps the message queued when the durable release cannot be written', async () => {
    const registry = registryOf([
      { promptId: 'pr_c', itemId: 'pr_c::0' },
      { promptId: 'pr_b', itemId: 'pr_b::0' },
    ]);
    const session = compactJumpedSession();
    const deps = depsFor(registry, ['pr_c::0'], { emitRelease: vi.fn(() => false) });

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages).toHaveLength(3);
    expect(registry.dropItem).not.toHaveBeenCalled();
  });

  it('the scoped seam still lists only the batch for a send', () => {
    const registry = registryOf([
      { promptId: 'pr_c', itemId: 'pr_c::0' },
      { promptId: 'pr_b', itemId: 'pr_b::0' },
    ]);
    const seam = scopedQueueRelease(registry, new Set(['pr_c::0']));
    expect(seam.listLive('convo-1')).toEqual([{ promptId: 'pr_c', itemId: 'pr_c::0' }]);
    expect(seam.findLive('convo-1', 'pr_b::0')).toEqual({ promptId: 'pr_b', itemId: 'pr_b::0' });
    expect(seam.findLive('convo-1', 'pr_gone::0')).toBeNull();
  });
});

describe('typed cancel of a message held for editing', () => {
  it('releases the edit hold on the removed message', async () => {
    const session = {
      busy: true,
      queuedMessages: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
      queueNotifications: [
        { id: 'pr_a::0', eventId: '$a', plain: 'a' },
        { id: 'pr_b::0', eventId: '$b', plain: 'b' },
      ],
    };
    const held = session.queuedMessages[1];
    const onExpire = vi.fn();
    vi.useFakeTimers();
    try {
      holdEntry(held, { holdMs: 1000, onExpire });
      await handleBusyQueueMagicWord(session, 'cancel', {
        sendReply: vi.fn(async () => {}),
        formatQueueSummary: vi.fn(),
        flushQueue: vi.fn(() => true),
      });
      expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'a' }]]);
      expect(isEditHeld(held)).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
