import { describe, it, expect } from 'vitest';
import { stopSessionAndConfirm, STOP_CONFIRMATION } from '../lib/stop-command.js';

// A reply path shaped like the bridge's own: it publishes into the
// conversation of whichever session is on the live map under that key, and
// drops the text when there is none.
function harness() {
  const sessions = new Map([['room-a', { alive: true }]]);
  const published = [];
  const calls = [];
  const sendReply = async (text) => {
    calls.push('reply');
    if (sessions.has('room-a')) published.push(text);
  };
  const run = () => stopSessionAndConfirm({
    sessions,
    roomId: 'room-a',
    kill: () => { calls.push('kill'); sessions.get('room-a').alive = false; },
    settle: () => { calls.push(sessions.has('room-a') ? 'settle-while-live' : 'settle'); },
    sendReply,
  });
  return { sessions, published, calls, run };
}

describe('stopSessionAndConfirm', () => {
  it('tells the user the session stopped', async () => {
    const h = harness();
    await h.run();
    expect(h.published).toEqual([STOP_CONFIRMATION]);
    expect(STOP_CONFIRMATION).toBe('Session stopped.');
  });

  it('confirms after the kill, so anything the kill reports comes first', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.indexOf('kill')).toBeLessThan(h.calls.indexOf('reply'));
  });

  it('still removes the session and settles its state after removal', async () => {
    const h = harness();
    await h.run();
    expect(h.sessions.has('room-a')).toBe(false);
    expect(h.calls).toEqual(['kill', 'reply', 'settle']);
  });

  it('removes the session and settles its state even when the reply fails', async () => {
    const h = harness();
    const failing = stopSessionAndConfirm({
      sessions: h.sessions,
      roomId: 'room-a',
      kill: () => {},
      settle: () => { h.calls.push('settle'); },
      sendReply: async () => { throw new Error('publish failed'); },
    });
    await expect(failing).rejects.toThrow('publish failed');
    expect(h.sessions.has('room-a')).toBe(false);
    expect(h.calls).toEqual(['settle']);
  });
});
