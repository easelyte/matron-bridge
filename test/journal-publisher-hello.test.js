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

describe('journal publisher hello extras', () => {
  const make = (extra) => createJournalPublisher({
    url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
    backoffBaseMs: 1, backoffCapMs: 1, keepaliveIntervalMs: 0, WebSocketImpl: ControlledWebSocket, ...extra,
  });
  const hello = async (i = 0) => {
    await waitFor(() => ControlledWebSocket.instances[i]?.sent.some((frame) => frame.op === 'hello'));
    return ControlledWebSocket.instances[i].sent.find((frame) => frame.op === 'hello');
  };

  it('without extras the hello is exactly what it was', async () => {
    ControlledWebSocket.instances.length = 0;
    const publisher = make({});
    expect(await hello()).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    publisher.close();
  });

  it('adds what helloExtras returns, read afresh on every connect, and never lets it replace the token', async () => {
    ControlledWebSocket.instances.length = 0;
    let locked = { on: true, until: null };
    const publisher = make({ helloExtras: () => ({ locked, token: 'other', op: 'nope' }) });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null, locked: { on: true, until: null } });
    locked = { on: false, until: 123 };
    ControlledWebSocket.instances[0].close();
    expect((await hello(1)).locked).toEqual({ on: false, until: 123 });
    publisher.close();
  });

  it('a helloExtras that throws or returns nothing leaves the hello as it was', async () => {
    ControlledWebSocket.instances.length = 0;
    const a = make({ helloExtras: () => { throw new Error('boom'); } });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    a.close();
    ControlledWebSocket.instances.length = 0;
    const b = make({ helloExtras: () => null });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    b.close();
  });
});

describe('journal publisher account lock frames', () => {
  it('hands hello_ok\'s panic (or its absence) and each live panic frame to onPanic', async () => {
    ControlledWebSocket.instances.length = 0;
    const seen = [];
    const order = [];
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
      backoffBaseMs: 1, backoffCapMs: 1, keepaliveIntervalMs: 0, WebSocketImpl: ControlledWebSocket,
      onPanic: (state, meta) => { seen.push([state, meta]); order.push('panic'); },
      onReconnect: () => order.push('reconnect'),
    });
    await waitFor(() => ControlledWebSocket.instances[0]?.sent.some((frame) => frame.op === 'hello'));
    const ws = ControlledWebSocket.instances[0];
    ws.emit('message', JSON.stringify({ op: 'hello_ok', device_id: 9, name: 'box-a', panic: { on: true, since: 5, source: null } }));
    expect(seen[0]).toEqual([{ on: true, since: 5, source: null }, { hello: true }]);
    expect(order).toEqual(['panic', 'reconnect']);
    ws.emit('message', JSON.stringify({ kind: 'panic', on: false }));
    expect(seen[1]).toEqual([{ kind: 'panic', on: false }, { hello: false }]);
    ws.emit('message', JSON.stringify({ kind: 'panic', on: true, since: 7, source: 'sentinel' }));
    expect(seen[2][0]).toMatchObject({ on: true, since: 7, source: 'sentinel' });
    ws.close();
    await waitFor(() => ControlledWebSocket.instances[1]?.sent.some((frame) => frame.op === 'hello'));
    ControlledWebSocket.instances[1].emit('message', JSON.stringify({ op: 'hello_ok', device_id: 9, name: 'box-a' }));
    expect(seen[3]).toEqual([null, { hello: true }]);
    publisher.close();
  });
});
