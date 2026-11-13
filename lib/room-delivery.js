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
//   isBusy(session, {foreign}) -> bool          (reads session.busy; with
//                                               foreign, also any running turn)
//   injectTurn(session, text, meta) -> bool     (sendTextToSession skipJournalMirror;
//                                                meta.causes = what started the turn
//                                                (lib/turn-cause.js): each message's
//                                                own `cause`, else its room and the
//                                                span of its messages' seqs (`seq`);
//                                                meta.foreign = {roomId, person} for a
//                                                turn another person started)
//
// Foreign messages (another PERSON's, sender `person:` — lib/foreign-turn.js)
// never share a turn with anything else: each injected turn is either the
// session's own room traffic or ONE foreign room's, because a foreign turn
// runs restricted and an own message must not be restricted with it (nor a
// foreign one ride an unrestricted turn). A flush that has both sends the
// own batch first and leaves the rest queued for the next turn end.
//   log

import { oneLine, quotedField, peerField, PEER_NAME_MAX, PEER_TOPIC_MAX, PEER_REASON_MAX } from './peer-text.js';
import { mergeCauses, roomBatchCauses } from './turn-cause.js';

// The USER-facing rendering of one inbound room message, published into the
// session's own conversation as a notice.
//
// Why it exists: the agent-facing line below is injected with
// skipJournalMirror, so until now an inbound peer message never appeared in
// the user's chat at all — only the agent's REPLY to it did. The user's words for
// what that looks like from the outside: "it just looks like random messages
// turning up" (2026-08-08). This is the missing half of the exchange, and it
// names the machine the message came from so the reply below it has a
// visible cause.
//
// Every interpolated field is peer-controlled, so all of them are flattened
// and capped, and quoted segments are escaped — same discipline as
// formatOne, for the same reason (a body must not be able to forge a header
// line). Published from:'assistant' by the caller, never from:'user': every
// word here was written by a remote agent, and rendering it as the user's own
// message would let a peer put words in his mouth in his own chat.
export function formatRoomMessageNotice({ from, body, roomTitle, roomId } = {}) {
  const who = peerField(from, PEER_NAME_MAX) || 'an agent';
  const where = peerField(roomTitle, PEER_TOPIC_MAX) || peerField(roomId, PEER_TOPIC_MAX);
  const text = peerField(body, PEER_REASON_MAX);
  return `💬 ${quotedField(who)}${where ? ` in "${quotedField(where)}"` : ''}: ${text}`;
}

// How the echo above names the user's OWN room message when it is mirrored into a
// member session's chat. Second person, because in that chat the line is a
// receipt for something he sent — not a message from a third party.
export const SELF_ECHO_LABEL = 'You';

// Who the 💬 echo names for one inbound room frame, or null when the frame
// gets no echo at all.
//
// `user:` frames are echoed as well as `agent:` ones (2026-08-19). They used
// to be suppressed on the grounds that the user can already read their own message
// in the room convo — but the room convo cannot show him the thing this
// pipeline exists to show: WHICH member chats took the message straight away
// and which parked it behind a running turn (the ⏳/📨 pair rides on this
// same gate). The echo's job is delivery visibility, not content.
//
// Anything else fails closed: the input router already drops frames whose
// sender is neither prefix, and a notice attributed to nobody is worse than
// none. `agentLabel` is the caller's already-derived delivery label (the
// same name the injected `[room …]` turn uses), so the two can't drift;
// an empty one falls back to the notice's own wording rather than a falsy
// label the caller's gate would read as "no echo".
export function roomEchoLabel(sender, agentLabel) {
  if (typeof sender !== 'string') return null;
  if (sender.startsWith('agent:')) return agentLabel || 'an agent';
  if (sender.startsWith('user:')) return SELF_ECHO_LABEL;
  // Another person's words (sharing phase 2): echoed like a peer agent's,
  // under the label the caller derived from the journal's person stamp.
  if (sender.startsWith('person:')) return agentLabel || 'another person';
  return null;
}

// The two halves of the QUEUED state, in the same user-facing voice as the
// notice above and published into the same conversation.
//
// Why it needs saying: `deliver` has two branches that look identical from
// the user's chair. An idle session gets the message injected as a turn straight
// away; a busy one parks it in the pending inbox until the current turn ends,
// which can be minutes. Without this, a 💬 line followed by nothing at all is
// indistinguishable from a peer message that was silently lost — the user asked
// for exactly this distinction.
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

// The ⏳'s counterpart for a MUTED member (2026-08-19). agent_chat_mute is the
// escape hatch that replaced agent_chat_leave: rooms now live for the life of
// the two sessions, and an agent that wants out stops taking delivery instead
// of closing the room. Non-delivery has to be as visible as queuing was, or a
// message the user typed into a muted room just vanishes — the exact ambiguity the
// ⏳/📨 pair exists to remove.
export const ROOM_MUTED_NOT_DELIVERED_NOTICE = '🔇 Not delivered — this chat is muted.';
// Published into a conversation the idle reaper (or a restart, or the box
// sleeping) has taken down, immediately before it is respawned to take a
// room message — the room twin of INVITE_WAKE_NOTICE (lib/agent-invites.js).
// Rooms outlive the claude process (2026-09-21): a Matron conversation keeps
// its rooms across every teardown that leaves it resumable, and a peer's
// message wakes it exactly as an item reply or a chat request does. Fixed
// string: the 💬 echo published right after carries the sanitised details.
export const ROOM_WAKE_NOTICE =
  '⏳ This session was asleep — waking it to deliver a message from an agent chat room.';

// What ONE recipient gets for ONE room frame, given whether THEIR binding is
// muted. Pulled out of index.js's deliverRoomFrameTo (which can't be imported
// — index.js boots the bridge) so the rule is unit-testable and the wiring is
// all that needs source-pinning:
//   'deliver'    — the ordinary path (💬 echo, waiter, inject-or-queue).
//   'muted-user' — a `user:` frame: publish the 💬 echo, then the 🔇 line in
//                  place of the ⏳. The user is owed an explicit non-delivery for
//                  something they typed themself.
//   'muted-drop' — anything else (a peer agent frame): no injection, no queue
//                  growth, and no notices — a per-frame notice would relay the
//                  very spam the mute was reached for. agent_chat_read still
//                  reads the room back in full.
// Fails to 'muted-drop' for an unrecognised sender: the quieter side of a
// mute is the safe side.
export function roomFrameDisposition({ muted, sender } = {}) {
  if (!muted) return 'deliver';
  return typeof sender === 'string' && sender.startsWith('user:') ? 'muted-user' : 'muted-drop';
}

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

// The `room "<title>" id=<room id>` label inside an injected turn's header.
// The id is what agent_chat_send/read/mute take; the title alone is not
// enough to reply with. A desk that serves many sessions on one box holds
// many rooms whose titles differ only in a session short (`D:39 ↔️ P:95`
// next to `D:b2 ↔️ P:95 — …`), and an agent left to map a title back to an
// id from memory answers into the wrong room. The id is a bare token
// outside the quoted segment, so it is reduced to id characters rather than
// escaped: it can never add a quote or a `]` to the header.
function roomLabel(title, roomId) {
  const id = String(roomId ?? '').replace(/[^\w.:-]/g, '');
  const label = `room "${quotedField(title || roomId)}"`;
  return id ? `${label} id=${id}` : label;
}

export function createRoomDelivery({ isBusy, injectTurn, log = console } = {}) {
  // sessionKey -> [{roomId, roomTitle, from, body}]
  const pending = new Map();
  // sessionKey -> Map(roomId -> count of messages evicted by the MAX_PENDING cap)
  const dropped = new Map();

  // Room titles/ids/senders/bodies are untrusted peer input pasted into a
  // line-structured format: flatten every interpolated field to exactly one
  // line so no message can forge a `[room "..."]` header or another sender's
  // line. The flattener itself lives in lib/peer-text.js so the user-facing
  // notices (which have the same forgery problem, in the user's chat rather than
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

  function formatOne(m) {
    return `[${roomLabel(m.roomTitle, m.roomId)}] ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`;
  }

  // What an injected turn carries besides its text: the causes of the
  // messages in it, and the foreign stamp for a turn another person started.
  // A message that sets its own `cause` keeps it (a spawn outcome names its
  // request; null when it has none to name — the synthetic 'spawn' bucket is
  // no room the journal could look up); the others name their room, one
  // cause per room spanning its messages' seqs, so the journal can tell
  // whether the Coordinator wrote any of them however many there were.
  function turnMeta(msgs, foreign) {
    const byRoom = roomBatchCauses(msgs.filter((m) => !('cause' in m)));
    // In message order: a message's own cause where it is, its room's where
    // that room's first message is (mergeCauses drops the repeats).
    const meta = { causes: mergeCauses(msgs.map((m) => ('cause' in m ? m.cause : m.roomId ? byRoom.get(m.roomId) ?? null : null))) };
    if (foreign) meta.foreign = foreign;
    return meta;
  }

  // One-attempt injection: never throws (injectTurn is real PTY/journal work),
  // warns with room ids + dropped count when the attempt is lost.
  function tryInject(session, text, roomIds, count, meta) {
    let ok = false;
    try { ok = injectTurn(session, text, meta); }
    catch (e) { try { log.warn(`[room-delivery] injectTurn threw: ${e.message}`); } catch { } }
    if (!ok) {
      try { log.warn(`[room-delivery] dropped ${count} message(s) for room(s) ${roomIds.join(', ')} (inject failed; journal has the copy)`); } catch { }
    }
    return ok;
  }

  return {
    deliver(session, sessionKey, m) {
      if (!session || !session.alive) return false;
      if (isBusy(session, { foreign: !!m.foreign })) {
        if (!pending.has(sessionKey)) pending.set(sessionKey, []);
        const list = pending.get(sessionKey);
        list.push(m);
        while (list.length > MAX_PENDING) {
          const evicted = list.shift();
          if (!dropped.has(sessionKey)) dropped.set(sessionKey, new Map());
          const perRoom = dropped.get(sessionKey);
          perRoom.set(evicted.roomId, (perRoom.get(evicted.roomId) || 0) + 1);
        }
        return true;
      }
      return tryInject(session, formatOne(m), [m.roomId], 1, turnMeta([m], m.foreign ? { roomId: m.roomId, person: m.foreign.person } : null));
    },
    // Called from every turn-end seam AFTER session.busy goes false and the
    // ordinary busy-queue flush ran (room updates yield to the user's queued input).
    flush(session, sessionKey) {
      const list = pending.get(sessionKey);
      const droppedByRoom = dropped.get(sessionKey);
      pending.delete(sessionKey);
      dropped.delete(sessionKey);
      if (!list || list.length === 0) return false;
      if (!session || !session.alive) return false;
      // One turn's worth: the own messages if there are any, else the
      // first foreign room's. The rest goes back in the inbox, in order,
      // with its eviction counters, for the next turn-end seam.
      const own = list.filter((m) => !m.foreign);
      const firstForeign = own.length ? null : list.find((m) => m.foreign);
      // A turn another person starts waits until no turn at all is running
      // (one the harness started by itself, or one an interrupt left
      // behind): that turn's end would otherwise disarm the gate early. It
      // stays in the inbox for the next seam; null says nothing was tried.
      if (firstForeign && isBusy(session, { foreign: true })) {
        pending.set(sessionKey, list);
        if (droppedByRoom) dropped.set(sessionKey, droppedByRoom);
        return null;
      }
      const batch = own.length ? own : list.filter((m) => m.foreign && m.roomId === firstForeign.roomId);
      const rest = list.filter((m) => !batch.includes(m));
      if (rest.length) {
        pending.set(sessionKey, rest);
        const keep = new Map();
        for (const m of rest) if (droppedByRoom?.has(m.roomId)) keep.set(m.roomId, droppedByRoom.get(m.roomId));
        if (keep.size) dropped.set(sessionKey, keep);
      }
      const byRoom = new Map();
      for (const m of batch) {
        if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
        byRoom.get(m.roomId).push(m);
      }
      const sections = [...byRoom.entries()].map(([roomId, ms]) => {
        const omitted = droppedByRoom?.get(roomId) || 0;
        const lines = [`[${roomLabel(ms[ms.length - 1].roomTitle, roomId)}] ${ms.length} message${ms.length === 1 ? '' : 's'} while you were working:`];
        if (omitted) lines.push(`  … ${omitted} earlier message(s) omitted — use agent_chat_read("${quotedField(roomId)}")`);
        for (const m of ms) lines.push(`  ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`);
        return lines.join('\n');
      });
      const meta = turnMeta(batch, firstForeign ? { roomId: firstForeign.roomId, person: firstForeign.foreign.person } : null);
      return tryInject(session, sections.join('\n\n'), [...byRoom.keys()], batch.length, meta);
    },
    pendingCount(sessionKey) { return pending.get(sessionKey)?.length || 0; },
    dropSession(sessionKey) { pending.delete(sessionKey); dropped.delete(sessionKey); },
    // dropSession's per-room twin, for agent_chat_mute: discard just this
    // room's queued messages and leave every other room's alone. Returns how
    // many were discarded, because the caller owes the user an outcome — those
    // messages already published a ⏳ promising delivery at turn end.
    //
    // Without it a mute could not act on the case it exists for: a peer floods
    // while the session is busy (every frame queues here), the agent mutes
    // during that same turn — the only moment it can — and the turn-end flush
    // injects the entire flood anyway.
    dropRoom(sessionKey, roomId) {
      const list = pending.get(sessionKey);
      if (!list) return 0;
      const kept = list.filter((m) => m.roomId !== roomId);
      const removed = list.length - kept.length;
      if (kept.length) pending.set(sessionKey, kept);
      else pending.delete(sessionKey);
      // The eviction counters are per room too, and an "N earlier messages
      // omitted" line for a room with nothing left to flush would be a footnote
      // to nothing.
      const perRoom = dropped.get(sessionKey);
      if (perRoom) {
        perRoom.delete(roomId);
        if (perRoom.size === 0) dropped.delete(sessionKey);
      }
      return removed;
    },
  };
}

// What the OTHER member of a room is told when one side mutes it. The mute
// line alone ("🔇 x muted y: reason") told the sender something had happened
// but not what to do about it, so it kept writing into a room nobody read, or
// opened a fresh chat to get round it. The guidance names the one sanctioned
// way back: the user, who can unmute with a tap.
//
// It names the muting member, not "them" or "the other side": a room can
// hold three or more members, and the rest still hear everything. A reader
// that took the line to mean the whole room had gone quiet would give up on
// a member that is still listening.
export const PEER_MUTED_GUIDANCE =
  'If they still need to hear from you, file a question for your user asking them to unmute it; do not open a new chat to get round the mute.';

export function formatMuteAnnouncement({ who, title, reason }) {
  return `🔇 ${who} muted "${title}": ${reason} — your messages in this room no longer reach ${who}; any other members still get them. ${PEER_MUTED_GUIDANCE}`;
}

// A member leaving a room the others carry on in (agent_chat_leave, or a
// muted third member whose mission closed). `why` says what made the bridge
// do it when the agent did not ask.
export function formatLeaveAnnouncement({ who, title, reason, why = null }) {
  return `👋 ${who} left "${title}"${why ? ` (${why})` : ''}: ${reason} — messages here no longer reach ${who}; everyone else in the room still gets them.`;
}

export function formatUnmuteAnnouncement({ who, title }) {
  return `🔊 ${who} unmuted "${title}" — messages sent while it was muted were not delivered; catching up with agent_chat_read.`;
}

// The same line when the USER undid the mute by tapping the card's Unmute
// (index.js resolveRoomMuteTap) rather than the agent calling unmute.
export function formatUserUnmuteAnnouncement({ who }) {
  return `🔊 ${who} unmuted by user — messages sent while it was muted were not delivered; catching up with agent_chat_read.`;
}

// agent_chat_send's note while another member has muted the room. Replaces
// "any reply will arrive as a later turn", which is false for the muting
// member — and for the whole room when nobody else is listening.
//
// `mutes`: [{ who, reason }] — every member that has muted, `who` null when
// its line could not be named. `listening`: the names of the members that
// still get the message, or null when the membership could not be read.
// Names what it knows and never more: a muter it cannot name is "a member",
// and an unknown membership is said to be unknown rather than guessed at —
// "the other member has muted" is exactly the guess that once pinned a
// third member's mute on a room's owner.
export function formatPeerMutedSendNote({ mutes = [], listening = null, prefix = 'sent — but ' } = {}) {
  const named = mutes.map((m) => m?.who).filter(Boolean);
  const unnamed = mutes.length - named.length;
  const parts = [...named.map((w) => quotedField(w))];
  if (unnamed > 0) parts.push(unnamed === 1 && !named.length ? 'a member of this room' : `${unnamed} other member${unnamed === 1 ? '' : 's'}`);
  const who = joinNames(parts);
  const plural = parts.length > 1 || unnamed > 1;
  const reasons = mutes.filter((m) => m?.who && m.reason).map((m) => `${quotedField(m.who)}: ${quotedField(m.reason)}`);
  let note = `${prefix}${who} ${plural ? 'have' : 'has'} MUTED this room${reasons.length ? ` (${reasons.join('; ')})` : ''}, so this will not reach ${plural ? 'them' : named.length ? quotedField(named[0]) : 'it'} as a turn.`;
  if (Array.isArray(listening)) {
    note += listening.length
      ? ` It still reaches ${joinNames(listening.map((n) => quotedField(n)))}, who can reply as usual.`
      : ' Nobody else in the room is listening, so no reply will come.';
  } else {
    note += ' Any other members of the room still get it.';
  }
  return `${note} If a muted member still needs it, file a question for your user asking them to unmute; do not open a new chat to get round the mute.`;
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// The old fixed note, for a caller with no member list at all (one unnamed
// muter, membership unknown).
export const PEER_MUTED_SEND_NOTE = formatPeerMutedSendNote({ mutes: [{ who: null }] });

// A remote peer's mute lives on ITS bridge; all this side ever sees is the
// announcement frame. Reads one back: 'muted', 'unmuted', or null for any
// other message. Matches the line's head only, so it also recognises the
// shorter mute line older bridges send (no guidance sentence).
const MUTE_LINE = /^🔇 (.+?) muted ".*": /u;
const UNMUTE_LINE = /^🔊 (.+?) unmuted (?:".*"|by user) — /u;
export function parseMuteAnnouncement(body) {
  return parseMuteAnnouncementDetail(body)?.state ?? null;
}
// The same, with the member the line names: { state, who, reason } or null.
// `who` is the label the muting bridge printed ("box-a [3f]"), the key the
// per-member mute record is filed under; `reason` is the mute's stated
// reason (null for an unmute).
const MUTE_REASON = /^🔇 .+? muted ".*": (.*?)(?: — |$)/u;
export function parseMuteAnnouncementDetail(body) {
  if (typeof body !== 'string') return null;
  let m = MUTE_LINE.exec(body);
  if (m) {
    const reason = MUTE_REASON.exec(body)?.[1]?.trim() || null;
    return { state: 'muted', who: m[1].trim() || null, reason };
  }
  m = UNMUTE_LINE.exec(body);
  if (m) return { state: 'unmuted', who: m[1].trim() || null, reason: null };
  return null;
}
