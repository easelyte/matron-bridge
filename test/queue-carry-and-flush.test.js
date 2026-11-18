import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

function flushHarness({ dispatchMergedFlush }) {
  const session = {
    agent: 'claude', alive: true, busy: false, roomId: 'room', queuedMessages: [], queueNotifications: [],
  };
  const context = vm.createContext({
    AGENT_CODEX: 'codex',
    claudeSteerEligible: () => false,
    hasQueuedCompact: () => false,
    runQueuedCleanup: vi.fn(),
    finalizeSentQueue: vi.fn(),
    journalPublishNotice: vi.fn(),
    journalConvoIdFor: () => 'convo',
    endTurn: vi.fn(),
    inflightMarker: { noteTurnEnd: vi.fn() },
    restartInputs: { begin: () => () => {} },
    dispatchMergedFlush,
    console: { log: vi.fn() },
  });
  vm.runInContext(['restoreQueuedBatch', 'flushQueue'].map(sourceOf).join('\n'), context);
  const batch = [[{ type: 'text', text: 'hello' }]];
  const snapshot = { convoId: 'convo', entries: [{ itemId: 'msg-1' }] };
  return { session, context, batch, snapshot, flush: () => context.flushQueue(session, batch, snapshot) };
}

describe('flushQueue when the dispatch throws', () => {
  it('puts the detached batch back on the queue and reports no delivery', () => {
    const h = flushHarness({ dispatchMergedFlush: () => { throw new Error('pty write failed'); } });
    expect(h.flush()).toBe(false);
    expect(h.session.queuedMessages).toEqual(h.batch);
    expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
  });

  it('keeps messages that arrived during the failed send behind the restored batch', () => {
    const late = [{ type: 'text', text: 'later' }];
    const h = flushHarness({
      dispatchMergedFlush: () => { h.session.queuedMessages = [late]; throw new Error('boom'); },
    });
    expect(h.flush()).toBe(false);
    expect(h.session.queuedMessages).toEqual([...h.batch, late]);
  });

  it('closes a turn the failed send began, so the restored batch can go next', () => {
    const h = flushHarness({
      dispatchMergedFlush: () => { h.session.busy = true; h.session.currentTurn = {}; throw new Error('boom'); },
    });
    expect(h.flush()).toBe(false);
    expect(h.session.busy).toBe(false);
    expect(h.context.endTurn).toHaveBeenCalledWith(h.session);
    expect(h.context.inflightMarker.noteTurnEnd).toHaveBeenCalledWith('convo');
  });

  it('leaves a turn that was already running alone', () => {
    const h = flushHarness({ dispatchMergedFlush: () => { throw new Error('boom'); } });
    h.session.busy = true;
    h.flush();
    expect(h.session.busy).toBe(true);
    expect(h.context.endTurn).not.toHaveBeenCalled();
  });

  it('still retires the queue cards on a normal delivery', () => {
    const h = flushHarness({ dispatchMergedFlush: () => true });
    expect(h.flush()).toBe(true);
    expect(h.context.finalizeSentQueue).toHaveBeenCalledWith('convo', h.snapshot.entries);
  });
});

describe('index.js wiring (source inspection)', () => {
  it('an interactive session that refuses the typed text reports a failed send', () => {
    const body = sourceOf('sendToSession');
    const typed = body.indexOf('session.iv.sendText(text)');
    expect(typed).toBeGreaterThan(-1);
    const guard = body.slice(typed - 10, typed + 260);
    expect(guard).toMatch(/session\.iv\.sendText\(text\) === false/);
    expect(guard).toContain('reportSessionSendFailure(session');
    // The turn is committed only after the guard.
    expect(body.indexOf('commitDispatchedUserTurn', typed)).toBeGreaterThan(typed + 150);
  });
});

describe('dispatchMergedFlush after the text is sent', () => {
  it('a throwing journal mirror does not turn a delivered batch into a failed one', () => {
    const context = vm.createContext({
      planQueueFlush: () => ({ blocks: [{ type: 'text', text: 'hi' }], mirrorText: 'hi' }),
      sendToSession: () => true,
      queueCauses: () => null,
      journalPublishUserItem: () => { throw new Error('journal down'); },
      pendingMediaMirror: () => [],
      journalMirrorUserMedia: vi.fn(),
      console: { log: vi.fn() },
    });
    vm.runInContext(sourceOf('dispatchMergedFlush'), context);
    expect(context.dispatchMergedFlush({ roomId: 'r' }, [[{ type: 'text', text: 'hi' }]])).toBe(true);
  });
});
