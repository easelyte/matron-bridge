import { describe, it, expect, vi } from 'vitest';
import { createMemoryHandlers } from '../lib/memory-tools.js';

const mem = { id: 'me_1', name: 'avoid-eric', description: 'Never use eric.', type: 'feedback' };

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session], ['!noconvo', { roomId: '!noconvo' }]]);
  const client = {
    save: vi.fn(async () => ({ status: 201, data: { memory: mem } })),
    list: vi.fn(async () => ({ status: 200, data: { memories: [mem] } })),
    get: vi.fn(async () => ({ status: 200, data: { memory: mem } })),
    remove: vi.fn(async () => ({ status: 200, data: { memory: mem } })),
    ...clientOverrides,
  };
  const h = createMemoryHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client });
  return { h, client };
}

describe('memory handlers', () => {
  it('save: fills convo_id, trims the description, passes body and type, reports created', async () => {
    const { h, client } = fixture();
    const r = await h.save({ roomId: '!r:s', name: 'avoid-eric', description: '  Never use eric.  ', body: 'why', type: 'user' });
    expect(r).toEqual({ status: 201, body: { memory: mem, created: true } });
    expect(client.save.mock.calls[0]).toEqual(['avoid-eric', { description: 'Never use eric.', body: 'why', type: 'user', convo_id: 'c1' }]);
  });

  it('save: an update is 200 with created:false; body and type omitted stay omitted', async () => {
    const { h, client } = fixture({ save: vi.fn(async () => ({ status: 200, data: { memory: mem } })) });
    const r = await h.save({ roomId: '!r:s', name: 'avoid-eric', description: 'd' });
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
      .toEqual({ status: 409, body: { error: 'the journal holds the maximum of 200 memories — delete one first' } });
    expect(await fixture({ save: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) }).h.save({ roomId: '!r:s', name: 'x', description: 'd' }))
      .toEqual({ status: 502, body: { error: 'journal unreachable' } });
    const refused = await fixture({ save: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) }).h.save({ roomId: '!r:s', name: 'x', description: 'd' });
    expect(refused.status).toBe(404);
    // An upsert cannot 404 on the name: say routes-not-deployed / not writable, never "no memory named".
    expect(refused.body.error).toMatch(/does not have the \/memories routes yet.*PR #94/);
    expect(refused.body.error).toMatch(/not writable by this session/);
    expect(refused.body.error).not.toMatch(/no memory named/);
  });

  it('list: passes the journal answer through; a 404 names the missing deploy', async () => {
    const { h } = fixture();
    expect(await h.list({ roomId: '!r:s' })).toEqual({ status: 200, body: { memories: [mem] } });
    const r = await fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) }).h.list({ roomId: '!r:s' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/does not have the \/memories routes yet.*PR #94/);
  });

  it('get and delete: by name, 404 → no memory named, bad name → 400', async () => {
    const { h, client } = fixture();
    expect(await h.get({ roomId: '!r:s', name: 'avoid-eric' })).toEqual({ status: 200, body: { memory: mem } });
    expect(client.get.mock.calls[0]).toEqual(['avoid-eric']);
    expect(await h.delete({ roomId: '!r:s', name: 'avoid-eric' })).toEqual({ status: 200, body: { memory: mem } });
    expect(client.remove.mock.calls[0]).toEqual(['avoid-eric']);
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
});
