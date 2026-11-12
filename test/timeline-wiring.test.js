import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadCoordinatorBlock } from '../lib/coordinator.js';
import { createTimelineHandlers, formatTimelineReadAck, formatTimelineWriteAck } from '../lib/timeline-tools.js';

describe('timeline wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

  it('mounts exactly the /timeline/read and /timeline/write routes through the handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/timeline\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /timeline route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|')).toEqual(['read', 'write']);
    expect(index).toContain('timelineHandlers[name]');
  });

  it('builds the client and handlers with the same Coordinator test as the briefing tool', () => {
    expect(index).toMatch(/import \{ createTimelineClient \} from '\.\/lib\/timeline-client\.js';/);
    expect(index).toMatch(/import \{ createTimelineHandlers \} from '\.\/lib\/timeline-tools\.js';/);
    expect(index).toMatch(/const timelineClient = createTimelineClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    const start = index.indexOf('const timelineHandlers = createTimelineHandlers({');
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf('});', start));
    expect(block).toContain('client: timelineClient,');
    expect(block).toContain('isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),');
  });

  it("index.js's isCoordinator admits the journal's live Coordinator whose spawn-time flag is false, and nobody else", async () => {
    const start = index.indexOf('const timelineHandlers = createTimelineHandlers({');
    const block = index.slice(start, index.indexOf('});', start));
    const src = block.match(/isCoordinator: (\(session, convoId\) => .+),\n/)[1];
    let liveConvoId = null;
    const isCoordinator = new Function('coordinatorLookup', `return ${src};`)({ snapshot: () => ({ convoId: liveConvoId }) });
    const session = { roomId: '!r:s', journalConvoId: 'c1', coordinator: false };
    const writeWeekEntries = vi.fn(async (week) => ({ status: 201, data: { week, written: true, final: false, entries: 0 } }));
    const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: { writeWeekEntries }, isCoordinator });
    const args = { roomId: '!r:s', week: '2026-11-02', entries: [] };
    expect((await h.write(args)).status).toBe(403);
    liveConvoId = 'other';
    expect((await h.write(args)).status).toBe(403);
    expect(writeWeekEntries).not.toHaveBeenCalled();
    liveConvoId = 'c1';
    expect((await h.write(args)).status).toBe(201);
    liveConvoId = null;
    session.coordinator = true;
    expect((await h.write(args)).status).toBe(201);
  });

  it('registers both tools through callTimeline with their renderers and Coordinator-only descriptions', () => {
    const slice = askUser.slice(askUser.indexOf("'timeline_week_read',"), askUser.indexOf('function compactSelfText'));
    expect(slice).toContain("callTimeline('read', args, formatTimelineReadAck)");
    expect(slice).toContain("callTimeline('write', args, formatTimelineWriteAck)");
    expect(slice.match(/Coordinator only/g)).toHaveLength(2);
    expect(slice).toMatch(/Went quiet list/);
    expect(slice).toMatch(/before timeline_week_write/);
    expect(slice).toMatch(/no links/);
    expect(slice).toMatch(/private work/);
    expect(slice).toMatch(/`final: true` freezes/);
    expect(askUser).toMatch(/import \{ formatTimelineReadAck, formatTimelineWriteAck \} from '\.\/lib\/timeline-tools\.js';/);
  });

  // Evaluates the REAL input schema source from ask-user.js with the real zod.
  function writeInputSchema() {
    const start = askUser.indexOf('const TIMELINE_REF = ');
    const end = askUser.indexOf("server.tool(\n  'timeline_week_read',");
    expect(start, 'the timeline schema block is missing from ask-user.js').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function('z', `${askUser.slice(start, end)}\nreturn TIMELINE_WEEK_WRITE_INPUT;`)(z);
  }

  it('the read schema takes an optional week and a page offset', () => {
    const start = askUser.indexOf('const TIMELINE_REF = ');
    const end = askUser.indexOf("server.tool(\n  'timeline_week_read',");
    expect(askUser.indexOf('const TIMELINE_WEEK_READ_INPUT = '), 'the read schema is missing from ask-user.js').toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    const schema = z.strictObject(new Function('z', `${askUser.slice(start, end)}\nreturn TIMELINE_WEEK_READ_INPUT;`)(z));
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09', offset: 0 }).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09', offset: 12 }).success).toBe(true);
    for (const offset of [-1, 1.5, '12']) expect(schema.safeParse({ offset }).success, String(offset)).toBe(false);
    // The index of a week, and the detail of up to 12 projects picked from it.
    expect(schema.safeParse({ index: true }).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09', index: false }).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09', projects: ['#12', 7, 'prj_abc'] }).success).toBe(true);
    expect(schema.safeParse({ projects: Array.from({ length: 12 }, (_, i) => i + 1) }).success).toBe(true);
    expect(schema.safeParse({ projects: Array.from({ length: 13 }, (_, i) => i + 1) }).success).toBe(false);
    expect(schema.safeParse({ projects: [] }).success).toBe(false);
    expect(schema.safeParse({ projects: [0] }).success).toBe(false);
    expect(schema.safeParse({ index: 'yes' }).success).toBe(false);
    const read = askUser.slice(end, askUser.indexOf("'timeline_week_write',"));
    expect(read).toContain('TIMELINE_WEEK_READ_INPUT,');
    expect(read).toMatch(/offset/);
    // Start with the index, then the detail of the projects worth a card.
    expect(read).toMatch(/Start with `index: true`/);
    expect(read).toMatch(/`projects: \[\.\.\.\]` \(up to 12 a call\)/);
    expect(read).toMatch(/a page of projects at a time/);
  });

  it('the write schema takes a week of entries, one per project', () => {
    const schema = writeInputSchema();
    const entry = { project: '#12', sentence: 'The thing went out.' };
    expect(schema.safeParse({ week: '2026-11-09', entries: [] }).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09', entries: [entry, { project: 7, sentence: 'S', next: 'N', media_blob_id: 'blob1' }, { project: 'prj_abc', sentence: 'S' }], final: true, notes: [{ project_id: 9, note: 'Left at review.' }] }).success).toBe(true);
    expect(schema.safeParse({ week: '2026-11-09' }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: Array.from({ length: 9 }, (_, i) => ({ project: i + 1, sentence: 'S' })) }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: [{ project: 3 }] }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: [{ sentence: 'S' }] }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: [{ project: 3, sentence: 'x'.repeat(301) }] }).success).toBe(false);
  });

  it('the write schema rejects stories, a lede and the old story fields', () => {
    const schema = writeInputSchema();
    const entry = { project: 3, sentence: 'The thing went out.' };
    const story = { title: 'Shipped it', sentence: 'The thing went out.', project_ids: [3] };
    expect(schema.safeParse({ week: '2026-11-09', stories: [story] }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: [entry], stories: [story] }).success).toBe(false);
    expect(schema.safeParse({ week: '2026-11-09', entries: [entry], lede: 'A good week.' }).success).toBe(false);
    for (const extra of [{ title: 'Shipped it' }, { project_ids: [3] }, { item_ids: [4] }]) {
      expect(schema.safeParse({ week: '2026-11-09', entries: [{ ...entry, ...extra }] }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('the write tool describes entries, not stories or a lede', () => {
    const slice = askUser.slice(askUser.indexOf('const TIMELINE_REF = '), askUser.indexOf('function compactSelfText'));
    const write = slice.slice(slice.indexOf("'timeline_week_write',"));
    expect(write).toMatch(/Write one week of Projects: up to 8 entries, one per project that mattered/);
    expect(write).toMatch(/The project\\'s name is the card\\'s title, so do not repeat it/);
    expect(write).not.toMatch(/\blede\b|\bstories\b|project_ids|item_ids/);
  });

  // The strict schema only refuses old-shape keys while the tool is
  // registered with it: a plain-shape registration would strip them instead.
  it('registers the write tool with the strict schema itself', () => {
    const start = askUser.indexOf("server.registerTool(\n  'timeline_week_write',");
    expect(start, 'timeline_week_write is not registered through registerTool').toBeGreaterThan(-1);
    const registration = askUser.slice(start, askUser.indexOf('\n);', start));
    expect(registration).toContain('inputSchema: TIMELINE_WEEK_WRITE_INPUT,');
    expect(askUser).toMatch(/const TIMELINE_WEEK_WRITE_INPUT = z\.strictObject\(/);
  });

  // Runs the REAL callTimeline source from ask-user.js against the REAL handlers.
  it('callTimeline renders acks and errors as one text line', async () => {
    const start = askUser.indexOf('async function callTimeline');
    const src = askUser.slice(start, askUser.indexOf('\n}\n', start) + 2);
    const session = { roomId: '!r:s', journalConvoId: 'c1', coordinator: true };
    const client = {
      listWeeks: async () => ({ status: 200, data: { weeks: [{ week: '2026-11-09' }] } }),
      readWeekRaw: async (week) => ({ status: 200, data: { week, current: false, projects: [] } }),
      writeWeekEntries: vi.fn(async (week, body) => (body.final ? { status: 409, data: { error: 'conflict', detail: 'week_final' } } : { status: 201, data: { week, written: true, final: false, entries: body.entries.length } })),
    };
    const handlers = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client });
    const fetch = async (url, init) => {
      const r = await handlers[url.split('/timeline/')[1]](JSON.parse(init.body));
      return { status: r.status, ok: r.status < 300, json: async () => r.body };
    };
    const callTimeline = new Function('bridgeFetch', 'BRIDGE_API', 'ROOM_ID', `${src}\nreturn callTimeline;`)(fetch, 'http://bridge', '!r:s');
    const read = await callTimeline('read', {}, formatTimelineReadAck);
    expect(read.content[0].text).toBe('week: {"week":"2026-11-09","current":false,"projects":[]}\nThat is every project that moved this week.');
    const wrote = await callTimeline('write', { week: '2026-11-02', entries: [{ project: '#3', sentence: 'S' }] }, formatTimelineWriteAck);
    expect(wrote.content[0].text).toBe('Week 2026-11-02 written (1 project).');
    const frozen = await callTimeline('write', { week: '2026-11-02', entries: [], final: true }, formatTimelineWriteAck);
    expect(frozen.content[0].text).toBe('timeline_week_write failed: that week is frozen; pass final: true to rewrite it on purpose');
  });

  it('the playbook has the weekly-stories routine, the rewrite and the preamble paragraph', () => {
    const coord = loadCoordinatorBlock({
      readFile: (p) => readFileSync(p, 'utf8'),
      path: fileURLToPath(new URL('../BRIDGE_COORDINATOR.md', import.meta.url)),
      dir: fileURLToPath(new URL('../coordinator', import.meta.url)),
      readDir: (d) => readdirSync(d),
    });
    expect(coord).toContain("## Routine: weekly-stories — The Projects timeline's weekly stories");
    const routine = coord.slice(coord.indexOf('## Routine: weekly-stories'));
    expect(routine).toMatch(/timeline_week_read/);
    expect(routine).toMatch(/timeline_week_write/);
    expect(routine).toMatch(/final: true/);
    expect(routine).toMatch(/media_blob_id/);
    expect(routine).toMatch(/`stored` is null, or `stored\.final` is false/);
    expect(routine).toMatch(/at most 10 weeks/);
    expect(routine).toMatch(/`entries`/);
    expect(routine).toMatch(/One entry per project, at most 8/);
    expect(routine).toMatch(/`sentence`/);
    // A week is read as its index, then the detail of the projects picked.
    expect(routine).toContain('`index: true`');
    expect(routine).toContain('`projects: [...]`');
    expect(routine).toContain('up to 12 candidates');
    expect(routine).toContain('lists every project that moved, most moves first, each with how much');
    // Never page by page: the only mention of `offset` is the rule against it.
    expect(routine).toContain('Never read a week a page at a time (with `offset`) for this routine');
    const file = readFileSync(new URL('../coordinator/routines/weekly-stories.md', import.meta.url), 'utf8');
    expect(routine).toContain(file.trim());
    expect(file.match(/offset/g)).toHaveLength(1);
    expect(file).not.toMatch(/every page|next page|keep going until/i);
    // A week whose index cannot be read is neither written nor frozen.
    expect(routine).toContain("If a week's index cannot be read (the read is refused, or the journal predates the index), write nothing for that week, never freeze it");
    expect(routine).toContain("When a week's index could not be read, add one more line saying which week and that it was left unwritten.");
    expect(routine).toMatch(/quiet \(n of total\)/);
    expect(routine).toMatch(/`notes`/);
    // The older shape is gone from the routine.
    expect(routine).not.toMatch(/lede/i);
    expect(routine).not.toMatch(/project_ids/);
    expect(routine).not.toMatch(/item_ids/);
    expect(routine).not.toMatch(/3 to 6 stories/);
    expect(routine).not.toMatch(/back-fill/i);
    expect(routine).toMatch(/### Rewrite/);
    const rewrite = routine.slice(routine.indexOf('### Rewrite'));
    expect(rewrite).toMatch(/oldest first/);
    expect(rewrite).toMatch(/`stored\.legacy` is true/);
    expect(rewrite).toMatch(/`final: true`, except the current week/);
    expect(rewrite).toContain('`index: true`');
    expect(rewrite).toContain('`projects: [...]`');
    expect(rewrite).toContain('the re-filing of projects into goals should be finished: weeks are told per project');
    expect(rewrite).toMatch(/out of range/);
    expect(rewrite).toMatch(/one line per week/);
    expect(coord).toMatch(/one card per project per week/);
    expect(coord).toContain('returns the index of one week (every project that moved, with how much) and then the detail of the projects you pick from it');
    expect(coord).toMatch(/follow `## Routine: weekly-stories`/);
  });
});
