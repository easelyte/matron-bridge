import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { markJournalOrigin, planQueueFlush } from '../lib/queue-flush.js';
import { hasQueuedCompact } from '../lib/compact-priority.js';
import { CodexPromptQueue } from '../lib/codex-prompts.js';
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let ack;
  const session = { agent: 'codex', alive: true, busy: true, roomId: 'room', queuedMessages: [], queueNotifications: [], codex: { transport: 'app-server', steer: vi.fn(() => new Promise(resolve => { ack = resolve; })), interrupt: vi.fn() } };
  const context = vm.createContext({ AGENT_CODEX: 'codex', hasQueuedCompact, markJournalOrigin, planQueueFlush, console,
    sessions: new Map([['room', session]]), pendingMediaMirror: () => [], journalMirrorUserMedia: vi.fn(),
    commitDispatchedUserTurn: vi.fn(), journalPublishUserItem: vi.fn(), finalizeSentQueue: vi.fn(),
    journalPublishNotice: vi.fn(), journalConvoIdFor: () => 'convo', dispatchDeferredCommand: vi.fn(), flushPendingSessionQueue: vi.fn(), maybeFlushRoomDelivery: vi.fn(),
    sendToSession: vi.fn(() => true), recordUserAnswer: vi.fn(),
  });
  vm.runInContext(['restoreQueuedBatch', 'flushQueue', 'submitCodexAsyncAnswer', 'dispatchMergedFlush', 'journalRoutePromptReply'].map(sourceOf).join('\n'), context);
  const batch = [[{ type: 'text', text: 'Also check the test' }]];
  const snapshot = { convoId: 'convo', entries: [{ itemId: 'msg-1' }] };
  return { session, context, batch, snapshot, ack: value => ack(value), flush: () => context.flushQueue(session, batch, snapshot) };
}
describe('bridge send-now steering', () => {
  it('retains messages for a parked restart without attempting native steering', () => {
    const h = setup(); h.session._deferredCommandText = '!restart --browser';
    expect(h.flush()).toBe(false);
    expect(h.session.queuedMessages).toEqual(h.batch);
    expect(h.session.codex.steer).not.toHaveBeenCalled();
    expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
  });
  it('does not interrupt or retire queued cards until Codex acknowledges input', async () => {
    const h = setup(); expect(h.flush()).toBe('deferred');
    expect(h.session.codex.interrupt).not.toHaveBeenCalled(); expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
    h.ack(true); await settle();
    expect(h.context.commitDispatchedUserTurn).toHaveBeenCalledTimes(1);
    expect(h.context.finalizeSentQueue).toHaveBeenCalledWith('convo', h.snapshot.entries);
    expect(h.session.busy).toBe(true); expect(h.session._codexSteerPending).toBe(false);
  });
  it('retains definitely rejected messages for turn end', async () => {
    const h = setup(); h.flush(); h.ack(false); await settle();
    expect(h.session.queuedMessages).toEqual(h.batch); expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
    expect(h.session._codexUncertainSteer).toBe(false);
  });
  it('holds unconfirmed messages even if the turn finishes before acknowledgement', async () => {
    const h = setup(); h.flush(); h.session.busy = false; h.session.codex.steerUncertain = true;
    h.ack(false); await settle();
    expect(h.session.queuedMessages).toEqual(h.batch); expect(h.session._codexUncertainSteer).toBe(true);
    expect(h.context.flushPendingSessionQueue).not.toHaveBeenCalled(); expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
  });
  it('ignores an acknowledgement from a replaced session', async () => {
    const h = setup(); h.flush(); h.context.sessions.set('room', { alive: true }); h.ack(true); await settle();
    expect(h.context.finalizeSentQueue).not.toHaveBeenCalled(); expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
  });
});

describe('asynchronous question answer delivery', () => {
  function question(h) {
    h.session.codexPrompts = new CodexPromptQueue({ publish: () => true,
      submitAsync: text => h.context.submitCodexAsyncAnswer(h.session, text) });
    h.session.codexPrompts.addAsync('question', [{ title: 'Which feature?', options: ['Models', 'Tokens'] }]);
    return () => h.context.journalRoutePromptReply(h.session, { choice: h.session.codexPrompts.active.options[1].value });
  }
  it('steers a selected answer without releasing unrelated queued messages or duplicating history', async () => {
    const h = setup(); h.session.queuedMessages = h.batch;
    const notification = { id: 'unrelated' }; h.session.queueNotifications = [notification];
    expect(question(h)()).toBe('Tokens');
    expect(h.session.codex.steer).toHaveBeenCalledWith([{ type: 'text', text: 'Which feature?\nTokens' }]);
    expect(h.context.recordUserAnswer).not.toHaveBeenCalled();
    expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
    h.ack(true); await settle();
    expect(h.context.commitDispatchedUserTurn).toHaveBeenCalledExactlyOnceWith(h.session, 'Which feature?\nTokens', null);
    expect(h.context.journalPublishUserItem).not.toHaveBeenCalled();
    expect(h.context.finalizeSentQueue).toHaveBeenCalledWith('convo', []);
    expect(h.session.queuedMessages).toBe(h.batch);
    expect(h.session.queueNotifications).toEqual([notification]);
  });
  it('starts a normal user turn for an answer received after the assistant finishes', () => {
    const h = setup(); h.session.busy = false;
    expect(question(h)()).toBe('Tokens');
    expect(h.session.codex.steer).not.toHaveBeenCalled();
    expect(h.context.sendToSession).toHaveBeenCalledWith(h.session, [{ type: 'text', text: 'Which feature?\nTokens' }], { skipJournalMirror: true });
    expect(h.context.recordUserAnswer).not.toHaveBeenCalled();
  });
  it('retains rejected answers and keeps queue notification positions aligned', async () => {
    const h = setup(); h.session.queuedMessages = h.batch;
    const notification = { id: 'unrelated' }; h.session.queueNotifications = [notification];
    question(h)(); h.ack(false); await settle();
    expect(h.session.queuedMessages).toEqual([[{ type: 'text', text: 'Which feature?\nTokens' }], ...h.batch]);
    expect(h.session.queueNotifications).toEqual([{}, notification]);
    expect(h.context.recordUserAnswer).not.toHaveBeenCalled();
    expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
  });
  it('holds new answers without retrying uncertain prior messages', () => {
    const h = setup(); h.session._codexUncertainSteer = true; h.session.queuedMessages = [...h.batch];
    h.session.queueNotifications = [{ id: 'unconfirmed' }];
    expect(question(h)()).toBe('Tokens');
    expect(h.session.codex.steer).not.toHaveBeenCalled();
    expect(h.session._codexUncertainSteer).toBe(true);
    expect(h.session.queuedMessages).toEqual([...h.batch, [{ type: 'text', text: 'Which feature?\nTokens' }]]);
    expect(h.session.queueNotifications).toEqual([{ id: 'unconfirmed' }, {}]);
  });
  it('retains an answer for the replacement when a restart is parked', () => {
    const h = setup(); h.session._deferredCommandText = '!restart --browser';
    expect(question(h)()).toBe('Tokens');
    expect(h.session.codex.steer).not.toHaveBeenCalled();
    expect(h.session.queuedMessages).toEqual([[{ type: 'text', text: 'Which feature?\nTokens' }]]);
    expect(h.session.queueNotifications).toEqual([{}]);
  });
});
