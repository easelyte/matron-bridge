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
// Returns `{session, addressed}`:
//   session   — the session to ask, or null when there is nobody to ask
//   addressed — whether the frame actually NAMED this session, as opposed to
//               being routed here by a guess. Callers must not write into a
//               session's user-visible conversation on a guess.
export function resolveInviteTarget(frame, room, { sessions, findSessionByConvoId } = {}) {
  // A join_request is about a room THIS bridge already owns, so the room
  // record itself is the address — always exact, never a guess.
  if (frame.event === 'join_request') {
    const session = room ? sessions.get(room.sessionRoomId) : null;
    return { session: session && session.alive ? session : null, addressed: true };
  }
  // Addressed: the caller named one of this device's conversations and the
  // journal verified the device owns it. Exact, or nobody — falling back to
  // another session here would recreate the bug this field exists to fix.
  if (frame.target_convo_id) {
    const session = findSessionByConvoId(frame.target_convo_id);
    return { session: session && session.alive ? session : null, addressed: true };
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
  return { session: best, addressed: false };
}
