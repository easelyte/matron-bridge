// Multi-select answers: item_create / item_comment take multi_select with
// their actions, and the 📌 turn and item_get list every label the user
// ticked and sent together.
import { describe, it, expect, vi } from 'vitest';
import { createItemsHandlers } from '../lib/items-tools.js';
import { formatItemTurn } from '../lib/items-turn.js';
import { formatItemDetail, formatCommentAck, withMultiSelectNote } from '../lib/items-format.js';
import { selectedActions, tappedAction } from '../lib/turn-cause.js';

const OPTIONS = ['Docs', 'Search', 'Billing'];

function fixture(clientOverrides = {}, extra = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const client = {
    create: vi.fn(async (body) => ({ status: 201, data: { item: { id: 'it_1', num: 1, multi_select: body.multi_select === true } } })),
    get: vi.fn(async () => ({ status: 200, data: { item: { id: 'it_1', state: 'open' }, comments: [] } })),
    comment: vi.fn(async (_id, body) => ({ status: 201, data: { item: {}, comment: { id: 'ic_1', actions: body.actions ?? [], multi_select: body.multi_select === true } } })),
    update: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    ...clientOverrides,
  };
  const h = createItemsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, uploadLocalFile: vi.fn(), ...extra });
  return { h, client };
}

describe('item_create / item_comment with multi_select', () => {
  it('create passes multi_select with the actions', async () => {
    const { h, client } = fixture();
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Close which?', actions: OPTIONS, multi_select: true });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0][0]).toMatchObject({ actions: OPTIONS, multi_select: true });
    expect(r.body.multi_select_error).toBeUndefined();
  });

  it('a one-tap create sends no multi_select', async () => {
    const { h, client } = fixture();
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Go?', actions: ['Go'] });
    expect('multi_select' in client.create.mock.calls[0][0]).toBe(false);
  });

  it('multi_select allows 12 labels of 80 chars; one-tap still stops at 4 and 40', async () => {
    const { h } = fixture();
    const twelve = Array.from({ length: 12 }, (_, i) => `Close the mission about topic number ${i + 1}`);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: twelve, multi_select: true })).status).toBe(201);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: [...twelve, 'x'], multi_select: true })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: ['x'.repeat(80)], multi_select: true })).status).toBe(201);
    const five = await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: twelve.slice(0, 5) });
    expect(five.status).toBe(400);
    expect(five.body.error).toMatch(/multi_select/);
  });

  it('refuses multi_select without actions, with step_up, on a notice, or as a non-boolean', async () => {
    const { h, client } = fixture();
    for (const extra of [
      { multi_select: true },
      { multi_select: true, actions: [] },
      { multi_select: true, actions: OPTIONS, step_up: true },
      { multi_select: 'yes', actions: OPTIONS },
      { kind: 'notice', multi_select: true },
    ]) {
      const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(client.create).not.toHaveBeenCalled();
  });

  it('the box-wide step_up default leaves a multi-select question unsigned', async () => {
    const { h, client } = fixture({}, { stepUpAll: true });
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: OPTIONS, multi_select: true });
    expect(client.create.mock.calls[0][0].step_up).toBeUndefined();
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: ['Go'] });
    expect(client.create.mock.calls[1][0].step_up).toBe(true);
  });

  it('warns when the journal stored one-tap buttons instead', async () => {
    const { h } = fixture({ create: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_1', num: 1 } } })) });
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: OPTIONS, multi_select: true });
    expect(r.body.multi_select_error).toMatch(/one-tap/);
    expect(withMultiSelectNote('#1 Q', r.body)).toMatch(/⚠ .*one-tap/);
  });

  it('comment passes multi_select and the ack says multi-select options', async () => {
    const { h, client } = fixture();
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'Which can go?', actions: OPTIONS, multi_select: true });
    expect(client.comment.mock.calls[0][1]).toMatchObject({ actions: OPTIONS, multi_select: true });
    expect(formatCommentAck(r.body)).toContain('with multi-select options "Docs", "Search", "Billing"');
  });

  it('a comment on an old journal says the user can pick only one', async () => {
    const { h } = fixture({ comment: vi.fn(async (_id, body) => ({ status: 201, data: { item: {}, comment: { id: 'ic_1', actions: body.actions } } })) });
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'Which?', actions: OPTIONS, multi_select: true });
    expect(formatCommentAck(r.body)).toMatch(/does not support multi_select/);
  });
});

describe('the 📌 turn for a multi-select answer', () => {
  const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Which can close?', by: 'user', awaiting: 'agent', resolution: null };

  it('lists every label picked', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { id: 'ic_1', body: 'Docs, Billing', action: 'Docs', selected: ['Docs', 'Billing'], attachments: [] } }, { username: 'alice' });
    expect(t).toBe('📌 Item #12 "Which can close?" — alice tapped "Docs", "Billing".\n(question, now awaiting: agent. item_get it_1 for the full thread; item_close when acted on.)');
  });

  it('keeps a typed note', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { id: 'ic_1', body: 'Keep search for now', action: 'Docs', selected: ['Docs', 'Billing'], attachments: [] } }, { username: 'alice' });
    expect(t.split('\n').slice(0, 2)).toEqual(['📌 Item #12 "Which can close?" — alice tapped "Docs", "Billing".', 'Keep search for now']);
  });

  it('a one-tap answer reads as before', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { id: 'ic_1', body: 'Go', action: 'Go', attachments: [] } }, { username: 'alice' });
    expect(t).toBe('📌 Item #12 "Which can close?" — alice tapped "Go".\nGo\n(question, now awaiting: agent. item_get it_1 for the full thread; item_close when acted on.)');
  });

  it('selectedActions reads comment.selected or meta.selected', () => {
    expect(selectedActions({ selected: ['A', 'C'] })).toEqual(['A', 'C']);
    expect(selectedActions({ meta: { action: 'A', selected: ['A', 'C'] } })).toEqual(['A', 'C']);
    expect(selectedActions({ action: 'A' })).toBeNull();
    expect(tappedAction({ action: 'A', selected: ['A', 'C'] })).toBe('A');
  });
});

describe('item_get for a multi-select question', () => {
  it('marks every chosen label and tags the answer with all of them', () => {
    const text = formatItemDetail({
      item: { id: 'it_1', num: 3, kind: 'question', state: 'open', title: 'Close which?', actions: OPTIONS, multi_select: true, chosen_actions: ['Docs', 'Billing'], chosen_action: 'Docs' },
      comments: [{ id: 'ic_1', author: 'user', kind: 'comment', body: 'Docs, Billing', action: 'Docs', selected: ['Docs', 'Billing'], created_at: 0, attachments: [] }],
    });
    expect(text).toContain('Actions (multi-select): [Docs], Search, [Billing]');
    expect(text).toContain('[tapped "Docs", "Billing"]');
  });
});

describe('older journals and idempotency', () => {
  it('turns an old journal\'s invalid_actions on a multi-select write into a plain reason', async () => {
    const { h } = fixture({ create: vi.fn(async () => ({ status: 400, data: { error: 'invalid_actions' } })) });
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', actions: Array.from({ length: 6 }, (_, i) => `Option ${i}`), multi_select: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not support multi_select/);
  });

  it('multi_select changes the idempotency key; leaving it out keeps the old key', async () => {
    const { itemIdemKey } = await import('../lib/missions-idem.js');
    const base = { op: 'item_create', roomId: '!r:s', now: 0, args: { kind: 'question', title: 'Q', actions: OPTIONS } };
    const one = itemIdemKey(base);
    expect(itemIdemKey({ ...base, args: { ...base.args, multi_select: true } })).not.toBe(one);
    expect(itemIdemKey({ ...base, args: { ...base.args, multi_select: false } })).toBe(one);
  });
});
