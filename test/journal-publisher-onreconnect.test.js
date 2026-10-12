import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createJournalPublisher } from '../lib/journal-publisher.js';

class ControlledWebSocket extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
    this.confirmations = [];
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data, callback) {
    this.sent.push(JSON.parse(data));
    if (this.deferSends && callback) this.confirmations.push(callback);
    else callback?.();
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('journal publisher onReconnect', () => {
  it('fires once per hello_ok across reconnect epochs and never before the first hello_ok', async () => {
    ControlledWebSocket.instances.length = 0;
    const reconnects = [];
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {} },
      backoffBaseMs: 1,
      backoffCapMs: 1,
      keepaliveIntervalMs: 0,
      WebSocketImpl: ControlledWebSocket,
      onReconnect: () => reconnects.push(ControlledWebSocket.instances.length),
    });

    await waitFor(() => ControlledWebSocket.instances[0]?.sent.some(frame => frame.op === 'hello'));
    expect(reconnects).toEqual([]);

    ControlledWebSocket.instances[0].emit('message', JSON.stringify({ op: 'hello_ok' }));
    expect(reconnects).toEqual([1]);

    ControlledWebSocket.instances[0].close();
    await waitFor(() => ControlledWebSocket.instances[1]?.sent.some(frame => frame.op === 'hello'));
    expect(reconnects).toEqual([1]);

    ControlledWebSocket.instances[1].emit('message', JSON.stringify({ op: 'hello_ok' }));
    expect(reconnects).toEqual([1, 2]);

    publisher.close();
  });
  it('drops a superseded terminal repair before a resumed child drains', async () => {
    ControlledWebSocket.instances.length = 0;
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
      WebSocketImpl: ControlledWebSocket, queueLimit: 2, keepaliveIntervalMs: 0,
    });
    try {
      await waitFor(() => ControlledWebSocket.instances[0]?.sent.some(frame => frame.op === 'hello'));
      const socket = ControlledWebSocket.instances[0];
      socket.deferSends = true;
      publisher.upsertConvo('box-a', { sessionState: 'running' });
      publisher.upsertConvo('alice', { sessionState: 'running' });
      socket.emit('message', JSON.stringify({ op: 'hello_ok' }));
      let repaired = false;
      expect(publisher.upsertConvoBestEffort('bob', { parentConvoId: 'alice', sessionState: 'done' },
        { onDelivered: () => { repaired = true; } })).toBe(false);
      publisher.upsertConvo('bob', { parentConvoId: 'alice', sessionState: 'running' });
      for (let i = 0; i < 10; i++) {
        socket.confirmations.splice(0).forEach(confirm => confirm());
        await Promise.resolve();
      }
      const states = socket.sent.filter(frame => frame.convo_id === 'bob').map(frame => frame.session_state);
      expect(states).toEqual(['running']);
      expect(states.at(-1)).toBe('running');
      expect(repaired).toBe(false);
    } finally {
      publisher.close();
    }
  });

});
