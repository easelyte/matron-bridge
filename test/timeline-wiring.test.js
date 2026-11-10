import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
    const writeWeek = vi.fn(async (week) => ({ status: 201, data: { week, written: true, final: false } }));
    const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: { writeWeek }, isCoordinator });
    const args = { roomId: '!r:s', week: '2026-11-02', stories: [] };
    expect((await h.write(args)).status).toBe(403);
    liveConvoId = 'other';
    expect((await h.write(args)).status).toBe(403);
    expect(writeWeek).not.toHaveBeenCalled();
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

  // Runs the REAL callTimeline source from ask-user.js against the REAL handlers.
  it('callTimeline renders acks and errors as one text line', async () => {
    const start = askUser.indexOf('async function callTimeline');
    const src = askUser.slice(start, askUser.indexOf('\n}\n', start) + 2);
    const session = { roomId: '!r:s', journalConvoId: 'c1', coordinator: true };
    const client = {
      listWeeks: async () => ({ status: 200, data: { weeks: [{ week: '2026-11-09' }] } }),
      readWeekRaw: async (week) => ({ status: 200, data: { week, current: false, projects: [] } }),
      writeWeek: vi.fn(async (week, body) => (body.final ? { status: 409, data: { error: 'conflict', detail: 'week_final' } } : { status: 201, data: { week, written: true, final: false } })),
    };
    const handlers = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client });
    const fetch = async (url, init) => {
      const r = await handlers[url.split('/timeline/')[1]](JSON.parse(init.body));
      return { status: r.status, ok: r.status < 300, json: async () => r.body };
    };
    const callTimeline = new Function('bridgeFetch', 'BRIDGE_API', 'ROOM_ID', `${src}\nreturn callTimeline;`)(fetch, 'http://bridge', '!r:s');
    const read = await callTimeline('read', {}, formatTimelineReadAck);
    expect(JSON.parse(read.content[0].text)).toEqual({ week: { week: '2026-11-09', current: false, projects: [] } });
    const wrote = await callTimeline('write', { week: '2026-11-02', stories: [{ title: 'T', sentence: 'S', project_ids: ['#3'] }] }, formatTimelineWriteAck);
    expect(wrote.content[0].text).toBe('Week 2026-11-02 written (1 story).');
    const frozen = await callTimeline('write', { week: '2026-11-02', stories: [], final: true }, formatTimelineWriteAck);
    expect(frozen.content[0].text).toBe('timeline_week_write failed: that week is frozen; pass final: true to rewrite it on purpose');
  });

  it('the playbook has the weekly-stories routine, back-fill and the preamble paragraph', () => {
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
    expect(routine).toMatch(/`week\.stored` is null, or `week\.stored\.final` is false/);
    expect(routine).toMatch(/at most 10 weeks/);
    expect(routine).toMatch(/week\.projects\[\]\.needs_you/);
    expect(routine).toMatch(/### Back-fill/);
    expect(routine).toMatch(/eight weeks/);
    expect(coord).toMatch(/follow `## Routine: weekly-stories`/);
  });
});
