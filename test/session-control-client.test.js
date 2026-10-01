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
    h.onSessionControlFrame({ kind: 'session_control', event: 'result', request_id: rid, ok: true, result: { applied: 'deferred', box: 'eric' } });
    expect(notices).toEqual([['coord-convo', '⏳ Session model switch on eric parked: the session is busy; it applies at its next idle point.']]);
    // a duplicate result is ignored
    h.onSessionControlFrame({ kind: 'session_control', event: 'result', request_id: rid, ok: true, result: { applied: 'now' } });
    expect(notices).toHaveLength(1);
    expect(h._inflightCount()).toBe(0);
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
  it('answers 502 when the journal socket is down', async () => {
    const { h } = fixture({ send: false });
    expect((await h.compact({ roomId: '!coord', target_convo_id: 'tgt' })).status).toBe(502);
  });
});
