// Per-room once-listener registry backing agent_chat_send's optional short
// reply wait (the awaitRoomMessage dep of lib/agent-chat.js). Register
// before arming the timeout, resolve {from, body} on the first inbound room
// message for that room, null on timeout, always unhook — empty sets are
// pruned so the map never grows past the set of rooms with live waiters.
//
// resolve() reports whether any waiter consumed the reply: a consumed reply
// is already in the agent's hands as the tool result of the wait, so the
// caller (index.js journalOnRoomFrame) must then SKIP room delivery — the
// session is busy for the whole tool call, and delivering anyway would queue
// the same message and wake the agent with a duplicate injected turn at turn
// end. The journal keeps the durable copy; agent_chat_read recovers.
//
// setTimeout/clearTimeout are injectable for tests (fake timers not needed).
export function createRoomReplyWaiters({
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  // chatRoomId -> Set<fn(reply)>
  const byRoom = new Map();
  return {
    // -> Promise<{from, body} | null> (null on timeout). Multiple concurrent
    // waiters on one room all settle on the first reply.
    await(chatRoomId, ms) {
      return new Promise((resolve) => {
        let waiters = byRoom.get(chatRoomId);
        if (!waiters) { waiters = new Set(); byRoom.set(chatRoomId, waiters); }
        const timer = setTimer(() => { unhook(); resolve(null); }, ms);
        const entry = (reply) => { clearTimer(timer); unhook(); resolve(reply); };
        function unhook() {
          waiters.delete(entry);
          if (waiters.size === 0) byRoom.delete(chatRoomId);
        }
        waiters.add(entry);
      });
    },
    // -> true when >=1 waiter consumed the reply (see header: the caller
    //    then skips room delivery), false when nobody was waiting.
    resolve(chatRoomId, reply) {
      const waiters = byRoom.get(chatRoomId);
      if (!waiters) return false;
      for (const entry of [...waiters]) entry(reply);
      return true;
    },
    // Test/introspection seam: live waiter count for a room.
    waiterCount(chatRoomId) { return byRoom.get(chatRoomId)?.size || 0; },
  };
}
