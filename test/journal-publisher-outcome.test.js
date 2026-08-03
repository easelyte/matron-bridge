import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createJournalPublisher } from '../lib/journal-publisher.js';

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.frames = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data, callback) {
    const frame = JSON.parse(data);
    if (frame.op === 'hello') {
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ op: 'hello_ok' }))));
    } else {
      this.frames.push(frame);
    }
    callback?.();
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

async function nextTurn() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('journal publisher session outcome', () => {
  it('forwards a defined outcome and omits the key when absent', async () => {
    FakeWebSocket.instances.length = 0;
    const pub = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {} },
      keepaliveIntervalMs: 0,
      WebSocketImpl: FakeWebSocket,
    });

    await nextTurn();
    pub.upsertConvo('parent:codex:run-1', {
      sessionState: 'done',
      sessionOutcome: 'interrupted',
    });
    pub.upsertConvo('parent:sub:agent-1', { title: 'x' });
    await nextTurn();

    const [terminal, unchangedSubagent] = FakeWebSocket.instances[0].frames;
    expect(terminal).toMatchObject({
      op: 'convo_upsert',
      convo_id: 'parent:codex:run-1',
      session_state: 'done',
      session_outcome: 'interrupted',
    });
    expect(unchangedSubagent).toMatchObject({
      op: 'convo_upsert',
      convo_id: 'parent:sub:agent-1',
      title: 'x',
    });
    expect('session_outcome' in unchangedSubagent).toBe(false);

    pub.close();
  });
});
