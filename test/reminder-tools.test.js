import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { codexMcpConfig } from '../lib/codex-mcp.js';
import { createReminderHandlers, reminderView, formatReminderLine, REMINDER_TEXT_MAX } from '../lib/reminder-tools.js';
import { createTimerStore, MIN_TIMER_MS, MAX_TIMER_MS } from '../lib/timer-command.js';
import { createRestartNotes } from '../lib/restart-notes.js';

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

// repeat: "daily" + tz. A fixed UTC instant and named zones, so these hold
// in any host TZ: 2026-09-30 05:00Z is 06:00 BST in London.
describe('daily repeating reminders (repeat + tz)', () => {
  const T = Date.parse('2026-09-30T05:00:00Z');
  function daily() {
    const store = createTimerStore({ load: () => null, save: () => {}, now: () => T, setTimer: () => 1, clearTimer: () => {}, onFire: () => {} });
    const announce = vi.fn(async () => {});
    const h = createReminderHandlers({
      sessions: new Map([['!r:s', { journalConvoId: 'c1' }]]),
      journalConvoIdFor: (s) => s.journalConvoId, timerStore: store, now: () => T, announce,
    });
    return { h, store, announce };
  }
  const create = (h, extra) => h.create({ roomId: '!r:s', text: 'run the mission and project status sweep', ...extra });

  it('creates a daily reminder at a wall-clock time in the named zone', async () => {
    const { h, store, announce } = daily();
    const r = await create(h, { at: '08:00', repeat: 'daily', tz: 'Europe/London' });
    expect(r.status).toBe(201);
    expect(r.body.reminder).toMatchObject({ repeat: 'daily', at: '08:00', tz: 'Europe/London', fire_at: '2026-09-30T07:00:00.000Z', in_ms: 2 * HOUR });
    expect(store.listForConvo('c1')[0].repeat).toEqual({ kind: 'daily', hour: 8, minute: 0, tz: 'Europe/London' });
    expect(announce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repeat: expect.objectContaining({ kind: 'daily' }) }));
  });

  it('tz defaults to this box\'s own zone, stored by name so the list can say which', async () => {
    const { h } = daily();
    const r = await create(h, { at: '17:00', repeat: 'daily' });
    expect(r.status).toBe(201);
    expect(r.body.reminder.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('tz also applies to a one-shot `at`', async () => {
    const { h } = daily();
    const r = await create(h, { at: '09:00', tz: 'America/New_York' });
    expect(r.status).toBe(201);
    // 05:00Z is 01:00 EDT; 09:00 EDT is 13:00Z.
    expect(r.body.reminder.fire_at).toBe('2026-09-30T13:00:00.000Z');
    expect(r.body.reminder.repeat).toBeUndefined();
  });

  it('rejects repeat with `in`, without `at`, an unknown repeat, a bad tz, tz with `in`, and hold_awake with repeat', async () => {
    const { h, store } = daily();
    const err = async (extra) => {
      const r = await create(h, extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
      return r.body.error;
    };
    expect(await err({ in: '2h', repeat: 'daily' })).toBe("repeat: \"daily\" needs 'at' (a clock time such as 08:00), not 'in' — it fires at that time every day");
    expect(await err({ repeat: 'daily' })).toBe("repeat: \"daily\" needs 'at' (a clock time such as 08:00), not 'in' — it fires at that time every day");
    expect(await err({ at: '08:00', repeat: 'weekly' })).toBe('repeat must be "daily" (got "weekly")');
    expect(await err({ at: '08:00', repeat: true })).toBe('repeat must be "daily" (got true)');
    expect(await err({ at: '08:00', repeat: 'daily', tz: 'Mars/Olympus_Mons' })).toBe('tz must be an IANA time zone such as Europe/London or America/New_York (got "Mars/Olympus_Mons")');
    expect(await err({ at: '08:00', tz: '+01:00' })).toMatch(/^tz must be an IANA time zone/);
    expect(await err({ in: '2h', tz: 'Europe/London' })).toBe("tz only applies to 'at' — 'in' is a duration, the same in every zone");
    expect(await err({ at: '08:00', repeat: 'daily', hold_awake: true })).toBe('hold_awake cannot be combined with repeat — a daily reminder would keep the box awake for good; the box is woken for each check-in anyway');
    expect(await err({ at: '25:00', repeat: 'daily', tz: 'Europe/London' })).toMatch(/^'at' must be a clock time/);
    expect(store.listForConvo('c1')).toEqual([]);
  });

  it('list shows a repeating reminder as repeating, with its next fire', async () => {
    const { h } = daily();
    await create(h, { at: '08:00', repeat: 'daily', tz: 'Europe/London' });
    const r = await h.list({ roomId: '!r:s' });
    expect(r.body.reminders.map(formatReminderLine)).toEqual([
      '#1 — daily at 08:00 Europe/London, next in 2h (2026-09-30T07:00:00.000Z, set by you): "run the mission and project status sweep"',
    ]);
  });

  it('cancel ends it for good', async () => {
    const { h, store } = daily();
    const a = await create(h, { at: '08:00', repeat: 'daily', tz: 'Europe/London' });
    const c = await h.cancel({ roomId: '!r:s', id: a.body.reminder.id });
    expect(c.status).toBe(200);
    expect(c.body.cancelled[0]).toMatchObject({ id: a.body.reminder.id, repeat: 'daily' });
    expect(store.listForConvo('c1')).toEqual([]);
  });
});

describe('restart note creation', () => {
  function setup({ available = true, state = { id: 'restart-a', state: 'pending' }, hold = vi.fn((id, convoId, text) => ({ id, convoId, text, writtenAt: NOW })) } = {}) {
    const setTimer = vi.fn();
    const onFire = vi.fn();
    const store = createTimerStore({ load: () => null, save: () => {}, now: () => NOW, setTimer, clearTimer: () => {}, onFire });
    const restartState = { getState: vi.fn(() => state) };
    const h = createReminderHandlers({ sessions: new Map([['box-a', { journalConvoId: 'alice', agent: 'codex' }]]),
      journalConvoIdFor: s => s.journalConvoId, timerStore: store, restartState: available ? restartState : undefined, restartNotes: { hold }, now: () => NOW });
    return { h, hold, store, setTimer, onFire, restartState };
  }
  const input = { roomId: 'box-a', restart_note: true, text: 'resume work' };

  it('the registered tool forwards a delay-free Codex note, saves it and acknowledges the hold', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'restart-notes-'));
    try {
      const options = { heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json'), now: () => NOW };
      const notes = createRestartNotes(options);
      const { h } = setup({ hold: notes.hold });
      const posts = [];
      const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        posts.push(body);
        const result = await h[url.split('/reminders/')[1]](body);
        return { ok: result.status < 300, status: result.status, json: async () => result.body };
      };
      const tools = new Map();
      const server = { tool: (name, description, schema, callback) => tools.set(name, { schema: z.object(schema), callback }) };
      const source = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
      const start = source.indexOf('async function callReminders(');
      const end = source.lastIndexOf('server.tool(', source.indexOf("  'reminder_list',"));
      Function('server', 'z', 'fetch', 'BRIDGE_API', 'ROOM_ID', 'formatReminderLine', source.slice(start, end))(
        server, z, fetch, 'http://bridge', 'box-a', formatReminderLine);
      const tool = tools.get('reminder_create');
      const result = await tool.callback(tool.schema.parse({ restart_note: true, text: 'resume work' }));
      expect(posts).toEqual([input]);
      expect(createRestartNotes(options).listHeld('restart-a')).toEqual([
        { id: 'restart-a', convoId: 'alice', text: 'resume work', writtenAt: NOW },
      ]);
      expect(result).toEqual({ content: [{ type: 'text', text: 'Restart note held for delivery after the planned restart.' }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a delay-free note from a Codex session and never arms or fires a timer over 48 hours', async () => {
    const { h, hold, store, setTimer, onFire } = setup();
    expect((await h.create(input)).body.restart_note).toEqual({ id: 'restart-a', convoId: 'alice', text: 'resume work', writtenAt: NOW });
    expect(hold).toHaveBeenCalledWith('restart-a', 'alice', 'resume work');
    expect(store.listForConvo('alice')).toEqual([]);
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(48 * HOUR); } finally { vi.useRealTimers(); }
    expect(setTimer).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('accepts a note after the restart returns to pending', async () => {
    const { h, restartState, hold } = setup();
    restartState.getState.mockReturnValueOnce({ id: 'restart-a', state: 'restarting' });
    expect((await h.create(input)).status).toBe(409);
    expect((await h.create(input)).status).toBe(201);
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it.each([{ in: '1h' }, { at: '09:00' }, { repeat: 'daily' }, { hold_awake: true }, { hold_awake: false }, { in: null }])('rejects scheduling options on a note: %j', async extra => {
    const { h, hold } = setup();
    expect((await h.create({ ...input, ...extra })).status).toBe(400);
    expect(hold).not.toHaveBeenCalled();
  });

  it.each([null, { state: 'pending', id: null }, { state: 'restarting', id: 'restart-a' }, { state: 'back', id: 'restart-a' }, { state: 'cancelled', id: 'restart-a' }, { state: 'abandoned', id: 'restart-a' }])('refuses a note without a pending restart: %j', async state => {
    const { h, hold } = setup({ state });
    expect((await h.create(input)).status).toBe(409);
    expect(hold).not.toHaveBeenCalled();
  });

  it.each(['state', 'save', 'unavailable', 'not saved'])('refuses %s failures without acknowledging a note', async failure => {
    const { h, hold, restartState } = setup({ available: failure !== 'unavailable', hold: vi.fn(() => { throw new Error('disk failure'); }) });
    if (failure === 'not saved') hold.mockReturnValue(null);
    if (failure === 'state') restartState.getState.mockImplementation(() => { throw new Error('unreadable'); });
    expect((await h.create(input)).status).toBe(500);
    if (failure === 'state' || failure === 'unavailable') expect(hold).not.toHaveBeenCalled();
  });

  it.each([null, 'true', 1])('rejects a nonboolean note flag %j', async flag => {
    const { h, hold } = setup();
    expect((await h.create({ ...input, restart_note: flag, in: '1h' })).status).toBe(400);
    expect(hold).not.toHaveBeenCalled();
  });

  it('accepts the text limit and refuses limit plus one, empty and missing text', async () => {
    const { h, hold } = setup();
    expect((await h.create({ ...input, text: 'x'.repeat(REMINDER_TEXT_MAX) })).body.restart_note?.text).toHaveLength(REMINDER_TEXT_MAX);
    for (const text of ['x'.repeat(REMINDER_TEXT_MAX + 1), '', ' ', null, undefined]) {
      expect((await h.create({ ...input, text })).status).toBe(400);
    }
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('keeps false as an ordinary scheduled reminder', async () => {
    const { h, hold } = setup();
    expect((await h.create({ ...input, restart_note: false, in: '1h' })).body.reminder?.in_ms).toBe(HOUR);
    expect(hold).not.toHaveBeenCalled();
  });
});

it('exposes the delay-free boolean field through the shared Codex tool and wires durable note dependencies', () => {
  const source = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf("  'reminder_create',"), source.indexOf("  'reminder_list',"));
  const schemaText = create.slice(create.indexOf('  {'), create.indexOf('  async (args)'));
  const schema = z.object(Function('z', `return (${schemaText.trim().replace(/,$/, '')})`)(z));
  expect(schema.parse({ text: 'resume', restart_note: true })).toEqual({ text: 'resume', restart_note: true });
  expect(schema.safeParse({ text: 'resume', restart_note: 'true' }).success).toBe(false);
  const config = codexMcpConfig({ baseConfig: { mcpServers: { 'ask-user': { command: 'node', args: ['ask-user.js'] } } }, bridgeDir: process.cwd(), roomId: 'box-a', apiPort: 0 });
  expect(config.mcp_servers['ask-user'].args.some(arg => arg.endsWith('ask-user.js'))).toBe(true);
  expect(config.mcp_servers['ask-user'].disabled_tools).not.toContain('reminder_create');
  const bridge = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const wiring = bridge.slice(bridge.indexOf('const reminderHandlers ='), bridge.indexOf('// Parent-side agent-spawn handlers'));
  expect(wiring).toContain('journalConvoIdFor,');
  expect(wiring).toContain('restartState: plannedRestartAvailable ? plannedRestartState : undefined');
  expect(wiring).toContain('restartNotes: createRestartNotes()');
  expect(create).toContain("d.restart_note ? 'Restart note held");
});
