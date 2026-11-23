import { describe, it, expect, vi } from 'vitest';
import { createMemoryHandlers } from '../lib/memory-tools.js';

const mem = { id: 'me_1', name: 'avoid-box-a', description: 'Never use box-a.', type: 'feedback' };
const coordMem = { id: 'me_2', name: 'compact-at-40', description: 'Compact at 40%.', type: 'feedback', scope: 'coordinator' };
const appMem = { id: 'me_3', name: 'merge-train', description: 'The train merges.', type: 'project', scope: 'repo:acme-app' };
const infraMem = { id: 'me_4', name: 'infra-rule', description: 'Infra.', type: 'project', scope: 'repo:acme-infra' };

function fixture(clientOverrides = {}, { isCoordinator, repoFor } = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session], ['!noconvo', { roomId: '!noconvo' }]]);
  const client = {
    save: vi.fn(async () => ({ status: 201, data: { memory: mem } })),
    list: vi.fn(async () => ({ status: 200, data: { memories: [mem] } })),
    get: vi.fn(async () => ({ status: 200, data: { memory: mem } })),
    remove: vi.fn(async () => ({ status: 200, data: { memory: mem } })),
    ...clientOverrides,
  };
  const h = createMemoryHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, isCoordinator, repoFor });
  return { h, client, session };
}
const fourList = () => vi.fn(async () => ({ status: 200, data: { memories: [mem, coordMem, appMem, infraMem] } }));

describe('memory handlers', () => {
  it('save: fills convo_id, trims the description, passes body and type, reports created', async () => {
    const { h, client } = fixture();
    const r = await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: '  Never use box-a.  ', body: 'why', type: 'user' });
    expect(r).toEqual({ status: 201, body: { memory: mem, created: true } });
    expect(client.save.mock.calls[0]).toEqual(['avoid-box-a', { description: 'Never use box-a.', body: 'why', type: 'user', convo_id: 'c1' }]);
  });

  it('save: an update is 200 with created:false; body and type omitted stay omitted', async () => {
    const { h, client } = fixture({ save: vi.fn(async () => ({ status: 200, data: { memory: mem } })) });
    const r = await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' });
    expect(r).toEqual({ status: 200, body: { memory: mem, created: false } });
    expect(client.save.mock.calls[0][1]).toEqual({ description: 'd', convo_id: 'c1' });
  });

  it('save: bad fields are 400 with the reason and never reach the journal', async () => {
    const { h, client } = fixture();
    const cases = [
      [{ name: 'Bad Name', description: 'd' }, /kebab-case/],
      [{ name: 'ok', description: 'a\nb' }, /one non-empty line/],
      [{ name: 'ok', description: 'a\u2028b' }, /one non-empty line/],
      [{ name: 'ok', description: '   ' }, /one non-empty line/],
      [{ name: 'ok', description: 'a'.repeat(201) }, /200 characters/],
      [{ name: 'ok', description: 'd', body: 'é'.repeat(4096) + 'a' }, /8192 bytes/],
      [{ name: 'ok', description: 'd', body: 42 }, /8192 bytes/],
      [{ name: 'ok', description: 'd', type: 'rule' }, /type must be one of/],
      [{ name: 'ok', description: 'd', scope: 'team:ops' }, /scope must be global, coordinator, or repo:<name>/],
      [{ name: 'ok', description: 'd', scope: 'repo:a/b' }, /scope must be/],
      [{ name: 'ok', description: 'd', scope: '' }, /scope must be/],
      [{ name: 'ok' }, /one non-empty line/],
    ];
    for (const [args, re] of cases) {
      const r = await h.save({ roomId: '!r:s', ...args });
      expect(r.status, JSON.stringify(args)).toBe(400);
      expect(r.body.error).toMatch(re);
    }
    expect(client.save).not.toHaveBeenCalled();
    expect((await h.save({ roomId: '!r:s', name: 'ok', description: 'd', body: 'é'.repeat(4096) })).status).toBe(201);
  });

  it('save: journal 409 → the max-200 message; status 0 → 502; 404 → refused (routes or not writable)', async () => {
    expect(await fixture({ save: vi.fn(async () => ({ status: 409, data: { error: 'too_many' } })) }).h.save({ roomId: '!r:s', name: 'x', description: 'd' }))
      .toEqual({ status: 409, body: { error: 'the journal holds the maximum of 400 memories — delete one first' } });
    expect(await fixture({ save: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) }).h.save({ roomId: '!r:s', name: 'x', description: 'd' }))
      .toEqual({ status: 502, body: { error: 'journal unreachable' } });
    const refused = await fixture({ save: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) }).h.save({ roomId: '!r:s', name: 'x', description: 'd' });
    expect(refused.status).toBe(404);
    // An upsert cannot 404 on the name: say routes-not-deployed / not writable, never "no memory named".
    expect(refused.body.error).toMatch(/does not have the \/memories routes yet.*PR #94/);
    expect(refused.body.error).toMatch(/not writable by this session/);
    expect(refused.body.error).not.toMatch(/no memory named/);
  });

  it('save: passes a valid scope through to the journal', async () => {
    const { h, client } = fixture();
    await h.save({ roomId: '!r:s', name: 'merge-train', description: 'd', scope: 'repo:acme-app' });
    expect(client.save.mock.calls[0][1]).toEqual({ description: 'd', scope: 'repo:acme-app', convo_id: 'c1' });
  });

  it('list: an ordinary session gets the global memories and its repo\'s, told what was left out; a 404 names the missing deploy', async () => {
    const { h, client } = fixture({ list: fourList() }, { repoFor: (s) => (s.workdir === '/w' ? 'acme-app' : null) });
    expect(await h.list({ roomId: '!r:s' })).toEqual({ status: 200, body: { memories: [mem, appMem], scopes: ['global', 'repo:acme-app'], omitted: 2, omitted_scopes: ['coordinator', 'repo:acme-infra'] } });
    expect(client.list).toHaveBeenCalledTimes(1);
    const noRepo = fixture({ list: fourList() });
    expect((await noRepo.h.list({ roomId: '!r:s' })).body).toEqual({ memories: [mem], scopes: ['global'], omitted: 3, omitted_scopes: ['coordinator', 'repo:acme-app', 'repo:acme-infra'] });
    const r = await fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) }).h.list({ roomId: '!r:s' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/does not have the \/memories routes yet.*PR #94/);
  });

  it('list: all: true, or the Coordinator, gets every memory; a non-boolean all is 400', async () => {
    const every = { memories: [mem, coordMem, appMem, infraMem], scopes: null, omitted: 0, omitted_scopes: [] };
    expect((await fixture({ list: fourList() }).h.list({ roomId: '!r:s', all: true })).body).toEqual(every);
    const coord = fixture({ list: fourList() }, { isCoordinator: (s, convoId) => s.roomId === '!r:s' && convoId === 'c1' });
    expect((await coord.h.list({ roomId: '!r:s' })).body).toEqual(every);
    const r = await fixture({ list: fourList() }).h.list({ roomId: '!r:s', all: 'yes' });
    expect(r).toEqual({ status: 400, body: { error: 'all must be true or false' } });
  });

  it('get and delete: by name, 404 → no memory named, bad name → 400', async () => {
    const { h, client } = fixture();
    expect(await h.get({ roomId: '!r:s', name: 'avoid-box-a' })).toEqual({ status: 200, body: { memory: mem } });
    expect(client.get.mock.calls[0]).toEqual(['avoid-box-a']);
    expect(await h.delete({ roomId: '!r:s', name: 'avoid-box-a' })).toEqual({ status: 200, body: { memory: mem } });
    expect(client.remove.mock.calls[0]).toEqual(['avoid-box-a', { convo_id: 'c1' }]);
    expect((await h.get({ roomId: '!r:s', name: 'Nope!' })).status).toBe(400);
    const r = await fixture({ remove: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) }).h.delete({ roomId: '!r:s', name: 'gone' });
    expect(r).toEqual({ status: 404, body: { error: 'no memory named "gone"' } });
  });

  it('caller session: missing roomId 400, unknown room 404, no convo yet 409', async () => {
    const { h, client } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!nope' })).status).toBe(404);
    expect((await h.list({ roomId: '!noconvo' })).status).toBe(409);
    expect(client.list).not.toHaveBeenCalled();
  });

  it('save and delete send the causes of the turn making the call, with the conversation', async () => {
    const { h, client, session } = fixture();
    const causes = [{ kind: 'user_message', ref: 'c1:7', at: 1 }];
    session.currentTurn = { causes };
    await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' });
    expect(client.save.mock.calls[0]).toEqual(['avoid-box-a', { description: 'd', convo_id: 'c1', causes }]);
    await h.delete({ roomId: '!r:s', name: 'avoid-box-a' });
    expect(client.remove.mock.calls[0]).toEqual(['avoid-box-a', { convo_id: 'c1', causes }]);
    // A turn with no recorded cause sends none: the journal then asks the user.
    session.currentTurn = null;
    await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' });
    expect(client.save.mock.calls[1][1]).toEqual({ description: 'd', convo_id: 'c1' });
    // causes are the bridge's to send, never the caller's.
    await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd', causes: [{ kind: 'user_message', ref: 'c1:1' }] });
    expect(client.save.mock.calls[2][1]).toEqual({ description: 'd', convo_id: 'c1' });
  });

  it('a 202 from the journal is a proposal: pending, with the item the user was asked on', async () => {
    const pending = (action) => vi.fn(async () => ({ status: 202, data: { pending: 'owner', proposal: { id: 'mp_1', name: 'avoid-box-a', action, state: 'pending' }, item: { id: 'it_9', num: 41 } } }));
    const { h } = fixture({ save: pending('save'), remove: pending('delete') });
    expect(await h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' }))
      .toEqual({ status: 202, body: { pending: true, action: 'save', name: 'avoid-box-a', item_num: 41, item_id: 'it_9' } });
    expect(await h.delete({ roomId: '!r:s', name: 'avoid-box-a' }))
      .toEqual({ status: 202, body: { pending: true, action: 'delete', name: 'avoid-box-a', item_num: 41, item_id: 'it_9' } });
    // At the journal's cap on waiting proposals: said as that, not as the memory cap.
    const capped = fixture({ save: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'too_many_asks' } })) });
    const refused = await capped.h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/too many memory proposals/);
    // A 202 with no usable item still reads as pending.
    const bare = fixture({ save: vi.fn(async () => ({ status: 202, data: {} })) });
    expect((await bare.h.save({ roomId: '!r:s', name: 'avoid-box-a', description: 'd' })).body).toEqual({ pending: true, action: 'save', name: 'avoid-box-a', item_num: null, item_id: null });
  });

  it('save: tier and topic pass through, topic trimmed ("" or null clears); bad ones are 400', async () => {
    const { h, client } = fixture();
    await h.save({ roomId: '!r:s', name: 'ok', description: 'd', tier: 'on_demand', topic: '  couriers ' });
    expect(client.save.mock.calls[0][1]).toEqual({ description: 'd', tier: 'on_demand', topic: 'couriers', convo_id: 'c1' });
    await h.save({ roomId: '!r:s', name: 'ok', description: 'd', topic: null });
    expect(client.save.mock.calls[1][1].topic).toBe('');
    for (const [extra, re] of [[{ tier: 'sometimes' }, /tier must be one of always, on_demand/], [{ topic: 'a'.repeat(41) }, /topic must be one line/], [{ topic: 'a\nb' }, /topic must be one line/], [{ topic: 3 }, /topic must be one line/]]) {
      const r = await h.save({ roomId: '!r:s', name: 'ok', description: 'd', ...extra });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(re);
    }
    expect(client.save).toHaveBeenCalledTimes(2);
  });

  it('recall: the query in this session\'s scopes; the Coordinator in every scope; bad input is 400', async () => {
    const recall = vi.fn(async () => ({ status: 200, data: { memories: [mem], semantic: 'ready' } }));
    const { h } = fixture({ recall }, { repoFor: () => 'acme-app' });
    const r = await h.recall({ roomId: '!r:s', query: '  booking couriers ' });
    expect(r).toEqual({ status: 200, body: { memories: [mem], semantic: 'ready' } });
    expect(recall.mock.calls[0][0]).toEqual({ text: 'booking couriers', mode: 'query', limit: 5, scopes: ['global', 'repo:acme-app'] });
    const coord = fixture({ recall }, { isCoordinator: () => true });
    await coord.h.recall({ roomId: '!r:s', query: 'x', limit: 2 });
    expect(recall.mock.calls[1][0]).toEqual({ text: 'x', mode: 'query', limit: 2 });
    for (const bad of [{ query: '' }, { query: 3 }, { query: 'x'.repeat(1001) }, { query: 'x', limit: 11 }]) {
      expect((await h.recall({ roomId: '!r:s', ...bad })).status).toBe(400);
    }
    expect(recall).toHaveBeenCalledTimes(2);
    const old = fixture({ recall: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r404 = await old.h.recall({ roomId: '!r:s', query: 'x' });
    expect(r404.status).toBe(404);
    expect(r404.body.error).toMatch(/cannot recall memories yet.*memory_list and memory_get/);
  });

  it('recallTurn: on-demand, auto, short timeout; each memory given to a session once', async () => {
    const recall = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { memories: [{ ...mem, tier: 'on_demand' }] } })
      .mockResolvedValueOnce({ status: 200, data: { memories: [] } });
    const { h } = fixture({ recall }, { repoFor: () => 'acme-app' });
    const r = await h.recallTurn({ roomId: '!r:s', text: 'please book a courier for tomorrow' });
    expect(r.body.memories.map((m) => m.name)).toEqual(['avoid-box-a']);
    expect(recall.mock.calls[0][0]).toEqual({ text: 'please book a courier for tomorrow', mode: 'auto', tier: 'on_demand', limit: 3, exclude: [], scopes: ['global', 'repo:acme-app'] });
    expect(recall.mock.calls[0][1]).toEqual({ timeoutMs: 2500 });
    await h.recallTurn({ roomId: '!r:s', text: 'and another courier on friday' });
    expect(recall.mock.calls[1][0].exclude).toEqual(['avoid-box-a']);
  });

  it('recallTurn: nothing for short text, a turn another person started, or a journal failure — never an error', async () => {
    const recall = vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } }));
    const { h, session } = fixture({ recall });
    expect(await h.recallTurn({ roomId: '!r:s', text: 'ok go' })).toEqual({ status: 200, body: { memories: [] } });
    expect(recall).not.toHaveBeenCalled();
    expect(await h.recallTurn({ roomId: '!r:s', text: 'please book a courier for tomorrow' })).toEqual({ status: 200, body: { memories: [] } });
    session.foreignTurn = { by: 'bob' };
    recall.mockClear();
    expect(await h.recallTurn({ roomId: '!r:s', text: 'please book a courier for tomorrow' })).toEqual({ status: 200, body: { memories: [] } });
    expect(recall).not.toHaveBeenCalled();
    expect((await h.recallTurn({ roomId: '!nope', text: 'please book a courier' })).status).toBe(404);
  });
});
