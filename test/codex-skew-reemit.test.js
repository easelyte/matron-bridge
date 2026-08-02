import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createCodexConvoTracker, journalReemitCodexOutcomes } from '../lib/codex-convos.js';
import { createCodexWatcherIsolation } from '../lib/codex-watcher.js';
import { createJournalPublisher } from '../lib/journal-publisher.js';

const RUN_ID = '1722600000000-1234-abcd';
const SECOND_RUN_ID = '1722600000002-1234-cafe';
const RUNNING_ID = '1722600000001-1234-beef';
const PARENT_ID = 'parent-convo';
const CHILD_ID = `${PARENT_ID}:codex:${RUN_ID}`;
const SECOND_CHILD_ID = `${PARENT_ID}:codex:${SECOND_RUN_ID}`;
const RUNNING_CHILD_ID = `${PARENT_ID}:codex:${RUNNING_ID}`;

class DeploySkewWebSocket extends EventEmitter {
  static instances = [];
  static upgraded = false;
  static conversations = new Map();
  static delayCallbacks = false;
  static pendingCallbacks = [];
  static frames = [];

  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    DeploySkewWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data, callback) {
    const frame = JSON.parse(data);
    DeploySkewWebSocket.frames.push(frame);
    if (frame.op === 'hello') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ op: 'hello_ok' })));
    } else if (frame.op === 'convo_upsert') {
      const previous = DeploySkewWebSocket.conversations.get(frame.convo_id) || {};
      DeploySkewWebSocket.conversations.set(frame.convo_id, {
        sessionState: frame.session_state ?? previous.sessionState ?? null,
        sessionOutcome: DeploySkewWebSocket.upgraded
          ? (frame.session_outcome ?? previous.sessionOutcome ?? null)
          : null,
      });
    }
    if (callback) {
      if (DeploySkewWebSocket.delayCallbacks && frame.op !== 'hello') {
        DeploySkewWebSocket.pendingCallbacks.push(callback);
      } else {
        callback();
      }
    }
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

describe('Codex outcome deploy-skew repair', () => {
  it('re-emits an in-memory terminal child after reconnect so an upgraded server persists its outcome', async () => {
    DeploySkewWebSocket.instances.length = 0;
    DeploySkewWebSocket.upgraded = false;
    DeploySkewWebSocket.conversations.clear();
    DeploySkewWebSocket.delayCallbacks = false;
    DeploySkewWebSocket.pendingCallbacks.length = 0;
    DeploySkewWebSocket.frames.length = 0;

    let publisher;
    let tracker;
    let isolation;
    publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {}, info() {} },
      backoffBaseMs: 1,
      backoffCapMs: 1,
      keepaliveIntervalMs: 0,
      WebSocketImpl: DeploySkewWebSocket,
      onReconnect: () => journalReemitCodexOutcomes({
        sessions: new Map([['session-1', {
          codexConvos: tracker,
          codexWatcherIsolation: isolation,
        }]]),
        publisher,
      }),
    });
    tracker = createCodexConvoTracker({
      sessionId: 'session-1',
      publisher,
      getParentConvoId: () => PARENT_ID,
      log: { warn() {} },
    });
    isolation = createCodexWatcherIsolation({
      sessionId: 'session-1',
      publisher,
      getParentConvoId: () => PARENT_ID,
      terminalize: (runId, outcome) => tracker.terminalize(runId, outcome),
      terminalizeAll: () => tracker.interruptAll(),
      isAdmittedRun: runId => tracker.hasChild(runId),
      log: { warn() {}, info() {} },
    });

    await waitFor(() => DeploySkewWebSocket.instances.length === 1);
    tracker.ensureChild({ runId: RUN_ID });
    tracker.ensureChild({ runId: RUNNING_ID });
    tracker.terminalize(RUN_ID, 'completed');
    await waitFor(() => DeploySkewWebSocket.conversations.get(CHILD_ID)?.sessionState === 'done');
    expect(DeploySkewWebSocket.conversations.get(CHILD_ID)).toEqual({
      sessionState: 'done',
      sessionOutcome: null,
    });

    DeploySkewWebSocket.upgraded = true;
    DeploySkewWebSocket.instances[0].close();

    await waitFor(() => DeploySkewWebSocket.conversations.get(CHILD_ID)?.sessionOutcome === 'completed');
    expect(DeploySkewWebSocket.conversations.get(CHILD_ID)).toEqual({
      sessionState: 'done',
      sessionOutcome: 'completed',
    });
    expect(DeploySkewWebSocket.conversations.get(RUNNING_CHILD_ID)).toEqual({
      sessionState: 'running',
      sessionOutcome: null,
    });

    publisher.close();
  });

  it('drains deferred reconnect repairs in FIFO order on the same connection', async () => {
    DeploySkewWebSocket.instances.length = 0;
    DeploySkewWebSocket.upgraded = false;
    DeploySkewWebSocket.conversations.clear();
    DeploySkewWebSocket.delayCallbacks = false;
    DeploySkewWebSocket.pendingCallbacks.length = 0;
    DeploySkewWebSocket.frames.length = 0;

    let publisher;
    let tracker;
    const isolation = {
      guardSession(_label, fn) { fn(); },
    };
    publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {}, info() {} },
      queueLimit: 3,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      keepaliveIntervalMs: 0,
      WebSocketImpl: DeploySkewWebSocket,
      onReconnect: () => journalReemitCodexOutcomes({
        sessions: new Map([['session-1', {
          codexConvos: tracker,
          codexWatcherIsolation: isolation,
        }]]),
        publisher,
      }),
    });
    tracker = createCodexConvoTracker({
      sessionId: 'session-1',
      publisher,
      getParentConvoId: () => PARENT_ID,
      log: { warn() {} },
    });

    await waitFor(() => DeploySkewWebSocket.instances.length === 1);
    tracker.ensureChild({ runId: RUN_ID });
    tracker.ensureChild({ runId: SECOND_RUN_ID });
    tracker.terminalize(RUN_ID, 'completed');
    tracker.terminalize(SECOND_RUN_ID, 'failed');
    await waitFor(() => DeploySkewWebSocket.conversations.get(CHILD_ID)?.sessionState === 'done');
    await waitFor(() => DeploySkewWebSocket.conversations.get(SECOND_CHILD_ID)?.sessionState === 'done');

    DeploySkewWebSocket.upgraded = true;
    DeploySkewWebSocket.instances[0].close();
    publisher.publishText('backlog-1', { body: 'one' });
    publisher.publishText('backlog-2', { body: 'two' });
    publisher.publishText('backlog-3', { body: 'three' });
    DeploySkewWebSocket.delayCallbacks = true;

    await waitFor(() => DeploySkewWebSocket.instances.length === 2);
    await waitFor(() => DeploySkewWebSocket.pendingCallbacks.length === 3);
    const secondEpochFrames = DeploySkewWebSocket.frames.filter(frame =>
      frame.op !== 'hello' && frame.convo_id !== CHILD_ID
    );
    expect(secondEpochFrames.slice(-3).map(frame => frame.convo_id)).toEqual([
      'backlog-1',
      'backlog-2',
      'backlog-3',
    ]);
    expect(DeploySkewWebSocket.conversations.get(CHILD_ID)?.sessionOutcome).toBeNull();
    expect(DeploySkewWebSocket.conversations.get(SECOND_CHILD_ID)?.sessionOutcome).toBeNull();

    DeploySkewWebSocket.pendingCallbacks.shift()();
    await waitFor(() => DeploySkewWebSocket.conversations.get(CHILD_ID)?.sessionOutcome === 'completed');
    expect(DeploySkewWebSocket.conversations.get(SECOND_CHILD_ID)?.sessionOutcome).toBeNull();

    DeploySkewWebSocket.pendingCallbacks.shift()();
    await waitFor(() => DeploySkewWebSocket.conversations.get(SECOND_CHILD_ID)?.sessionOutcome === 'failed');
    expect(DeploySkewWebSocket.frames.filter(frame =>
      frame.op === 'convo_upsert' && [CHILD_ID, SECOND_CHILD_ID].includes(frame.convo_id)
    ).slice(-2).map(frame => frame.convo_id)).toEqual([CHILD_ID, SECOND_CHILD_ID]);

    for (const callback of DeploySkewWebSocket.pendingCallbacks.splice(0)) callback();
    DeploySkewWebSocket.delayCallbacks = false;
    expect(DeploySkewWebSocket.conversations.get(CHILD_ID)).toEqual({
      sessionState: 'done',
      sessionOutcome: 'completed',
    });
    expect(DeploySkewWebSocket.conversations.get(SECOND_CHILD_ID)).toEqual({
      sessionState: 'done',
      sessionOutcome: 'failed',
    });
    expect(DeploySkewWebSocket.instances).toHaveLength(2);

    publisher.close();
  });

  it('contains a malformed tracker during reconnect repair and repairs its sibling session', () => {
    const repaired = [];
    const publisher = {
      upsertConvoBestEffort(convoId, opts) {
        repaired.push({ convoId, opts });
        return true;
      },
      publishText() { return true; },
    };
    const malformedIsolation = createCodexWatcherIsolation({
      sessionId: 'malformed',
      publisher,
      log: { warn() {}, info() {} },
    });
    const siblingIsolation = createCodexWatcherIsolation({
      sessionId: 'sibling',
      publisher,
      log: { warn() {}, info() {} },
    });
    const sessions = new Map([
      ['malformed', {
        codexConvos: {
          terminalChildren() { throw new Error('malformed tracker'); },
        },
        codexWatcherIsolation: malformedIsolation,
      }],
      ['sibling', {
        codexConvos: {
          terminalChildren: () => new Map([[RUN_ID, 'completed']]),
          convoIdFor: () => CHILD_ID,
        },
        codexWatcherIsolation: siblingIsolation,
      }],
    ]);

    expect(() => journalReemitCodexOutcomes({ sessions, publisher })).not.toThrow();
    expect(repaired).toEqual([{
      convoId: CHILD_ID,
      opts: { sessionState: 'done', sessionOutcome: 'completed' },
    }]);
  });
});
