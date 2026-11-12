import { describe, it, expect, vi } from 'vitest';
import {
  createTimelineHandlers, formatJournalTimelineError, formatTimelineWriteAck, formatTimelineReadAck,
  normalizeRef, validateTimelineWrite, validateWeekKey, TIMELINE_LIMITS, TIMELINE_READ_MAX_CHARS,
} from '../lib/timeline-tools.js';
import { createTimelineClient } from '../lib/timeline-client.js';

const rawWeek = (over = {}) => ({ week: '2026-11-09', start: 1, end: 2, final: false, written_at: null, current: true, stored: null, projects: [], more_projects: 0, ...over });
const pagedWeek = (over = {}) => rawWeek({ projects_total: 0, offset: 0, next_offset: null, ...over });
const quiet = { total: 2, rows: [{ project: { id: 'p1', num: 1, title: 'A' }, last_moved_at: 5, note: null, weekly: false }] };

function fixture({ coordinator = true, client = {} } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const c = {
    readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week }) })),
    listWeeks: vi.fn(async () => ({ status: 200, data: { weeks: [{ week: '2026-11-09' }, { week: '2026-11-02' }], next_before: null } })),
    wentQuiet: vi.fn(async () => ({ status: 200, data: quiet })),
    writeWeekEntries: vi.fn(async (week, body) => ({ status: 201, data: { week, written: true, final: body.final, entries: body.entries.length } })),
    ...client,
  };
  const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: c });
  return { h, c, session };
}

const entry = (over = {}) => ({ project: 3, sentence: 'The thing went out.', ...over });
const call = (over = {}) => ({ roomId: '!r:s', week: '2026-11-02', entries: [entry()], ...over });

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
    expect(c.writeWeekEntries).not.toHaveBeenCalled();
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
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09', { offset: 0 });
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
    expect(r.body).toEqual({ week: rawWeek({ week: '2026-11-02', current: false }), offset: 0 });
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

  it('the quiet line comes first, and only at offset 0 of the current week', async () => {
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week }) })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    const lines = formatTimelineReadAck(r.body).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`quiet (1 of 2): ${JSON.stringify(quiet.rows)}`);
    expect(lines[1]).toBe(`week: ${JSON.stringify(pagedWeek())}`);
    expect(lines[2]).toBe('That is every project that moved this week.');

    const later = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, offset: 12, projects_total: 14 }) })) } });
    const r2 = await later.h.read({ roomId: '!r:s', offset: 12 });
    expect(later.c.wentQuiet).not.toHaveBeenCalled();
    expect(r2.body.quiet).toBeUndefined();
    const text = formatTimelineReadAck(r2.body);
    expect(text).not.toMatch(/quiet \(/);
    expect(text.split('\n')[0]).toMatch(/^week: \{/);
  });

  it('offset: 12 is passed to the journal as &offset=12', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url]); return { ok: true, status: 200, json: async () => pagedWeek({ current: false, offset: 12, projects_total: 14 }) }; };
    const session = { roomId: '!r:s', coordinator: true, journalConvoId: 'c-coord' };
    const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client: createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl }) });
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', offset: 12 })).status).toBe(200);
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09' })).status).toBe(200);
    expect(calls).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1&offset=12'],
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1'],
    ]);
  });

  it('a bad offset is refused locally', async () => {
    const { h, c } = fixture();
    for (const offset of [-1, 1.5, '12', true, {}]) {
      const r = await h.read({ roomId: '!r:s', week: '2026-11-09', offset });
      expect(r.status, JSON.stringify(offset)).toBe(400);
      expect(r.body.error).toMatch(/^offset must be a whole number, 0 or more/);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', offset: null })).status).toBe(200);
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09', { offset: 0 });
  });

  it("the More projects line carries the journal's next_offset", async () => {
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, projects_total: 20, next_offset: 6, more_projects: 14 }) })) } });
    const r = await h.read({ roomId: '!r:s' });
    const lines = formatTimelineReadAck(r.body).split('\n');
    expect(lines.at(-1)).toBe('More projects: call timeline_week_read again with week: "2026-11-09", offset: 6.');
    expect(lines[0]).toMatch(/^quiet \(1 of 2\): /);
    expect(formatTimelineReadAck({ week: pagedWeek({ next_offset: null }) }).split('\n').at(-1)).toBe('That is every project that moved this week.');
  });

  const EVERY = 'That is every project that moved this week.';
  const CANNOT_PAGE = 'More projects moved this week than this read shows; the journal cannot page them — deploy the journal update.';

  it('an older journal that says more projects moved but gives no next_offset is not called complete', async () => {
    const lines = formatTimelineReadAck({ week: rawWeek({ current: false, more_projects: 7 }) }).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(CANNOT_PAGE);
    expect(formatTimelineReadAck({ week: rawWeek({ current: false, more_projects: true }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    expect(formatTimelineReadAck({ week: rawWeek({ current: false, more_projects: 0 }) }).split('\n').at(-1)).toBe(EVERY);

    // Through the handler: the count the journal sends, and no offset to go on from.
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week, more_projects: 5 }) })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(formatTimelineReadAck(r.body).split('\n').at(-1)).toBe(CANNOT_PAGE);
  });

  it('a journal that pages says the week is complete with a null next_offset, whatever else it sends', async () => {
    expect(formatTimelineReadAck({ week: pagedWeek({ next_offset: null, more_projects: 0 }) }).split('\n').at(-1)).toBe(EVERY);
    // The key is what counts: null is the last page even beside a stray count.
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 12, next_offset: null, more_projects: 5 }) }).split('\n').at(-1)).toBe(EVERY);
    const last = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, offset: 12, projects_total: 14, next_offset: null, more_projects: 0 }) })) } });
    const r = await last.h.read({ roomId: '!r:s', offset: 12 });
    expect(r.body.offset).toBe(12);
    expect(formatTimelineReadAck(r.body).split('\n').at(-1)).toBe(EVERY);
  });

  it('a next_offset that does not pass the offset asked for is never offered: no loop', async () => {
    const stuck = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, offset: 12, next_offset: 12, projects_total: 30, more_projects: 6 }) })) } });
    const r = await stuck.h.read({ roomId: '!r:s', offset: 12 });
    expect(r.status).toBe(200);
    const last = formatTimelineReadAck(r.body).split('\n').at(-1);
    expect(last).toBe(CANNOT_PAGE);
    expect(last).not.toMatch(/offset/);
    // The first page naming itself, and an offset that goes backwards.
    expect(formatTimelineReadAck({ week: pagedWeek({ next_offset: 0, more_projects: 6 }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 12, next_offset: 6, more_projects: 6 }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    // An offset that stays put is not a last page, even with nothing counted after it.
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 12, next_offset: 12, more_projects: 0 }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    // Something that is neither a whole number nor null is no offset at all.
    expect(formatTimelineReadAck({ week: pagedWeek({ next_offset: '6', more_projects: 6 }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 12, next_offset: 18, more_projects: 6 }) }).split('\n').at(-1)).toBe('More projects: call timeline_week_read again with week: "2026-11-09", offset: 18.');
  });

  it('it is the offset asked for that counts, not the one the journal echoes', async () => {
    // The journal echoes an earlier offset: 6 would look like progress from 0, and is none from 12.
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 0, next_offset: 6, more_projects: 6 }) }).split('\n').at(-1)).toBe(CANNOT_PAGE);
    // The journal echoes a later one: 18 is past the 12 asked for.
    expect(formatTimelineReadAck({ offset: 12, week: pagedWeek({ offset: 30, next_offset: 18, more_projects: 6 }) }).split('\n').at(-1)).toBe('More projects: call timeline_week_read again with week: "2026-11-09", offset: 18.');
    const echo = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, offset: 0, next_offset: 6, projects_total: 30, more_projects: 6 }) })) } });
    const r = await echo.h.read({ roomId: '!r:s', offset: 12 });
    expect(formatTimelineReadAck(r.body).split('\n').at(-1)).toBe(CANNOT_PAGE);
  });

  it('an oversized body is refused: the journal has no paging', async () => {
    const big = rawWeek({ projects: [{ id: 'p1', num: 1, title: 'Promo launch', milestones: [{ text: 'x'.repeat(60000) }] }] });
    expect(JSON.stringify(big).length).toBeGreaterThan(60000);
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async () => ({ status: 200, data: big })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r).toEqual({ status: 502, body: { error: "the journal's week read is too large for this tool — deploy the journal update" } });
  });

  it('an oversized page from a journal that pages is refused with the offset to continue from', async () => {
    const big = pagedWeek({ projects: [{ id: 'p1', num: 1, title: 'Promo launch', milestones: [{ text: 'x'.repeat(60000) }] }], projects_total: 20, next_offset: 6, more_projects: 14 });
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async () => ({ status: 200, data: big })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r).toEqual({ status: 502, body: { error: 'this page of the week is too large for this tool — skip it and carry on: call timeline_week_read again with week: "2026-11-09", offset: 6' } });
    // An offset that does not move on is no way to continue.
    const stuck = pagedWeek({ ...big, offset: 6, next_offset: 6 });
    const r2 = await fixture({ client: { readWeekRaw: vi.fn(async () => ({ status: 200, data: stuck })) } }).h.read({ roomId: '!r:s', offset: 6 });
    expect(r2).toEqual({ status: 502, body: { error: "the journal's week read is too large for this tool — deploy the journal update" } });
    // Nor is the offset the journal echoes: 6 asked for, 6 offered, 0 echoed.
    const r3 = await fixture({ client: { readWeekRaw: vi.fn(async () => ({ status: 200, data: { ...stuck, offset: 0 } })) } }).h.read({ roomId: '!r:s', offset: 6 });
    expect(r3.status).toBe(502);
    expect(r3.body.error).not.toMatch(/offset/);
  });

  const quietRows = (n, noteLength) => Array.from({ length: n }, (_, i) => ({ project: { id: `q${i}`, num: i + 1, title: 'A' }, last_moved_at: 5, note: 'n'.repeat(noteLength), weekly: false }));

  it('a full page plus a long quiet list is trimmed to fit, never refused', async () => {
    const week = pagedWeek({ projects: [{ id: 'p1', title: 'x'.repeat(36000 - JSON.stringify(pagedWeek({ projects: [{ id: 'p1', title: '' }] })).length) }] });
    expect(JSON.stringify(week)).toHaveLength(36000);
    const rows = quietRows(12, 1000);
    expect(JSON.stringify(rows).length).toBeGreaterThan(12000);
    const r = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { total: 12, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(r.body.quiet.length).toBeGreaterThan(0);
    expect(r.body.quiet.length).toBeLessThan(12);
    expect(r.body.quiet).toEqual(rows.slice(0, r.body.quiet.length));
    expect(r.body.quiet_total).toBe(12);
    const text = formatTimelineReadAck(r.body);
    expect(text.length).toBeLessThan(TIMELINE_READ_MAX_CHARS);
    expect(text.split('\n')[0]).toMatch(new RegExp(`^quiet \\(${r.body.quiet.length} of 12\\): `));
    // One more row would not have fitted.
    expect(formatTimelineReadAck({ ...r.body, quiet: rows.slice(0, r.body.quiet.length + 1) }).length).toBeGreaterThan(TIMELINE_READ_MAX_CHARS);

    // A journal that gives no total: the line still says how many there were.
    const untold = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { rows } }) } }).h.read({ roomId: '!r:s' });
    expect(untold.status).toBe(200);
    expect(formatTimelineReadAck(untold.body).split('\n')[0]).toMatch(new RegExp(`^quiet \\(${untold.body.quiet.length} of 12\\): `));

    // A quiet list that fits is left alone.
    const small = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: pagedWeek({ projects: [{ id: 'p1', title: 'x'.repeat(20000) }] }) }), wentQuiet: async () => ({ status: 200, data: { total: 12, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(small.body.quiet).toHaveLength(12);
  });

  it('a text of exactly the limit is read; one character more is not', async () => {
    expect(TIMELINE_READ_MAX_CHARS).toBe(40000);
    const sized = (length, over = {}) => {
      const empty = formatTimelineReadAck({ week: pagedWeek({ current: false, projects: [{ id: 'p1', title: '' }], ...over }) }).length;
      return pagedWeek({ current: false, projects: [{ id: 'p1', title: 'x'.repeat(length - empty) }], ...over });
    };
    const at = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: sized(TIMELINE_READ_MAX_CHARS) }) } }).h.read({ roomId: '!r:s', week: '2026-11-09' });
    expect(at.status).toBe(200);
    expect(formatTimelineReadAck(at.body)).toHaveLength(TIMELINE_READ_MAX_CHARS);
    const over = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: sized(TIMELINE_READ_MAX_CHARS + 1) }) } }).h.read({ roomId: '!r:s', week: '2026-11-09' });
    expect(over.status).toBe(502);

    // The current week: quiet rows are dropped until the text is exactly the limit or less.
    const emptyQuiet = 'quiet (0 of 3): []\n'.length;
    const rows = quietRows(3, 10);
    const one = JSON.stringify(rows.slice(0, 1)).length - 2;
    const week = sized(TIMELINE_READ_MAX_CHARS - emptyQuiet - one, { current: true });
    const exact = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { total: 3, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(exact.status).toBe(200);
    expect(exact.body.quiet).toHaveLength(1);
    expect(formatTimelineReadAck(exact.body)).toHaveLength(TIMELINE_READ_MAX_CHARS);
  });

  it('a page that fits by itself is never refused for the quiet line: the line is left out', async () => {
    const rows = quietRows(3, 10);
    const empty = formatTimelineReadAck({ week: pagedWeek({ projects: [{ id: 'p1', title: '' }] }) }).length;
    // The page alone is exactly the limit, so not even "quiet (0 of 3): []" fits beside it.
    const week = pagedWeek({ projects: [{ id: 'p1', title: 'x'.repeat(TIMELINE_READ_MAX_CHARS - empty) }] });
    const r = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { total: 3, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(r.body.quiet).toBeUndefined();
    const text = formatTimelineReadAck(r.body);
    expect(text).toHaveLength(TIMELINE_READ_MAX_CHARS);
    expect(text.startsWith('week: ')).toBe(true);
  });

  it('a non-ASCII title is measured in characters, and rows are dropped whole', async () => {
    const title = 'Café déjà vu — 東京 '.repeat(2000);
    expect(Buffer.byteLength(title)).toBeGreaterThan(TIMELINE_READ_MAX_CHARS);
    const week = pagedWeek({ projects: [{ id: 'p1', title }] });
    const rows = quietRows(12, 0).map((row, i) => ({ ...row, note: `Où en est-on ? ${'é'.repeat(900)} ${i}` }));
    const r = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { total: 12, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(r.body.week.projects[0].title).toBe(title);
    expect(r.body.quiet.length).toBeGreaterThan(0);
    expect(r.body.quiet.length).toBeLessThan(12);
    expect(r.body.quiet).toEqual(rows.slice(0, r.body.quiet.length));
    const text = formatTimelineReadAck(r.body);
    expect(text.length).toBeLessThanOrEqual(TIMELINE_READ_MAX_CHARS);
    expect(JSON.parse(text.split('\n')[0].replace(/^quiet \(\d+ of 12\): /, ''))).toEqual(r.body.quiet);
    expect(JSON.parse(text.split('\n')[1].replace(/^week: /, '')).projects[0].title).toBe(title);
  });

  it('a past week has no quiet line', async () => {
    const { h, c } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, current: false }) })) } });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(formatTimelineReadAck(r.body)).toBe(`week: ${JSON.stringify(pagedWeek({ week: '2026-11-02', current: false }))}\nThat is every project that moved this week.`);
  });
});

const indexRow = (n, over = {}) => ({ id: `p${n}`, num: n, title: `Project ${n}`, moved: 20 - n, milestones: 3, done: 1, for_you: 0, media: 0, newest: 5, ...over });
const indexWeek = (over = {}) => rawWeek({ projects_total: 2, projects: [indexRow(1), indexRow(2)], ...over });
const detailRow = (n) => ({ project: { id: `p${n}`, num: n, title: `Project ${n}` }, moved: 3, status: 'Going well.', milestones: [], items: [], media: [], needs_you: 0 });
// A journal that reads chosen projects always says which it left out, if only [].
const detailWeek = (over = {}) => pagedWeek({ projects_total: 2, projects: [detailRow(1), detailRow(2)], omitted: [], ...over });
const PICK = (week) => `Pick the projects that mattered (at most 8 get a card), then call timeline_week_read with week: "${week}" and projects: [their ids or numbers] (up to 12 a call) for their milestones, items and pictures.`;
const PREDATES_INDEX = 'the journal predates the week index — deploy the journal update, or read the week a page at a time';

function indexFixture(client = {}) {
  return fixture({
    client: {
      readWeekIndex: vi.fn(async (week) => ({ status: 200, data: indexWeek({ week }) })),
      readWeekProjects: vi.fn(async (week) => ({ status: 200, data: detailWeek({ week }) })),
      ...client,
    },
  });
}

describe('timeline_week_read: the index', () => {
  it('index: true reads the whole week in one result: quiet line, index, then what to do next', async () => {
    const { h, c } = indexFixture();
    const r = await h.read({ roomId: '!r:s', index: true });
    expect(c.listWeeks).toHaveBeenCalledWith({ limit: 1 });
    expect(c.readWeekIndex).toHaveBeenCalledWith('2026-11-09');
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(formatTimelineReadAck(r.body).split('\n')).toEqual([
      `quiet (1 of 2): ${JSON.stringify(quiet.rows)}`,
      `index: ${JSON.stringify(indexWeek())}`,
      PICK('2026-11-09'),
    ]);
  });

  it('a past week has no quiet line, and projects left off the end are counted', async () => {
    const data = indexWeek({ week: '2026-11-02', current: false, projects_total: 5, more_projects: 3 });
    const { h, c } = indexFixture({ readWeekIndex: vi.fn(async () => ({ status: 200, data })) });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02', index: true });
    expect(c.listWeeks).not.toHaveBeenCalled();
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(formatTimelineReadAck(r.body).split('\n')).toEqual([
      `index: ${JSON.stringify(data)}`,
      '3 more projects moved and are not listed (the least active).',
      PICK('2026-11-02'),
    ]);
  });

  it('a week in which nothing moved is still an index', async () => {
    const { h } = indexFixture({ readWeekIndex: vi.fn(async (week) => ({ status: 200, data: indexWeek({ week, current: false, projects_total: 0, projects: [] }) })) });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02', index: true });
    expect(r.status).toBe(200);
    expect(formatTimelineReadAck(r.body).split('\n').at(-1)).toBe(PICK('2026-11-02'));
  });

  it('index with projects or offset is refused locally; index: false is the paged read', async () => {
    const { h, c } = indexFixture();
    for (const extra of [{ projects: [1] }, { offset: 12 }, { offset: 0 }]) {
      const r = await h.read({ roomId: '!r:s', week: '2026-11-09', index: true, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error).toBe('index cannot be combined with projects or offset — the index is the whole week in one read');
    }
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', index: 'yes' })).body.error).toBe('index must be true or false');
    expect(c.readWeekIndex).not.toHaveBeenCalled();
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', index: false })).status).toBe(200);
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09', { offset: 0 });
    expect(c.readWeekIndex).not.toHaveBeenCalled();
  });

  it('an older journal answers an index call with a page: 502, not a week read as if it were whole', async () => {
    const answers = [
      pagedWeek({ projects_total: 30, projects: [detailRow(1)], next_offset: 12, more_projects: 18 }),
      pagedWeek({ projects_total: 1, projects: [detailRow(1)] }),
      pagedWeek(),
      rawWeek({ projects: [{ id: 'p1', num: 1, title: 'A', milestones: [] }] }),
    ];
    for (const data of answers) {
      const { h } = indexFixture({ readWeekIndex: vi.fn(async () => ({ status: 200, data })) });
      expect(await h.read({ roomId: '!r:s', index: true }), JSON.stringify(data)).toEqual({ status: 502, body: { error: PREDATES_INDEX } });
    }
    const phase1 = await indexFixture({ readWeekIndex: vi.fn(async () => ({ status: 200, data: { week: '2026-11-09', projects: [] } })) }).h.read({ roomId: '!r:s', index: true });
    expect(phase1.status).toBe(404);
    const refused = await indexFixture({ readWeekIndex: vi.fn(async () => ({ status: 400, data: { error: 'bad_request', detail: 'week_out_of_range' } })) }).h.read({ roomId: '!r:s', index: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/outside the range/);
  });

  it('a long quiet list is trimmed to fit beside the index; an index too large by itself is refused', async () => {
    const pad = (length) => indexWeek({ projects: [indexRow(1, { title: 'x'.repeat(length) })] });
    const rows = Array.from({ length: 12 }, (_, i) => ({ project: { id: `q${i}`, num: i + 1, title: 'A' }, last_moved_at: 5, note: 'n'.repeat(1000), weekly: false }));
    const trimmed = await indexFixture({ readWeekIndex: async () => ({ status: 200, data: pad(35000) }), wentQuiet: async () => ({ status: 200, data: { total: 12, rows } }) }).h.read({ roomId: '!r:s', index: true });
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.quiet.length).toBeGreaterThan(0);
    expect(trimmed.body.quiet.length).toBeLessThan(12);
    const text = formatTimelineReadAck(trimmed.body);
    expect(text.length).toBeLessThanOrEqual(TIMELINE_READ_MAX_CHARS);
    expect(text.split('\n')[0]).toMatch(new RegExp(`^quiet \\(${trimmed.body.quiet.length} of 12\\): `));
    expect(formatTimelineReadAck({ ...trimmed.body, quiet: rows.slice(0, trimmed.body.quiet.length + 1) }).length).toBeGreaterThan(TIMELINE_READ_MAX_CHARS);

    // The index alone is exactly the limit: it goes out without the quiet line.
    const empty = formatTimelineReadAck({ index: pad(0) }).length;
    const exact = await indexFixture({ readWeekIndex: async () => ({ status: 200, data: pad(TIMELINE_READ_MAX_CHARS - empty) }), wentQuiet: async () => ({ status: 200, data: { total: 12, rows } }) }).h.read({ roomId: '!r:s', index: true });
    expect(exact.status).toBe(200);
    expect(exact.body.quiet).toBeUndefined();
    expect(formatTimelineReadAck(exact.body)).toHaveLength(TIMELINE_READ_MAX_CHARS);
    const over = await indexFixture({ readWeekIndex: async () => ({ status: 200, data: pad(TIMELINE_READ_MAX_CHARS - empty + 1) }) }).h.read({ roomId: '!r:s', index: true });
    expect(over).toEqual({ status: 502, body: { error: "the journal's week read is too large for this tool — deploy the journal update" } });
  });
});

describe('timeline_week_read: chosen projects', () => {
  it('projects: [...] reads exactly those projects, refs normalised, and no quiet line', async () => {
    const { h, c } = indexFixture();
    const r = await h.read({ roomId: '!r:s', week: '2026-11-09', projects: ['#12', ' 7 ', 3, 'prj_abc', '12'] });
    expect(c.readWeekProjects).toHaveBeenCalledWith('2026-11-09', [12, 7, 3, 'prj_abc']);
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(formatTimelineReadAck(r.body)).toBe(`week: ${JSON.stringify(detailWeek())}\nThose are the projects you asked for.`);
  });

  it('with no week it reads the current one, still without the quiet line', async () => {
    const { h, c } = indexFixture();
    const r = await h.read({ roomId: '!r:s', projects: [1] });
    expect(c.readWeekProjects).toHaveBeenCalledWith('2026-11-09', [1]);
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(formatTimelineReadAck(r.body)).not.toMatch(/quiet \(/);
  });

  it('projects the journal left out to fit are named', async () => {
    const data = detailWeek({ omitted: ['p3', 'p4'] });
    const { h } = indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data })) });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-09', projects: [1, 2, 3, 4] });
    expect(formatTimelineReadAck(r.body).split('\n')).toEqual([
      `week: ${JSON.stringify(data)}`,
      'Those are the projects you asked for.',
      'Left out to fit: p3, p4 — ask for them in another call.',
    ]);
    const none = await indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data: detailWeek({ omitted: [] }) })) }).h.read({ roomId: '!r:s', week: '2026-11-09', projects: [1] });
    expect(formatTimelineReadAck(none.body)).not.toMatch(/Left out/);
  });

  it('a bad list of projects is refused locally, naming the problem', async () => {
    const { h, c } = indexFixture();
    const read = (projects, extra = {}) => h.read({ roomId: '!r:s', week: '2026-11-09', projects, ...extra });
    for (const projects of [[], 'p1', 7, {}]) {
      const r = await read(projects);
      expect(r.status, JSON.stringify(projects)).toBe(400);
      expect(r.body.error).toBe('projects must be a list of 1 to 12 projects: ids, or numbers such as 12 or #12');
    }
    const many = await read(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(many.status).toBe(400);
    expect(many.body.error).toBe('too many projects: at most 12 a call (got 13) — ask for the rest in another call');
    for (const ref of ['#x', 0, -3, '', null, {}, 'a,b']) {
      const r = await read([1, ref]);
      expect(r.status, JSON.stringify(ref)).toBe(400);
      expect(r.body.error).toBe(`project 2 is a bad reference ${JSON.stringify(ref)} — use the id, or the number such as 12 or #12`);
    }
    const paged = await read([1], { offset: 12 });
    expect(paged.status).toBe(400);
    expect(paged.body.error).toBe('projects cannot be combined with offset — the projects asked for come in one read');
    expect(c.readWeekProjects).not.toHaveBeenCalled();
  });

  it('an older journal answers with a page that has more to come: 502', async () => {
    const page = pagedWeek({ projects_total: 30, projects: [detailRow(1)], next_offset: 12, more_projects: 18 });
    const { h } = indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data: page })) });
    expect(await h.read({ roomId: '!r:s', projects: [1] })).toEqual({ status: 502, body: { error: PREDATES_INDEX } });
    const noPaging = rawWeek({ projects: [detailRow(1)], more_projects: 4 });
    const old = await indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data: noPaging })) }).h.read({ roomId: '!r:s', projects: [1] });
    expect(old).toEqual({ status: 502, body: { error: PREDATES_INDEX } });
  });

  it('an older journal answers with one complete page of the whole week: 502', async () => {
    // It ignored projects: no omitted list, so these are every project of the week.
    for (const data of [
      pagedWeek({ projects_total: 2, projects: [detailRow(1), detailRow(2)] }),
      rawWeek({ projects: [detailRow(1), detailRow(2)] }),
      pagedWeek({ projects_total: 2, projects: [detailRow(1), detailRow(2)], omitted: null }),
    ]) {
      const { h } = indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data })) });
      expect(await h.read({ roomId: '!r:s', week: '2026-11-09', projects: [1] })).toEqual({ status: 502, body: { error: PREDATES_INDEX } });
    }
  });

  it('projects too large for one read are refused with what to do', async () => {
    const big = detailWeek({ projects: [{ ...detailRow(1), milestones: [{ text: 'x'.repeat(60000) }] }] });
    const { h } = indexFixture({ readWeekProjects: vi.fn(async () => ({ status: 200, data: big })) });
    expect(await h.read({ roomId: '!r:s', week: '2026-11-09', projects: [1, 2] })).toEqual({ status: 502, body: { error: 'those projects are too large for one read — ask for fewer in a call' } });
  });
});

describe('timeline client: the index and chosen projects', () => {
  it('asks the journal for index=1 and for projects=<refs>', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url]); return { ok: true, status: 200, json: async () => ({}) }; };
    const c = createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    await c.readWeekIndex('2026-11-09');
    await c.readWeekProjects('2026-11-09', [12, 'prj_abc', 3]);
    await c.readWeekProjects('2026-11-09', ['a b']);
    expect(calls).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1&index=1'],
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1&projects=12,prj_abc,3'],
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1&projects=a%20b'],
    ]);
  });
});

describe('timeline_week_write', () => {
  it('posts the cleaned entries to the entries route with the Coordinator convo_id', async () => {
    const { h, c } = fixture();
    const r = await h.write(call({
      week: ' 2026-11-09 ',
      entries: [
        entry({ project: '#12', sentence: ' The thing went out. ', next: ' Then the rest. ', media_blob_id: ' blob1 ' }),
        entry({ project: ' prj_abc ' }),
        entry({ project: 7 }),
      ],
      final: true,
      notes: [{ project_id: '#9', note: ' Left at review. ' }],
    }));
    expect(c.writeWeekEntries).toHaveBeenCalledTimes(1);
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-09', {
      convo_id: 'c-coord',
      entries: [
        { project: 12, sentence: 'The thing went out.', next: 'Then the rest.', media_blob_id: 'blob1' },
        { project: 'prj_abc', sentence: 'The thing went out.' },
        { project: 7, sentence: 'The thing went out.' },
      ],
      final: true,
      notes: [{ project_id: 9, note: 'Left at review.' }],
    });
    expect(r).toEqual({ status: 201, body: { week: '2026-11-09', written: true, final: true, entries: 3 } });
  });

  it('reaches the journal at /timeline/weeks/<week>/entries', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url, init.body]); return { ok: true, status: 201, json: async () => ({ week: '2026-11-09', written: true, final: false, entries: 1 }) }; };
    const { h } = fixture({ client: createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }) });
    const r = await h.write(call({ week: '2026-11-09', entries: [entry({ project: '#12' })] }));
    expect(r.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['POST', 'https://journal.example.com/timeline/weeks/2026-11-09/entries']);
    expect(JSON.parse(calls[0][2])).toEqual({ convo_id: 'c-coord', entries: [{ project: 12, sentence: 'The thing went out.' }], final: false, notes: [] });
  });

  it('defaults: final false, no notes, optional entry fields omitted, an empty list for a quiet week', async () => {
    const { h, c } = fixture();
    await h.write({ roomId: '!r:s', week: '2026-11-02', entries: [] });
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-02', { convo_id: 'c-coord', entries: [], final: false, notes: [] });
    await h.write(call({ entries: [entry({ next: '  ', media_blob_id: '' })] }));
    expect(c.writeWeekEntries.mock.calls[1][1].entries[0]).toEqual({ project: 3, sentence: 'The thing went out.' });
  });

  it('lede, stories and the old story fields passed anyway are not forwarded', async () => {
    const { h, c } = fixture();
    const r = await h.write(call({
      lede: 'A good week.',
      stories: [{ title: 'Shipped it', sentence: 'The thing went out.', project_ids: [3] }],
      entries: [entry({ title: 'Shipped it', project_ids: [3, 4], item_ids: [5] })],
    }));
    expect(r.status).toBe(201);
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-02', { convo_id: 'c-coord', entries: [{ project: 3, sentence: 'The thing went out.' }], final: false, notes: [] });
  });

  it('stories without entries is refused locally: the old shape is never sent', async () => {
    const { h, c } = fixture();
    const r = await h.write({ roomId: '!r:s', week: '2026-11-02', lede: 'A good week.', stories: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/entries is required/);
    expect(c.writeWeekEntries).not.toHaveBeenCalled();
  });

  it('nine entries, a missing sentence and a bad project ref each fail locally, naming the entry', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => entry({ project: i + 1 }));
    const cases = [
      [{ entries: nine }, 'too many entries: at most 8 (got 9) — one entry per project, for the projects that mattered most'],
      [{ entries: [entry(), { project: 4 }] }, 'entry 2 sentence is required'],
      [{ entries: [entry(), entry({ project: 4 }), entry({ project: '#abc' })] }, 'entry 3 has a bad project "#abc" — use the id, or the number such as 12 or #12'],
    ];
    for (const [over, sentence] of cases) {
      const { h, c } = fixture();
      const r = await h.write(call(over));
      expect(r).toEqual({ status: 400, body: { error: sentence } });
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
  });

  it('two entries for the same project fail locally with the one-entry-per-project sentence', async () => {
    for (const [a, b, shown] of [[12, '#12', '#12'], ['12', 12, '#12'], ['prj_abc', ' prj_abc ', 'prj_abc']]) {
      const { h, c } = fixture();
      const r = await h.write(call({ entries: [entry({ project: a }), entry({ project: 5 }), entry({ project: b })] }));
      expect(r).toEqual({ status: 400, body: { error: `project ${shown} has two entries — one entry per project` } });
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
  });

  it('enforces every limit before the journal', async () => {
    const L = TIMELINE_LIMITS;
    const refs = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const cases = [
      [{ week: undefined }, /week must be/],
      [{ week: '2026-11-03' }, /not a Monday/],
      [{ entries: undefined }, /entries is required/],
      [{ entries: 'x' }, /entries is required/],
      [{ entries: refs(L.entriesMax + 1).map((n) => entry({ project: n })) }, /too many entries/],
      [{ entries: ['x'] }, /entry 1 must be an object/],
      [{ entries: [[entry()]] }, /entry 1 must be an object/],
      [{ entries: [entry({ sentence: '  ' })] }, /entry 1 sentence is required/],
      [{ entries: [entry({ sentence: 5 })] }, /entry 1 sentence must be text/],
      [{ entries: [entry({ sentence: 'x'.repeat(L.sentenceMax + 1) })] }, /entry 1 sentence is too long: at most 300/],
      [{ entries: [entry({ next: 'x'.repeat(L.nextMax + 1) })] }, /entry 1 next is too long/],
      [{ entries: [entry({ project: undefined })] }, /entry 1 project is required/],
      [{ entries: [entry({ project: null })] }, /entry 1 project is required/],
      [{ entries: [entry({ project: 0 })] }, /entry 1 has a bad project/],
      [{ entries: [entry({ project: -3 })] }, /bad project/],
      [{ entries: [entry({ project: 1.5 })] }, /bad project/],
      [{ entries: [entry({ project: '  ' })] }, /bad project/],
      [{ entries: [entry({ project: '#0' })] }, /bad project/],
      [{ entries: [entry({ project: {} })] }, /bad project/],
      [{ entries: [entry({ project: [3] })] }, /bad project/],
      [{ entries: [entry({ media_blob_id: 7 })] }, /entry 1 media_blob_id/],
      [{ entries: [entry({ media_blob_id: 'b'.repeat(L.blobIdMax + 1) })] }, /entry 1 media_blob_id is too long: at most 128/],
      [{ notes: refs(L.notesMax + 1).map((n) => ({ project_id: n, note: 'x' })) }, /too many notes/],
      [{ notes: [{ project_id: 1, note: '' }] }, /note 1 note is required/],
      [{ notes: [{ project_id: 1, note: 'x'.repeat(L.noteMax + 1) }] }, /note is too long/],
      [{ notes: [{ project_id: '', note: 'x' }] }, /bad project_id/],
      [{ notes: 'nope' }, /notes must be a list/],
      [{ final: 'yes' }, /final must be true or false/],
    ];
    for (const [over, re] of cases) {
      const { h, c } = fixture();
      const r = await h.write(call(over));
      expect(r.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(r.body.error, JSON.stringify(over).slice(0, 80)).toMatch(re);
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
    // The limits themselves are accepted.
    const edge = fixture();
    const r = await edge.h.write(call({
      entries: refs(L.entriesMax).map((n) => entry({ project: n, sentence: 'x'.repeat(L.sentenceMax), next: 'x'.repeat(L.nextMax), media_blob_id: 'b'.repeat(L.blobIdMax) })),
      notes: refs(L.notesMax).map((n) => ({ project_id: n, note: 'x'.repeat(L.noteMax) })),
    }));
    expect(r.status).toBe(201);
    expect(L).toEqual({ entriesMax: 8, sentenceMax: 300, nextMax: 300, notesMax: 50, noteMax: 300, blobIdMax: 128 });
  });

  it('an old journal: 404, nothing written', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url]); return { ok: false, status: 404, json: async () => { throw new Error('not json'); } }; };
    const { h } = fixture({ client: createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }) });
    const r = await h.write(call({ week: '2026-11-09' }));
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/^the journal predates per-project weeks — deploy the journal update before writing/);
    // One POST to the new path; the older whole-week path is never tried.
    expect(calls).toEqual([['POST', 'https://journal.example.com/timeline/weeks/2026-11-09/entries']]);
    expect(createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }).writeWeek).toBeUndefined();
  });

  it('maps each journal error to a sentence an agent can act on, and unreachable to 502', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, 403, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden' } }, 403, /only the Coordinator agent/],
      [{ status: 409, data: { error: 'conflict', detail: 'week_final' } }, 409, /^that week is frozen; pass final: true to rewrite it on purpose$/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_not_ended' } }, 400, /only after it ends \(Monday 00:00/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_out_of_range' } }, 400, /outside the range/],
      [{ status: 400, data: { error: 'bad_request', detail: 'bad_week' } }, 400, /Monday of the week/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_project', ref: 42 } }, 400, /project 42 is not one of the user's projects, or is private — a week never names private work/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_blob', ref: 'b1' } }, 400, /media_blob_id b1 is not a picture or video/],
      [{ status: 400, data: { error: 'bad_request', detail: 'duplicate_project', ref: 12 } }, 400, /^project 12 has two entries — one entry per project$/],
      [{ status: 400, data: { error: 'bad_request', detail: 'duplicate_project' } }, 400, /^project \(unnamed\) has two entries — one entry per project$/],
      [{ status: 400, data: { error: 'bad_request' } }, 400, /rejected the call — check the week and the entry limits \(8 entries, one per project, sentences to 300 characters\)/],
      [{ status: 404, data: { error: 'HTTP 404' } }, 404, /^the journal predates per-project weeks — deploy the journal update before writing/],
      [{ status: 404, data: { error: 'not_found' } }, 404, /if the journal is up to date, it does not know this conversation on this box/],
      [{ status: 500, data: { error: 'HTTP 500' } }, 500, /^HTTP 500$/],
    ];
    for (const [res, status, re] of cases) {
      const r = await fixture({ client: { writeWeekEntries: async () => res } }).h.write(call());
      expect(r.status, JSON.stringify(res)).toBe(status);
      expect(r.body.error, JSON.stringify(res)).toMatch(re);
      expect(r.body.error).not.toMatch(/\bbad_request\b|\bforbidden\b|\bweek_final\b|\bunknown_project\b|\bduplicate_project\b|\bstor(y|ies)\b/);
    }
    const down = await fixture({ client: { writeWeekEntries: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.write(call());
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
    expect(validateTimelineWrite({ week: '2026-11-09', entries: [] }).ok).toBe(true);
  });
  it('acks', () => {
    expect(formatTimelineWriteAck({ week: '2026-11-09', final: false, entries: 4 })).toBe('Week 2026-11-09 written (4 projects).');
    expect(formatTimelineWriteAck({ week: '2026-11-02', final: true, entries: 1 })).toBe('Week 2026-11-02 written (1 project, frozen).');
    expect(formatTimelineWriteAck({ week: '2026-11-02', final: false, entries: 0 })).toBe('Week 2026-11-02 written (0 projects).');
    expect(formatTimelineReadAck({ week: { week: 'w' } })).toBe('week: {"week":"w"}\nThat is every project that moved this week.');
    expect(formatTimelineReadAck({ week: { week: 'w', next_offset: 8 }, quiet: [], quiet_total: 0 })).toBe('quiet (0 of 0): []\nweek: {"week":"w","next_offset":8}\nMore projects: call timeline_week_read again with week: "w", offset: 8.');
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
    await c.writeWeekEntries('2026-11-09', { convo_id: 'c1', entries: [] });
    expect(calls.map((x) => [x.init.method, x.url])).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1'],
      ['GET', 'https://j/timeline/weeks?limit=1'],
      ['GET', 'https://j/timeline/weeks'],
      ['GET', 'https://j/timeline/quiet?raw=1'],
      ['POST', 'https://j/timeline/weeks/2026-11-09/entries'],
    ]);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[4].init.body)).toEqual({ convo_id: 'c1', entries: [] });
    expect(calls[4].init.headers['Content-Type']).toBe('application/json');
  });
  it('returns error statuses and never throws; no base means unreachable', async () => {
    const { fetchImpl } = fakeFetch(409, { error: 'conflict', detail: 'week_final' });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl }).writeWeekEntries('2026-11-09', {})).toEqual({ status: 409, data: { error: 'conflict', detail: 'week_final' } });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('boom'); } }).wentQuiet()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    expect((await createTimelineClient({}).wentQuiet()).status).toBe(0);
  });
});
