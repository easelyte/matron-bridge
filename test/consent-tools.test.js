import { describe, it, expect, vi } from 'vitest';
import { createConsentHandlers, formatPendingList, formatPendingAsk, formatConsentNudge, formatDecideAck, formatJournalConsentError } from '../lib/consent-tools.js';
import { createConsentClient } from '../lib/consent-client.js';

const NOW = 1_790_000_000_000;
const spawnAsk = { kind: 'spawn', id: 'sp-1', created_at: NOW - 5 * 60_000, from_device_id: 7, from_name: 'coord-box', from_convo_id: 'c-coord', from_convo_title: 'Coordinator', target_device_id: 12, target_name: 'eric', target_state: 'asleep', workdir: '/home/dan/proj', task: 'fix the flaky test\nand report back', topic: 'flaky test', model: 'opus[1m]', link: true, mission_num: 61, item_num: 640 };
const chatAsk = { kind: 'chat', id: 'room-1/12', created_at: NOW - 3 * 3_600_000, request: 'invite', room_id: 'room-1', room_title: 'A ↔ B', target_device_id: 12, from_device_id: 7, from_name: 'dev-2', from_convo_id: 'c-2', from_convo_title: 'Dev 2', to_device_id: 12, to_name: 'eric', to_convo_id: 'c-e', to_convo_title: 'Eric session', target_state: 'online', topic: 'review', justification: 'need eyes on the diff' };

function fixture({ coordinator = true, pending = { status: 200, data: { pending: [spawnAsk, chatAsk] } }, answer = { status: 200, data: { ok: true } } } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const sessions = new Map([['!r:s', session]]);
  const client = { pending: vi.fn(async () => pending), answer: vi.fn(async () => answer) };
  const h = createConsentHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, now: () => NOW });
  return { h, client, session };
}

describe('consent handlers', () => {
  it('refuse a non-Coordinator session before any journal call, and the usual session guards', async () => {
    const { h, client } = fixture({ coordinator: false });
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("only the Coordinator may approve chats and spawns on the user's behalf — this conversation is not the Coordinator");
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' })).status).toBe(403);
    expect(client.pending).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other' })).status).toBe(404);
    const noConvo = fixture();
    noConvo.session.journalConvoId = null;
    expect((await noConvo.h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('isCoordinator lets the wiring count the journal\'s current role holder, so a live assignment is not refused', async () => {
    const session = { roomId: '!r:s', coordinator: false, journalConvoId: 'c-coord' };
    const sessions = new Map([['!r:s', session]]);
    const client = { pending: vi.fn(async () => ({ status: 200, data: { pending: [] } })), answer: vi.fn() };
    const h = createConsentHandlers({ sessions, journalConvoIdFor: (s) => s.journalConvoId, client, isCoordinator: (s, convoId) => s.coordinator === true || convoId === 'c-coord' });
    expect((await h.list({ roomId: '!r:s' })).status).toBe(200);
    session.journalConvoId = 'c-other';
    expect((await h.list({ roomId: '!r:s' })).status).toBe(403);
  });

  it('list asks the journal with the Coordinator convo id and passes the pending rows through', async () => {
    const { h, client } = fixture();
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(client.pending.mock.calls[0]).toEqual(['c-coord']);
    expect(r.body.pending).toHaveLength(2);
    const old = fixture({ pending: { status: 404, data: { error: 'not_found' } } });
    expect((await old.h.list({ roomId: '!r:s' })).body.error).toMatch(/no \/consent routes yet/);
    const down = fixture({ pending: { status: 0, data: { error: 'journal unreachable' } } });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  it('decide validates kind, id, decision and reason, folds the reason to one line, and posts convo_id with it', async () => {
    const { h, client } = fixture();
    expect((await h.decide({ roomId: '!r:s', kind: 'mail', id: 'x', decision: 'approve', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: '', decision: 'approve', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'maybe', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: '  ' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: 'x'.repeat(201) })).status).toBe(400);
    expect(client.answer).not.toHaveBeenCalled();
    const r = await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'sp-1', decision: 'approve', reason: ' follows the\nbox rules ' });
    expect(r.status).toBe(200);
    expect(client.answer.mock.calls[0]).toEqual([{ convo_id: 'c-coord', kind: 'spawn', id: 'sp-1', decision: 'approve', reason: 'follows the box rules' }]);
  });

  it('renders every journal refusal as a sentence that names the next move', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden', detail: 'consent_disabled' } }, /switched off .*leave this ask for them/],
      [{ status: 409, data: { error: 'conflict', detail: 'daily_cap', cap: 20 } }, /daily cap .*\(20 in 24 h\).*stays for the user/],
      [{ status: 409, data: { error: 'conflict', detail: 'target_offline' } }, /offline and cannot be woken.*decline with a reason is still allowed/],
      [{ status: 409, data: { error: 'conflict' } }, /no longer waiting/],
      [{ status: 404, data: { error: 'not_found' } }, /no such ask/],
      [{ status: 400, data: { error: 'bad_request' } }, /reason is 1–200 characters/],
    ];
    for (const [answer, re] of cases) {
      const { h } = fixture({ answer });
      const r = await h.decide({ roomId: '!r:s', kind: 'chat', id: 'room-1/12', decision: 'approve', reason: 'ok' });
      expect(r.status).toBe(answer.status);
      expect(r.body.error).toMatch(re);
    }
    expect(formatJournalConsentError({ error: 'weird' })).toBe('weird');
    const down = fixture({ answer: { status: 0, data: { error: 'journal unreachable' } } });
    expect((await down.h.decide({ roomId: '!r:s', kind: 'chat', id: 'room-1/12', decision: 'decline', reason: 'ok' })).status).toBe(502);
  });
});

describe('consent formatting', () => {
  it('formatPendingAsk: a spawn names asker, target box and state, directory, model, mission, room, task and the exact call, with peer text one-lined', () => {
    const text = formatPendingAsk(spawnAsk, { now: NOW });
    expect(text).toContain('spawn sp-1 (tracker #640) — 5 min ago: coord-box — session "Coordinator" [c-coord] asks to start a session on eric (box asleep)');
    expect(text).toContain('directory: /home/dan/proj · model: opus[1m] · joins mission #61 · opens a chat room back to the asker');
    expect(text).toContain('task: fix the flaky test ⏎ and report back');
    expect(text).toContain('consent_decide(kind: "spawn", id: "sp-1", decision: approve|decline, reason: …)');
    expect(text.split('\n')).toHaveLength(4);
  });
  it('formatPendingAsk: a no-model spawn onto a Fable-maxed box says it will run on Opus; a named model wins', () => {
    const { model: _, ...noModel } = spawnAsk;
    const text = formatPendingAsk({ ...noModel, fallback_model: 'opus', fallback_reason: 'fable_limit' }, { now: NOW });
    expect(text).toContain('directory: /home/dan/proj · model: opus — the box is at its Fable weekly limit · joins mission #61');
    const named = formatPendingAsk({ ...spawnAsk, fallback_model: 'opus', fallback_reason: 'fable_limit' }, { now: NOW });
    expect(named).toContain('· model: opus[1m] · joins');
    expect(named).not.toMatch(/Fable weekly limit/);
  });
  it('formatPendingAsk: a chat invite names both sides, the topic, the justification and the call; a join names the room', () => {
    const text = formatPendingAsk(chatAsk, { now: NOW });
    expect(text).toContain('chat room-1/12 — 3 h ago: dev-2 — session "Dev 2" [c-2] asks to chat with eric — session "Eric session" about "review" (box online)');
    expect(text).toContain("why, in dev-2's words: need eyes on the diff");
    expect(text).toContain('consent_decide(kind: "chat", id: "room-1/12", decision: approve|decline, reason: …)');
    const join = formatPendingAsk({ ...chatAsk, request: 'join', to_name: 'dev-a', room_title: 'triage' }, { now: NOW });
    expect(join).toContain('asks to join dev-a\'s room "triage"');
  });
  it('formatPendingList: empty, and a headed list; formatConsentNudge wraps one ask as a turn; formatDecideAck says what happened', () => {
    expect(formatPendingList({ pending: [] })).toBe('No chat or spawn requests are waiting for approval.');
    const list = formatPendingList({ pending: [spawnAsk, chatAsk] }, { now: NOW });
    expect(list).toMatch(/^2 requests waiting for the user's approval \(oldest first\)/);
    expect(list).toContain('spawn sp-1');
    expect(list).toContain('chat room-1/12');
    const nudge = formatConsentNudge({ kind: 'consent', event: 'pending', ask: chatAsk }, { now: NOW });
    expect(nudge).toMatch(/^🤝 A consent request is waiting for the user:/);
    expect(nudge).toContain('chat room-1/12');
    expect(nudge).toContain('The user has the card too and may answer first.');
    expect(formatConsentNudge({ kind: 'consent', event: 'pending' })).toBeNull();
    expect(formatDecideAck({ ok: true }, { kind: 'spawn', decision: 'decline', id: 'sp-1' })).toMatch(/^Declined spawn request sp-1 on the user's behalf/);
    expect(formatDecideAck({ ok: true }, { kind: 'spawn', decision: 'approve', id: 'sp-1' })).toMatch(/^Approved spawn request sp-1 on the user's behalf — the session is being started/);
    expect(formatDecideAck({ ok: true, delivered: true }, { kind: 'chat', decision: 'approve', id: 'room-1/12' })).toMatch(/invitation was delivered/);
    expect(formatDecideAck({ ok: true, delivered: false }, { kind: 'chat', decision: 'approve', id: 'room-1/12' })).toMatch(/being woken/);
  });
});

describe('consent client', () => {
  it('GETs pending with the encoded convo id and POSTs the answer with the bearer token; never throws', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ pending: [] }) }; });
    const c = createConsentClient({ baseUrl: 'https://j/', token: 'T', fetchImpl });
    expect((await c.pending('a b')).status).toBe(200);
    expect(calls[0][0]).toBe('https://j/consent/pending?convo_id=a%20b');
    expect(calls[0][1].headers.Authorization).toBe('Bearer T');
    await c.answer({ convo_id: 'a', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' });
    expect(calls[1][0]).toBe('https://j/consent/answer');
    expect(JSON.parse(calls[1][1].body)).toEqual({ convo_id: 'a', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' });
    const broken = createConsentClient({ baseUrl: 'https://j', token: 'T', fetchImpl: async () => { throw new Error('boom'); } });
    expect(await broken.pending('a')).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const refused = createConsentClient({ baseUrl: 'https://j', token: 'T', fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict', detail: 'daily_cap', cap: 20 }) }) });
    expect(await refused.answer({})).toEqual({ status: 409, data: { error: 'conflict', detail: 'daily_cap', cap: 20 } });
    expect((await createConsentClient({ baseUrl: '', token: 'T' }).pending('a')).status).toBe(0);
  });
});
