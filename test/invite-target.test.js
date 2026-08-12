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
});
