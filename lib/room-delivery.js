// Hybrid idle/busy delivery of agent-chat room messages into local sessions
// (spec: agent chat phase 3, "Delivery model"). An idle session gets one
// immediate injected turn per room message; a busy session accumulates
// messages in an in-memory pending inbox that is flushed as ONE coalesced
// "room update" turn when the turn ends. The pending inbox is in-memory only
// (same stance as the router's prompt state): a bridge restart loses pending
// room messages, but the room's content is durable in the journal and
// `agent_chat_read` recovers it. Flush makes exactly one delivery attempt —
// messages are NOT re-queued on an injectTurn refusal; the journal is the
// durable copy.
//
// deps:
//   isBusy(session) -> bool                     (reads session.busy)
//   injectTurn(session, text) -> bool           (sendTextToSession skipJournalMirror)
//   log

import { oneLine, quotedField, peerField, PEER_NAME_MAX, PEER_TOPIC_MAX, PEER_REASON_MAX } from './peer-text.js';

// The USER-facing rendering of one inbound room message, published into the
// session's own conversation as a notice.
//
// Why it exists: the agent-facing line below is injected with
// skipJournalMirror, so until now an inbound peer message never appeared in
// the user's chat at all — only the agent's REPLY to it did. Dan's words for
// what that looks like from the outside: "it just looks like random messages
// turning up" (2026-08-08). This is the missing half of the exchange, and it
// names the machine the message came from so the reply below it has a
// visible cause.
//
// Every interpolated field is peer-controlled, so all of them are flattened
// and capped, and quoted segments are escaped — same discipline as
// formatOne, for the same reason (a body must not be able to forge a header
// line). Published from:'assistant' by the caller, never from:'user': every
// word here was written by a remote agent, and rendering it as Dan's own
// message would let a peer put words in his mouth in his own chat.
export function formatRoomMessageNotice({ from, body, roomTitle, roomId } = {}) {
  const who = peerField(from, PEER_NAME_MAX) || 'an agent';
  const where = peerField(roomTitle, PEER_TOPIC_MAX) || peerField(roomId, PEER_TOPIC_MAX);
  const text = peerField(body, PEER_REASON_MAX);
  return `💬 ${quotedField(who)}${where ? ` in "${quotedField(where)}"` : ''}: ${text}`;
}

// The two halves of the QUEUED state, in the same user-facing voice as the
// notice above and published into the same conversation.
//
// Why it needs saying: `deliver` has two branches that look identical from
// Dan's chair. An idle session gets the message injected as a turn straight
// away; a busy one parks it in the pending inbox until the current turn ends,
// which can be minutes. Without this, a 💬 line followed by nothing at all is
// indistinguishable from a peer message that was silently lost — Dan asked
// for exactly this distinction (2026-08-09).
//
// Published once per BATCH, not per message: the caller emits the queued line
// only for the message that opens a pending inbox, and the delivered line
// when that inbox drains. A per-message pair would out-shout the messages.
//
// Both are fixed strings and a count — no peer input reaches them, which is
// why neither needs the peer-text discipline the two formatters around them
// have.
export const ROOM_MESSAGE_QUEUED_NOTICE =
  '⏳ Queued — this chat is mid-turn. It will be delivered when the turn ends.';

export function formatRoomDeliveredNotice(count) {
  return `📨 Delivered ${count} queued message${count === 1 ? '' : 's'}.`;
}

// The flush attempt was refused (dead PTY, a session that went away). Says so
// rather than leaving the ⏳ hanging forever, and names the recovery: the room
// convo is the durable copy, so nothing is actually lost.
export function formatRoomDeliveryFailedNotice(count) {
  const one = count === 1;
  return `⚠️ Couldn't deliver ${count} queued message${one ? '' : 's'} to this chat — ${one ? "it's" : "they're"} still in the room, and the agent can re-read ${one ? 'it' : 'them'} with agent_chat_read.`;
}

// Per-session-key cap on the pending inbox: a chatty peer must not grow an
// unbounded coalesced turn. Oldest messages are evicted first and surfaced
// as an "omitted" line per room; the journal keeps the full history.
const MAX_PENDING = 50;

function formatRoomDelivery(messages, { coalesced = false, droppedByRoom } = {}) {
  const formatOne = (m) =>
    `[room "${quotedField(m.roomTitle || m.roomId)}"] ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`;

  if (!coalesced) return formatOne(messages[0]);

  const byRoom = new Map();
  for (const m of messages) {
    if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
    byRoom.get(m.roomId).push(m);
  }
  return [...byRoom.entries()].map(([roomId, ms]) => {
    const omitted = droppedByRoom?.get(roomId) || 0;
    const lines = [`[room "${quotedField(ms[ms.length - 1].roomTitle || roomId)}"] ${ms.length} message${ms.length === 1 ? '' : 's'} while you were working:`];
    if (omitted) lines.push(`  … ${omitted} earlier message(s) omitted — use agent_chat_read("${quotedField(roomId)}")`);
    for (const m of ms) lines.push(`  ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function createRoomDelivery({
  isBusy,
  injectTurn,
  formatter = formatRoomDelivery,
  maxPendingBytes = Infinity,
  pendingBytesOf = () => 0,
  onDrop = () => {},
  log = console,
} = {}) {
  // sessionKey -> [{roomId, roomTitle, from, body}]
  const pending = new Map();
  // Optional aggregate byte budget used by peer delivery. Room delivery only
  // uses the shared message-count cap.
  const pendingBytes = new Map();
  // sessionKey -> Map(roomId -> count of messages evicted by the MAX_PENDING cap)
  const dropped = new Map();

  // Room titles/ids/senders/bodies are untrusted peer input pasted into a
  // line-structured format: flatten every interpolated field to exactly one
  // line so no message can forge a `[room "..."]` header or another sender's
  // line. The flattener itself lives in lib/peer-text.js so the user-facing
  // notices (which have the same forgery problem, in Dan's chat rather than
  // the agent's turn) share ONE implementation.
  //
  // Flattening is not enough for the fields rendered INSIDE quotes (the room
  // title, and the room id in the omitted-messages hint): a `"` there closes
  // the segment and forges the rest of the line, so those go through
  // quotedField. The sender gets it too — it cannot break out of a segment it
  // is not in, but escaping it costs nothing and makes the invariant total and
  // checkable: a rendered header line carries exactly TWO unescaped quotes,
  // its own delimiters.
  //
  // The body deliberately does NOT: it is the message content, it sits at the
  // tail of its own line outside any quoted segment, and escaping every quote
  // in it would corrupt quoted prose and code for no structural gain — a body
  // can neither start a line nor close a delimiter, so header-shaped text in
  // one is visibly mid-line, after a legitimate `sender: ` prefix.

  // One-attempt injection: never throws (injectTurn is real PTY/journal work),
  // warns with room ids + dropped count when the attempt is lost.
  function tryInject(session, text, roomIds, count) {
    let ok = false;
    try { ok = injectTurn(session, text); }
    catch (e) { try { log.warn(`[room-delivery] injectTurn threw: ${e.message}`); } catch { } }
    if (!ok) {
      try { log.warn(`[room-delivery] dropped ${count} message(s) for room(s) ${roomIds.join(', ')} (inject failed; journal has the copy)`); } catch { }
    }
    return ok;
  }

  return {
    deliver(session, sessionKey, m) {
      if (!session || !session.alive) return false;
      if (isBusy(session)) {
        if (!pending.has(sessionKey)) pending.set(sessionKey, []);
        const list = pending.get(sessionKey);
        list.push(m);
        pendingBytes.set(sessionKey, (pendingBytes.get(sessionKey) || 0) + pendingBytesOf(m));
        while (list.length > MAX_PENDING || pendingBytes.get(sessionKey) > maxPendingBytes) {
          const evicted = list.shift();
          pendingBytes.set(sessionKey, pendingBytes.get(sessionKey) - pendingBytesOf(evicted));
          if (!dropped.has(sessionKey)) dropped.set(sessionKey, new Map());
          const perRoom = dropped.get(sessionKey);
          perRoom.set(evicted.roomId, (perRoom.get(evicted.roomId) || 0) + 1);
          try { onDrop(evicted); }
          catch { try { log.warn('[room-delivery] onDrop callback failed'); } catch { } }
        }
        return true;
      }
      return tryInject(session, formatter([m]), [m.roomId], 1);
    },
    // Called from every turn-end seam AFTER session.busy goes false and the
    // ordinary busy-queue flush ran (room updates yield to Dan's queued input).
    flush(session, sessionKey) {
      const list = pending.get(sessionKey);
      const droppedByRoom = dropped.get(sessionKey);
      pending.delete(sessionKey);
      pendingBytes.delete(sessionKey);
      dropped.delete(sessionKey);
      if (!list || list.length === 0) return false;
      if (!session || !session.alive) return false;
      const roomIds = [...new Set(list.map(m => m.roomId))];
      const droppedCount = droppedByRoom
        ? [...droppedByRoom.values()].reduce((sum, count) => sum + count, 0)
        : 0;
      return tryInject(session, formatter(list, { coalesced: true, droppedByRoom, droppedCount }), roomIds, list.length);
    },
    pendingCount(sessionKey) { return pending.get(sessionKey)?.length || 0; },
    dropSession(sessionKey) { pending.delete(sessionKey); pendingBytes.delete(sessionKey); dropped.delete(sessionKey); },
  };
}
