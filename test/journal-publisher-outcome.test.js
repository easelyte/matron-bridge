import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createJournalPublisher, peerMessageIdemKey } from '../lib/journal-publisher.js';

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

describe('journal publisher agent kind', () => {
  it('forwards a defined agent_kind and omits the key when absent', async () => {
    FakeWebSocket.instances.length = 0;
    const pub = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {} },
      keepaliveIntervalMs: 0,
      WebSocketImpl: FakeWebSocket,
    });

    await nextTurn();
    // A top-level codex-backed conversation stamps its backend kind...
    pub.upsertConvo('codex-top-1', { sessionState: 'running', agentKind: 'codex' });
    // ...while an upsert that omits it leaves the key off the frame entirely, so
    // the server COALESCEs and any recorded kind survives.
    pub.upsertConvo('claude-top-1', { title: 'x' });
    await nextTurn();

    const [codexFrame, plainFrame] = FakeWebSocket.instances[0].frames;
    expect(codexFrame).toMatchObject({
      op: 'convo_upsert',
      convo_id: 'codex-top-1',
      session_state: 'running',
      agent_kind: 'codex',
    });
    expect(plainFrame).toMatchObject({ op: 'convo_upsert', convo_id: 'claude-top-1', title: 'x' });
    expect('agent_kind' in plainFrame).toBe(false);

    pub.close();
  });
});

describe('journal publisher peer messages', () => {
  it('hashes canonical tuples without plain-concatenation collisions', () => {
    expect(peerMessageIdemKey('ab', 'c', 'd')).not.toBe(peerMessageIdemKey('a', 'bc', 'd'));
    expect(peerMessageIdemKey('from', 'target', 'body')).toBe(peerMessageIdemKey('from', 'target', 'body'));
  });

  it('makes priority part of the semantic key so an escalation is not deduped', () => {
    // A same-body priority resend must get a DISTINCT key from the prior normal send.
    expect(peerMessageIdemKey('from', 'target', 'body', true)).not.toBe(
      peerMessageIdemKey('from', 'target', 'body', false),
    );
    // Absent priority defaults to non-priority — unchanged from the 3-arg call.
    expect(peerMessageIdemKey('from', 'target', 'body')).toBe(
      peerMessageIdemKey('from', 'target', 'body', false),
    );
  });

  it('emits the agent op with a deterministic content-derived key', async () => {
    FakeWebSocket.instances.length = 0;
    const pub = createJournalPublisher({
      url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
      keepaliveIntervalMs: 0, WebSocketImpl: FakeWebSocket,
    });
    await nextTurn();

    const first = await pub.sendPeerMessage({ targetConvo: 'target', fromConvo: 'from', body: 'coordinate' });
    const second = await pub.sendPeerMessage({ targetConvo: 'target', fromConvo: 'from', body: 'coordinate' });

    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: true });
    const frames = FakeWebSocket.instances[0].frames;
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      op: 'peer_message', target_convo: 'target', from_convo: 'from', body: 'coordinate',
      idem_key: peerMessageIdemKey('from', 'target', 'coordinate'),
    });
    expect(frames[1].idem_key).toBe(frames[0].idem_key);
    pub.close();
  });

  it('retransmits an unconfirmed frame with the same key inside the horizon', async () => {
    class DropFirstPeerConfirmWebSocket extends FakeWebSocket {
      send(data, callback) {
        const frame = JSON.parse(data);
        if (frame.op !== 'peer_message' || DropFirstPeerConfirmWebSocket.instances.length > 1) {
          return super.send(data, callback);
        }
        this.frames.push(frame);
        callback?.(new Error('simulated transport loss'));
      }
    }
    DropFirstPeerConfirmWebSocket.instances.length = 0;
    const pub = createJournalPublisher({
      url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
      keepaliveIntervalMs: 0, backoffBaseMs: 1, backoffCapMs: 1,
      peerMessageRetryHorizonMs: 100, WebSocketImpl: DropFirstPeerConfirmWebSocket,
    });
    await nextTurn();

    const outcome = await pub.sendPeerMessage({ targetConvo: 'target', fromConvo: 'from', body: 'once' });

    expect(outcome).toEqual({ sent: true });
    expect(DropFirstPeerConfirmWebSocket.instances).toHaveLength(2);
    const frames = DropFirstPeerConfirmWebSocket.instances.flatMap((socket) => socket.frames);
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((frame) => frame.idem_key)).size).toBe(1);
    pub.close();
  });

  it('stops at the retry horizon and reports uncertainty', async () => {
    class NeverConfirmPeerWebSocket extends FakeWebSocket {
      send(data, callback) {
        const frame = JSON.parse(data);
        if (frame.op === 'peer_message') {
          this.frames.push(frame);
          return;
        }
        return super.send(data, callback);
      }
    }
    NeverConfirmPeerWebSocket.instances.length = 0;
    const pub = createJournalPublisher({
      url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
      keepaliveIntervalMs: 0, peerMessageRetryHorizonMs: 10,
      WebSocketImpl: NeverConfirmPeerWebSocket,
    });
    await nextTurn();

    const outcome = await pub.sendPeerMessage({ targetConvo: 'target', fromConvo: 'from', body: 'uncertain' });

    expect(outcome).toEqual({ queued: false, uncertain: true });
    expect(NeverConfirmPeerWebSocket.instances[0].frames).toHaveLength(1);
    pub.close();
  });
});
