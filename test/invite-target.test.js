import { describe, it, expect } from 'vitest';
import { resolveInviteTarget } from '../lib/invite-target.js';

// The routing rule that decides whose conversation an inbound chat request
// lands in. Before target_convo_id existed this guessed, and on 2026-08-08 it
// guessed wrong in the wild — a yearbook agent's coordination message
// surfaced in an unrelated chat of Dan's.

function makeSessions(specs) {
  const sessions = new Map();
  for (const [roomId, s] of Object.entries(specs)) {
    sessions.set(roomId, { roomId, alive: true, ...s });
  }
  const findSessionByConvoId = (convoId) => {
    for (const s of sessions.values()) if (s.journalConvoId === convoId) return s;
    return null;
  };
  return { sessions, findSessionByConvoId };
}

// Three live sessions where the most recently active is deliberately NOT the
// one that owns the addressed conversation — so a test that passes by
// accident (falling through to the old guess) cannot look correct.
const fleet = () => makeSessions({
  '!a': { journalConvoId: 'convo-a', lastActivityAt: 100 },
  '!b': { journalConvoId: 'convo-b', lastActivityAt: 200 },
  '!c': { journalConvoId: 'convo-c', lastActivityAt: 999 },
});

describe('resolveInviteTarget', () => {
  describe('an addressed request', () => {
    it('goes to the session that owns the named conversation, not the busiest one', () => {
      const deps = fleet();
      const { session, addressed } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-a' }, null, deps,
      );
      expect(session.roomId).toBe('!a');
      expect(addressed).toBe(true);
    });

    it('resolves to nobody rather than falling back when that session is gone', () => {
      const deps = fleet();
      // The whole point: an ask for a conversation that isn't running here
      // must be refused. Falling back to another live session is exactly the
      // bug — it would hand a stranger's request to an unrelated agent.
      const { session, addressed } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-gone' }, null, deps,
      );
      expect(session).toBe(null);
      expect(addressed).toBe(true);
    });

    it('treats a dead session as no session', () => {
      const deps = fleet();
      deps.sessions.get('!a').alive = false;
      const { session } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-a' }, null, deps,
      );
      expect(session).toBe(null);
    });
  });

  describe('an unaddressed request (a peer bridge predating target_convo_id)', () => {
    it('falls back to the most recently active session, and says it guessed', () => {
      const deps = fleet();
      const { session, addressed } = resolveInviteTarget(
        { event: 'request', room_id: 'r1' }, null, deps,
      );
      expect(session.roomId).toBe('!c');
      expect(addressed).toBe(false);
    });

    it('skips dead sessions when guessing', () => {
      const deps = fleet();
      deps.sessions.get('!c').alive = false;
      const { session, addressed } = resolveInviteTarget(
        { event: 'request', room_id: 'r1' }, null, deps,
      );
      expect(session.roomId).toBe('!b');
      expect(addressed).toBe(false);
    });

    it('has nobody to ask when nothing is live', () => {
      const deps = fleet();
      for (const s of deps.sessions.values()) s.alive = false;
      const { session, addressed } = resolveInviteTarget(
        { event: 'request', room_id: 'r1' }, null, deps,
      );
      expect(session).toBe(null);
      expect(addressed).toBe(false);
    });
  });

  describe('a join_request', () => {
    it('goes to the session bound to the room, and is always addressed', () => {
      const deps = fleet();
      // This bridge already owns the room, so the room record IS the
      // address — never a guess, even though a target_convo_id is absent.
      const { session, addressed } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, { sessionRoomId: '!a' }, deps,
      );
      expect(session.roomId).toBe('!a');
      expect(addressed).toBe(true);
    });

    it('resolves to nobody for an unknown room, without guessing', () => {
      const deps = fleet();
      const { session, addressed } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, null, deps,
      );
      expect(session).toBe(null);
      expect(addressed).toBe(true);
    });
  });

  // The wake candidate: WHICH sleeping session, if any, the caller should try
  // to resume before refusing the peer. A reaped session is resumable (that is
  // the whole premise of the idle reaper), so an addressed request finding no
  // live session is not the end of the story — but only where the address is
  // exact. Resolution stays pure: naming the candidate is this function's job,
  // deciding whether it is actually on disk is index.js's.
  describe('the wake candidate', () => {
    it('names the addressed conversation when its session is not running', () => {
      const deps = fleet();
      const { session, wake } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-gone' }, null, deps,
      );
      expect(session).toBe(null);
      expect(wake).toEqual({ kind: 'convo', id: 'convo-gone' });
    });

    it('names the addressed conversation when its session is dead rather than absent', () => {
      const deps = fleet();
      deps.sessions.get('!a').alive = false;
      const { session, wake } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-a' }, null, deps,
      );
      expect(session).toBe(null);
      expect(wake).toEqual({ kind: 'convo', id: 'convo-a' });
    });

    it('names the room-bound session for a join_request whose session is not running', () => {
      const deps = { ...fleet(), roomIsActive: () => true };
      deps.sessions.get('!a').alive = false;
      const { session, wake } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, { sessionRoomId: '!a' }, deps,
      );
      expect(session).toBe(null);
      expect(wake).toEqual({ kind: 'room', id: '!a' });
    });

    it('has nothing to wake for a join_request about an unknown room', () => {
      const deps = { ...fleet(), roomIsActive: () => true };
      const { wake } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, null, deps,
      );
      expect(wake).toBe(null);
    });

    // Bugbot #220: the idle reaper's own teardown (journalEvictConvoInput)
    // sets every 'joined' room of the dying session to 'left' and tells the
    // peer. So the very case a room wake looks like it serves is, after a
    // reap, one answerInvite refuses outright — "room X is left, start a new
    // room instead of admitting into a dead one". Waking for it would spawn a
    // claude process to surface an ask the agent structurally cannot accept.
    //
    // The gate is answerInvite's OWN predicate, injected rather than
    // reimplemented, so the two can't drift into disagreeing about which
    // rooms are worth waking for.
    it('has nothing to wake for a join_request about a room that is no longer active', () => {
      const deps = { ...fleet(), roomIsActive: () => false };
      deps.sessions.get('!a').alive = false;
      const { session, wake } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, { sessionRoomId: '!a', state: 'left' }, deps,
      );
      expect(session).toBe(null);
      expect(wake).toBe(null);
    });

    it('asks about the room by its ROOM id, not the session key', () => {
      // The predicate is answerInvite's, and answerInvite keys it on the chat
      // room id — passing sessionRoomId would silently always miss.
      const seen = [];
      const deps = { ...fleet(), roomIsActive: (id) => { seen.push(id); return true; } };
      deps.sessions.get('!a').alive = false;
      resolveInviteTarget({ event: 'join_request', room_id: 'r1' }, { sessionRoomId: '!a' }, deps);
      expect(seen).toEqual(['r1']);
    });

    // Fail CLOSED: a caller that cannot say whether the room is live has not
    // earned a process spawn. The absent-dep default is the whole reason this
    // bug existed, so it must not be "assume active".
    it('has nothing to wake for a join_request when no liveness predicate is supplied', () => {
      const deps = fleet();
      deps.sessions.get('!a').alive = false;
      const { wake } = resolveInviteTarget(
        { event: 'join_request', room_id: 'r1' }, { sessionRoomId: '!a' }, deps,
      );
      expect(wake).toBe(null);
    });

    it('has nothing to wake for an unaddressed request, even with sleepers on the box', () => {
      const deps = fleet();
      // The unaddressed path reaches a session by GUESSING among the live
      // ones. Waking a guessed-at sleeper would spawn a process for a request
      // that was never aimed at it — strictly worse than refusing.
      for (const s of deps.sessions.values()) s.alive = false;
      const { session, wake } = resolveInviteTarget(
        { event: 'request', room_id: 'r1' }, null, deps,
      );
      expect(session).toBe(null);
      expect(wake).toBe(null);
    });

    it('is null whenever a live session was found', () => {
      const deps = fleet();
      const { session, wake } = resolveInviteTarget(
        { event: 'request', room_id: 'r1', target_convo_id: 'convo-a' }, null, deps,
      );
      expect(session.roomId).toBe('!a');
      expect(wake).toBe(null);
    });
  });
});
