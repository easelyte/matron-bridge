// How a transfer ended, told to the session that sent it (lib/transfer-
// sender.js notify). An upload can outlast the idle reap, so the line goes
// through the room delivery path the receiver uses (index.js
// deliverRoomFrameTo, with the sending session's binding): the mute gate,
// busy coalescing, and the wake of a reaped conversation all apply.
//
// The journal also writes its own lines into the room (declined, delivered,
// expired, failed), but under the `journal` sender, which the input router
// never routes to a session; this is the session's only copy.

// getRoom(roomId) -> the room binding (lib/agent-rooms.js) or null.
// deliverRoomFrameTo(binding, frame) -> delivers one frame to binding.sessionRoomId.
export function createTransferOutcomeNotify({ getRoom, deliverRoomFrameTo, log = console, now = Date.now } = {}) {
  return function notify({ sessionKey, roomId, text } = {}) {
    const room = roomId ? getRoom(roomId) : null;
    const bound = !!room && sessionKey != null
      && (room.sessionRoomId === sessionKey || room.guestSessionRoomId === sessionKey);
    if (!bound) {
      try { log.log?.(`[transfer] no room binding for ${sessionKey || '(none)'} to tell: ${text}`); } catch { /* best effort */ }
      return false;
    }
    deliverRoomFrameTo({ ...room, sessionRoomId: sessionKey }, {
      convo_id: roomId, type: 'text', sender: 'bridge', payload: { body: text }, ts: now(),
    });
    return true;
  };
}
