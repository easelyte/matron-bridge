import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createJournalPublisher, FLUSH_TIMEOUT_MS } from '../lib/journal-publisher.js';

// A socket whose send-confirmation is caller-controlled: send() records the
// frame + its callback but does NOT auto-confirm unless `autoConfirm` is set.
// Lets a test hold frames in the outbound queue (hasQueuedIdem / flush timeout)
// and then release them (onSendCapacity / flush drain).
class ManualSocket extends EventEmitter {
  static instances = [];
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
    this.pending = [];
    this.autoConfirm = false;
    ManualSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  send(data, callback) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (this.autoConfirm) { callback?.(); return; }
    this.pending.push({ frame, callback });
  }
  confirmAll() {
    const batch = this.pending.splice(0);
    for (const { callback } of batch) callback?.();
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() { this.close(); }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 1));
  }
}

function makePublisher(extra = {}) {
  ManualSocket.instances.length = 0;
  const publisher = createJournalPublisher({
    url: 'ws://journal.test/ws',
    token: 't',
    log: { warn() {} },
    backoffBaseMs: 1,
    backoffCapMs: 1,
    keepaliveIntervalMs: 0,
    WebSocketImpl: ManualSocket,
    ...extra,
  });
  return publisher;
}

async function connected(publisher) {
  await waitFor(() => ManualSocket.instances[0]?.sent.some(f => f.op === 'hello'));
  ManualSocket.instances[0].emit('message', JSON.stringify({ op: 'hello_ok' }));
  return ManualSocket.instances[0];
}

describe('journal-publisher — queued-release durability hooks', () => {
  it('publishPromptReply threads a deterministic idem_key onto the enqueued frame', async () => {
    const publisher = makePublisher();
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' }, { idemKey: 'qr\0pr_1\0send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    const frame = sock.sent.find(f => f.type === 'prompt_reply');
    expect(frame.idem_key).toBe('qr\0pr_1\0send');
  });

  it('publishPromptReply without options keeps a random idem_key (backward compatible)', async () => {
    const publisher = makePublisher();
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    const frame = sock.sent.find(f => f.type === 'prompt_reply');
    expect(typeof frame.idem_key).toBe('string');
    expect(frame.idem_key).not.toBe('qr\0pr_1\0send');
  });

  it('hasQueuedIdem reports a frame still sitting in the outbound queue, false once confirmed', async () => {
    const publisher = makePublisher();
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' }, { idemKey: 'qr\0pr_1\0send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    expect(publisher.hasQueuedIdem('qr\0pr_1\0send')).toBe(true);
    expect(publisher.hasQueuedIdem('qr\0other\0send')).toBe(false);
    sock.confirmAll();
    await waitFor(() => publisher.hasQueuedIdem('qr\0pr_1\0send') === false);
    expect(publisher.hasQueuedIdem('qr\0pr_1\0send')).toBe(false);
  });

  it('onSendCapacity fires when pump confirms a send and the queue has headroom (send-completion trigger)', async () => {
    const onSendCapacity = vi.fn();
    const publisher = makePublisher({ onSendCapacity });
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' }, { idemKey: 'qr\0pr_1\0send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    expect(onSendCapacity).not.toHaveBeenCalled(); // not yet confirmed
    sock.confirmAll();
    await waitFor(() => onSendCapacity.mock.calls.length > 0);
    expect(onSendCapacity).toHaveBeenCalled();
  });

  it('flush() resolves drained:true once the queue drains', async () => {
    const publisher = makePublisher();
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' }, { idemKey: 'qr\0pr_1\0send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    const flushed = publisher.flush({ timeoutMs: 500 });
    sock.confirmAll();
    await expect(flushed).resolves.toEqual({ drained: true });
  });

  it('flush() resolves drained:false on a dead socket within the timeout (does not hang)', async () => {
    const publisher = makePublisher();
    const sock = await connected(publisher);
    publisher.publishPromptReply('convo-1', { kind: 'queued_release', prompt_id: 'pr_1', action: 'send' }, { idemKey: 'qr\0pr_1\0send' });
    await waitFor(() => sock.sent.some(f => f.type === 'prompt_reply'));
    // never confirm -> the frame stays queued
    await expect(publisher.flush({ timeoutMs: 30 })).resolves.toEqual({ drained: false });
  });

  it('flush() on an empty queue resolves drained:true immediately', async () => {
    const publisher = makePublisher();
    await connected(publisher);
    await expect(publisher.flush({ timeoutMs: 5 })).resolves.toEqual({ drained: true });
  });

  it('exports a sane FLUSH_TIMEOUT_MS default', () => {
    expect(FLUSH_TIMEOUT_MS).toBe(2000);
  });
});
