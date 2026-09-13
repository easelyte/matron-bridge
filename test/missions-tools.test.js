import { describe, it, expect, vi } from 'vitest';
import { createMissionsHandlers } from '../lib/missions-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const mission = { id: 'ms_1', num: 61, title: 'M', origin_convo_id: 'c1', state: 'open' };
  const client = {
    start: vi.fn(async () => ({ status: 201, data: { mission } })),
    list: vi.fn(async () => ({ status: 200, data: { missions: [] } })),
    get: vi.fn(async () => ({ status: 200, data: { mission, milestones: [], items: [], conversations: [{ id: 'c1' }] } })),
    update: vi.fn(async () => ({ status: 200, data: { mission } })),
    join: vi.fn(async () => ({ status: 200, data: { mission } })),
    close: vi.fn(async () => ({ status: 200, data: { mission: { ...mission, state: 'closed' } } })),
    postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { id: 'ml_1', num: 63 }, mission } })),
    listMilestones: vi.fn(async () => ({ status: 200, data: { milestones: [] } })),
    ...clientOverrides,
  };
  const h = createMissionsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client });
  return { h, client, session, mission };
}

describe('missions handlers', () => {
  it('start: validates title/body, fills convo_id, passes idem key, caches the mission on the session', async () => {
    const { h, client, session } = fixture();
    const emptyTitle = await h.start({ roomId: '!r:s', title: '' });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body.error).toBe('title must be a non-empty string of at most 200 characters');
    expect((await h.start({ roomId: '!r:s', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await h.start({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.start({ roomId: '!r:s', title: ' M ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.start.mock.calls[0]).toEqual([{ title: 'M', body: 'goal', convo_id: 'c1' }, { idemKey: 'k' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.get({})).status).toBe(400);
    expect((await h.get({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.get({ roomId: '!r:s' })).status).toBe(409);
  });

  it('post: validates kind and title; passes convo_id; 409 bodies pass through; status 0 → 502', async () => {
    const { h, client } = fixture();
    expect((await h.post({ roomId: '!r:s', kind: 'nope', title: 't' })).status).toBe(400);
    expect((await h.post({ roomId: '!r:s', kind: 'progress', title: '' })).status).toBe(400);
    const r = await h.post({ roomId: '!r:s', kind: 'user_input', title: 'Dan asked', body: 'b', idem_key: 'm' });
    expect(r.status).toBe(201);
    expect(client.postMilestone.mock.calls[0]).toEqual([{ convo_id: 'c1', kind: 'user_input', title: 'Dan asked', body: 'b' }, { idemKey: 'm' }]);
    const blocked = fixture({ postMilestone: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'no_mission' } })) });
    const b = await blocked.h.post({ roomId: '!r:s', kind: 'progress', title: 't' });
    expect(b.status).toBe(409); expect(b.body.blocked_by).toBe('no_mission');
    const down = fixture({ postMilestone: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.post({ roomId: '!r:s', kind: 'progress', title: 't' })).status).toBe(502);
  });

  it('get: explicit num goes straight through; no num resolves the conversation mission from GET /missions and caches it', async () => {
    const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [{ ...mission, id: 'ms_9', num: 9 }] } })) });
    await h.get({ roomId: '!r:s', num: 5 });
    expect(client.get.mock.calls[0][0]).toBe(5);
    client.get.mockResolvedValueOnce({ status: 200, data: { mission: { id: 'ms_9', num: 9 }, milestones: [], items: [], conversations: [{ id: 'c1' }] } });
    const r = await h.get({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(session.missionId).toBe('ms_9');
  });

  it('get / update / close with no resolvable mission answer 404 with a helpful error', async () => {
    const { h, client } = fixture();
    const r = await h.update({ roomId: '!r:s', title: 'x' });
    expect(r.status).toBe(404); expect(r.body.error).toMatch(/no mission/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('update: requires title or body; close: requires summary; join: requires num — each uses the resolved/explicit mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    expect((await h.update({ roomId: '!r:s' })).status).toBe(400);
    const emptyTitle = await h.update({ roomId: '!r:s', title: '' });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body.error).toBe('title must be a non-empty string of at most 200 characters');
    expect((await h.update({ roomId: '!r:s', title: 'New' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { title: 'New' }]);
    expect((await h.close({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.close({ roomId: '!r:s', summary: 'done' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['ms_1', { summary: 'done' }]);
    expect((await h.join({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.join({ roomId: '!r:s', num: 61 })).status).toBe(200);
    expect(client.join.mock.calls[0]).toEqual([61, { convo_id: 'c1' }]);
  });

  it('close 409 carries blocked_by and the items list unchanged', async () => {
    const { h, session } = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] } })) });
    session.missionId = 'ms_1';
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409); expect(r.body.items).toEqual([{ num: 64, title: 'Q?' }]);
  });

  it('get: explicit num 404 passes through the journal error, not the NO_ROUTES sentence', async () => {
    const { h } = fixture({ get: vi.fn(async () => ({ status: 404, data: { error: 'no such mission' } })) });
    const r = await h.get({ roomId: '!r:s', num: 999 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'no such mission' });
  });

  it('update: a 404 for the cached mission id clears the cache so the next call re-resolves cold', async () => {
    const otherMission = { id: 'ms_9', num: 9, title: 'M', origin_convo_id: 'c1', state: 'open' };
    const { h, client, session } = fixture({
      update: vi.fn()
        .mockResolvedValueOnce({ status: 404, data: { error: 'no such mission' } })
        .mockResolvedValueOnce({ status: 200, data: { mission: otherMission } }),
      list: vi.fn(async () => ({ status: 200, data: { missions: [otherMission] } })),
    });
    session.missionId = 'ms_1';
    const r1 = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r1.status).toBe(404);
    expect(session.missionId).toBeUndefined();
    expect(client.list).not.toHaveBeenCalled();
    const r2 = await h.update({ roomId: '!r:s', title: 'New2' });
    expect(r2.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.update.mock.calls[1][0]).toBe('ms_9');
    expect(session.missionId).toBe('ms_9');
  });

  it('close: a 409 (closed / other_mission) for the cached id does not clear the cache — the mission still exists', async () => {
    const { h, session } = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })) });
    session.missionId = 'ms_1';
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409);
    expect(session.missionId).toBe('ms_1');
  });

  it('status 0 (journal unreachable) becomes 502 for start, update, join, get and close', async () => {
    const down = { status: 0, data: { error: 'journal unreachable' } };

    const { h: h1 } = fixture({ start: vi.fn(async () => down) });
    expect((await h1.start({ roomId: '!r:s', title: 't' })).status).toBe(502);

    const { h: h2, session: s2 } = fixture({ update: vi.fn(async () => down) });
    s2.missionId = 'ms_1';
    expect((await h2.update({ roomId: '!r:s', title: 't' })).status).toBe(502);

    const { h: h3 } = fixture({ join: vi.fn(async () => down) });
    expect((await h3.join({ roomId: '!r:s', num: 61 })).status).toBe(502);

    const { h: h4, session: s4 } = fixture({ get: vi.fn(async () => down) });
    s4.missionId = 'ms_1';
    expect((await h4.get({ roomId: '!r:s' })).status).toBe(502);
    const { h: h4b } = fixture({ get: vi.fn(async () => down) });
    expect((await h4b.get({ roomId: '!r:s', num: 5 })).status).toBe(502);

    const { h: h5, session: s5 } = fixture({ close: vi.fn(async () => down) });
    s5.missionId = 'ms_1';
    expect((await h5.close({ roomId: '!r:s', summary: 's' })).status).toBe(502);
  });

  it('cold resolve lists missions in EVERY state and finds a CLOSED one by origin', async () => {
    // After a bridge restart, a conversation whose mission is closed must
    // still resolve to it — otherwise the model is told "call mission_start",
    // POST /missions answers 200 existing:true with that same closed mission,
    // and the loop never ends. Resolving it lets the journal say 409 closed.
    const closed = { id: 'ms_c', num: 6, title: 'Done', origin_convo_id: 'c1', state: 'closed' };
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions: [closed] } })),
      update: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })),
    });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.list.mock.calls[0][0]?.state).toBeUndefined();
    expect(session.missionId).toBe('ms_c');
    expect(r.status).toBe(409);
    expect(r.body.blocked_by).toBe('closed');
  });

  it('cold resolve finds a CLOSED mission this conversation merely JOINED, and caches it', async () => {
    const closed = { id: 'ms_c', num: 6, title: 'Done', origin_convo_id: 'cOther', state: 'closed' };
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions: [closed] } })),
      get: vi.fn(async () => ({ status: 200, data: { mission: closed, milestones: [], items: [], conversations: [{ id: 'cOther' }, { id: 'c1' }] } })),
      close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })),
    });
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409);
    expect(client.get.mock.calls[0][0]).toBe('ms_c');
    expect(session.missionId).toBe('ms_c');
    // Cached: a second call re-uses it without scanning again.
    await h.close({ roomId: '!r:s', summary: 's' });
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('cold resolve picks the ONE matching mission out of several and stops scanning there', async () => {
    const missions = [
      { id: 'ms_a', num: 1, origin_convo_id: 'cA', state: 'open' },
      { id: 'ms_b', num: 2, origin_convo_id: 'cB', state: 'closed' },
      { id: 'ms_c', num: 3, origin_convo_id: 'cC', state: 'open' },
    ];
    const detail = (id, convos) => ({ status: 200, data: { mission: { id }, milestones: [], items: [], conversations: convos } });
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions } })),
      get: vi.fn(async (id) => detail(id, id === 'ms_b' ? [{ id: 'cB' }, { id: 'c1' }] : [{ id: `c${id.slice(-1).toUpperCase()}` }])),
    });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r.status).toBe(200);
    expect(session.missionId).toBe('ms_b');
    expect(client.update.mock.calls[0][0]).toBe('ms_b');
    // ms_a then ms_b — the scan stops on the match, never reaching ms_c.
    expect(client.get.mock.calls.map((c) => c[0])).toEqual(['ms_a', 'ms_b']);
  });

  it('cold resolve against an unreachable or failing journal reports the outage, never "no mission"', async () => {
    for (const listResult of [{ status: 0, data: { error: 'journal unreachable' } }, { status: 500, data: { error: 'boom' } }]) {
      const { h, client, session } = fixture({ list: vi.fn(async () => listResult) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(listResult.status === 0 ? 502 : 500);
      expect(r.body.error).not.toContain('mission_start');
      expect(session.missionId).toBeUndefined();
      expect(client.update).not.toHaveBeenCalled();
    }
  });

  it('cold resolve treats a 200 with an unreadable list as a 502, never as a mission', async () => {
    for (const body of [{}, { missions: null }, { missions: 'nope' }]) {
      const { h, client, session } = fixture({ list: vi.fn(async () => ({ status: 200, data: body })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe('the journal returned an unreadable mission list');
      expect(session.missionId).toBeUndefined();
      expect(client.update).not.toHaveBeenCalled();
    }
  });

  it('start / post 404 says the conversation was refused, NOT that the routes are missing', async () => {
    const notFound = { status: 404, data: { error: 'not_found' } };
    const convoText = 'the journal did not accept this conversation — it may have no journal row yet, or its mission is not visible to this session';

    const { h: h1 } = fixture({ start: vi.fn(async () => notFound) });
    const r1 = await h1.start({ roomId: '!r:s', title: 'M' });
    expect(r1.status).toBe(404);
    expect(r1.body.error).toBe(convoText);

    const { h: h2 } = fixture({ postMilestone: vi.fn(async () => notFound) });
    const r2 = await h2.post({ roomId: '!r:s', kind: 'progress', title: 't' });
    expect(r2.status).toBe(404);
    expect(r2.body.error).toBe(convoText);
  });

  it('the NO_ROUTES sentence is reserved for a 404 from GET /missions, the collection route', async () => {
    const { h } = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/does not have the \/missions routes yet/);
  });
});
