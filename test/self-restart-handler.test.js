import { describe, it, expect } from 'vitest';
import { createSelfRestartHandler, SELF_RESTART_MAX, CONTINUATION_PREFIX } from '../lib/self-restart.js';

// The /restart-session endpoint body, in the same injected-deps shape as
// lib/agent-spawn.js's handlers: a pure-ish async (data) => {status, body}
// around index.js's session state, so the ordering rules below are testable
// without a live bridge.
//
// The ordering that matters: the continuation is queued BEFORE the restart
// runs. recreateSession copies session.queuedMessages onto the replacement
// (index.js) and flushes them once it's ready — queue after the restart and
// the message lands on a session that is already dead.

function harness({ session = {}, ...over } = {}) {
  const calls = [];
  const live = {
    roomId: '!room:x', alive: true, busy: true, agent: 'claude', queuedMessages: null,
    ...session,
  };
  const handler = createSelfRestartHandler({
    getSession: () => (live.alive ? live : null),
    // Returns an undo, so a restart that fails to start can take its
    // continuation back out of the queue instead of stranding it there.
    queueContinuation: (s, text) => {
      calls.push(['queue', text]);
      (s.queuedMessages ??= []).push(text);
      return () => { calls.push(['unqueue', text]); s.queuedMessages.pop(); };
    },
    park: (s, command) => { calls.push(['park', command]); s._deferredCommandText = command; },
    dispatch: (s, command) => { calls.push(['dispatch', command]); },
    notify: (s, text) => { calls.push(['notify', text]); },
    ...over,
  });
  return { handler, session: live, calls, kinds: () => calls.map(c => c[0]) };
}

const body = (over = {}) => ({ roomId: '!room:x', continue_with: 'Screenshot the header.', browser: true, ...over });

describe('/restart-session — refusals', () => {
  it('404s when the room has no live session', async () => {
    const { handler } = harness({ getSession: () => null });
    const res = await handler(body());
    expect(res.status).toBe(404);
  });

  it('400s on a bad model without touching the session', async () => {
    const { handler, calls } = harness();
    const res = await handler(body({ model: 'gpt-5' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
    expect(calls).toEqual([]);
  });

  it('400s on a missing continuation without touching the session', async () => {
    const { handler, calls } = harness();
    const res = await handler(body({ continue_with: '' }));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('429s once the self-restart budget is spent, and says so', async () => {
    const { handler, calls } = harness({ session: { _agentRestartCount: SELF_RESTART_MAX } });
    const res = await handler(body());
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/ask the user/i);
    expect(calls).toEqual([]);
  });

  it('refuses browser tools for a Codex session', async () => {
    const { handler } = harness({ session: { agent: 'codex' } });
    expect((await handler(body())).status).toBe(400);
  });
});

describe('/restart-session — mid-turn (the normal case)', () => {
  it('queues the continuation, then parks the forced restart', async () => {
    const { handler, calls } = harness();
    const res = await handler(body());
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual(['queue', `${CONTINUATION_PREFIX}Screenshot the header.`]);
    expect(calls[1]).toEqual(['park', '!restart --force --browser']);
  });

  it('never dispatches the restart while a turn is in flight', async () => {
    const { handler, kinds } = harness();
    await handler(body());
    expect(kinds()).not.toContain('dispatch');
  });

  it('reports back that the restart is parked, not already done', async () => {
    const { handler } = harness();
    expect((await handler(body())).body.parked).toBe(true);
  });

  it('spends one unit of the loop budget, on the session', async () => {
    const { handler, session } = harness({ session: { _agentRestartCount: 1 } });
    await handler(body());
    expect(session._agentRestartCount).toBe(2);
  });

  it('tells the user what is about to happen, and why', async () => {
    const { handler, calls } = harness();
    await handler(body({ reason: 'need to check the rendered header' }));
    const notice = calls.find(c => c[0] === 'notify')[1];
    expect(notice).toMatch(/restart/i);
    expect(notice).toMatch(/browser/i);
    expect(notice).toMatch(/need to check the rendered header/);
  });

  it('notifies even when no reason was given', async () => {
    const { handler, kinds } = harness();
    await handler(body());
    expect(kinds()).toContain('notify');
  });
});

describe('/restart-session — idle session', () => {
  it('runs the restart immediately, after queueing the continuation', async () => {
    const { handler, calls } = harness({ session: { busy: false } });
    const res = await handler(body({ browser: false, model: 'opus' }));
    expect(res.status).toBe(200);
    expect(res.body.parked).toBe(false);
    expect(calls.map(c => c[0]).indexOf('queue'))
      .toBeLessThan(calls.map(c => c[0]).indexOf('dispatch'));
    expect(calls.find(c => c[0] === 'dispatch')[1]).toBe('!restart --force --model opus');
  });

  it('does not also park a command it already dispatched', async () => {
    const { handler, kinds, session } = harness({ session: { busy: false } });
    await handler(body());
    expect(kinds()).not.toContain('park');
    expect(session._deferredCommandText).toBeUndefined();
  });
});

describe('/restart-session — failure leaves nothing half-done', () => {
  it('does not spend budget or leave a queued message when parking throws', async () => {
    const { handler, session } = harness({
      park: () => { throw new Error('boom'); },
    });
    const res = await handler(body());
    expect(res.status).toBe(500);
    expect(session.queuedMessages ?? []).toEqual([]);
    expect(session._agentRestartCount ?? 0).toBe(0);
  });
});

describe('/restart-session — one restart per swap', () => {
  it('409s a second call while the first is still parked, touching nothing', async () => {
    const { handler, session, calls } = harness();
    expect((await handler(body())).status).toBe(200);
    const before = calls.length;
    const second = await handler(body({ continue_with: 'Something else.' }));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already pending/);
    // No second continuation, no replaced parked command, no extra budget.
    expect(calls.length).toBe(before);
    expect(session.queuedMessages).toHaveLength(1);
    expect(session._agentRestartCount).toBe(1);
  });

  it('409s a second call after an idle restart was dispatched too', async () => {
    const { handler, calls } = harness({ session: { busy: false } });
    await handler(body());
    const before = calls.length;
    expect((await handler(body())).status).toBe(409);
    expect(calls.length).toBe(before);
  });

  it('does not mark the session pending when parking failed, so a retry is allowed', async () => {
    const { handler, session } = harness({ park: () => { throw new Error('boom'); } });
    expect((await handler(body())).status).toBe(500);
    expect(session._selfRestartPending).toBeUndefined();
    expect((await handler(body())).status).toBe(500);
  });
});
