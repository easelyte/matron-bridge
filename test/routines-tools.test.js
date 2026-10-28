import { describe, it, expect, vi } from 'vitest';
import { createRoutineHandlers, describeSchedule, describeTrigger, formatRoutineList, formatRoutineLine, formatRoutineUpdateAck, formatRoutineRunAck, formatRoutineCreateAck, formatRoutineDeleteAck, formatJournalRoutinesError, validateUpdateFields, validateCreateFields } from '../lib/routines-tools.js';
import { createRoutinesClient } from '../lib/routines-client.js';

const NOW = Date.parse('2026-10-01T10:00:00Z'); // 11:00 BST
const sweep = { id: 'rt_01', name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', tz: 'Europe/London', prompt: 'Routine daily-sweep: follow the Daily sweep section of your playbook.', enabled: true, origin: 'seed', next_at: Date.parse('2026-10-02T06:05:00Z'), last_fired_at: NOW - 4 * 3_600_000, last_outcome: 'applied now' };
const health = { id: 'rt_02', name: 'session-health', title: 'Session health check', schedule: '0 */2 * * *', tz: 'Europe/London', prompt: 'p', enabled: false, origin: 'seed', next_at: null, last_fired_at: null, last_outcome: null };
const window_ = { id: 'rt_03', name: 'deploy-window', title: 'Evening deploy window', schedule: '30 18 * * 1-5', tz: 'Europe/London', prompt: 'p', enabled: true, origin: 'user', next_at: Date.parse('2026-10-01T17:30:00Z'), last_fired_at: null, last_outcome: 'missed' };

const triage = { name: 'exception-triage', title: 'Exception and alert triage', schedule: '30 8,16 * * *', tz: 'Europe/London', prompt: 'Routine exception-triage: follow the exception-triage-routine memory.' };

function fixture({ coordinator = true, list = { status: 200, data: { routines: [sweep, health, window_] } }, update = { status: 200, data: { routine: { ...sweep, enabled: false, next_at: null } } }, run = { status: 202, data: { accepted: true } }, create = { status: 201, data: { routine: { ...sweep, id: 'rt_new', name: 'exception-triage', title: 'Exception and alert triage', schedule: '30 8,16 * * *', origin: 'agent', last_fired_at: null, last_outcome: null } } }, remove = { status: 200, data: { ok: true } } } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const sessions = new Map([['!r:s', session]]);
  const client = { list: vi.fn(async () => list), update: vi.fn(async () => update), run: vi.fn(async () => run), create: vi.fn(async () => create), remove: vi.fn(async () => remove) };
  const h = createRoutineHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, now: () => NOW });
  return { h, client, session };
}

describe('routine handlers', () => {
  it('refuse a non-Coordinator session before any journal call, and the usual session guards', async () => {
    const { h, client } = fixture({ coordinator: false });
    for (const call of [h.list({ roomId: '!r:s' }), h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false }), h.run({ roomId: '!r:s', name: 'daily-sweep' }), h.create({ roomId: '!r:s', ...triage }), h.remove({ roomId: '!r:s', name: 'daily-sweep' })]) {
      const r = await call;
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not the Coordinator/);
    }
    expect(client.list).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
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

describe('routine create and delete', () => {
  it('create validates with reasons, then POSTs the fields with the Coordinator convo_id', async () => {
    const { h, client } = fixture();
    expect((await h.create({ roomId: '!r:s', ...triage, name: 'Exception Triage' })).body.error).toMatch(/lowercase letters, digits and dashes/);
    expect((await h.create({ roomId: '!r:s', ...triage, title: undefined })).body.error).toMatch(/title is required/);
    expect((await h.create({ roomId: '!r:s', ...triage, prompt: undefined })).body.error).toMatch(/prompt is required/);
    expect((await h.create({ roomId: '!r:s', ...triage, title: null })).body.error).toMatch(/title is required/);
    expect((await h.create({ roomId: '!r:s', ...triage, prompt: null })).body.error).toMatch(/prompt is required/);
    expect((await h.create({ roomId: '!r:s', ...triage, schedule: undefined })).body.error).toMatch(/schedule or a trigger/);
    expect((await h.create({ roomId: '!r:s', ...triage, trigger: { kind: 'disk_under', pct: 20 } })).body.error).toMatch(/not both/);
    expect((await h.create({ roomId: '!r:s', ...triage, schedule: 'twice daily' })).body.error).toMatch(/five cron fields/);
    expect((await h.create({ roomId: '!r:s', ...triage, origin: 'user' })).body.error).toMatch(/not a routine field/);
    expect(client.create).not.toHaveBeenCalled();
    const r = await h.create({ roomId: '!r:s', ...triage, title: ' Exception and alert triage ' });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0]).toEqual([{ ...triage, convo_id: 'c-coord' }]);
    // A triggered routine and a paused one; tz may be left to the journal.
    await h.create({ roomId: '!r:s', name: 'disk-tight', title: 'Disk tight', prompt: 'p', trigger: { kind: 'disk_under', pct: 10 }, enabled: false });
    expect(client.create.mock.calls[1]).toEqual([{ name: 'disk-tight', title: 'Disk tight', prompt: 'p', trigger: { kind: 'disk_under', pct: 10 }, enabled: false, convo_id: 'c-coord' }]);
    // Journal refusals become sentences; an older journal says to deploy.
    expect((await fixture({ create: { status: 409, data: { error: 'conflict', blocked_by: 'name' } } }).h.create({ roomId: '!r:s', ...triage })).body.error).toMatch(/already exists/);
    expect((await fixture({ create: { status: 400, data: { error: 'bad_request' } } }).h.create({ roomId: '!r:s', ...triage, schedule: '* * * * *' })).body.error).toMatch(/15 minutes apart/);
    expect((await fixture({ create: { status: 404, data: { error: 'not_found' } } }).h.create({ roomId: '!r:s', ...triage })).body.error).toMatch(/\/routines routes yet/);
  });

  it('delete checks the name, then DELETEs with the Coordinator convo_id', async () => {
    const { h, client } = fixture();
    expect((await h.remove({ roomId: '!r:s', name: 'bad name' })).status).toBe(400);
    expect(client.remove).not.toHaveBeenCalled();
    const r = await h.remove({ roomId: '!r:s', name: 'daily-sweep' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(client.remove.mock.calls[0]).toEqual(['daily-sweep', { convo_id: 'c-coord' }]);
    expect((await fixture({ remove: { status: 404, data: { error: 'not_found' } } }).h.remove({ roomId: '!r:s', name: 'nope' })).body.error).toMatch(/^no routine named "nope"/);
    // A journal from before Coordinator deletes refuses every agent.
    expect((await fixture({ remove: { status: 403, data: { error: 'forbidden' } } }).h.remove({ roomId: '!r:s', name: 'daily-sweep' })).body.error).toMatch(/deploy the journal update/);
  });

  it('acks and validateCreateFields', () => {
    const created = { ...sweep, name: 'exception-triage', title: 'Exception and alert triage', schedule: '30 8,16 * * *', next_at: Date.now() + 3_600_000, last_fired_at: null, last_outcome: null };
    expect(formatRoutineCreateAck({ routine: created })).toMatch(/^Created exception-triage\. - exception-triage — Exception and alert triage · daily at 08:30 and 16:30 Europe\/London · next in 1 h/);
    expect(formatRoutineCreateAck({ routine: { ...created, enabled: false } })).toMatch(/^Created exception-triage, paused/);
    expect(formatRoutineDeleteAck('daily-sweep')).toMatch(/^Deleted daily-sweep/);
    expect(validateCreateFields({ ...triage, roomId: 'r' })).toEqual({ ok: true, value: triage });
    expect(validateCreateFields({ ...triage, tz: undefined }).value).toEqual({ name: triage.name, title: triage.title, schedule: triage.schedule, prompt: triage.prompt });
  });
});

describe('routine writes carry the calling turn\'s causes', () => {
  const causes = [{ kind: 'room_message', ref: 'room:r1', at: 1000 }, { kind: 'user_message', ref: 'c-coord:4', at: 1001 }];
  const forged = [{ kind: 'user_message', ref: 'c-coord:1', at: 1 }];
  const calls = (h) => [
    () => h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false }),
    () => h.run({ roomId: '!r:s', name: 'daily-sweep' }),
    () => h.create({ roomId: '!r:s', ...triage }),
    () => h.remove({ roomId: '!r:s', name: 'daily-sweep' }),
  ];
  const bodies = (client) => [client.update.mock.calls, client.run.mock.calls, client.create.mock.calls, client.remove.mock.calls]
    .map((c) => c.at(-1)).map((args) => args.at(-1));

  it('update, run, create and delete send the session\'s current turn causes verbatim', async () => {
    const { h, client, session } = fixture();
    session.currentTurn = { causes, startedAt: 999 };
    for (const call of calls(h)) expect((await call()).status).toBeLessThan(300);
    for (const body of bodies(client)) expect(body.causes).toEqual(causes);
    expect(client.update.mock.calls[0]).toEqual(['daily-sweep', { enabled: false, convo_id: 'c-coord', causes }]);
  });

  it('omit causes when the session has no turn, or a turn with none', async () => {
    const { h, client, session } = fixture();
    for (const call of calls(h)) await call();
    for (const body of bodies(client)) expect('causes' in body).toBe(false);
    session.currentTurn = { causes: null, startedAt: 1 };
    for (const call of calls(h)) await call();
    for (const body of bodies(client)) expect('causes' in body).toBe(false);
  });

  it('ignore causes the model put in the loopback body: never forwarded, never a validation error', async () => {
    const { h, client, session } = fixture();
    const extra = { causes: forged, cause: forged[0] };
    const r = [
      await h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false, ...extra }),
      await h.run({ roomId: '!r:s', name: 'daily-sweep', ...extra }),
      await h.create({ roomId: '!r:s', ...triage, ...extra }),
      await h.remove({ roomId: '!r:s', name: 'daily-sweep', ...extra }),
    ];
    for (const x of r) expect(x.status).toBeLessThan(300);
    for (const body of bodies(client)) { expect('causes' in body).toBe(false); expect('cause' in body).toBe(false); }
    session.currentTurn = { causes, startedAt: 2 };
    await h.update({ roomId: '!r:s', name: 'daily-sweep', enabled: false, ...extra });
    await h.create({ roomId: '!r:s', ...triage, ...extra });
    expect(client.update.mock.calls.at(-1)[1].causes).toEqual(causes);
    expect(client.create.mock.calls.at(-1)[0].causes).toEqual(causes);
    expect('cause' in client.create.mock.calls.at(-1)[0]).toBe(false);
  });

  it('list is a read and carries no causes', async () => {
    const { h, client, session } = fixture();
    session.currentTurn = { causes, startedAt: 3 };
    await h.list({ roomId: '!r:s' });
    expect(client.list.mock.calls[0]).toEqual([]);
  });
});

describe('routine envelopes', () => {
  const env = { spawns_per_fire: 3, chats: false, boxes: ['box-a', 'box-b'] };
  it('validateUpdateFields accepts an envelope, an any-box envelope and null (clears it)', () => {
    expect(validateUpdateFields({ envelope: env })).toEqual({ ok: true, value: { envelope: env } });
    expect(validateUpdateFields({ envelope: { spawns_per_fire: 0, chats: true, boxes: null } })).toEqual({ ok: true, value: { envelope: { spawns_per_fire: 0, chats: true, boxes: null } } });
    expect(validateUpdateFields({ envelope: { spawns_per_fire: 50, chats: false, boxes: [' box-a '] } }).value).toEqual({ envelope: { spawns_per_fire: 50, chats: false, boxes: ['box-a'] } });
    expect(validateUpdateFields({ envelope: null })).toEqual({ ok: true, value: { envelope: null } });
    expect(validateUpdateFields({ envelope: { spawns_per_fire: 1, chats: false, boxes: Array.from({ length: 32 }, (_, i) => `box-${i}`) } }).ok).toBe(true);
    expect(validateUpdateFields({ envelope: { spawns_per_fire: 1, chats: false, boxes: ['b'.repeat(64)] } }).ok).toBe(true);
  });

  it('validateUpdateFields rejects every other envelope shape with the rule', () => {
    const bads = [
      'any', 3, [], true,
      { spawns_per_fire: 51, chats: false, boxes: null },
      { spawns_per_fire: -1, chats: false, boxes: null },
      { spawns_per_fire: 1.5, chats: false, boxes: null },
      { spawns_per_fire: '2', chats: false, boxes: null },
      { chats: false, boxes: null },
      { spawns_per_fire: 1, chats: 'yes', boxes: null },
      { spawns_per_fire: 1, boxes: null },
      { spawns_per_fire: 1, chats: false },
      { spawns_per_fire: 1, chats: false, boxes: [] },
      { spawns_per_fire: 1, chats: false, boxes: 'box-a' },
      { spawns_per_fire: 1, chats: false, boxes: ['box-a', ''] },
      { spawns_per_fire: 1, chats: false, boxes: ['  '] },
      { spawns_per_fire: 1, chats: false, boxes: [7] },
      { spawns_per_fire: 1, chats: false, boxes: ['b'.repeat(65)] },
      { spawns_per_fire: 1, chats: false, boxes: ['box\na'] },
      { spawns_per_fire: 1, chats: false, boxes: Array.from({ length: 33 }, (_, i) => `box-${i}`) },
      { spawns_per_fire: 1, chats: false, boxes: null, users: ['x'] },
    ];
    for (const envelope of bads) {
      const v = validateUpdateFields({ envelope });
      expect(v.ok, JSON.stringify(envelope)).toBe(false);
      expect(v.err.body.error).toBe('envelope must be null (clears it) or {spawns_per_fire: 0–50, chats: true|false, boxes: null for any box, or 1–32 box names of at most 64 characters}');
    }
  });

  it('update and create pass the envelope to the journal; create leaves a null one out', async () => {
    const { h, client } = fixture();
    expect((await h.update({ roomId: '!r:s', name: 'daily-sweep', envelope: { spawns_per_fire: 99, chats: false, boxes: null } })).status).toBe(400);
    expect(client.update).not.toHaveBeenCalled();
    await h.update({ roomId: '!r:s', name: 'daily-sweep', envelope: env });
    expect(client.update.mock.calls[0]).toEqual(['daily-sweep', { envelope: env, convo_id: 'c-coord' }]);
    await h.update({ roomId: '!r:s', name: 'daily-sweep', envelope: null });
    expect(client.update.mock.calls[1]).toEqual(['daily-sweep', { envelope: null, convo_id: 'c-coord' }]);
    await h.create({ roomId: '!r:s', ...triage, envelope: env });
    expect(client.create.mock.calls[0]).toEqual([{ ...triage, envelope: env, convo_id: 'c-coord' }]);
    expect((await h.create({ roomId: '!r:s', ...triage, envelope: { spawns_per_fire: 1, chats: 'no', boxes: null } })).body.error).toMatch(/^envelope must be/);
    expect(validateCreateFields({ ...triage, envelope: null })).toEqual({ ok: true, value: triage });
    expect(formatRoutineUpdateAck({ routine: { ...sweep, envelope: env } }, { name: 'daily-sweep', envelope: env })).toMatch(/^Updated daily-sweep\./);
  });

  it('formatRoutineLine appends the envelope when the routine has one, and nothing without', () => {
    const base = { name: 'disk-low', title: 'Box disk under the threshold', trigger: { kind: 'disk_under', pct: 20 }, tz: 'Europe/London', enabled: true, next_at: null, last_fired_at: null, last_outcome: null };
    expect(formatRoutineLine({ ...base, envelope: env }, NOW)).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk · envelope: 3 spawns/fire, chats no, boxes box-a,box-b');
    expect(formatRoutineLine({ ...base, envelope: { spawns_per_fire: 0, chats: true, boxes: null } }, NOW)).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk · envelope: 0 spawns/fire, chats yes, boxes any');
    expect(formatRoutineLine({ ...base, envelope: null }, NOW)).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk');
    expect(formatRoutineLine(base, NOW)).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk');
    // A hostile envelope from the journal is one-lined and capped.
    const odd = formatRoutineLine({ ...base, envelope: { spawns_per_fire: 'x', chats: 1, boxes: ['a\nb', 7] } }, NOW);
    expect(odd).toBe('- disk-low — Box disk under the threshold · when a box drops under 20% free disk · envelope: ? spawns/fire, chats no, boxes a ⏎ b');
    // Only null is any box: an empty, missing or malformed list is none.
    for (const boxes of [[], [7, ''], 'box-a', undefined]) {
      expect(formatRoutineLine({ ...base, envelope: { spawns_per_fire: 1, chats: false, boxes } }, NOW), JSON.stringify(boxes)).toMatch(/· envelope: 1 spawns\/fire, chats no, boxes none$/);
    }
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
    // The journal's provenance gate on a Coordinator's routine write: say what
    // it needs (the user's own ask) and carry the journal's why, never the
    // generic "delete routines" wording that sends operators hunting for a
    // missing deployment.
    const unverified = formatJournalRoutinesError({ error: 'forbidden', detail: 'routine_write_unverified', why: 'started by agent' });
    expect(unverified).toMatch(/user's own ask/);
    expect(unverified).toMatch(/\(started by agent\)/);
    expect(unverified).toMatch(/tap on one of this conversation's items/);
    expect(unverified).not.toMatch(/delete routines/);
    expect(formatJournalRoutinesError({ error: 'forbidden', detail: 'routine_write_unverified' })).not.toMatch(/\(\)/);
    expect(formatJournalRoutinesError({ error: 'forbidden', detail: 'routine_write_unverified', why: '   ' })).not.toMatch(/\(\)/);
    expect(formatJournalRoutinesError({ error: 'forbidden', detail: 'not_coordinator' })).toMatch(/not list this conversation as the Coordinator/);
    expect(formatJournalRoutinesError({ error: 'forbidden' })).toMatch(/delete routines/);
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
    await c.create({ name: 'x', convo_id: 'c' });
    await c.remove('x', { convo_id: 'c' });
    expect(calls).toEqual([
      ['http://j/routines', 'GET', undefined],
      ['http://j/routines/daily-sweep', 'PATCH', JSON.stringify({ enabled: false, convo_id: 'c' })],
      ['http://j/routines/a%2Fb/run', 'POST', JSON.stringify({ convo_id: 'c' })],
      ['http://j/routines', 'POST', JSON.stringify({ name: 'x', convo_id: 'c' })],
      ['http://j/routines/x', 'DELETE', JSON.stringify({ convo_id: 'c' })],
    ]);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
    expect(await createRoutinesClient({ baseUrl: '', token: 't' }).list()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const down = createRoutinesClient({ baseUrl: 'http://j', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect((await down.list()).status).toBe(0);
    const err = createRoutinesClient({ baseUrl: 'http://j', token: 't', fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('x'); } }) });
    expect(await err.list()).toEqual({ status: 500, data: { error: 'HTTP 500' } });
  });
});

describe('allowance_expiring trigger', () => {
  it('validates pct and an optional hour window, and says it in words', () => {
    const base = { name: 'spare-allowance', title: 'Spare', prompt: 'p' };
    expect(validateCreateFields({ ...base, trigger: { kind: 'allowance_expiring', pct: 70 } }).value.trigger).toEqual({ kind: 'allowance_expiring', pct: 70 });
    expect(validateCreateFields({ ...base, trigger: { kind: 'allowance_expiring', pct: 70, from_hours: 2, to_hours: 24 } }).value.trigger).toEqual({ kind: 'allowance_expiring', pct: 70, from_hours: 2, to_hours: 24 });
    for (const trigger of [{ kind: 'allowance_expiring' }, { kind: 'allowance_expiring', pct: 70, from_hours: 12 }, { kind: 'allowance_expiring', pct: 70, to_hours: 200 }, { kind: 'disk_under', pct: 20, from_hours: 1 }]) {
      expect(validateCreateFields({ ...base, trigger }).ok).toBe(false);
    }
    expect(describeTrigger({ kind: 'allowance_expiring', pct: 70 })).toBe('when a weekly limit resets within 6–12 h and is under 70%');
    expect(describeTrigger({ kind: 'allowance_expiring', pct: 50, from_hours: 2, to_hours: 24 })).toBe('when a weekly limit resets within 2–24 h and is under 50%');
  });

  it('validates 1–4 tiers of unused percent and hours left, on create and update', () => {
    const base = { name: 'spare-allowance', title: 'Spare', prompt: 'p' };
    const tiers = [{ unused_pct: 50, hours_left: 12 }, { unused_pct: 25, hours_left: 2 }];
    expect(validateCreateFields({ ...base, trigger: { kind: 'allowance_expiring', tiers } }).value.trigger).toEqual({ kind: 'allowance_expiring', tiers });
    expect(validateUpdateFields({ trigger: { kind: 'allowance_expiring', tiers } }).value.trigger).toEqual({ kind: 'allowance_expiring', tiers });
    const t = (x) => ({ kind: 'allowance_expiring', tiers: [x] });
    for (const trigger of [{ kind: 'allowance_expiring', tiers: [] }, { kind: 'allowance_expiring', tiers, pct: 70 }, { kind: 'allowance_expiring', tiers: Array(5).fill(tiers[0]) },
      t({ unused_pct: 0, hours_left: 2 }), t({ unused_pct: 50, hours_left: 0 }), t({ unused_pct: 50, hours_left: 169 }), t({ unused_pct: 50 }), t({ unused_pct: 50, hours_left: 2, pct: 1 }), t(null),
      { kind: 'disk_under', pct: 20, tiers }]) {
      expect(validateCreateFields({ ...base, trigger }).ok).toBe(false);
    }
    expect(describeTrigger({ kind: 'allowance_expiring', tiers })).toBe('when a weekly limit has 50% unused with 12 h left or 25% unused with 2 h left');
  });
});
