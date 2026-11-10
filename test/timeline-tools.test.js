import { describe, it, expect, vi } from 'vitest';
import {
  createTimelineHandlers, formatJournalTimelineError, formatTimelineWriteAck, formatTimelineReadAck,
  normalizeRef, validateTimelineWrite, validateWeekKey, TIMELINE_LIMITS,
} from '../lib/timeline-tools.js';
import { createTimelineClient } from '../lib/timeline-client.js';

const rawWeek = (over = {}) => ({ week: '2026-11-09', start: 1, end: 2, final: false, written_at: null, current: true, stored: null, projects: [], more_projects: false, ...over });
const quiet = { total: 2, rows: [{ project: { id: 'p1', num: 1, title: 'A' }, last_moved_at: 5, note: null, weekly: false }] };

function fixture({ coordinator = true, client = {} } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const c = {
    readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week }) })),
    listWeeks: vi.fn(async () => ({ status: 200, data: { weeks: [{ week: '2026-11-09' }, { week: '2026-11-02' }], next_before: null } })),
    wentQuiet: vi.fn(async () => ({ status: 200, data: quiet })),
    writeWeek: vi.fn(async (week, body) => ({ status: 201, data: { week, written: true, final: body.final } })),
    ...client,
  };
  const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: c });
  return { h, c, session };
}

const story = (over = {}) => ({ title: 'Shipped it', sentence: 'The thing went out.', project_ids: [3], ...over });
const call = (over = {}) => ({ roomId: '!r:s', week: '2026-11-02', lede: 'A good week.', stories: [story()], ...over });

describe('timeline handlers: gate', () => {
  it('refuses a non-Coordinator before any journal call, and the usual session guards', async () => {
    const { h, c } = fixture({ coordinator: false });
    for (const op of ['read', 'write']) {
      const r = await h[op](call());
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not the Coordinator/);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect(c.listWeeks).not.toHaveBeenCalled();
    expect(c.writeWeek).not.toHaveBeenCalled();
    const ok = fixture();
    for (const op of ['read', 'write']) {
      expect((await ok.h[op]({ ...call(), roomId: undefined })).status).toBe(400);
      expect((await ok.h[op]({ ...call(), roomId: '!other' })).status).toBe(404);
    }
    ok.session.journalConvoId = null;
    expect((await ok.h.write(call())).status).toBe(409);
  });
});

describe('timeline_week_read', () => {
  it('defaults to the current week via listWeeks, and includes quiet for the current week only', async () => {
    const { h, c } = fixture();
    const r = await h.read({ roomId: '!r:s' });
    expect(c.listWeeks).toHaveBeenCalledWith({ limit: 1 });
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09');
    expect(r.status).toBe(200);
    expect(r.body.week.week).toBe('2026-11-09');
    expect(r.body.quiet).toEqual(quiet.rows);
    expect(r.body.quiet_total).toBe(2);
  });

  it('an explicit past week skips listWeeks and carries no quiet list', async () => {
    const { h, c } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week, current: false }) })) } });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(c.listWeeks).not.toHaveBeenCalled();
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(r.body).toEqual({ week: rawWeek({ week: '2026-11-02', current: false }) });
  });

  it('rejects a malformed or non-Monday week locally', async () => {
    const { h, c } = fixture();
    for (const week of ['yesterday', '2026-11-03', '2026-02-30', '2026-13-01']) {
      const r = await h.read({ roomId: '!r:s', week });
      expect(r.status, week).toBe(400);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
  });

  it('an empty week list is a clear 404; journal errors become sentences; unreachable is 502', async () => {
    expect((await fixture({ client: { listWeeks: async () => ({ status: 200, data: { weeks: [] } }) } }).h.read({ roomId: '!r:s' })).body.error).toMatch(/no weeks yet/);
    const bad = await fixture({ client: { readWeekRaw: async () => ({ status: 400, data: { error: 'bad_request', detail: 'bad_week' } }) } }).h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Monday of the week/);
    const down = await fixture({ client: { listWeeks: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.read({ roomId: '!r:s' });
    expect(down).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    const phase1 = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: { week: '2026-11-09', start: 1, end: 2, final: false, projects: [] } }) } }).h.read({ roomId: '!r:s' });
    expect(phase1.status).toBe(404);
    expect(phase1.body.error).toMatch(/^the journal predates the timeline routes — deploy/);
    expect(phase1.body.error).not.toMatch(/conversation/);
    const phase1b = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: { current: true, week: '2026-11-09' } }) } }).h.read({ roomId: '!r:s' });
    expect(phase1b.status).toBe(404);
    const badRead = await fixture({ client: { readWeekRaw: async () => ({ status: 400, data: { error: 'bad_request' } }) } }).h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(badRead.body.error).toMatch(/Monday of the week/);
    expect(badRead.body.error).not.toMatch(/story limits/);
    const quietDown = await fixture({ client: { wentQuiet: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.read({ roomId: '!r:s' });
    expect(quietDown.status).toBe(502);
  });
});

describe('timeline_week_write', () => {
  it('posts the cleaned body with the Coordinator convo_id', async () => {
    const { h, c } = fixture();
    const r = await h.write(call({
      week: ' 2026-11-02 ',
      lede: '  A good week. ',
      stories: [story({ title: ' Shipped it ', project_ids: ['#12', 'prj_abc', 7], item_ids: ['#4'], next: ' Then the rest. ', media_blob_id: ' blob1 ' })],
      final: true,
      notes: [{ project_id: '#9', note: ' Left at review. ' }],
    }));
    expect(c.writeWeek).toHaveBeenCalledWith('2026-11-02', {
      convo_id: 'c-coord',
      lede: 'A good week.',
      stories: [{ title: 'Shipped it', sentence: 'The thing went out.', project_ids: [12, 'prj_abc', 7], item_ids: [4], next: 'Then the rest.', media_blob_id: 'blob1' }],
      final: true,
      notes: [{ project_id: 9, note: 'Left at review.' }],
    });
    expect(r).toEqual({ status: 201, body: { week: '2026-11-02', written: true, final: true, stories_count: 1 } });
  });

  it('defaults: no lede, final false, no notes, optional story fields omitted', async () => {
    const { h, c } = fixture();
    await h.write({ roomId: '!r:s', week: '2026-11-02', stories: [] });
    expect(c.writeWeek).toHaveBeenCalledWith('2026-11-02', { convo_id: 'c-coord', stories: [], final: false, notes: [] });
    await h.write(call());
    expect(c.writeWeek.mock.calls[1][1].stories[0]).toEqual({ title: 'Shipped it', sentence: 'The thing went out.', project_ids: [3] });
  });

  it('enforces every limit before the journal', async () => {
    const L = TIMELINE_LIMITS;
    const refs = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const cases = [
      [{ week: undefined }, /week must be/],
      [{ week: '2026-11-03' }, /not a Monday/],
      [{ lede: 'x'.repeat(L.ledeMax + 1) }, /lede is too long/],
      [{ lede: 5 }, /lede must be text/],
      [{ stories: undefined }, /stories is required/],
      [{ stories: Array.from({ length: L.storiesMax + 1 }, () => story()) }, /too many stories/],
      [{ stories: ['x'] }, /story 1 must be an object/],
      [{ stories: [story({ title: '  ' })] }, /story 1 title is required/],
      [{ stories: [story({ title: 'x'.repeat(L.titleMax + 1) })] }, /title is too long/],
      [{ stories: [story({ sentence: '' })] }, /sentence is required/],
      [{ stories: [story({ sentence: 'x'.repeat(L.sentenceMax + 1) })] }, /sentence is too long/],
      [{ stories: [story({ next: 'x'.repeat(L.nextMax + 1) })] }, /next is too long/],
      [{ stories: [story({ project_ids: [] })] }, /project_ids needs 1 to 10/],
      [{ stories: [story({ project_ids: undefined })] }, /project_ids is required/],
      [{ stories: [story({ project_ids: refs(L.projectRefsMax + 1) })] }, /project_ids needs 1 to 10/],
      [{ stories: [story({ project_ids: [0] })] }, /bad reference/],
      [{ stories: [story({ project_ids: [-3] })] }, /bad reference/],
      [{ stories: [story({ project_ids: [1.5] })] }, /bad reference/],
      [{ stories: [story({ project_ids: ['  '] })] }, /bad reference/],
      [{ stories: [story({ project_ids: ['#abc'] })] }, /bad reference/],
      [{ stories: [story({ project_ids: [{}] })] }, /bad reference/],
      [{ stories: [story({ item_ids: refs(L.itemRefsMax + 1) })] }, /item_ids has at most 10/],
      [{ stories: [story({ item_ids: ['#0'] })] }, /bad reference/],
      [{ stories: [story({ media_blob_id: 7 })] }, /media_blob_id/],
      [{ stories: [story({ media_blob_id: 'b'.repeat(L.blobIdMax + 1) })] }, /story 1 media_blob_id is too long: at most 128/],
      [{ notes: refs(L.notesMax + 1).map((n) => ({ project_id: n, note: 'x' })) }, /too many notes/],
      [{ notes: [{ project_id: 1, note: '' }] }, /note 1 note is required/],
      [{ notes: [{ project_id: 1, note: 'x'.repeat(L.noteMax + 1) }] }, /note is too long/],
      [{ notes: [{ project_id: 'x y'.slice(0, 0), note: 'x' }] }, /bad project_id/],
      [{ notes: 'nope' }, /notes must be a list/],
      [{ final: 'yes' }, /final must be true or false/],
    ];
    for (const [over, re] of cases) {
      const { h, c } = fixture();
      const r = await h.write(call(over));
      expect(r.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(r.body.error, JSON.stringify(over).slice(0, 80)).toMatch(re);
      expect(c.writeWeek).not.toHaveBeenCalled();
    }
    // The limits themselves are accepted.
    const edge = fixture();
    const r = await edge.h.write(call({
      lede: 'x'.repeat(L.ledeMax),
      stories: Array.from({ length: L.storiesMax }, () => story({ title: 'x'.repeat(L.titleMax), sentence: 'x'.repeat(L.sentenceMax), next: 'x'.repeat(L.nextMax), project_ids: refs(L.projectRefsMax), item_ids: refs(L.itemRefsMax) })),
      notes: refs(L.notesMax).map((n) => ({ project_id: n, note: 'x'.repeat(L.noteMax) })),
    }));
    expect(r.status).toBe(201);
  });

  it('a media_blob_id of exactly 128 characters passes local validation', () => {
    const v = validateTimelineWrite({ week: '2026-11-09', stories: [story({ media_blob_id: 'b'.repeat(128) })] });
    expect(v.ok).toBe(true);
  });

  it('maps each journal error to a sentence an agent can act on, and unreachable to 502', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, 403, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden' } }, 403, /only the Coordinator agent/],
      [{ status: 409, data: { error: 'conflict', detail: 'week_final' } }, 409, /frozen; pass final: true to rewrite it on purpose/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_not_ended' } }, 400, /only after it ends \(Monday 00:00/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_out_of_range' } }, 400, /outside the range/],
      [{ status: 400, data: { error: 'bad_request', detail: 'bad_week' } }, 400, /Monday of the week/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_project', ref: 42 } }, 400, /project 42 is not one of the user's projects, or is private — stories never name private work/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_item', ref: 'it_9' } }, 400, /item it_9 is not one of the user's items, or is private/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_blob', ref: 'b1' } }, 400, /media_blob_id b1 is not a picture or video/],
      [{ status: 400, data: { error: 'bad_request' } }, 400, /rejected the call/],
      [{ status: 404, data: { error: 'HTTP 404' } }, 404, /predates the timeline routes, or does not know this conversation on this box/],
      [{ status: 404, data: { error: 'not_found' } }, 404, /does not know this conversation on this box/],
      [{ status: 500, data: { error: 'HTTP 500' } }, 500, /^HTTP 500$/],
    ];
    for (const [res, status, re] of cases) {
      const r = await fixture({ client: { writeWeek: async () => res } }).h.write(call());
      expect(r.status, JSON.stringify(res)).toBe(status);
      expect(r.body.error, JSON.stringify(res)).toMatch(re);
      expect(r.body.error).not.toMatch(/\bbad_request\b|\bforbidden\b|\bweek_final\b|\bunknown_project\b/);
    }
    const down = await fixture({ client: { writeWeek: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.write(call());
    expect(down).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    expect(formatJournalTimelineError(null)).toBe('unknown error');
  });
});

describe('helpers', () => {
  it('normalizeRef turns #12 and "12" into 12 and keeps ids', () => {
    expect(normalizeRef('#12')).toBe(12);
    expect(normalizeRef('12')).toBe(12);
    expect(normalizeRef(' prj_1 ')).toBe('prj_1');
    expect(normalizeRef(12)).toBe(12);
    for (const bad of [0, -1, 1.2, '', '#', '#0', null, undefined, {}, '#x']) expect(normalizeRef(bad), String(bad)).toBeNull();
  });
  it('validateWeekKey accepts a Monday only', () => {
    expect(validateWeekKey('2026-11-09')).toEqual({ ok: true, value: '2026-11-09' });
    expect(validateWeekKey('2026-11-08').ok).toBe(false);
    expect(validateTimelineWrite({ week: '2026-11-09', stories: [] }).ok).toBe(true);
  });
  it('acks', () => {
    expect(formatTimelineWriteAck({ week: '2026-11-09', final: false, stories_count: 4 })).toBe('Week 2026-11-09 written (4 stories).');
    expect(formatTimelineWriteAck({ week: '2026-11-02', final: true, stories_count: 1 })).toBe('Week 2026-11-02 written (1 story, frozen).');
    expect(formatTimelineReadAck({ week: { week: 'w' } })).toBe('{"week":{"week":"w"}}');
  });
});

describe('createTimelineClient', () => {
  function fakeFetch(status = 200, body = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => body }; });
    return { fetchImpl, calls };
  }
  it('hits the four routes with bearer auth', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { ok: 1 });
    const c = createTimelineClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    await c.readWeekRaw('2026-11-09');
    await c.listWeeks({ limit: 1 });
    await c.listWeeks();
    await c.wentQuiet();
    await c.writeWeek('2026-11-09', { convo_id: 'c1', stories: [] });
    expect(calls.map((x) => [x.init.method, x.url])).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1'],
      ['GET', 'https://j/timeline/weeks?limit=1'],
      ['GET', 'https://j/timeline/weeks'],
      ['GET', 'https://j/timeline/quiet?raw=1'],
      ['POST', 'https://j/timeline/weeks/2026-11-09'],
    ]);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[4].init.body)).toEqual({ convo_id: 'c1', stories: [] });
    expect(calls[4].init.headers['Content-Type']).toBe('application/json');
  });
  it('returns error statuses and never throws; no base means unreachable', async () => {
    const { fetchImpl } = fakeFetch(409, { error: 'conflict', detail: 'week_final' });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl }).writeWeek('w', {})).toEqual({ status: 409, data: { error: 'conflict', detail: 'week_final' } });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('boom'); } }).wentQuiet()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    expect((await createTimelineClient({}).wentQuiet()).status).toBe(0);
  });
});
