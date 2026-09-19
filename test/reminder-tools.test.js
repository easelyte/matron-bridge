import { describe, it, expect, vi } from 'vitest';
import { createReminderHandlers, reminderView, formatReminderLine, REMINDER_TEXT_MAX } from '../lib/reminder-tools.js';
import { createTimerStore, MIN_TIMER_MS, MAX_TIMER_MS } from '../lib/timer-command.js';

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 17, 10, 0, 0, 0).getTime(); // local 10:00

function fixture({ announce } = {}) {
  const saves = [];
  const store = createTimerStore({
    load: () => null,
    save: (d) => saves.push(JSON.parse(JSON.stringify(d))),
    now: () => NOW,
    setTimer: () => 1,
    clearTimer: () => {},
    onFire: () => {},
  });
  const session = { journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const announceFn = announce || vi.fn(async () => {});
  const h = createReminderHandlers({
    sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, timerStore: store, now: () => NOW, announce: announceFn,
  });
  return { h, store, saves, session, announce: announceFn };
}

describe('reminder handlers', () => {
  it('create with `in` arms a convo-scoped agent record, persists it, and announces it', async () => {
    const { h, store, saves, announce, session } = fixture();
    const r = await h.create({ roomId: '!r:s', text: 'check the CI curve', in: '2h' });
    expect(r.status).toBe(201);
    expect(r.body.reminder).toMatchObject({ id: 1, text: 'check the CI curve', in_ms: 2 * HOUR, hold_awake: false, source: 'agent' });
    expect(r.body.reminder.fire_at).toBe(new Date(NOW + 2 * HOUR).toISOString());
    expect(store.listForConvo('c1')).toHaveLength(1);
    expect(saves.at(-1).timers[0]).toMatchObject({ convoId: 'c1', roomId: '!r:s', source: 'agent' });
    expect(saves.at(-1).timers[0].holdAwake).toBeUndefined();
    expect(announce).toHaveBeenCalledWith(session, expect.objectContaining({ id: 1 }));
  });

  it('create with `at` resolves a clock time on this box', async () => {
    const { h } = fixture();
    const r = await h.create({ roomId: '!r:s', text: 'standup', at: '14:30' });
    expect(r.status).toBe(201);
    expect(r.body.reminder.in_ms).toBe(4.5 * HOUR);
  });

  it('hold_awake is persisted on the record so the keep-awake marker and the reaper see it', async () => {
    const { h, saves, store } = fixture();
    const r = await h.create({ roomId: '!r:s', text: 'deploy window', in: '3h', hold_awake: true });
    expect(r.status).toBe(201);
    expect(r.body.reminder.hold_awake).toBe(true);
    expect(saves.at(-1).timers[0].holdAwake).toBe(true);
    expect(store.holdAwakeUntil('c1')).toBe(NOW + 3 * HOUR);
  });

  it('a failing announce never fails the tool — the reminder is already armed', async () => {
    const { h, store } = fixture({ announce: vi.fn(async () => { throw new Error('chat down'); }) });
    const r = await h.create({ roomId: '!r:s', text: 'x', in: '10m' });
    expect(r.status).toBe(201);
    expect(store.listForConvo('c1')).toHaveLength(1);
  });

  it('a failed save is a failed create: nothing armed, nothing listed, no announce, 500', async () => {
    const setTimer = vi.fn(() => 1);
    const store = createTimerStore({
      load: () => null, save: () => { throw new Error('ENOSPC'); }, now: () => NOW,
      setTimer, clearTimer: () => {}, onFire: () => {},
    });
    const announce = vi.fn(async () => {});
    const h = createReminderHandlers({
      sessions: new Map([['!r:s', { journalConvoId: 'c1' }]]),
      journalConvoIdFor: (s) => s.journalConvoId, timerStore: store, now: () => NOW, announce,
    });
    const r = await h.create({ roomId: '!r:s', text: 'x', in: '2h', hold_awake: true });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/NOT set/);
    expect(setTimer).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(store.listForConvo('c1')).toEqual([]);
    expect(store.holdAwakeUntil('c1')).toBeNull();
  });

  it('validates text, the in/at pair, bounds and hold_awake', async () => {
    const { h } = fixture();
    expect((await h.create({ roomId: '!r:s', in: '1h' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: '   ', in: '1h' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x'.repeat(REMINDER_TEXT_MAX + 1), in: '1h' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x', in: '1h', at: '09:00' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x', in: 'soon' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x', at: '25:00' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', text: 'x', in: '1s' })).body.error).toMatch(/too soon/);
    expect((await h.create({ roomId: '!r:s', text: 'x', in: '8d' })).body.error).toMatch(/too far/);
    expect((await h.create({ roomId: '!r:s', text: 'x', in: '1h', hold_awake: 'yes' })).status).toBe(400);
    expect(MIN_TIMER_MS).toBeLessThan(MAX_TIMER_MS);
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('list shows this convo only, user /timer records included, soonest first', async () => {
    const { h, store } = fixture();
    store.add({ convoId: 'c1', roomId: '!r:s', text: 'typed by the user', delayMs: HOUR });
    store.add({ convoId: 'other', roomId: '!o:s', text: 'not ours', delayMs: HOUR });
    await h.create({ roomId: '!r:s', text: 'agent one', in: '30m' });
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(r.body.reminders.map(x => [x.text, x.source])).toEqual([['agent one', 'agent'], ['typed by the user', 'user']]);
  });

  it('cancel by id and all are convo-scoped; nothing matched is a 404', async () => {
    const { h, store } = fixture();
    const a = await h.create({ roomId: '!r:s', text: 'a', in: '1h' });
    await h.create({ roomId: '!r:s', text: 'b', in: '2h' });
    store.add({ convoId: 'other', roomId: '!o:s', text: 'theirs', delayMs: HOUR });
    expect((await h.cancel({ roomId: '!r:s', id: a.body.reminder.id })).body.cancelled.map(x => x.text)).toEqual(['a']);
    expect((await h.cancel({ roomId: '!r:s', id: 999 })).status).toBe(404);
    expect((await h.cancel({ roomId: '!r:s', id: 'nope' })).status).toBe(400);
    expect((await h.cancel({ roomId: '!r:s', id: 'all' })).body.cancelled.map(x => x.text)).toEqual(['b']);
    expect((await h.cancel({ roomId: '!r:s', id: 'all' })).status).toBe(404);
    expect(store.listForConvo('other')).toHaveLength(1);
  });
});

describe('reminderView / formatReminderLine', () => {
  it('renders a sentence with who set it and the hold', () => {
    const v = reminderView({ id: 4, text: 'go', fireAt: NOW + 90 * 60_000, holdAwake: true, source: 'agent' }, NOW);
    expect(formatReminderLine(v)).toBe(`#4 — in 1h 30m (${new Date(NOW + 90 * 60_000).toISOString()}, set by you, holding the box awake): "go"`);
    const u = reminderView({ id: 5, text: 'hey', fireAt: NOW - 1000 }, NOW);
    expect(u).toMatchObject({ in_ms: 0, hold_awake: false, source: 'user' });
    expect(formatReminderLine(u)).toContain('set by the user with /timer');
  });
});
