import { describe, it, expect, vi } from 'vitest';
import { createRoutineHandlers, describeSchedule, describeTrigger, formatRoutineList, formatRoutineLine, formatRoutineUpdateAck, formatRoutineRunAck, formatJournalRoutinesError, validateUpdateFields } from '../lib/routines-tools.js';
import { createRoutinesClient } from '../lib/routines-client.js';

const NOW = Date.parse('2026-10-01T10:00:00Z'); // 11:00 BST
const sweep = { id: 'rt_01', name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', tz: 'Europe/London', prompt: 'Routine daily-sweep: follow the Daily sweep section of your playbook.', enabled: true, origin: 'seed', next_at: Date.parse('2026-10-02T06:05:00Z'), last_fired_at: NOW - 4 * 3_600_000, last_outcome: 'applied now' };
const health = { id: 'rt_02', name: 'session-health', title: 'Session health check', schedule: '0 */2 * * *', tz: 'Europe/London', prompt: 'p', enabled: false, origin: 'seed', next_at: null, last_fired_at: null, last_outcome: null };
const window_ = { id: 'rt_03', name: 'deploy-window', title: 'Evening deploy window', schedule: '30 18 * * 1-5', tz: 'Europe/London', prompt: 'p', enabled: true, origin: 'user', next_at: Date.parse('2026-10-01T17:30:00Z'), last_fired_at: null, last_outcome: 'missed' };

function fixture({ coordinator = true, list = { status: 200, data: { routines: [sweep, health, window_] } }, update = { status: 200, data: { routine: { ...sweep, enabled: false, next_at: null } } }, run = { status: 202, data: { accepted: true } } } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const sessions = new Map([['!r:s', session]]);
  const client = { list: vi.fn(async () => list), update: vi.fn(async () => update), run: vi.fn(async () => run) };
  const h = createRoutineHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, now: () => NOW });
  return { h, client, session };
}

describe('routine handlers', () => {
  it('refuse a non-Coordinator session before any journal call, and the usual session guards', async () => {
    const { h, client } = fixture({ coordinator: false });
    for (const call of [h.list({ roomId: '!r:s' }), h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false }), h.run({ roomId: '!r:s', name: 'daily-sweep' })]) {
      const r = await call;
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not the Coordinator/);
    }
    expect(client.list).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other' })).status).toBe(404);
    const noConvo = fixture();
    noConvo.session.journalConvoId = null;
    expect((await noConvo.h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('isCoordinator lets the wiring count the journal\'s current role holder', async () => {
    const session = { roomId: '!r:s', coordinator: false, journalConvoId: 'c-coord' };
    const client = { list: vi.fn(async () => ({ status: 200, data: { routines: [] } })), update: vi.fn(), run: vi.fn() };
    const h = createRoutineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client, isCoordinator: (s, convoId) => s.coordinator === true || convoId === 'c-coord' });
    expect((await h.list({ roomId: '!r:s' })).status).toBe(200);
    session.journalConvoId = 'c-other';
    expect((await h.list({ roomId: '!r:s' })).status).toBe(403);
  });

  it('list passes the routines through; a journal without the routes, or unreachable, says so', async () => {
    const { h } = fixture();
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(r.body.routines).toHaveLength(3);
    expect((await fixture({ list: { status: 404, data: { error: 'not_found' } } }).h.list({ roomId: '!r:s' })).body.error).toMatch(/\/routines routes yet/);
    expect((await fixture({ list: { status: 0, data: { error: 'journal unreachable' } } }).h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  it('update validates the name and fields with reasons, then PATCHes with the Coordinator convo_id', async () => {
    const { h, client } = fixture();
    expect((await h.update({ roomId: '!r:s', name: 'Daily Sweep', enabled: false })).body.error).toMatch(/slug/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep' })).body.error).toMatch(/nothing to change/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', schedule: 'daily' })).body.error).toMatch(/five cron fields/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', title: 'a\nb' })).body.error).toMatch(/one non-empty line/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', prompt: 'x'.repeat(2001) })).body.error).toMatch(/2000/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', tz: 'Europe/ London' })).body.error).toMatch(/IANA/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: 'no' })).body.error).toMatch(/true or false/);
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', origin: 'user' })).body.error).toMatch(/not editable/);
    expect(client.update).not.toHaveBeenCalled();
    const r = await h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false, title: ' Sweep ' });
    expect(r.status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['daily-sweep', { enabled: false, title: 'Sweep', convo_id: 'c-coord' }]);
    // Journal refusals become sentences.
    expect((await fixture({ update: { status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } } }).h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: true })).body.error).toMatch(/does not list this conversation as the Coordinator/);
    expect((await fixture({ update: { status: 404, data: { error: 'not_found' } } }).h.update({ roomId: '!r:s', name: 'nope', enabled: true })).body.error).toMatch(/^no routine named "nope" .*or this journal deployment does not have the \/routines routes yet$/);
    expect((await fixture({ update: { status: 400, data: { error: 'bad_request' } } }).h.update({ roomId: '!r:s', name: 'daily-sweep', schedule: '* * * * *' })).body.error).toMatch(/15 minutes apart/);
  });

  it('run posts the Coordinator convo_id and passes the 202 body through', async () => {
    const { h, client } = fixture();
    expect((await h.run({ roomId: '!r:s', name: 'bad name' })).status).toBe(400);
    const r = await h.run({ roomId: '!r:s', name: 'daily-sweep' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: true });
    expect(client.run.mock.calls[0]).toEqual(['daily-sweep', { convo_id: 'c-coord' }]);
  });
});

describe('formatting', () => {
  it('describeSchedule puts the common shapes in words and leaves the rest as cron', () => {
    expect(describeSchedule('5 7 * * *', 'Europe/London')).toBe('daily at 07:05 Europe/London');
    expect(describeSchedule('0 8,17 * * *', 'Europe/London')).toBe('daily at 08:00 and 17:00 Europe/London');
    expect(describeSchedule('0 8,12,17 * * *', 'UTC')).toBe('daily at 08:00, 12:00 and 17:00 UTC');
    expect(describeSchedule('0 */2 * * *', 'Europe/London')).toBe('every 2 h at :00 Europe/London');
    expect(describeSchedule('30 18 * * 1-5', 'Europe/London')).toBe('weekdays at 18:30 Europe/London');
    expect(describeSchedule('0 10 * * 0,6', 'Europe/London')).toBe('weekends at 10:00 Europe/London');
    expect(describeSchedule('0 9 * * 1,4', 'Europe/London')).toBe('Mon, Thu at 09:00 Europe/London');
    expect(describeSchedule('15 * * * *', 'UTC')).toBe('hourly at :15 UTC');
    expect(describeSchedule('0 9 1 * *', 'UTC')).toBe('cron "0 9 1 * *" UTC');
    expect(describeSchedule('*/15 * * * *', 'UTC')).toBe('cron "*/15 * * * *" UTC');
    expect(describeSchedule('', 'UTC')).toBe('no schedule');
    expect(describeSchedule(7, 'UTC')).toBe('no schedule');
    expect(describeSchedule('a b c', undefined)).toBe('cron "a b c"');
  });

  it('formatRoutineList: one line per routine with schedule in words, next fire, last outcome, paused', () => {
    const text = formatRoutineList({ routines: [sweep, health, window_] }, { now: NOW });
    expect(text).toMatch(/^3 routines the journal fires into this conversation/);
    expect(text).toContain('- daily-sweep — Daily sweep · daily at 07:05 Europe/London · next in 20 h (Fri 07:05) · last fired 4 h ago: applied now');
    expect(text).toContain('- session-health — Session health check · every 2 h at :00 Europe/London · paused');
    expect(text).toContain('- deploy-window — Evening deploy window · weekdays at 18:30 Europe/London · next in 8 h (Thu 18:30) · last: missed');
    expect(formatRoutineList({ routines: [] })).toMatch(/no routines/);
    // Hostile fields are capped and one-lined; a bad name shows as ?.
    const line = formatRoutineLine({ name: 'Bad Name', title: 'x\ny'.repeat(60), schedule: '5 7 * * *', tz: 'UTC', enabled: true, next_at: NOW + 60_000, last_outcome: 'z\u0007z' }, NOW);
    expect(line.startsWith('- ? — x ⏎ y')).toBe(true);
    expect(line).not.toContain('\n');
  });

  it('acks', () => {
    expect(formatRoutineUpdateAck({ routine: { ...sweep, enabled: false, next_at: null } }, { enabled: false })).toMatch(/^Paused daily-sweep: it will not fire until resumed/);
    expect(formatRoutineUpdateAck({ routine: sweep }, { enabled: true })).toMatch(/^Resumed daily-sweep\./);
    expect(formatRoutineUpdateAck({ routine: sweep }, { name: 'daily-sweep', roomId: '!r', enabled: true })).toMatch(/^Resumed daily-sweep\./);
    expect(formatRoutineUpdateAck({ routine: sweep }, { title: 'Sweep' })).toMatch(/^Updated daily-sweep\./);
    expect(formatRoutineRunAck({ accepted: true }, 'daily-sweep')).toMatch(/^Firing daily-sweep now/);
    expect(formatRoutineRunAck({ delivered: false, reason: 'no_coordinator' }, 'daily-sweep')).toMatch(/no Coordinator/);
    expect(formatRoutineRunAck({ delivered: false, reason: 'busy' }, 'daily-sweep')).toMatch(/try again/);
    expect(formatJournalRoutinesError({ error: 'conflict', blocked_by: 'cap' })).toMatch(/maximum/);
    expect(validateUpdateFields({ enabled: true, name: 'x', roomId: 'r' })).toEqual({ ok: true, value: { enabled: true } });
    expect(validateUpdateFields({ trigger: { kind: 'context_over', pct: 55 } })).toEqual({ ok: true, value: { trigger: { kind: 'context_over', pct: 55 } } });
    expect(validateUpdateFields({ trigger: { kind: 'stalled' } })).toEqual({ ok: true, value: { trigger: { kind: 'stalled' } } });
    expect(validateUpdateFields({ trigger: { kind: 'stalled', reset_minutes: 30 } })).toEqual({ ok: true, value: { trigger: { kind: 'stalled', reset_minutes: 30 } } });
    expect(validateUpdateFields({ trigger: { kind: 'context_over', pct: 100 } }).ok).toBe(false);
    expect(validateUpdateFields({ trigger: { kind: 'volcano', pct: 5 } }).ok).toBe(false);
    expect(validateUpdateFields({ trigger: { kind: 'disk_under', pct: 20 }, schedule: '5 7 * * *' }).err.body.error).toMatch(/not both/);
    expect(describeTrigger({ kind: 'context_over', pct: 40 })).toBe('when a session passes 40% of its context window');
    expect(describeTrigger({ kind: 'stalled', reset_minutes: 120 })).toBe('when a session stalls on a usage limit with no reset within 2 h');
    expect(describeTrigger({ kind: 'disk_under', pct: 20 })).toBe('when a box drops under 20% free disk');
    const trig = { id: 'rt_9', name: 'disk-low', title: 'Box disk under the threshold', schedule: null, trigger: { kind: 'disk_under', pct: 20 }, tz: 'Europe/London', prompt: 'p', enabled: true, origin: 'seed', next_at: null, last_fired_at: null, last_outcome: null };
    expect(formatRoutineLine(trig, NOW)).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk');
  });
});

describe('createRoutinesClient', () => {
  it('GETs, PATCHes and POSTs against the journal with the bearer; a missing base is unreachable', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push([url, init.method, init.body]); return { ok: true, status: 200, json: async () => ({ routines: [] }) }; });
    const c = createRoutinesClient({ baseUrl: 'http://j/', token: 't', fetchImpl });
    expect(await c.list()).toEqual({ status: 200, data: { routines: [] } });
    await c.update('daily-sweep', { enabled: false, convo_id: 'c' });
    await c.run('a/b', { convo_id: 'c' });
    expect(calls).toEqual([
      ['http://j/routines', 'GET', undefined],
      ['http://j/routines/daily-sweep', 'PATCH', JSON.stringify({ enabled: false, convo_id: 'c' })],
      ['http://j/routines/a%2Fb/run', 'POST', JSON.stringify({ convo_id: 'c' })],
    ]);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
    expect(await createRoutinesClient({ baseUrl: '', token: 't' }).list()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const down = createRoutinesClient({ baseUrl: 'http://j', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect((await down.list()).status).toBe(0);
    const err = createRoutinesClient({ baseUrl: 'http://j', token: 't', fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('x'); } }) });
    expect(await err.list()).toEqual({ status: 500, data: { error: 'HTTP 500' } });
  });
});
