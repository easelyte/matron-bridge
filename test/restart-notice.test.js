import { describe, expect, it, vi } from 'vitest';
import { createRestartNotices, restartNoticeText } from '../lib/restart-notice.js';

function make({ state = { id: 'r1', state: 'pending', requests: [{ reason: 'update' }], notified: {} }, sessions, ready = () => true, send = () => true } = {}) {
  const store = {
    state: { ...state },
    getState() { return this.state; },
    markNotified: vi.fn(function (id, convoId) { this.state = { ...this.state, notified: { ...this.state.notified, [convoId]: { at: 1 } } }; }),
  };
  const list = sessions ?? [{ id: 'a' }, { id: 'b' }];
  const sendSpy = vi.fn(send);
  const notices = createRestartNotices({ stateStore: store, sessions: () => list, ready, send: sendSpy, convoIdOf: s => s.id });
  return { notices, store, sendSpy };
}

describe('restart notice text', () => {
  it('names the reasons and how to leave a note', () => {
    const text = restartNoticeText([{ reason: 'ship fix' }, { reason: '' }, { reason: 'config' }]);
    expect(text).toContain('(ship fix; config)');
    expect(text).toContain('reminder_create restart_note: true');
    expect(text).toContain('ScheduleWakeup');
  });

  it('bounds the reasons it quotes', () => {
    expect(restartNoticeText([{ reason: 'x'.repeat(5000) }]).length).toBeLessThan(1700);
  });
});

describe('restart notices', () => {
  it('tells each live session once and records it', () => {
    const { notices, store, sendSpy } = make();
    expect(notices.notifyPending()).toEqual(['a', 'b']);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(store.markNotified).toHaveBeenCalledWith('r1', 'a');
    expect(notices.notifyPending()).toEqual([]);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves a session that is not free, or whose send fails, for the next poll', () => {
    let free = false;
    let ok = false;
    const { notices, store } = make({ sessions: [{ id: 'a' }], ready: () => free, send: () => ok });
    expect(notices.notifyPending()).toEqual([]);
    free = true;
    expect(notices.notifyPending()).toEqual([]);
    ok = true;
    expect(notices.notifyPending()).toEqual(['a']);
    expect(store.markNotified).toHaveBeenCalledTimes(1);
  });

  it('does not treat a non-true send result as delivered', () => {
    const { notices } = make({ sessions: [{ id: 'a' }], send: () => 'yes' });
    expect(notices.notifyPending()).toEqual([]);
  });

  it('gives up on a session whose send keeps failing after three attempts, so it cannot hold the restart', () => {
    const log = vi.fn();
    const { notices, store, sendSpy } = make({ sessions: [{ id: 'a' }], send: () => false });
    const again = createRestartNotices({ stateStore: store, sessions: () => [{ id: 'a' }], ready: () => true, send: sendSpy, convoIdOf: s => s.id, log });
    expect(again.notifyPending()).toEqual([]);
    expect(again.notifyPending()).toEqual([]);
    expect(again.notifyPending()).toEqual(['a']);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.markNotified).toHaveBeenCalledWith('r1', 'a');
    expect(again.notifyPending()).toEqual([]);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(notices).toBeDefined();
  });

  it('does not send the notice again when recording it failed', () => {
    const { notices, store, sendSpy } = make({ sessions: [{ id: 'a' }] });
    store.markNotified.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => notices.notifyPending()).toThrow('ENOSPC');
    expect(notices.notifyPending()).toEqual(['a']);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('skips sessions without an id and does nothing unless a restart is pending', () => {
    const idless = make({ sessions: [{ id: null }, { id: 'a' }] });
    expect(idless.notices.notifyPending()).toEqual(['a']);
    for (const state of ['restarting', 'back', null]) {
      const h = make({ state: { id: 'r1', state, requests: [], notified: {} } });
      expect(h.notices.notifyPending()).toEqual([]);
      expect(h.sendSpy).not.toHaveBeenCalled();
    }
  });

  it('does not re-tell a session already recorded for this restart', () => {
    const { notices, sendSpy } = make({ state: { id: 'r1', state: 'pending', requests: [], notified: { a: { at: 1 } } } });
    expect(notices.notifyPending()).toEqual(['b']);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
