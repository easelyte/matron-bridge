// Resolve which live session a /share-sensitive roomId refers to.
//
// The share notification is posted into the room the caller names; a stale
// or mistyped roomId used to be accepted silently, landing the notification
// in another chat (or nowhere). Callers must get either a hard rejection
// (no live session) or a human-readable description of the chat that was
// notified, so a wrong-but-live room is immediately visible.

import path from 'node:path';

function describeSession(roomId, session) {
  const title = session._journalTitleHint
    || (session.workdir ? path.basename(session.workdir) : null)
    || '(untitled)';
  return `"${title}" (room ${roomId})`;
}

// Being alive is not the same as being reachable: sessions are constructed
// with sendCallback/sendHtml null and have them attached afterwards, so
// there is a real window where a live session cannot be messaged. Resolving
// such a session as OK is how the caller ended up being told a notification
// was posted when none was — and an unannounced share is worse than a failed
// one, because the agent holding the link must never paste it into chat
// itself. Both conditions are checked here so the one send path downstream
// cannot disagree with what this reports.
function canNotify(session) {
  return session.alive !== false && Boolean(session.sendHtml || session.sendCallback);
}

export function resolveShareTarget(sessions, roomId) {
  const session = sessions.get(roomId);
  if (session && canNotify(session)) {
    // The session itself rides along so the caller sends through the exact
    // object that was vetted, rather than looking the room up a second time.
    return { ok: true, description: describeSession(roomId, session), session };
  }
  const live = [...sessions.entries()]
    .filter(([, s]) => canNotify(s))
    .map(([id, s]) => describeSession(id, s));
  const why = session && session.alive !== false
    ? `roomId ${roomId} has a live session with no send channel attached yet`
    : `roomId ${roomId} has no live session`;
  return {
    ok: false,
    error: `${why} — refusing to create a share whose `
      + `notification cannot reach its chat. Live sessions: ${live.join('; ') || '(none)'}`,
  };
}
