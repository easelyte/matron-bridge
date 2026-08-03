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
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data, callback) {
    this.sent.push(JSON.parse(data));
    callback?.();
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
});
