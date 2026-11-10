// Room frames that arrive while the bridge is still joining a room on the
// agent's behalf (an approved invite joins on delivery).
//
// Joining takes journal round trips: the accept, then a read of what the room
// has said so far, which the "you are now in a room" turn carries. The other
// side hears the join as soon as the accept lands and may write at once, so a
// live message can reach this bridge before that turn has been handed to the
// session. Delivered straight away, it would reach the agent first, and the
// same message would come again in the turn's backlog.
//
// So frames for a room being joined are held, and released once the join turn
// is delivered, minus any the backlog already carried (same journal seq). The
// hold has a deadline: a join that never finishes must not swallow the room.
//
// Items are opaque to this module apart from `frame.seq`; the caller stores
// whatever it needs to deliver one later.

export const JOIN_HOLD_MAX_MS = 60_000;

export function createJoinHold({ maxMs = JOIN_HOLD_MAX_MS, now = Date.now } = {}) {
  // roomId -> { at, items: [{ frame, ... }] }
  const held = new Map();

  return {
    // Start holding a room's frames. Starting again keeps what is held.
    hold(roomId) {
      if (!held.has(roomId)) held.set(roomId, { at: now(), items: [] });
    },

    isHeld(roomId) {
      return held.has(roomId);
    },

    // An item for a room. Returns the items to deliver now, in order: none
    // while the room is held, the item itself when it is not, and everything
    // held so far plus the item once the hold is past its deadline.
    offer(roomId, item) {
      const h = held.get(roomId);
      if (!h) return [item];
      if (now() - h.at > maxMs) {
        held.delete(roomId);
        return [...h.items, item];
      }
      h.items.push(item);
      return [];
    },

    // End the hold. Returns the held items the join turn did not already
    // carry: `events` is the backlog it showed (journal events with `seq`).
    // null or a non-array (the backlog could not be read) drops nothing.
    release(roomId, events = null) {
      const h = held.get(roomId);
      held.delete(roomId);
      if (!h) return [];
      const shown = new Set(Array.isArray(events)
        ? events.map((e) => e?.seq).filter(Number.isInteger)
        : []);
      return h.items.filter((it) => !Number.isInteger(it?.frame?.seq) || !shown.has(it.frame.seq));
    },
  };
}
