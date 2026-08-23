// Which local session an inbound agent-chat invite is FOR.
//
// Extracted from index.js so the routing rule — the one that decides whose
// conversation a stranger's chat request lands in — is a pure function with
// tests, rather than a branch that can only be exercised by standing up two
// bridges.
//
// The history it encodes: an agent picks a CONVERSATION off agent_roster,
// but the invite used to carry only that conversation's owning DEVICE. A
// bridge running several sessions could not tell which was meant, so it
// guessed at its most recently active one, bound the room there, and
// published the user's copy of the request into that unrelated chat. On
// 2026-08-08 that put a yearbook agent's maintenance-window chatter into a
// completely unrelated conversation of Dan's.
//
// deps:
//   sessions              — Map of sessionRoomId -> session (index.js's own)
//   findSessionByConvoId  — (convoId) => session|null, the journal return
//                           path's existing reverse lookup
//
// Returns `{session, addressed, wake}`:
//   session   — the session to ask, or null when there is nobody to ask
//   addressed — whether the frame actually NAMED this session, as opposed to
//               being routed here by a guess. Callers must not write into a
//               session's user-visible conversation on a guess.
//   wake      — when there is no live session but the request named an EXACT
//               target, which sleeper the caller should try to resume before
//               refusing the peer: {kind:'convo'|'room', id}. The idle reaper
//               kills sessions precisely because they are resumable, so "no
//               live session" is not the same fact as "no session" — a reaped
//               target used to refuse the peer outright. Null whenever a live
//               session was found, and null on the unaddressed path: that one
//               reaches a session by GUESSING among the live ones, and waking
//               a guessed-at sleeper would spawn a process for a request that
//               was never aimed at it.
//
//               Naming the candidate is all this function does — whether the
//               id is actually resumable (i.e. on disk in the persisted
//               sessions) is the caller's question, which keeps the routing
//               rule pure and testable.
export function resolveInviteTarget(frame, room, { sessions, findSessionByConvoId, roomIsActive } = {}) {
  // A join_request is about a room THIS bridge already owns, so the room
  // record itself is the address — always exact, never a guess.
  if (frame.event === 'join_request') {
    const session = room ? sessions.get(room.sessionRoomId) : null;
    if (session && session.alive) return { session, addressed: true, wake: null };
    // The room record survives an idle reap (it is persisted), so its
    // sessionRoomId still names the session that owns this room — but only
    // wake for a room the woken agent could actually admit anyone into.
    //
    // The reaper's own teardown (journalEvictConvoInput) sets every 'joined'
    // room of the dying session to 'left' and tells the peer, so after a reap
    // the obvious case here is one answerInvite refuses outright ("room X is
    // left — start a new room instead of admitting into a dead one"). Waking
    // for that would spawn a claude process purely to surface an ask that
    // cannot succeed (Bugbot, #220). What survives is the case no teardown ran
    // for: a bridge that died without a clean shutdown, whose 'joined' rooms
    // are still on disk with no live session behind them.
    //
    // roomIsActive is answerInvite's OWN predicate, injected rather than
    // reimplemented, so the two cannot drift into disagreeing about which
    // rooms are worth waking for — and keyed on the ROOM id, as answerInvite
    // keys it. Absent, it fails CLOSED: a caller that cannot say whether the
    // room is live has not earned a process spawn, and "assume active" is
    // exactly the default that made this a bug.
    const wakeable = room && roomIsActive && roomIsActive(frame.room_id);
    return { session: null, addressed: true, wake: wakeable ? { kind: 'room', id: room.sessionRoomId } : null };
  }
  // Addressed: the caller named one of this device's conversations and the
  // journal verified the device owns it. Exact, or nobody — falling back to
  // another session here would recreate the bug this field exists to fix.
  if (frame.target_convo_id) {
    const session = findSessionByConvoId(frame.target_convo_id);
    if (session && session.alive) return { session, addressed: true, wake: null };
    return { session: null, addressed: true, wake: { kind: 'convo', id: frame.target_convo_id } };
  }
  // Unaddressed: a peer bridge predating target_convo_id. Route to the most
  // recently active live session so the feature still works against older
  // bridges — the request text carries the room id, so the agent can hand
  // off — but say plainly that this was a guess.
  let best = null;
  for (const session of sessions.values()) {
    if (!session.alive) continue;
    if (!best || (session.lastActivityAt || 0) > (best.lastActivityAt || 0)) best = session;
  }
  return { session: best, addressed: false, wake: null };
}
