import { readFileSync, readdirSync } from 'node:fs';
import { loadCoordinatorBlock } from '../lib/coordinator.js';
import { describe, expect, it, vi } from 'vitest';
import { createProjectsHandlers } from '../lib/projects-tools.js';
import { formatProjectBlocked, formatProjectJournalError } from '../lib/projects-format.js';

const OPS = ['list', 'get', 'create', 'update', 'status', 'close', 'merge'];
const TOOL_CALLS = {
  project_list: "callProjects('list', args, formatProjectList)",
  project_get: "callProjects('get', args, formatProjectDetail)",
  project_create: "callProjects('create', args, formatProjectCreateAck)",
  project_update: "callProjects('update', args, (d) => projectLine(d.project))",
  project_status: "callProjects('status', args, formatProjectStatusAck)",
  project_close: "callProjects('close', args, (d) => projectLine(d.project))",
  project_merge: "callProjects('merge', args, (d) => formatProjectMergeAck(d, args))",
};

describe('projects wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('mounts exactly the seven /projects routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/projects\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /projects route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('projectsHandlers[name]');
  });

  it('builds the handlers with the missions resolver and the same Coordinator test as the consent tools', () => {
    expect(index).toMatch(/import \{ createProjectsClient \} from '\.\/lib\/projects-client\.js';/);
    expect(index).toMatch(/import \{ createProjectsHandlers \} from '\.\/lib\/projects-tools\.js';/);
    expect(index).toMatch(/const projectsClient = createProjectsClient\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,\s*\}\);/);
    const start = index.indexOf('const projectsHandlers = createProjectsHandlers({');
    expect(start).toBeGreaterThan(index.indexOf('const missionsHandlers = createMissionsHandlers({'));
    const block = index.slice(start, index.indexOf('});', start));
    expect(block).toContain('client: projectsClient,');
    expect(block).toContain('missionsClient,');
    expect(block).toContain('resolveMission: (session, convoId) => missionsHandlers.resolveMission(session, convoId),');
    expect(block).toContain('isCoordinator: (session, convoId) => session?.coordinator === true || (!!convoId && coordinatorLookup.snapshot().convoId === convoId),');
  });

  it("index.js's isCoordinator admits the journal's live Coordinator whose spawn-time flag is false, and nobody else", async () => {
    const start = index.indexOf('const projectsHandlers = createProjectsHandlers({');
    const block = index.slice(start, index.indexOf('});', start));
    const src = block.match(/isCoordinator: (\(session, convoId\) => .+),\n/)[1];
    let liveConvoId = null;
    const coordinatorLookup = { snapshot: () => ({ convoId: liveConvoId }) };
    const isCoordinator = new Function('coordinatorLookup', `return ${src};`)(coordinatorLookup);
    const session = { roomId: '!r:s', journalConvoId: 'c1', coordinator: false };
    const close = vi.fn(async () => ({ status: 200, data: { project: { num: 70, title: 'Promo', state: 'closed' } } }));
    const h = createProjectsHandlers({
      sessions: new Map([['!r:s', session]]),
      journalConvoIdFor: (s) => s?.journalConvoId ?? null,
      client: { close },
      missionsClient: {},
      resolveMission: async () => ({ id: null }),
      isCoordinator,
    });
    const args = { roomId: '!r:s', num: 70, summary: 'done' };
    expect((await h.close(args)).status).toBe(403);
    liveConvoId = 'other';
    expect((await h.close(args)).status).toBe(403);
    expect(close).not.toHaveBeenCalled();
    liveConvoId = 'c1';
    expect((await h.close(args)).status).toBe(200);
    liveConvoId = null;
    session.coordinator = true;
    expect((await h.close(args)).status).toBe(200);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('registers the seven project tools, each pinned to its exact renderer', () => {
    for (const [tool, call] of Object.entries(TOOL_CALLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through ${call}`).toContain(call);
    }
    expect(askUser).toMatch(/import \{[^}]*\bformatProjectBlocked\b[^}]*\bformatProjectJournalError\b[^}]*\} from '\.\/lib\/projects-format\.js'/);
  });

  it('callProjects: 409 through formatProjectBlocked, other errors through formatProjectJournalError, idem key for create only', () => {
    const start = askUser.indexOf('async function callProjects');
    const end = askUser.indexOf("server.tool(\n  'project_list',");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = askUser.slice(start, end);
    expect(fn).toContain('formatProjectBlocked(data)');
    expect(fn).toContain('formatProjectJournalError(name, data)');
    expect(fn).toMatch(/if \(name === 'create'\) payload\.idem_key = missionIdemKey\(\{ op: 'project_create', roomId: ROOM_ID, title: args\?\.title, body: args\?\.body \}\);/);
    expect(fn).toContain('${BRIDGE_API}/projects/${name}');
    expect(fn).not.toContain('isError');
  });

  // Controller requirement: every journal error the handlers pass through
  // (raw 400, 403 forbidden / not_coordinator, 404, 409 bodies, 502) and
  // every bridge refusal reaches the agent as "<tool> failed: <sentence>" —
  // one plain text block, never isError, never raw JSON. Runs the REAL
  // callProjects source from ask-user.js against the REAL handlers.
  it('callProjects renders every handler error as "<tool> failed: <sentence>" text', async () => {
    const start = askUser.indexOf('async function callProjects');
    const src = askUser.slice(start, askUser.indexOf('\n}\n', start) + 2);
    const makeCall = (handlers) => {
      const fetch = async (url, init) => {
        const op = url.split('/projects/')[1];
        const r = await handlers[op](JSON.parse(init.body));
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
      };
      return new Function('fetch', 'BRIDGE_API', 'ROOM_ID', 'missionIdemKey', 'formatProjectBlocked', 'formatProjectJournalError', `${src}\nreturn callProjects;`)(
        fetch, 'http://bridge', '!r:s', () => 'k', formatProjectBlocked, formatProjectJournalError);
    };
    const journal = (status, data) => vi.fn(async () => ({ status, data }));
    const cases = [
      ['update', { num: 70, title: 'x' }, { update: journal(400, { error: 'bad_request', detail: 'title too long' }) }],
      ['status', { num: 70, status: 'ok' }, { update: journal(400, { error: 'bad_request' }) }],
      ['merge', { num: 70, into: 71 }, { merge: journal(400, { error: 'bad_request' }) }],
      ['update', { num: 70, title: 'x' }, { update: journal(403, { error: 'forbidden' }) }],
      ['close', { num: 70, summary: 's' }, { close: journal(403, { error: 'not_coordinator' }) }],
      ['merge', { num: 70, into: 71 }, { merge: journal(403, { detail: 'not_coordinator' }) }],
      ['get', { num: 70 }, { get: journal(404, { error: 'not_found' }) }],
      ['merge', { num: 70, into: 71 }, { merge: journal(404, { error: 'not_found' }) }],
      ['list', {}, { list: journal(404, { error: 'not_found' }) }],
      ['create', { title: 'P' }, { create: journal(404, { error: 'not_found' }) }],
      ['close', { num: 70, summary: 's' }, { close: journal(409, { error: 'conflict', blocked_by: 'open_missions', missions: [{ num: 61, title: 'Launch' }] }) }],
      ['update', { num: 70, title: 'x' }, { update: journal(409, { error: 'closed' }) }],
      ['merge', { num: 70, into: 71 }, { merge: journal(409, { error: 'conflict', blocked_by: 'into_closed' }) }],
      ['update', { num: 70, title: 'x' }, { update: journal(409, { error: 'conflict', blocked_by: 'something_new' }) }],
      ['update', { num: 70, title: 'x' }, { update: journal(409, {}) }],
      ['update', { num: 70, title: 'x' }, { update: journal(500, { detail: { nested: true } }) }],
      ['update', { num: 70, title: 'x' }, { update: journal(0, null) }],
      ['update', { num: 70 }, {}],
      ['merge', { num: 70, into: 70 }, {}],
    ];
    for (const [op, args, client] of cases) {
      const h = createProjectsHandlers({
        sessions: new Map([['!r:s', { roomId: '!r:s', journalConvoId: 'c1', coordinator: true }]]),
        journalConvoIdFor: (s) => s.journalConvoId,
        client,
        missionsClient: {},
        resolveMission: async () => ({ id: null }),
      });
      const out = await makeCall(h)(op, args, () => 'rendered');
      const journalFn = Object.values(client)[0];
      const label = `${op} ${JSON.stringify(args)} journal=${journalFn ? JSON.stringify(await journalFn()) : 'none'}`;
      expect(Object.keys(out), label).toEqual(['content']);
      expect(out.content).toHaveLength(1);
      expect(out.content[0].type).toBe('text');
      const text = out.content[0].text;
      expect(text, label).toMatch(new RegExp(`^project_${op} failed: \\S`));
      expect(text, label).not.toMatch(/[{}]|\bnot_found\b|\bbad_request\b|\bforbidden\b|\bnot_coordinator\b|\bblocked_by\b|\[object/);
    }
    // Gate refusal: not the Coordinator.
    const plain = createProjectsHandlers({
      sessions: new Map([['!r:s', { roomId: '!r:s', journalConvoId: 'c1', coordinator: false }]]),
      journalConvoIdFor: (s) => s.journalConvoId,
      client: {},
      missionsClient: {},
      resolveMission: async () => ({ id: null }),
    });
    expect((await makeCall(plain)('merge', { num: 70, into: 71 }, () => '')).content[0].text)
      .toBe('project_merge failed: only the Coordinator may call project_merge — this conversation is not the Coordinator');
  });

  it('schemas: close and merge say Coordinator; status is a string; no convo_id or idem_key parameter', () => {
    const slice = (from, to) => askUser.slice(askUser.indexOf(`'${from}',`), to ? askUser.indexOf(`'${to}',`) : askUser.indexOf('// --- Memories'));
    expect(slice('project_close', 'project_merge')).toMatch(/Coordinator only/);
    expect(slice('project_merge')).toMatch(/Coordinator only/);
    expect(slice('project_merge')).toMatch(/into: z\.number\(\)\.int\(\)\.min\(1\)/);
    expect(slice('project_status', 'project_close')).toMatch(/status: z\.string\(\)/);
    expect(slice('project_list', 'project_get')).toMatch(/state: z\.enum\(\['open', 'closed'\]\)\.optional\(\)/);
    expect(askUser).toMatch(/const PROJECT_WHAT = .*nothing to do with ~\/\.claude\/projects/);
    expect(slice('project_list', 'project_get')).toContain('${PROJECT_WHAT}');
    expect(slice('project_create', 'project_update')).toContain('${PROJECT_WHAT}');
    expect(askUser).not.toMatch(/(?<!\w)convo_id:\s*z\./);
    expect(askUser).not.toMatch(/idem_key:\s*z\./);
  });

  it('npm run check covers the three new files', () => {
    for (const f of ['lib/projects-client.js', 'lib/projects-tools.js', 'lib/projects-format.js']) {
      expect(pkg.scripts.check).toContain(`node --check ${f}`);
    }
  });

  describe('instructions (spec 2026-09-30 §5 "Prompts")', () => {
    const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
    const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');
    const coord = loadCoordinatorBlock({
      readFile: (p) => readFileSync(p, 'utf8'),
      path: new URL('../BRIDGE_COORDINATOR.md', import.meta.url).pathname,
      dir: new URL('../coordinator', import.meta.url).pathname,
      readDir: (d) => readdirSync(d),
    });
    const DEFINITION = 'A Project is the user\'s tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`.';

    it('both session prompts define a Project once and teach filing with project_list first', () => {
      for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
        const section = md.slice(md.indexOf('## Missions & milestones'));
        expect(section, name).toContain(DEFINITION);
        expect(section.split(DEFINITION).length - 1, name).toBe(1);
        expect(section, name).toContain('When you start a mission, run `project_list` and file it into the project it belongs to');
        expect(section, name).toContain('the mission gets a project of its own with the same name');
        expect(section, name).toContain('it can never be taken out of one');
      }
    });

    it('both session prompts teach join-not-refusal, leave, and naming the mission on milestone_post', () => {
      for (const [name, md] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd]]) {
        const section = md.slice(md.indexOf('## Missions & milestones'));
        expect(section, name).toContain('A conversation can be on several missions; one is current.');
        expect(section, name).toContain('When you move on to new work, join it: `mission_join N`');
        expect(section, name).toContain('`mission_leave N` when you are done with a mission that goes on without you');
        expect(section, name).toContain('pass `mission: N` to `milestone_post` when you are on several');
        expect(section, name).not.toMatch(/already belongs to another mission/);
      }
    });

    it('Codex fallbacks: leave, conversation missions, named milestone, project filing, project routes', () => {
      const section = codexMd.slice(codexMd.indexOf('## Missions & milestones'));
      expect(section).toContain('`mission_leave`');
      expect(section).toContain('`project_list`, `project_get`, `project_create`, `project_update`, `project_status`');
      expect(section).toContain('`POST $BASE/missions/:num/leave` `{"convo_id":"<id>"}`');
      expect(section).toContain('`GET $BASE/conversations/<id>/missions`');
      expect(section).toContain('409 `not_linked`');
      expect(section).toContain('`{"project":"#P"}`');
      expect(section).toContain('`GET $BASE/projects?state=open`');
      expect(section).toContain('`POST $BASE/projects` `{"title":"...","body":"...","convo_id":"<id>"}`');
      expect(section).toContain('`PATCH $BASE/projects/:num`');
    });

    it('the Coordinator brief: definition, project sweep, merges reported, ONE filing question, never without the answer', () => {
      expect(coord).toContain('## Procedure: file projects');
      expect(coord).toContain(DEFINITION);
      expect(coord).toContain('After the missions, refresh the projects: `project_list`, then for each open project `project_get N` and `project_status` with `num: N`');
      expect(coord).toContain('`project_merge` with `num` the one to fold away and `into` the one to keep');
      expect(coord).toContain('Report each merge in your reply: `Merged #A title into #B title — why`.');
      expect(coord).toContain('Then file ONE question (`item_create`, `kind: "question"`) proposing which one-mission projects (a mission in a project of its own, made because none was named) belong in a bigger project, and which quiet missions to close.');
      expect(coord).toContain('Never move a mission between projects, fold a one-mission project into another, or close a mission without the user\'s answer.');
      expect(coord).toContain('`project_merge` to fold a one-mission project into the bigger one (or `mission_update` with `mission: N` and `project: P` to move one mission)');
      expect(coord).toMatch(/`project_list` for every open project/);
    });
  });
});
