import { describe, it, expect } from 'vitest';
import { createSessionControlHandlers } from '../lib/session-control-client.js';

function fixture({ coordinator = true, send = true } = {}) {
  const sent = [];
  const notices = [];
  const sessions = new Map([['!coord', { alive: true, coordinator, journalConvoId: 'coord-convo' }], ['!plain', { alive: true, coordinator: false, journalConvoId: 'plain-convo' }]]);
  const publisher = { sendRoomOp: (f) => { if (send) sent.push(f); return send; } };
  const h = createSessionControlHandlers({ sessions, publisher, journalConvoIdFor: (s) => s.journalConvoId, notify: (c, t) => notices.push([c, t]), pendingTimeoutMs: 100 });
  return { h, sent, notices };
}

describe('session control client', () => {
  it('refuses a non-Coordinator caller, a missing target, and self', async () => {
    const { h } = fixture();
    expect((await h.compact({ roomId: '!plain', target_convo_id: 'x' })).status).toBe(403);
    expect((await h.compact({ roomId: '!nope', target_convo_id: 'x' })).status).toBe(404);
    expect((await h.compact({ roomId: '!coord' })).status).toBe(400);
    expect((await h.compact({ roomId: '!coord', target_convo_id: 'coord-convo' })).status).toBe(400);
    expect((await h.carryOn({ roomId: '!coord', target_convo_id: 'coord-convo', message: 'go' })).status).toBe(400);
    expect((await h.setModel({ roomId: '!coord', target_convo_id: 'x' })).status).toBe(400);
    expect((await h.carryOn({ roomId: '!coord', target_convo_id: 'x' })).status).toBe(400);
  });
  it('sends the op and answers on the sent ack; the result frame becomes a notice in the Coordinator chat', async () => {
    const { h, sent, notices } = fixture();
    const p = h.setModel({ roomId: '!coord', target_convo_id: 'tgt', model: 'sonnet', agent: 'claude', reason: 'limit hit' });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: 'session_control', from_convo_id: 'coord-convo', target_convo_id: 'tgt', action: 'set_model', model: 'sonnet', agent: 'claude', reason: 'limit hit' });
    const rid = sent[0].request_id;
    h.onSessionControlFrame({ kind: 'session_control', event: 'sent', request_id: rid, target_waking: true });
    const res = await p;
    expect(res).toEqual({ status: 200, body: { sent: true, request_id: rid, target_waking: true } });
    h.onSessionControlFrame({ kind: 'session_control', event: 'result', request_id: rid, ok: true, result: { applied: 'deferred', box: 'elm' } });
    expect(notices).toEqual([['coord-convo', '⏳ Session model switch on elm parked: the session is busy; it applies at its next idle point.']]);
    // a duplicate result is ignored
    h.onSessionControlFrame({ kind: 'session_control', event: 'result', request_id: rid, ok: true, result: { applied: 'now' } });
    expect(notices).toHaveLength(1);
    expect(h._inflightCount()).toBe(0);
  });
  it('a carry-on carries the causes of the Coordinator\'s turn; other actions do not', async () => {
    const sent = [];
    const causes = [{ kind: 'user_message', ref: 'coord-convo:12', at: 1 }];
    // The causes come from the turn the bridge is running, never the request body.
    const sessions = new Map([['!coord', { alive: true, coordinator: true, journalConvoId: 'coord-convo', currentTurn: { causes, startedAt: 1 } }]]);
    const h2 = createSessionControlHandlers({ sessions, publisher: { sendRoomOp: (f) => { sent.push(f); return true; } }, journalConvoIdFor: (x) => x.journalConvoId, pendingTimeoutMs: 20 });
    await h2.carryOn({ roomId: '!coord', target_convo_id: 'tgt', message: 'go', causes: [{ kind: 'routine', ref: 'forged' }] });
    expect(sent[0]).toMatchObject({ action: 'carry_on', causes });
    await h2.compact({ roomId: '!coord', target_convo_id: 'tgt' });
    expect('causes' in sent[1]).toBe(false);
    // A turn with no causes sends none.
    sessions.get('!coord').currentTurn = null;
    await h2.carryOn({ roomId: '!coord', target_convo_id: 'tgt', message: 'go' });
    expect('causes' in sent[2]).toBe(false);
  });
  it('maps journal error frames to HTTP statuses and times out without an ack', async () => {
    const { h, sent } = fixture();
    const p = h.carryOn({ roomId: '!coord', target_convo_id: 'tgt', message: 'go', when: 'after_limit_reset' });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent[0]).toMatchObject({ action: 'carry_on', message: 'go', when: 'after_limit_reset' });
    expect(h.onOpError({ code: 'forbidden', ref: 'session_control', detail: 'not_coordinator', requestId: sent[0].request_id })).toBe(true);
    expect((await p).status).toBe(403);
    const p2 = h.compact({ roomId: '!coord', target_convo_id: 'tgt' });
    await new Promise((r) => setTimeout(r, 5));
    h.onOpError({ code: 'not_found', ref: 'session_control', requestId: sent[1].request_id });
    expect((await p2).status).toBe(404);
    const p3 = h.compact({ roomId: '!coord', target_convo_id: 'tgt' });
    expect((await p3).status).toBe(504);
    expect(h.onOpError({ code: 'x', ref: 'spawn_request' })).toBe(false);
    // an older journal keys the error by ref alone
    const p4 = h.compact({ roomId: '!coord', target_convo_id: 'tgt' });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.onOpError({ code: 'not_found', ref: sent[3].request_id })).toBe(true);
    expect((await p4).status).toBe(404);
  });
  it('a compact aimed at the Coordinator\'s own conversation runs compact_self instead of being refused', async () => {
    const calls = [];
    const sessions = new Map([['!coord', { alive: true, coordinator: true, journalConvoId: 'coord-convo' }]]);
    const h = createSessionControlHandlers({ sessions, publisher: { sendRoomOp: () => { throw new Error('must not reach the journal'); } }, journalConvoIdFor: (s) => s.journalConvoId, compactSelf: async (d) => { calls.push(d); return { status: 200, body: { ok: true, parked: true } }; } });
    expect(await h.compact({ roomId: '!coord', target_convo_id: 'coord-convo', reason: 'at 31%' })).toEqual({ status: 200, body: { ok: true, parked: true } });
    expect(calls).toEqual([{ roomId: '!coord', reason: 'at 31%' }]);
    expect((await h.carryOn({ roomId: '!coord', target_convo_id: 'coord-convo', message: 'go' })).status).toBe(400);
  });
  it('answers 502 when the journal socket is down', async () => {
    const { h } = fixture({ send: false });
    expect((await h.compact({ roomId: '!coord', target_convo_id: 'tgt' })).status).toBe(502);
  });
});
