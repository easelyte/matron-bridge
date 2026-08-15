import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgentInvites, formatInviteRequestNotice } from '../lib/agent-invites.js';
import { createAgentRooms } from '../lib/agent-rooms.js';

// Awaited stages inside invite()/join() resume on microtasks; drain a few
// ticks so the next waiter is registered before the next frame is driven.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function makeInvites(overrides = {}) {
  const sendRoomOp = overrides.sendRoomOp ?? vi.fn(() => true);
  const rooms = overrides.rooms ?? createAgentRooms({ log: { warn: () => {} } });
  const injectRequestTurn = overrides.injectRequestTurn ?? vi.fn();
  const notifyRoom = overrides.notifyRoom ?? vi.fn();
  const log = overrides.log ?? { warn: vi.fn() };
  const inv = createAgentInvites({ sendRoomOp, rooms, injectRequestTurn, notifyRoom, log });
  return { inv, sendRoomOp, rooms, injectRequestTurn, notifyRoom, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAgentInvites', () => {
  describe('invite()', () => {
    it('omits target_convo_id entirely when there is none to send', async () => {
      // Absent, never null: the journal treats a present value as
      // authorisation and the receiving bridge treats its absence as "this
      // ask addresses no particular conversation" — a null would read as the
      // latter being addressed to nothing.
      const { inv, sendRoomOp, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      const op = sendRoomOp.mock.calls[0][0];
      expect('target_convo_id' in op).toBe(false);
    });

    it('happy path: delivered -> idle ack -> accept answer, registry joined', async () => {
      const { inv, sendRoomOp, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });

      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, targetConvoId: 'convo-remote', topic: 'ci triage', justification: 'need eyes' });
      expect(sendRoomOp).toHaveBeenCalledWith({
        op: 'agent_invite', room_id: 'r1', target_device_id: 7, target_convo_id: 'convo-remote', topic: 'ci triage', justification: 'need eyes',
      });

      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });

      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('joined');
    });

    it('sends from_convo_id so the consent card can name the asking session', async () => {
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await inv.invite({ roomId: 'r1', targetDeviceId: 7, targetConvoId: 'convo-remote', fromConvoId: 'convo-mine', justification: 'j' });
      expect(sendRoomOp).toHaveBeenCalledWith({
        op: 'agent_invite', room_id: 'r1', target_device_id: 7,
        target_convo_id: 'convo-remote', from_convo_id: 'convo-mine', justification: 'j',
      });
    });

    it('omits from_convo_id entirely when the session has no journal convo yet', async () => {
      // Same absent-never-null discipline as target_convo_id: the journal
      // validates a PRESENT from_convo_id against this device and fails the
      // whole invite on a mismatch, so a null would turn a missing label
      // into a failed chat.
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await inv.invite({ roomId: 'r1', targetDeviceId: 7, fromConvoId: null, justification: 'j' });
      expect('from_convo_id' in sendRoomOp.mock.calls[0][0]).toBe(false);
    });

    it('omits topic when not given', async () => {
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_invite', room_id: 'r1', target_device_id: 7, justification: 'j' });
      expect(sendRoomOp.mock.calls[0][0]).not.toHaveProperty('topic');
    });

    it('busy ack resolves pending_busy', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
    });

    it('refusal with reason resolves refused and marks the registry', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'heads-down', peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'heads-down', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('refused');
      expect(notifyRoom).not.toHaveBeenCalled(); // a waiter consumed the answer
    });

    it('expiry answer (no from_device_id) yields reason expired and state expired', async () => {
      const { inv, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'expired', peerDeviceId: undefined });
      expect(rooms.get('r1').state).toBe('expired');
    });

    it('offline error frame resolves {kind:error, code:offline}', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onOpError({ code: 'offline', ref: 'agent_invite', detail: 'peer offline' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'offline', detail: 'peer offline' });
    });

    it('ignores op errors with an unrelated ref', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onOpError({ code: 'bad_request', ref: 'convo_upsert' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
    });

    it('no delivered/error within the deliver window resolves pending_quiet (a documented outcome, not a raw timeout)', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('delivered but silence resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      // Stage waiters are armed up front, so the ack/answer window is
      // DELIVER+ANSWER from the send, not ANSWER from the delivered frame.
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('idle ack but no answer resolves pending_idle', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      // Answer waiter budget is DELIVER + 2*ANSWER from the send.
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(p).resolves.toEqual({ kind: 'pending_idle' });
    });

    it('sendRoomOp false resolves journal_unreachable without waiting', async () => {
      const { inv } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await expect(inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' }))
        .resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
    });
  });

  // ws emits every message from one TCP chunk synchronously in one tick, so
  // lifecycle frames can land back-to-back with no microtask gap. These tests
  // deliberately do NOT flush() between frames: every stage waiter must
  // already be armed when the batch drains.
  describe('same-tick frame batches', () => {
    it('invite: delivered+ack(idle)+answer(accept) in one tick returns the accept (no leak to notifyRoom)', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('joined');
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('invite: delivered+answer in one tick (no ack) returns the answer', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'heads-down', peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'heads-down', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('refused');
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('join: delivered+ack(idle)+answer(accept) in one tick returns the accept', async () => {
      const { inv, notifyRoom } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r2', accept: true, peer_device_id: 3, from_device_id: 3 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 3 });
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('frames settle only their own room; roomId-less op errors fan out to every in-flight invite (coarse, pinned)', async () => {
      const { inv } = makeInvites();
      const p1 = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      const p2 = inv.invite({ roomId: 'r2', targetDeviceId: 8, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p1).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      // r2 was untouched by r1's frames. Without a roomId (old journal) the
      // error correlation is ref-level: it settles EVERY in-flight invite —
      // acceptable because room ops serialize per tool call.
      inv.onOpError({ code: 'offline', ref: 'agent_invite', detail: 'peer offline' });
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'offline', detail: 'peer offline' });
    });
  });

  describe('roomId-correlated op errors (newer journals stamp room_id)', () => {
    it('settles exactly the named room even when another room armed an EARLIER waiter for the same ref', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' }); // older waiter, scan order
      const p2 = inv.invite({ roomId: 'r2', targetDeviceId: 8, justification: 'j' });
      inv.onOpError({ code: 'offline', ref: 'agent_invite', detail: 'peer offline', roomId: 'r2' });
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'offline', detail: 'peer offline' });
      // r1 was NOT settled by r2's error — it runs out its own clock.
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p1).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('a correlated error with no waiter for its room settles nothing (never leaks into another room\'s scan)', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite', detail: 'stale', roomId: 'r-gone' });
      // r1's in-flight invite still resolves by its own frames.
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
    });

    it('correlates leave errors by room across an eviction-style batch, regardless of arm order', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.leave({ roomId: 'r1' });
      const p2 = inv.leave({ roomId: 'r2' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'not a joined participant', roomId: 'r2' });
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'not a joined participant' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p1).resolves.toEqual({ kind: 'left' });
    });

    it('an UNSTAMPED error settles NOTHING while TWO rooms are armed for that ref (ambiguous)', async () => {
      // Eviction fires a BATCH of agent_leave ops. With two waiters armed for
      // the same ref an unstamped error names neither, and picking the first
      // is a coin flip whose wrong side is a false terminal 'left' on a room
      // that is still joined. Both must run out their own clocks instead.
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.leave({ roomId: 'r1' });
      const p2 = inv.leave({ roomId: 'r2' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'mystery' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p1).resolves.toEqual({ kind: 'left' });
      await expect(p2).resolves.toEqual({ kind: 'left' });
    });

    it('an UNSTAMPED error still settles the ONE room left armed after a stamped error (no capability latch)', async () => {
      // The rule is AMBIGUITY, not journal capability. A stamped frame proves
      // nothing about the next frame, so once the batch narrows to a single
      // armed room the fallback must still correlate — otherwise a journal
      // that stops stamping (a rollback) turns every leave/accept error into
      // a silent success for the rest of the process.
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.leave({ roomId: 'r1' });
      const p2 = inv.leave({ roomId: 'r2' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'r1 failed', roomId: 'r1' });
      await expect(p1).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'r1 failed' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'r2 failed' });
      // Advance before asserting so an unsettled p2 reads as a 'left' diff
      // rather than a hung test.
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'r2 failed' });
    });

    it('ambiguity is counted per REF: a waiter of another family is not a second match', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const pLeave = inv.leave({ roomId: 'r1' });
      const pAnswer = inv.answerAwait({ roomId: 'r2', accept: true });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'not a joined participant' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pLeave).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'not a joined participant' });
      await expect(pAnswer).resolves.toEqual({ kind: 'answered' });
    });

    it('an unstamped agent_invite_answer error cannot settle another room\'s in-flight ACCEPT', async () => {
      // Refuse stays fire-and-forget, so a refusal the journal rejects raises
      // an op error with no waiter of its own. Widening the ref allow-list let
      // that frame reach the fallback; the exactly-one rule keeps it from
      // stealing an unrelated accept (which would falsely expire that room).
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.answerAwait({ roomId: 'r1', accept: true });
      const p2 = inv.answerAwait({ roomId: 'r2', accept: true });
      inv.answer({ roomId: 'r3', peerDeviceId: null, accept: false, reason: 'busy' });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite_answer', detail: 'no such invite' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p1).resolves.toEqual({ kind: 'answered' });
      await expect(p2).resolves.toEqual({ kind: 'answered' });
    });
  });

  describe('join()', () => {
    it('happy path: delivered -> idle ack -> accept answer', async () => {
      const { inv, sendRoomOp } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'saw the roster entry' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_join', room_id: 'r2', justification: 'saw the roster entry' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r2', accept: true, peer_device_id: 3, from_device_id: 3 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 3 });
    });

    it('busy ack resolves pending_busy', async () => {
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
    });

    it('correlates error frames via ref agent_join', async () => {
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onOpError({ code: 'not_found', ref: 'agent_join' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'not_found', detail: undefined });
    });

    it('sendRoomOp false resolves journal_unreachable without waiting', async () => {
      const { inv } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await expect(inv.join({ roomId: 'r2', justification: 'j' }))
        .resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
    });

    it('no delivered/error within the deliver window resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('delivered but silence resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('idle ack but no answer resolves pending_idle', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(p).resolves.toEqual({ kind: 'pending_idle' });
    });
  });

  describe('ack / answer / leave senders', () => {
    it('ack sends session_state and includes peer_device_id only when given', () => {
      const { inv, sendRoomOp } = makeInvites();
      expect(inv.ack({ roomId: 'r1', peerDeviceId: 7, sessionState: 'busy' })).toBe(true);
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_ack', room_id: 'r1', peer_device_id: 7, session_state: 'busy' });
      inv.ack({ roomId: 'r1', sessionState: 'idle' });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_ack', room_id: 'r1', session_state: 'idle' });
    });

    it('answer sends accept and includes reason/peer_device_id only when given', () => {
      const { inv, sendRoomOp } = makeInvites();
      inv.answer({ roomId: 'r1', peerDeviceId: 7, accept: false, reason: 'busy week' });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_answer', room_id: 'r1', peer_device_id: 7, accept: false, reason: 'busy week' });
      inv.answer({ roomId: 'r1', accept: true });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_answer', room_id: 'r1', accept: true });
    });

    it('leave: sendRoomOp false resolves journal_unreachable without waiting', async () => {
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await expect(inv.leave({ roomId: 'r1' })).resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_leave', room_id: 'r1' });
    });

    it('leave: silence within the error window means the leave took (journal only answers on failure)', async () => {
      vi.useFakeTimers();
      const { inv, sendRoomOp } = makeInvites();
      const p = inv.leave({ roomId: 'r1' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_leave', room_id: 'r1' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'left' });
    });

    it('leave: an op error with ref agent_leave surfaces as the outcome (C2 — the OWNER\'s conflict)', async () => {
      const { inv } = makeInvites();
      const p = inv.leave({ roomId: 'r1' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'not a joined participant' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'not a joined participant' });
    });

    it('leave: op errors from other families never settle the leave waiter', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.leave({ roomId: 'r1' });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite', detail: 'unrelated' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'left' });
    });

    it('answerAwait: silence within the error window means the answer took (journal only answers on failure)', async () => {
      vi.useFakeTimers();
      const { inv, sendRoomOp } = makeInvites();
      const p = inv.answerAwait({ roomId: 'r1', peerDeviceId: null, accept: true });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_invite_answer', room_id: 'r1', accept: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'answered' });
    });

    it('answerAwait: includes peer_device_id and reason only when given', async () => {
      vi.useFakeTimers();
      const { inv, sendRoomOp } = makeInvites();
      const p = inv.answerAwait({ roomId: 'r1', peerDeviceId: 9, accept: true, reason: 'come in' });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_answer', room_id: 'r1', peer_device_id: 9, accept: true, reason: 'come in' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'answered' });
    });

    it('answerAwait: sendRoomOp false resolves journal_unreachable and cancels the armed waiter', async () => {
      vi.useFakeTimers();
      let sendOk = false;
      const { inv } = makeInvites({ sendRoomOp: vi.fn(() => sendOk) });
      await expect(inv.answerAwait({ roomId: 'r1', accept: true }))
        .resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
      // The abandoned r1 waiter was cancelled, so it is not a GHOST second
      // match under the exactly-one rule: the next unstamped error still
      // correlates to the one genuinely in-flight accept. Leave the ghost
      // armed and r2 goes ambiguous — it would report 'answered' for an
      // accept the journal actually rejected, and join a dead room.
      sendOk = true;
      const p2 = inv.answerAwait({ roomId: 'r2', accept: true });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite_answer', detail: 'invite expired' });
      // Advance first so an unsettled p2 resolves to its 'answered' timeout
      // and the failure reads as a diff rather than a hung test.
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'invite expired' });
    });

    it('answerAwait arms its error waiter BEFORE the send, so a synchronously-drained error still lands', async () => {
      vi.useFakeTimers();
      let inv;
      // The socket can drain the journal's reply into onOpError inside the
      // same tick as the write; a waiter armed after sendRoomOp misses it and
      // the caller reports 'answered' for a rejected answer.
      const sendRoomOp = vi.fn((frame) => {
        inv.onOpError({ code: 'conflict', ref: 'agent_invite_answer', detail: 'invite expired', roomId: frame.room_id });
        return true;
      });
      ({ inv } = makeInvites({ sendRoomOp }));
      const p = inv.answerAwait({ roomId: 'r1', accept: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'invite expired' });
    });

    it('answerAwait: a stamped agent_invite_answer error is the outcome and settles ONLY its own room (Major 1 interplay)', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.answerAwait({ roomId: 'r1', accept: true });
      const p2 = inv.answerAwait({ roomId: 'r2', accept: true });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite_answer', detail: 'invite expired', roomId: 'r1' });
      await expect(p1).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'invite expired' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p2).resolves.toEqual({ kind: 'answered' });
    });

    it('answerAwait: an UNSTAMPED agent_invite_answer error (old journal) still settles via the ref-level scan', async () => {
      const { inv } = makeInvites();
      const p = inv.answerAwait({ roomId: 'r1', accept: true });
      inv.onOpError({ code: 'conflict', ref: 'agent_invite_answer', detail: 'invite expired' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'conflict', detail: 'invite expired' });
    });

    it('leave: an unstamped error frame settles NO leave waiter while two are in flight', async () => {
      // Eviction fires a BATCH of agent_leave ops; one uncorrelatable
      // conflict must not be pinned on whichever leave armed first. Both fall
      // through to their own timeouts. (A stamped frame still settles exactly
      // its own room — see the roomId-correlated block.)
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p1 = inv.leave({ roomId: 'r1' });
      const p2 = inv.leave({ roomId: 'r2' });
      inv.onOpError({ code: 'conflict', ref: 'agent_leave', detail: 'not a joined participant' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p1).resolves.toEqual({ kind: 'left' });
      await expect(p2).resolves.toEqual({ kind: 'left' });
    });
  });

  describe('onInviteFrame (inbound, no waiter)', () => {
    it('late accept answer with no waiter notifies the room', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
      expect(rooms.get('r1').state).toBe('joined');
    });

    it('late refusal with no waiter notifies with the reason', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'nope', peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'refused the chat: nope');
      expect(rooms.get('r1').state).toBe('refused');
    });

    it('a replayed/duplicate answer does not resurrect a terminal room', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      rooms.setState('r1', 'joined');
      rooms.record('r1', { role: 'owner', state: 'left', sessionRoomId: '!sess' }); // chatLeave stamped it
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('left');
      // Late-answer notify still fires; only the state transition is gated.
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
    });

    it('a peer refusal whose reason text is literally "expired" is refused, not expired', () => {
      const { inv, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'expired', peer_device_id: 7, from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('refused');
    });

    it('left marks a known room state=left so it goes inactive (routing/chatSend stop)', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'r1', from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('left');
      expect(rooms.isActive('r1')).toBe(false);
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'left the room');
    });

    it('answer for an unknown room settles nothing and never notifies', () => {
      const { inv, notifyRoom, rooms } = makeInvites();
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'ghost', accept: true, peer_device_id: 7 })).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled();
      expect(rooms.get('ghost')).toBeNull();
    });

    it('request and join_request are handed to injectRequestTurn with the frame', () => {
      const { inv, injectRequestTurn } = makeInvites();
      const req = { kind: 'invite', event: 'request', room_id: 'r1', from_device_id: 7, justification: 'j' };
      const joinReq = { kind: 'invite', event: 'join_request', room_id: 'r1', from_device_id: 8, justification: 'k' };
      inv.onInviteFrame(req);
      inv.onInviteFrame(joinReq);
      expect(injectRequestTurn).toHaveBeenNthCalledWith(1, req);
      expect(injectRequestTurn).toHaveBeenNthCalledWith(2, joinReq);
    });

    it('a throwing injectRequestTurn is swallowed and warned', () => {
      const { inv, log } = makeInvites({ injectRequestTurn: vi.fn(() => { throw new Error('boom'); }) });
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'request', room_id: 'r1' })).not.toThrow();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('left notifies known rooms only and swallows a throwing notifyRoom', () => {
      const { inv, rooms, notifyRoom } = makeInvites({ notifyRoom: vi.fn(() => { throw new Error('down'); }) });
      rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess' });
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'r1', from_device_id: 7 })).not.toThrow();
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'left the room');
      notifyRoom.mockClear();
      inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'ghost', from_device_id: 7 });
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('unknown events are ignored', () => {
      const { inv } = makeInvites();
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'mystery', room_id: 'r1' })).not.toThrow();
    });
  });

  describe('waiter cleanup', () => {
    it('replaying every frame after resolution is a safe no-op (waiters drained)', async () => {
      const { inv, notifyRoom } = makeInvites(); // room never recorded -> answer path settles only
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      const frames = [
        { kind: 'invite', event: 'delivered', room_id: 'r1' },
        { kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' },
        { kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 },
      ];
      for (const f of frames) { inv.onInviteFrame(f); await flush(); }
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      // Double-settle safety: nothing is waiting anymore, so replays do nothing.
      expect(() => { for (const f of frames) inv.onInviteFrame(f); }).not.toThrow();
      expect(() => inv.onOpError({ code: 'offline', ref: 'agent_invite' })).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('timed-out and cancelled waiters are unhooked: late frames after a deliver timeout settle nothing', async () => {
      vi.useFakeTimers();
      const { inv, notifyRoom } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
      // The up-front outcome/answer waiters must be cancelled on this path too.
      expect(() => {
        inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
        inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
        inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      }).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled(); // room never recorded
    });

    it('after pending_busy the abandoned answer waiter is cancelled: a late answer surfaces via notifyRoom', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
      // If the armed answer waiter leaked, settleReturns would report true
      // and this genuinely late answer would be swallowed silently.
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
      expect(rooms.get('r1').state).toBe('joined');
    });
  });
});

// The USER-facing half of an inbound request (index.js publishes this via
// journalPublishNotice into the convo where the decision is made). Every
// field here is written by a REMOTE agent, so these are security tests as
// much as formatting ones.
describe('formatInviteRequestNotice', () => {
  const request = { event: 'request', room_id: 'room-1', from_device_id: 7, from_name: 'dev-2', topic: 'ci triage', justification: 'the build is red' };
  const join = { event: 'join_request', room_id: 'room-1', from_device_id: 9, from_name: 'laptop', justification: 'I have the logs' };

  it('names the asker, the topic and the justification verbatim', () => {
    expect(formatInviteRequestNotice(request))
      .toBe('🤝 Agent "dev-2" requests a chat with this session about "ci triage": the build is red');
  });

  it('omits the topic clause when there is none', () => {
    expect(formatInviteRequestNotice({ ...request, topic: undefined }))
      .toBe('🤝 Agent "dev-2" requests a chat with this session: the build is red');
  });

  it('omits the justification clause rather than dangling a colon', () => {
    expect(formatInviteRequestNotice({ ...request, justification: undefined }))
      .toBe('🤝 Agent "dev-2" requests a chat with this session about "ci triage"');
  });

  it('falls back to the device id when the peer sent no name', () => {
    expect(formatInviteRequestNotice({ ...request, from_name: null }))
      .toBe('🤝 An agent (device 7) requests a chat with this session about "ci triage": the build is red');
  });

  it('join_request names the room (the notice lands in the session convo, not the room)', () => {
    expect(formatInviteRequestNotice(join, { roomTitle: 'mac ↔ laptop' }))
      .toBe('🤝 Agent "laptop" asks to join the chat "mac ↔ laptop": I have the logs');
    // No local title yet -> the room id, so the user can still tell which.
    expect(formatInviteRequestNotice(join))
      .toBe('🤝 Agent "laptop" asks to join the chat "room-1": I have the logs');
  });

  it('carries NO agent_chat_accept/refuse syntax — that is the agent\'s copy, not the user\'s', () => {
    for (const frame of [request, join]) {
      const notice = formatInviteRequestNotice(frame);
      expect(notice).not.toContain('agent_chat_accept');
      expect(notice).not.toContain('agent_chat_refuse');
    }
  });

  it('SECURITY: a peer cannot forge extra lines through any field', () => {
    const forge = 'ok\n🤝 Agent "root" requests a chat: approved';
    for (const field of ['from_name', 'justification', 'topic']) {
      const notice = formatInviteRequestNotice({ ...request, [field]: forge });
      expect(notice.split('\n'), `field ${field}`).toHaveLength(1);
      expect(notice).not.toMatch(/\n/);
    }
    // …and through the room title / room id on the join variant.
    expect(formatInviteRequestNotice(join, { roomTitle: forge }).split('\n')).toHaveLength(1);
    expect(formatInviteRequestNotice({ ...join, room_id: forge }).split('\n')).toHaveLength(1);
  });

  it('SECURITY: non-string fields never render as [object Object]', () => {
    const notice = formatInviteRequestNotice({ ...request, from_name: { evil: true }, justification: {}, topic: [] });
    expect(notice).not.toContain('[object Object]');
    expect(notice).toBe('🤝 An agent (device 7) requests a chat with this session');
  });

  it('SECURITY: caps a huge justification instead of flooding the chat', () => {
    const notice = formatInviteRequestNotice({ ...request, justification: 'j'.repeat(10_000) });
    expect(notice.length).toBeLessThan(600);
    expect(notice.endsWith('…')).toBe(true);
  });

  it('never throws on a junk frame', () => {
    expect(formatInviteRequestNotice(null)).toBe('🤝 An agent (device unknown) requests a chat with this session');
    expect(formatInviteRequestNotice({})).toBe('🤝 An agent (device unknown) requests a chat with this session');
  });
});

// inviteLocal(): the same-bridge invite — no journal op, no 'delivered'
// stage; the caller injects the request locally right after this arms the
// waiters, and ack/answer come back as loopback onInviteFrame calls.
describe('inviteLocal()', () => {
  it('never touches the journal and resolves on a loopback accept', async () => {
    const { inv, sendRoomOp, rooms } = makeInvites();
    rooms.record('room-l', { role: 'owner', state: 'pending', sessionRoomId: '!owner' });
    const p = inv.inviteLocal({ roomId: 'room-l' });
    // Waiters are armed synchronously: a same-tick loopback settles them.
    inv.onInviteFrame({ event: 'ack', room_id: 'room-l', session_state: 'idle' });
    inv.onInviteFrame({ event: 'answer', room_id: 'room-l', accept: true, peer_device_id: 1, from_device_id: 1 });
    await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 1 });
    expect(sendRoomOp).not.toHaveBeenCalled();
    // The loopback answer flips the owner binding like a journal one.
    expect(rooms.get('room-l').state).toBe('joined');
  });

  it('maps a busy loopback ack to pending_busy', async () => {
    const { inv, sendRoomOp } = makeInvites();
    const p = inv.inviteLocal({ roomId: 'room-l' });
    inv.onInviteFrame({ event: 'ack', room_id: 'room-l', session_state: 'busy' });
    await expect(p).resolves.toEqual({ kind: 'pending_busy' });
    expect(sendRoomOp).not.toHaveBeenCalled();
  });

  it('surfaces a loopback refusal with its reason, not as an expiry', async () => {
    const { inv, rooms } = makeInvites();
    rooms.record('room-l', { role: 'owner', state: 'pending', sessionRoomId: '!owner' });
    const p = inv.inviteLocal({ roomId: 'room-l' });
    inv.onInviteFrame({ event: 'answer', room_id: 'room-l', accept: false, reason: 'mid-deploy', from_device_id: 1 });
    await expect(p).resolves.toMatchObject({ kind: 'refused', reason: 'mid-deploy' });
    expect(rooms.get('room-l').state).toBe('refused');
  });
});
