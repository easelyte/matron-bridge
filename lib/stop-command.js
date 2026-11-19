// The /stop sequence: kill the session's process, take the session off the
// live map, settle its published state, and tell the user it stopped.
//
// `sendReply` is the session's own reply path, and it publishes only while
// the session is still on the live map. So the confirmation is started after
// the kill (whatever the kill reports comes first) and before the session
// leaves the map; sent any later it is dropped without a word. The rest of
// the teardown stays synchronous and does not wait on the reply, so a failed
// reply cannot leave a dead session on the map.

export const STOP_CONFIRMATION = 'Session stopped.';

/**
 * @param {object} o
 * @param {Map<string, unknown>} o.sessions the live session map
 * @param {string} o.roomId the key of the session being stopped
 * @param {() => void} o.kill kills the session's process
 * @param {() => void} o.settle publishes the stopped state, after the session is off the map
 * @param {(text: string) => unknown} o.sendReply the session's reply path
 */
export async function stopSessionAndConfirm({ sessions, roomId, kill, settle, sendReply }) {
  kill();
  // The async wrapper turns a synchronous throw into a rejection too.
  const confirmed = (async () => sendReply(STOP_CONFIRMATION))();
  sessions.delete(roomId);
  settle();
  await confirmed;
}
