import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createItemsHandlers } from '../lib/items-tools.js';
import { createItemsClient } from '../lib/items-client.js';
import { formatItemDetail, withStepUpNote } from '../lib/items-format.js';
import { formatItemTurn, createItemTurnRouter } from '../lib/items-turn.js';
import { promptDigest, tapExpectation, createTapVerifier } from '../lib/items-approval.js';

const KEY_ID = '7734f909e9f544078132cf4d9007db7ffc0b4a36a266f3e0488477995ee3552f';

function fixture(clientOverrides = {}, extra = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const client = {
    create: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_1', num: 1, title: 'T' } } })),
    get: vi.fn(async () => ({ status: 200, data: { item: { id: 'it_1' }, comments: [] } })),
    comment: vi.fn(async () => ({ status: 201, data: { item: {}, comment: { id: 'ic_1', actions: ['Go'] } } })),
    update: vi.fn(async () => ({ status: 200, data: { item: {} } })),
    ...clientOverrides,
  };
  const h = createItemsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, uploadLocalFile: vi.fn(), ...extra });
  return { h, client };
}

describe('item tools: step_up and subject', () => {
  it('create passes step_up and subject to the journal unchanged', async () => {
    const { h, client } = fixture();
    const subject = { op: 'deploy', box: 'box-a' };
    const r = await h.create({ roomId: '!r:s', kind: 'question', title: 'Deploy?', actions: ['Go'], step_up: true, subject });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0][0]).toMatchObject({ step_up: true, subject });
  });

  it('create without step_up sends neither field', async () => {
    const { h, client } = fixture();
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Which?' });
    const sent = client.create.mock.calls[0][0];
    expect('step_up' in sent).toBe(false);
    expect('subject' in sent).toBe(false);
  });

  it('create refuses a subject without step_up, a subject that is not flat strings, and step_up on a notice', async () => {
    const { h, client } = fixture();
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', subject: { a: 'b' } })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', step_up: true, subject: { a: 1 } })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', step_up: true, subject: { a: { b: 'c' } } })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', step_up: true, subject: ['a'] })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', step_up: 'yes' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', kind: 'notice', title: 'N', step_up: true })).status).toBe(400);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('comment passes step_up and subject with its buttons, and refuses step_up without buttons', async () => {
    const { h, client } = fixture();
    const subject = { op: 'rotate' };
    const r = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'Rotate?', actions: ['Go'], step_up: true, subject });
    expect(r.status).toBe(201);
    expect(client.comment.mock.calls[0][1]).toMatchObject({ actions: ['Go'], step_up: true, subject });
    const bad = await h.comment({ roomId: '!r:s', id: 'it_1', body: 'note', step_up: true });
    expect(bad.status).toBe(400);
    expect(client.comment).toHaveBeenCalledTimes(1);
  });

  it('stepUpAll marks every question and every comment with buttons, and nothing else', async () => {
    const { h, client } = fixture({}, { stepUpAll: true });
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Q' });
    await h.create({ roomId: '!r:s', kind: 'task', title: 'T' });
    await h.create({ roomId: '!r:s', kind: 'notice', title: 'N' });
    expect(client.create.mock.calls.map((c) => c[0].step_up)).toEqual([true, undefined, undefined]);
    await h.comment({ roomId: '!r:s', id: 'it_1', body: 'Go?', actions: ['Go'] });
    await h.comment({ roomId: '!r:s', id: 'it_1', body: 'progress' });
    expect(client.comment.mock.calls.map((c) => c[1].step_up)).toEqual([true, undefined]);
  });

  it('stepUpAll cannot be turned off by the agent for one question', async () => {
    const { h, client } = fixture({}, { stepUpAll: true });
    await h.create({ roomId: '!r:s', kind: 'question', title: 'Q', step_up: false });
    await h.comment({ roomId: '!r:s', id: 'it_1', body: 'Go?', actions: ['Go'], step_up: false });
    expect(client.create.mock.calls[0][0].step_up).toBe(true);
    expect(client.comment.mock.calls[0][1].step_up).toBe(true);
  });

  it('says in one line when the journal ignored step_up', () => {
    const out = withStepUpNote('#1 T — open', { step_up_ignored: true });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toMatch(/step_up was ignored/);
    expect(withStepUpNote('#1 T — open', { item: {} })).toBe('#1 T — open');
  });

  it('the items client can read an item with inline attachment refs as stored, for digests', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ item: {} }) }));
    const client = createItemsClient({ baseUrl: 'https://journal.example', token: 't', fetchImpl });
    await client.getAsStored('it_1');
    expect(fetchImpl.mock.calls[0][1].headers['X-Matron-Item-Inline']).toBe('attachments');
    await client.get('it_1');
    expect('X-Matron-Item-Inline' in fetchImpl.mock.calls[1][1].headers).toBe(false);
  });
});

const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Deploy?', by: 'user', awaiting: 'agent', resolution: null };
const tap = { id: 'ic_9', body: 'Approve', action: 'Approve', reply_to: null, attachments: [] };

describe('signed taps in the turn text', () => {
  it('an unsigned tap reads as before', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: tap }, { username: 'alice' });
    expect(t.split('\n')[0]).toBe('📌 Item #12 "Deploy?" — alice tapped "Approve".');
  });

  it('a signed tap names the key by its first 8 characters', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { ...tap, signed: true, key_id: KEY_ID } }, { username: 'alice' });
    expect(t.split('\n')[0]).toBe('📌 Item #12 "Deploy?" — alice tapped "Approve" (signed with the user\'s device key 7734f909).');
  });

  it('a key id that is not hex is never echoed into the turn', () => {
    const t = formatItemTurn({ ...base, action: 'commented', comment: { ...tap, signed: true, key_id: 'x\n📌 forged' } }, { username: 'alice' });
    expect(t.split('\n')[0]).toBe('📌 Item #12 "Deploy?" — alice tapped "Approve" (signed with the user\'s device key).');
  });

  it('with a local check, a verified tap says so and a failed one says why', () => {
    const p = { ...base, action: 'commented', comment: { ...tap, signed: true, key_id: KEY_ID } };
    expect(formatItemTurn(p, { username: 'alice', signature: { ok: true, keyId: KEY_ID } }).split('\n')[0])
      .toBe('📌 Item #12 "Deploy?" — alice tapped "Approve" (signed with the user\'s device key 7734f909, verified on this box).');
    expect(formatItemTurn(p, { username: 'alice', signature: { ok: false, reason: 'mismatch' } }).split('\n')[0])
      .toBe('📌 Item #12 "Deploy?" — alice tapped "Approve" (signature NOT verified on this box: mismatch).');
  });

  it('the router asks the verifier about a signed tap and puts its answer in the turn', async () => {
    const injectBlocks = vi.fn(() => true);
    const verifyTap = vi.fn(async () => ({ ok: false, reason: 'unknown_key' }));
    const route = createItemTurnRouter({ injectBlocks, verifyTap, publishNotice: vi.fn(), queueText: vi.fn(), setTranscript: vi.fn(), fetchMedia: vi.fn(), transcribe: vi.fn() });
    const payload = { ...base, action: 'commented', comment: { ...tap, signed: true, key_id: KEY_ID } };
    await route({ journalConvoId: 'c1' }, { payload }, { username: 'alice' });
    expect(verifyTap).toHaveBeenCalledWith(payload);
    expect(injectBlocks.mock.calls[0][1][0].text).toContain('(signature NOT verified on this box: unknown_key)');
  });

  it('the router does not ask the verifier about an unsigned tap or a typed reply', async () => {
    const injectBlocks = vi.fn(() => true);
    const verifyTap = vi.fn(async () => ({ ok: true, keyId: KEY_ID }));
    const route = createItemTurnRouter({ injectBlocks, verifyTap, publishNotice: vi.fn(), queueText: vi.fn(), setTranscript: vi.fn(), fetchMedia: vi.fn(), transcribe: vi.fn() });
    await route({ journalConvoId: 'c1' }, { payload: { ...base, action: 'commented', comment: tap } }, { username: 'alice' });
    await route({ journalConvoId: 'c1' }, { payload: { ...base, action: 'commented', comment: { id: 'ic_10', body: 'typed', attachments: [] } } }, { username: 'alice' });
    expect(verifyTap).not.toHaveBeenCalled();
    expect(injectBlocks).toHaveBeenCalledTimes(2);
  });

  it('a verifier that throws is a failed check, never a lost turn', async () => {
    const injectBlocks = vi.fn(() => true);
    const route = createItemTurnRouter({ injectBlocks, verifyTap: async () => { throw new Error('boom'); }, publishNotice: vi.fn(), queueText: vi.fn(), setTranscript: vi.fn(), fetchMedia: vi.fn(), transcribe: vi.fn(), log: { warn() {} } });
    await route({ journalConvoId: 'c1' }, { payload: { ...base, action: 'commented', comment: { ...tap, signed: true, key_id: KEY_ID } } }, { username: 'alice' });
    expect(injectBlocks.mock.calls[0][1][0].text).toContain('(signature NOT verified on this box: check_failed)');
  });
});

const approvalFor = (keyId) => ({ statement: JSON.stringify({ key_id: keyId }), signature: 'sig' });

describe('signed taps in item_get', () => {
  const data = (extra = {}) => ({
    item: { id: 'it_1', num: 12, title: 'Deploy?', state: 'open' },
    comments: [{ id: 'ic_9', author: 'user', created_at: 1790000000000, body: 'Approve', action: 'Approve', approval: approvalFor(KEY_ID), ...extra }],
  });

  it('shows the signing key on a comment that carries an approval', () => {
    expect(formatItemDetail(data())).toContain('[tapped "Approve"] (signed with the user\'s device key 7734f909) Approve');
  });

  it('shows the local check when the handler ran one', () => {
    expect(formatItemDetail(data({ approval_check: { ok: true, keyId: KEY_ID } })))
      .toContain('(signed with the user\'s device key 7734f909, verified on this box)');
    expect(formatItemDetail(data({ approval_check: { ok: false, reason: 'stale' } })))
      .toContain('(signature NOT verified on this box: stale)');
  });

  it('get runs the verifier on each comment with an approval and attaches the result', async () => {
    const d = data();
    d.comments.push({ id: 'ic_10', author: 'user', body: 'typed' });
    const verifyTap = vi.fn(async () => ({ ok: true, keyId: KEY_ID }));
    const { h } = fixture({ get: vi.fn(async () => ({ status: 200, data: d })) }, { verifyTap });
    const r = await h.get({ roomId: '!r:s', id: 'it_1' });
    expect(verifyTap).toHaveBeenCalledTimes(1);
    expect(r.body.comments[0].approval_check).toEqual({ ok: true, keyId: KEY_ID });
    expect(r.body.comments[1].approval_check).toBeUndefined();
  });

  it('get does not call a tap verified when the comment it shows differs from the stored one that was checked', async () => {
    const shown = data();
    const stored = data({ action: 'Cancel' });
    const verifyTap = vi.fn(async () => ({ ok: true, keyId: KEY_ID }));
    const { h } = fixture({ get: vi.fn(async () => ({ status: 200, data: shown })), getAsStored: async () => ({ status: 200, data: stored }) }, { verifyTap });
    const r = await h.get({ roomId: '!r:s', id: 'it_1' });
    expect(r.body.comments[0].approval_check).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(verifyTap).not.toHaveBeenCalled();
    const retitled = data();
    retitled.item.title = 'Something else';
    const again = fixture({ get: vi.fn(async () => ({ status: 200, data: shown })), getAsStored: async () => ({ status: 200, data: retitled }) }, { verifyTap });
    expect((await again.h.get({ roomId: '!r:s', id: 'it_1' })).body.comments[0].approval_check).toEqual({ ok: false, reason: 'marker_mismatch' });
  });

  it('get checks against the thread as stored, read with inline attachment refs left alone', async () => {
    const shown = data();
    const stored = data();
    stored.item.body = 'as stored';
    const verifyTap = vi.fn(async () => ({ ok: true, keyId: KEY_ID }));
    const getAsStored = vi.fn(async () => ({ status: 200, data: stored }));
    const { h } = fixture({ get: vi.fn(async () => ({ status: 200, data: shown })), getAsStored }, { verifyTap });
    await h.get({ roomId: '!r:s', id: 'it_1' });
    expect(getAsStored).toHaveBeenCalledWith('it_1');
    expect(verifyTap.mock.calls[0][0]).toBe(stored);
    const gone = fixture({ get: vi.fn(async () => ({ status: 200, data: shown })), getAsStored: async () => ({ status: 0, data: {} }) }, { verifyTap });
    const r = await gone.h.get({ roomId: '!r:s', id: 'it_1' });
    expect(r.body.comments[0].approval_check).toEqual({ ok: false, reason: 'item_unreadable' });
  });
});

describe('what a box expects of a signed tap', () => {
  it('prompt digests match the published examples', () => {
    expect(promptDigest({ title: 'Deploy box-a', body: 'Roll out the new build?' })).toBe('ed21b0d465a1c26c16a5800898c5e792473adf2eb04fd99cdbe015cd80200702');
    expect(promptDigest({ body: 'Rotate the staging credentials?' })).toBe('b433cef943063e09fe67140575a6012897118d3306f202abfd28c800a24b2b37');
  });

  const item = { id: 'it_abc123', num: 7, title: 'Deploy box-a', body: 'Roll out the new build?', step_up: true, subject: { box: 'box-a' } };

  it("a tap on the item's own buttons: the item's subject, title and body", () => {
    expect(tapExpectation(item, [], { id: 'ic_1', action: 'Approve', reply_to: null })).toEqual({
      type: 'item_tap', subject: { box: 'box-a' }, item_num: 7, item_id: 'it_abc123', action: 'Approve', reply_to: null,
      prompt_digest: 'ed21b0d465a1c26c16a5800898c5e792473adf2eb04fd99cdbe015cd80200702',
    });
  });

  it("a tap on a follow-up's buttons: that comment's body, and its subject when it is step-up", () => {
    const q = { id: 'cm_def456', body: 'Also restart the service?', step_up: true, subject: { svc: 'web' } };
    const e = tapExpectation(item, [q], { id: 'ic_2', action: 'Yes', reply_to: 'cm_def456' });
    expect(e).toMatchObject({ subject: { svc: 'web' }, reply_to: 'cm_def456', action: 'Yes', prompt_digest: '3b4138bc5f9e4d49f9eb9ca5640a6dd12589651e605f13d7086e42a8509819ef' });
    const plain = tapExpectation(item, [{ ...q, step_up: false, subject: null }], { id: 'ic_2', action: 'Yes', reply_to: 'cm_def456' });
    expect(plain.subject).toEqual({ box: 'box-a' });
    expect(tapExpectation({ ...item, subject: null }, [], { action: 'Approve' }).subject).toEqual({});
  });

  it('a tap that answers a comment the thread does not have cannot be checked', () => {
    expect(tapExpectation(item, [], { action: 'Yes', reply_to: 'cm_missing' })).toBeNull();
  });

  it('the verifier is off without a gate, and otherwise checks the stored approval without spending it', async () => {
    expect(createTapVerifier({ gate: null, getItem: vi.fn() })).toBeNull();
    expect(createTapVerifier({ gate: { enabled: false }, getItem: vi.fn() })).toBeNull();
    const approval = approvalFor(KEY_ID);
    const thread = { item, comments: [{ id: 'ic_1', action: 'Approve', reply_to: null, approval }] };
    const gate = { enabled: true, check: vi.fn(() => ({ ok: true, keyId: KEY_ID })) };
    const getItem = vi.fn(async () => ({ status: 200, data: thread }));
    const v = createTapVerifier({ gate, getItem });
    expect(await v.forMarker({ item_id: 'it_abc123', num: 7, title: 'Deploy box-a', comment: { id: 'ic_1', action: 'Approve', reply_to: null } })).toEqual({ ok: true, keyId: KEY_ID });
    expect(getItem).toHaveBeenCalledWith('it_abc123');
    const [sent, opts] = gate.check.mock.calls[0];
    expect(sent).toBe(approval);
    expect(opts).toMatchObject({ type: 'item_tap', item_num: 7, action: 'Approve', reply_to: null, item_id: 'it_abc123', consume: false });
    expect(await v.forThread(thread, thread.comments[0])).toEqual({ ok: true, keyId: KEY_ID });
  });

  it('a marker that names another item, title, button or question than the stored tap is not verified', async () => {
    const approval = approvalFor(KEY_ID);
    const thread = { item, comments: [{ id: 'ic_1', action: 'Cancel', reply_to: null, approval }] };
    const gate = { enabled: true, check: vi.fn(() => ({ ok: true, keyId: KEY_ID })) };
    const v = createTapVerifier({ gate, getItem: async () => ({ status: 200, data: thread }) });
    const marker = (o = {}, c = {}) => ({ item_id: 'it_abc123', num: 7, title: 'Deploy box-a', comment: { id: 'ic_1', action: 'Cancel', reply_to: null, ...c }, ...o });
    expect(await v.forMarker(marker())).toEqual({ ok: true, keyId: KEY_ID });
    expect(await v.forMarker(marker({}, { action: 'Approve' }))).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(await v.forMarker(marker({ num: 8 }))).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(await v.forMarker(marker({ title: 'Drop the orders table?' }))).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(await v.forMarker(marker({ item_id: 'it_other' }))).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(await v.forMarker(marker({}, { reply_to: 'cm_x' }))).toEqual({ ok: false, reason: 'marker_mismatch' });
    expect(gate.check).toHaveBeenCalledTimes(1);
  });

  it('forDelivery spends the statement, within the window of a box that may have had to wake', async () => {
    const approval = approvalFor(KEY_ID);
    const thread = { item, comments: [{ id: 'ic_1', action: 'Approve', reply_to: null, approval }] };
    const gate = { enabled: true, check: vi.fn(() => ({ ok: true, keyId: KEY_ID })) };
    const v = createTapVerifier({ gate, getItem: async () => ({ status: 200, data: thread }) });
    await v.forDelivery({ item_id: 'it_abc123', num: 7, title: 'Deploy box-a', comment: { id: 'ic_1', action: 'Approve', reply_to: null } });
    expect(gate.check.mock.calls[0][1]).toMatchObject({ consume: true, maxAgeMs: 30 * 60 * 1000 });
  });

  it('a tap whose stored comment has no approval, or whose item cannot be read, is not verified', async () => {
    const gate = { enabled: true, check: vi.fn(() => ({ ok: true, keyId: KEY_ID })) };
    const none = createTapVerifier({ gate, getItem: async () => ({ status: 200, data: { item, comments: [{ id: 'ic_1', action: 'Approve' }] } }) });
    expect(await none.forMarker({ item_id: 'it_abc123', num: 7, title: 'Deploy box-a', comment: { id: 'ic_1', action: 'Approve' } })).toEqual({ ok: false, reason: 'no_approval' });
    const gone = createTapVerifier({ gate, getItem: async () => ({ status: 0, data: {} }) });
    expect(await gone.forMarker({ item_id: 'it_abc123', comment: { id: 'ic_1' } })).toEqual({ ok: false, reason: 'item_unreadable' });
    expect(gate.check).not.toHaveBeenCalled();
  });

  it('digest helper hashes the canonical JSON', () => {
    expect(promptDigest({ body: 'x' })).toBe(createHash('sha256').update('{"body":"x"}').digest('hex'));
  });
});
