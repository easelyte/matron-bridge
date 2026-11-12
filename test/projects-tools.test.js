import { describe, it, expect, vi } from 'vitest';
import { createProjectsHandlers } from '../lib/projects-tools.js';

function fixture(clientOverrides = {}, opts = {}) {
  const session = { roomId: '!r:s', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const project = { id: 'pj_1', num: 70, title: 'Promo launch', state: 'open' };
  const client = {
    list: vi.fn(async () => ({ status: 200, data: { projects: [project] } })),
    get: vi.fn(async () => ({ status: 200, data: { project, missions: [], needs_you: [], recent_milestones: [], sessions_by_box: {} } })),
    create: vi.fn(async () => ({ status: 201, data: { project } })),
    update: vi.fn(async () => ({ status: 200, data: { project } })),
    close: vi.fn(async () => ({ status: 200, data: { project: { ...project, state: 'closed' } } })),
    // R8 (2026-09-30 preflight): the journal's merge response is {project:
    // into (kept, with rollup), merged: this (now closed)} — data.project is
    // never the folded-away project. num: 70 (the base `project` fixture) is
    // the `into` target in every test below; num 71 is the one merged away.
    merge: vi.fn(async () => ({ status: 200, data: { project, merged: { ...project, id: 'pj_2', num: 71, state: 'closed', merged_into: 'pj_1' } } })),
    ...clientOverrides,
  };
  const missionsClient = {
    get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61, project_id: 'pj_1' }, milestones: [], items: [], conversations: [] } })),
    ...(opts.missionsClient || {}),
  };
  const resolveMission = opts.resolveMission || vi.fn(async () => ({ id: 'ms_1' }));
  const h = createProjectsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, missionsClient, resolveMission, ...(opts.isCoordinator ? { isCoordinator: opts.isCoordinator } : {}) });
  return { h, client, missionsClient, resolveMission, session, project };
}

describe('projects handlers', () => {
  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('list: open by default, closed on request, bad state 400; a 404 is the missing-routes sentence; 0 → 502', async () => {
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s' });
    await h.list({ roomId: '!r:s', state: 'closed' });
    expect(client.list.mock.calls).toEqual([[{ state: 'open' }], [{ state: 'closed' }]]);
    expect((await h.list({ roomId: '!r:s', state: 'all' })).status).toBe(400);
    const old = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r = await old.h.list({ roomId: '!r:s' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)');
    const down = fixture({ list: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  const rows = (count) => Array.from({ length: count }, (_, i) => ({
    id: `pj_${i + 1}`, num: i + 1, title: `Project ${i + 1}`, state: 'open', status: 'x'.repeat(300),
    // Every fourth project has nothing open.
    missions: { running: i % 4 === 0 ? 0 : 1, waiting: 0, idle: 0, quiet: 0, closed: 2 }, needs_you: 0, open_items: 1, last_activity_at: 1700000000000,
  }));
  const listing = (count) => fixture({ list: vi.fn(async () => ({ status: 200, data: { projects: rows(count) } })) });
  const nums = (r) => r.body.projects.map((p) => p.num);

  it('list: a long list comes back 60 at a time, with the total and the offset', async () => {
    const { h } = listing(400);
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(nums(r)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(r.body).toMatchObject({ total: 400, offset: 0, brief: false });
  });

  it('list: offset continues without repeating or skipping; limit sets the page', async () => {
    const { h } = listing(400);
    const seen = [];
    for (let offset = 0; offset < 400; offset += 60) seen.push(...nums(await h.list({ roomId: '!r:s', offset })));
    expect(seen).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
    expect(nums(await h.list({ roomId: '!r:s', offset: 10, limit: 3 }))).toEqual([11, 12, 13]);
    expect(nums(await h.list({ roomId: '!r:s', limit: 200 }))).toHaveLength(200);
    const past = await h.list({ roomId: '!r:s', offset: 400 });
    expect(past.body).toMatchObject({ projects: [], total: 400, offset: 400 });
  });

  it('list live: drops projects with no open mission, and pages what is left', async () => {
    const { h } = listing(400);
    const r = await h.list({ roomId: '!r:s', live: true });
    expect(r.body.total).toBe(300);
    expect(nums(r)).toHaveLength(60);
    expect(nums(r).every((n) => (n - 1) % 4 !== 0)).toBe(true);
    const next = await h.list({ roomId: '!r:s', live: true, offset: 60 });
    expect(nums(next)[0]).toBeGreaterThan(nums(r).at(-1));
    expect(new Set([...nums(r), ...nums(next)]).size).toBe(120);
    // A row with no mission counts (an older journal) is not known to be idle.
    const old = fixture({ list: vi.fn(async () => ({ status: 200, data: { projects: [{ num: 1, title: 'A' }, { num: 2, title: 'B', missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 1 } }] } })) });
    expect(nums(await old.h.list({ roomId: '!r:s', live: true }))).toEqual([1]);
  });

  it('list brief: 150 at a time, marked for the renderer', async () => {
    const { h } = listing(400);
    const r = await h.list({ roomId: '!r:s', brief: true });
    expect(nums(r)).toHaveLength(150);
    expect(r.body).toMatchObject({ total: 400, offset: 0, brief: true });
    expect(nums(await h.list({ roomId: '!r:s', brief: true, limit: 20 }))).toHaveLength(20);
  });

  it('list: a short list is passed through whole', async () => {
    const { h, project } = fixture();
    const r = await h.list({ roomId: '!r:s' });
    expect(r.body).toEqual({ projects: [project], total: 1, offset: 0, brief: false, live: false, state: 'open' });
  });

  it('list: the reply carries the filters of the call, for the closing line', async () => {
    const { h } = listing(400);
    expect((await h.list({ roomId: '!r:s', live: true, brief: true })).body).toMatchObject({ live: true, brief: true, state: 'open', offset: 0 });
    expect((await h.list({ roomId: '!r:s', live: true, brief: true })).body.limit).toBeUndefined();
    expect((await h.list({ roomId: '!r:s', state: 'closed', limit: 20 })).body).toMatchObject({ live: false, brief: false, state: 'closed', limit: 20 });
    // A limit that is the default anyway is not repeated.
    expect((await h.list({ roomId: '!r:s', limit: 60 })).body.limit).toBeUndefined();
    expect((await h.list({ roomId: '!r:s', brief: true, limit: 150 })).body.limit).toBeUndefined();
    expect((await h.list({ roomId: '!r:s', brief: true, limit: 60 })).body.limit).toBe(60);
    // A journal body cannot set them.
    const odd = fixture({ list: vi.fn(async () => ({ status: 200, data: { projects: rows(3), live: true, state: 'closed', limit: 9 } })) });
    const r = await odd.h.list({ roomId: '!r:s' });
    expect(r.body).toMatchObject({ live: false, state: 'open' });
    expect(r.body.limit).toBeUndefined();
  });

  it('list: closed projects have no open missions, so state closed with live is refused', async () => {
    const { h, client } = fixture();
    const r = await h.list({ roomId: '!r:s', state: 'closed', live: true });
    expect(r).toEqual({ status: 400, body: { error: 'live lists open projects with open missions — leave out state, or leave out live' } });
    expect(client.list).not.toHaveBeenCalled();
    expect((await h.list({ roomId: '!r:s', state: 'closed', live: false })).status).toBe(200);
    expect((await h.list({ roomId: '!r:s', state: 'open', live: true })).status).toBe(200);
  });

  it('list: bad live, brief, offset and limit are refused before any journal call', async () => {
    const { h, client } = fixture();
    for (const bad of [{ live: 'yes' }, { brief: 1 }, { offset: -1 }, { offset: 1.5 }, { offset: '3' }, { limit: 0 }, { limit: 201 }, { limit: 2.5 }]) {
      expect((await h.list({ roomId: '!r:s', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(client.list).not.toHaveBeenCalled();
  });

  it('get with num: straight through by number, no mission lookup', async () => {
    const { h, client, resolveMission } = fixture();
    expect((await h.get({ roomId: '!r:s', num: 0 })).status).toBe(400);
    const r = await h.get({ roomId: '!r:s', num: 70 });
    expect(r.status).toBe(200);
    expect(client.get.mock.calls[0]).toEqual([70]);
    expect(resolveMission).not.toHaveBeenCalled();
  });

  it("get with no num: the current mission's project, by id; the resolver is only read, never written", async () => {
    const { h, client, missionsClient, resolveMission, session } = fixture();
    const r = await h.get({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(resolveMission.mock.calls[0]).toEqual([session, 'c1']);
    expect(missionsClient.get.mock.calls[0]).toEqual(['ms_1']);
    expect(client.get.mock.calls[0]).toEqual(['pj_1']);
    expect(session.missionId).toBeUndefined();
  });

  it('get with no num: no mission, mission not filed, old journal, resolver outage, mission unreadable', async () => {
    const none = fixture({}, { resolveMission: vi.fn(async () => ({ id: null })) });
    const a = await none.h.get({ roomId: '!r:s' });
    expect(a.status).toBe(404);
    expect(a.body.error).toBe('this conversation has no current mission, so no project — pass num (project_list shows the projects)');
    const unfiled = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61, project_id: null } } })) } });
    const b = await unfiled.h.get({ roomId: '!r:s' });
    expect(b.status).toBe(404);
    expect(b.body.error).toBe("this conversation's mission #61 is not in a project — project_list shows the projects; file it with mission_update project: N");
    const old = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 } } })) } });
    expect((await old.h.get({ roomId: '!r:s' })).body.error).toMatch(/does not have the \/projects routes yet/);
    const outage = { status: 502, body: { error: 'journal unreachable' } };
    const down = fixture({}, { resolveMission: vi.fn(async () => ({ err: outage })) });
    expect(await down.h.get({ roomId: '!r:s' })).toEqual(outage);
    const gone = fixture({}, { missionsClient: { get: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) } });
    const g = await gone.h.get({ roomId: '!r:s' });
    expect(g.status).toBe(404);
    expect(g.body.error).toBe("this conversation's current mission could not be read — mission_get checks it, or pass num");
  });

  it('create: validates, trims, carries convo_id and the idem key; 404 names routes AND conversation', async () => {
    const { h, client } = fixture();
    expect((await h.create({ roomId: '!r:s', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.create({ roomId: '!r:s', title: ' Promo launch ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0]).toEqual([{ title: 'Promo launch', body: 'goal', convo_id: 'c1' }, { idemKey: 'k' }]);
    const old = fixture({ create: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await old.h.create({ roomId: '!r:s', title: 'P' })).body.error).toBe('the journal refused the project — this deployment may not have the /projects routes yet (deploy the journal projects update), or this conversation has no journal row yet or is not writable by this session');
  });

  it('update: num required, title or body required, carries convo_id; any agent', async () => {
    const { h, client } = fixture();
    expect((await h.update({ roomId: '!r:s', title: 'T' })).status).toBe(400);
    const empty = await h.update({ roomId: '!r:s', num: 70 });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('title or body is required');
    expect((await h.update({ roomId: '!r:s', num: 70, title: '' })).status).toBe(400);
    expect((await h.update({ roomId: '!r:s', num: 70, title: 'Promo', body: 'b' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual([70, { title: 'Promo', body: 'b', convo_id: 'c1' }]);
  });

  it('status: folds CRLF, trims, counts UTF-16 units to 600; PATCHes {status, convo_id}; any agent', async () => {
    const { h, client } = fixture();
    expect((await h.status({ roomId: '!r:s', status: 's' })).status).toBe(400); // no num
    expect((await h.status({ roomId: '!r:s', num: 70, status: '   ' })).status).toBe(400);
    expect((await h.status({ roomId: '!r:s', num: 70, status: '😀'.repeat(301) })).status).toBe(400);
    expect((await h.status({ roomId: '!r:s', num: 70, status: '😀'.repeat(300) })).status).toBe(200);
    await h.status({ roomId: '!r:s', num: 70, status: ' a\r\nb ' });
    expect(client.update.mock.calls[1]).toEqual([70, { status: 'a\nb', convo_id: 'c1' }]);
  });

  describe('close and merge (the Coordinator only)', () => {
    it('refuse a non-Coordinator before any journal call', async () => {
      const { h, client } = fixture();
      const c = await h.close({ roomId: '!r:s', num: 70, summary: 's' });
      expect(c.status).toBe(403);
      expect(c.body.error).toBe('only the Coordinator may call project_close — this conversation is not the Coordinator');
      const m = await h.merge({ roomId: '!r:s', num: 71, into: 70 });
      expect(m.status).toBe(403);
      expect(m.body.error).toBe('only the Coordinator may call project_merge — this conversation is not the Coordinator');
      expect(client.close).not.toHaveBeenCalled();
      expect(client.merge).not.toHaveBeenCalled();
    });

    it('the spawn-time flag or an injected isCoordinator (the journal\'s current role holder) lets it through', async () => {
      const flagged = fixture();
      flagged.session.coordinator = true;
      expect((await flagged.h.close({ roomId: '!r:s', num: 70, summary: 'done' })).status).toBe(200);
      expect(flagged.client.close.mock.calls[0]).toEqual([70, { summary: 'done', convo_id: 'c1' }]);
      const isCoordinator = vi.fn((session, convoId) => convoId === 'c1');
      const live = fixture({}, { isCoordinator });
      expect((await live.h.merge({ roomId: '!r:s', num: 71, into: 70 })).status).toBe(200);
      expect(isCoordinator.mock.calls[0]).toEqual([live.session, 'c1']);
      expect(live.client.merge.mock.calls[0]).toEqual([71, { into: 70, convo_id: 'c1' }]);
    });

    it('validation comes first: num, summary, into, and into ≠ num', async () => {
      const { h, client, session } = fixture();
      session.coordinator = true;
      expect((await h.close({ roomId: '!r:s', summary: 's' })).status).toBe(400);
      expect((await h.close({ roomId: '!r:s', num: 70, summary: '  ' })).status).toBe(400);
      expect((await h.merge({ roomId: '!r:s', num: 71 })).status).toBe(400);
      const self = await h.merge({ roomId: '!r:s', num: 70, into: 70 });
      expect(self.status).toBe(400);
      expect(self.body.error).toBe('into must be a different project from num');
      expect(client.merge).not.toHaveBeenCalled();
    });

    it('journal 403 not_coordinator (either field) is a sentence; 409 open_missions passes through; 0 → 502', async () => {
      for (const data of [{ error: 'forbidden', detail: 'not_coordinator' }, { error: 'not_coordinator' }]) {
        const refused = fixture({ merge: vi.fn(async () => ({ status: 403, data })) });
        refused.session.coordinator = true;
        const r = await refused.h.merge({ roomId: '!r:s', num: 71, into: 70 });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('the journal does not list this conversation as the Coordinator');
      }
      const blocked = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'open_missions' } })) });
      blocked.session.coordinator = true;
      const b = await blocked.h.close({ roomId: '!r:s', num: 70, summary: 's' });
      expect(b.status).toBe(409); expect(b.body.blocked_by).toBe('open_missions');
      const down = fixture({ close: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      down.session.coordinator = true;
      expect((await down.h.close({ roomId: '!r:s', num: 70, summary: 's' })).status).toBe(502);
    });
  });
});
