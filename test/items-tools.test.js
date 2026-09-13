import { describe, it, expect, vi } from 'vitest';
import { createItemsHandlers } from '../lib/items-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const client = {
    create: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_1', num: 1 } } })),
    list: vi.fn(async () => ({ status: 200, data: { items: [], next_cursor: null } })),
    get: vi.fn(async () => ({ status: 200, data: { item: { id: 'it_1' }, comments: [] } })),
    comment: vi.fn(async () => ({ status: 201, data: { item: {}, comment: { id: 'ic_1' } } })),
    close: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    reopen: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    rank: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    update: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    ...clientOverrides,
  };
  const uploadLocalFile = vi.fn(async (_s, p) => p.endsWith('.png')
    ? { ok: true, media: { blob_ref: 'b-' + p, mime: 'image/png', name: p, size: 3, isImage: true } }
    : { ok: false, status: 404, body: { error: `file not found: ${p}` } });
  const h = createItemsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, uploadLocalFile });
  return { h, client, session, uploadLocalFile };
}

describe('items handlers', () => {
  it('create: uploads local attachments, fills convo_id, passes the body through', async () => {
    const { h, client } = fixture();
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Which?', body: 'A or B', attachments: ['shot.png'], labels: ['ui'] });
    expect(r.status).toBe(201);
    expect(r.body.item.num).toBe(1);
    expect(client.create.mock.calls[0][0]).toMatchObject({
      kind: 'question', title: 'Which?', body: 'A or B', convo_id: 'c1', labels: ['ui'],
      attachments: [{ blob_ref: 'b-shot.png', mime: 'image/png', name: 'shot.png', size: 3 }],
    });
  });

  it('create: a failed upload aborts with that status and never calls the journal', async () => {
    const { h, client } = fixture();
    const r = await h.create({ roomId: '!r:s', kind: 'task', title: 'T', attachments: ['nope.txt'] });
    expect(r.status).toBe(404);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('create: validates kind and title', async () => {
    const { h } = fixture();
    expect((await h.create({ roomId: '!r:s', kind: 'bug', title: 'T' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'task', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'task', title: 'x'.repeat(201) })).status).toBe(400);
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('list: scope convo filters by the session convo; scope all does not; state any drops the filter', async () => {
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s' });
    expect(client.list.mock.calls[0][0]).toMatchObject({ convo: 'c1', state: 'open', sort: 'rank' });
    await h.list({ roomId: '!r:s', scope: 'all', state: 'any', awaiting: 'user' });
    expect(client.list.mock.calls[1][0].convo).toBeUndefined();
    expect(client.list.mock.calls[1][0].state).toBeUndefined();
    expect(client.list.mock.calls[1][0].awaiting).toBe('user');
    expect((await h.list({ roomId: '!r:s', scope: 'mine' })).status).toBe(400);
  });

  it('list: since sorts by recency, otherwise by the backlog rank', async () => {
    // `rank` is the order the user dragged the backlog into — the answer to
    // "what next". `since` asks a different question ("what changed while I
    // was away"), which rank would answer oldest-untouched-first.
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s', since: 1725800000000 });
    expect(client.list.mock.calls[0][0]).toMatchObject({ since: 1725800000000, sort: 'updated' });
    await h.list({ roomId: '!r:s' });
    expect(client.list.mock.calls[1][0].sort).toBe('rank');
  });

  it('list: rejects an over-long or non-string label with a 400 naming the field', async () => {
    const { h, client } = fixture();
    const r = await h.list({ roomId: '!r:s', label: 'x'.repeat(41) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/label/);
    expect((await h.list({ roomId: '!r:s', label: 7 })).status).toBe(400);
    expect(client.list).not.toHaveBeenCalled();
    expect((await h.list({ roomId: '!r:s', label: 'x'.repeat(40) })).status).toBe(200);
  });

  it('list / create: a 404 means the journal has no /items routes, and says which upgrade is missing', async () => {
    // Neither route has an item id in its path, so a 404 cannot be "no such
    // item" — a bare "not found" would read to the model as an empty backlog.
    const { h } = fixture({
      list: vi.fn(async () => ({ status: 404, data: { error: 'Not Found' } })),
      create: vi.fn(async () => ({ status: 404, data: { error: 'Not Found' } })),
    });
    for (const r of [
      await h.list({ roomId: '!r:s' }),
      await h.create({ roomId: '!r:s', kind: 'task', title: 'T' }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/does not have the \/items routes yet/);
      expect(r.body.error).toMatch(/matron-journal PR #73/);
    }
    // An item-addressed 404 still means "no such item" — untouched.
    const { h: h2 } = fixture({ get: vi.fn(async () => ({ status: 404, data: { error: 'no such item' } })) });
    expect((await h2.get({ roomId: '!r:s', id: 'it_9' })).body.error).toBe('no such item');
  });

  it('list: passes through cursor', async () => {
    const { h, client } = fixture();
    await h.list({ roomId: '!r:s', cursor: 'cur_1', limit: 10 });
    expect(client.list.mock.calls[0][0]).toMatchObject({ cursor: 'cur_1', limit: 10 });
  });

  it('get / close / reopen / reorder pass through; journal status 0 becomes 502', async () => {
    const { h, client } = fixture({ get: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect(await h.get({ roomId: '!r:s', id: '#3' })).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    expect((await h.close({ roomId: '!r:s', id: 'it_1', resolution: 'done', comment: 'shipped' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['it_1', { resolution: 'done', comment: 'shipped' }]);
    expect((await h.close({ roomId: '!r:s', id: 'it_1', resolution: 'meh' })).status).toBe(400);
    expect((await h.reopen({ roomId: '!r:s', id: 'it_1' })).status).toBe(200);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1', position: 'top' })).status).toBe(200);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
  });

  it('reorder: requires exactly one of position/after/before', async () => {
    const { h, client } = fixture();
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1', after: 'it_2' })).status).toBe(200);
    expect(client.rank.mock.calls[0]).toEqual(['it_1', { after: 'it_2' }]);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1', before: 'it_3' })).status).toBe(200);
    const r = await h.reorder({ roomId: '!r:s', id: 'it_1', position: 'top', after: 'it_2' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/position|after|before/);
    expect((await h.reorder({ roomId: '!r:s', id: 'it_1', position: 'sideways' })).status).toBe(400);
  });

  it('comment: requires body or attachments; uploads attachments', async () => {
    const { h, client } = fixture();
    expect((await h.comment({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', attachments: ['a.png'] });
    expect(r.status).toBe(201);
    expect(client.comment.mock.calls[0][1].attachments[0].blob_ref).toBe('b-a.png');
  });

  it('comment: awaiting sets item state via update after a successful comment', async () => {
    const { h, client } = fixture();
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'agent' });
    expect(r.status).toBe(201);
    expect(client.update.mock.calls[0]).toEqual(['it_1', { awaiting: 'agent' }]);
  });

  it('comment: awaiting null clears the awaiting state', async () => {
    const { h, client } = fixture();
    await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: null });
    expect(client.update.mock.calls[0]).toEqual(['it_1', { awaiting: null }]);
  });

  it('comment: invalid awaiting is a 400 naming the field, without calling comment or update', async () => {
    const { h, client } = fixture();
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'nobody' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/awaiting/);
    expect(client.comment).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it('comment: awaiting update failure does not fail the comment, but reports awaiting_error', async () => {
    const { h } = fixture({ update: vi.fn(async () => ({ status: 409, data: { error: 'conflict' } })) });
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'user' });
    expect(r.status).toBe(201);
    expect(r.body.comment.id).toBe('ic_1');
    expect(r.body.awaiting_error).toBe('conflict');
  });

  it('comment: awaiting_error is never undefined, whatever the journal answered', async () => {
    // formatCommentAck reports the key's PRESENCE as a failure, so an
    // error-less body must still name what went wrong.
    const { h } = fixture({ update: vi.fn(async () => ({ status: 500, data: {} })) });
    expect((await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'user' })).body.awaiting_error)
      .toBe('HTTP 500');
    // A 2xx this handler does not accept as success is still a failure — and
    // still names itself rather than reading as "unknown error".
    const { h: h2 } = fixture({ update: vi.fn(async () => ({ status: 202, data: {} })) });
    expect((await h2.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'user' })).body.awaiting_error)
      .toBe('HTTP 202');
    const { h: h3 } = fixture({ update: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await h3.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'user' })).body.awaiting_error)
      .toBe('journal unreachable');
  });

  it('comment: does not call update when awaiting is not provided', async () => {
    const { h, client } = fixture();
    await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok' });
    expect(client.update).not.toHaveBeenCalled();
  });

  it('comment: does not call update when the comment itself fails', async () => {
    const { h, client } = fixture({ comment: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'ok', awaiting: 'user' });
    expect(r.status).toBe(404);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('move: sets or clears the item mission through PATCH; validates the target', async () => {
    const { h, client } = fixture();
    expect((await h.move({ roomId: '!r:s', id: 'it_1' })).status).toBe(400);
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: 'sixty' })).status).toBe(400);
    for (const bad of [0, -1, 61.5, '#0', '#007', '#abc', '', undefined]) {
      expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: bad })).status, `mission ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(client.update).not.toHaveBeenCalled();
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: 61 })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['it_1', { mission: '#61' }]);
    expect((await h.move({ roomId: '!r:s', id: '#4', mission: '#62' })).status).toBe(200);
    expect(client.update.mock.calls[1]).toEqual(['#4', { mission: '#62' }]);
    expect((await h.move({ roomId: '!r:s', id: 'it_1', mission: null })).status).toBe(200);
    expect(client.update.mock.calls[2]).toEqual(['it_1', { mission: null }]);
  });
});
