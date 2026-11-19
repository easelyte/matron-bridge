import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleBusyQueueMagicWord, notifyQueuedMessage, resolveQueueReleaseTap } from '../lib/busy-queue.js';
import { markBridgeOrigin } from '../lib/queue-flush.js';

// Bridge-made turns (reminders, carry-ons, "secret submitted") sit in the queue
// with no card. Every user-facing queue command must act on the entries the
// user made and leave the hidden ones alone.

const userEntry = (text) => [{ type: 'text', text }];
const bridgeEntry = (text) => markBridgeOrigin([{ type: 'text', text }]);

function sessionWith(entries) {
  return {
    roomId: '!room', busy: true,
    queuedMessages: entries.map(([kind, text]) => (kind === 'bridge' ? bridgeEntry(text) : userEntry(text))),
    queueNotifications: entries.map(([kind, text], i) => (kind === 'bridge'
      ? { id: null, eventId: null, plain: text }
      : { id: `pr_${i}::0`, eventId: `$ev${i}`, plain: `📨 Queued (${i + 1}): ${text}` })),
  };
}

const deps = () => ({
  sendReply: vi.fn(async () => {}),
  formatQueueSummary: () => ({ plain: '' }),
  flushQueue: vi.fn(() => true),
});

describe('typed cancel skips bridge-made entries', () => {
  it('user message, then a bridge turn, then cancel: removes the user message, keeps the bridge turn', async () => {
    const session = sessionWith([['user', 'mine'], ['bridge', 'reminder']]);
    const d = deps();
    await handleBusyQueueMagicWord(session, 'cancel', d);
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0][0].text).toBe('reminder');
    expect(session.queueNotifications).toHaveLength(1);
    expect(session.queueNotifications[0].plain).toBe('reminder');
    expect(d.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('counts only user-made entries in the reply', async () => {
    const session = sessionWith([['user', 'a'], ['user', 'b'], ['bridge', 'reminder'], ['bridge', 'carry-on']]);
    const d = deps();
    await handleBusyQueueMagicWord(session, 'cancel', d);
    expect(session.queuedMessages.map(e => e[0].text)).toEqual(['a', 'reminder', 'carry-on']);
    expect(d.sendReply).toHaveBeenCalledWith('Cancelled queued message (1 remaining).');
  });

  it('only bridge entries queued: nothing to cancel, queue untouched', async () => {
    const session = sessionWith([['bridge', 'reminder'], ['bridge', 'secret submitted']]);
    const d = deps();
    await handleBusyQueueMagicWord(session, 'cancel', d);
    expect(session.queuedMessages).toHaveLength(2);
    expect(session.queueNotifications).toHaveLength(2);
    expect(d.sendReply).toHaveBeenCalledWith('No queued messages to cancel.');
  });
});

describe('counts on cards and replies ignore bridge-made entries', () => {
  it('the card for a user message queued behind a bridge turn reads as the first queued message', async () => {
    const session = sessionWith([['bridge', 'reminder']]);
    session.queuedMessages.push(userEntry('mine'));
    session.sendButtonMessage = vi.fn(async () => '$card');
    await notifyQueuedMessage(session, 'mine', {
      sendReply: vi.fn(), queueRelease: { noteQueued: vi.fn() }, convoId: 'c',
    });
    const [plain] = session.sendButtonMessage.mock.calls[0];
    expect(plain).toBe('📨 Queued (1): mine');
  });

  it('send_one reports only user-made entries as still waiting', () => {
    const session = sessionWith([['user', 'a'], ['bridge', 'reminder'], ['user', 'b']]);
    const notify = vi.fn();
    const queueRelease = { dropItem: vi.fn(), listLive: vi.fn(() => []) };
    resolveQueueReleaseTap('send_one', session, {
      entry: { prompt_id: 'pr_0', itemIds: ['pr_0::0'] },
      flushQueue: vi.fn(() => true),
      formatQueueSummary: () => ({ plain: 'x' }),
      notify, queueRelease, emitRelease: vi.fn(), convoId: 'c',
    });
    expect(notify.mock.calls[0][0]).toMatch(/the other 1 \w+ stays queued/);
  });
});

describe('the positional /cancel-queued endpoint', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = src.indexOf("url.pathname === '/cancel-queued'");
  const body = src.slice(start, src.indexOf("url.pathname === '/message'", start));
  it('refuses a bridge-made slot and counts only user-made entries', () => {
    expect(body).toMatch(/isBridgeOrigin\(queue\[/);
    expect(body).toMatch(/countUserQueued\(/);
  });
});
