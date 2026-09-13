import { randomUUID } from 'crypto';
import { peerField, quotedField, PEER_NAME_MAX, PEER_REASON_MAX } from './peer-text.js';
import { boxLetterFor } from './box-letters.js';
import { sessionShortFromTitle } from './journal-title-seed.js';

// Loopback handlers for the agent-chat room tools (spec: agent chat phase 3,
// "Bridge changes"; mute/reuse 2026-08-19). One factory returning all
// handlers — including chatLeave, which no longer has an MCP tool in front of
// it but is still how session eviction closes a dead session's rooms — each
// async (data) => ({status, body}) — HTTP-agnostic so they are fully
// unit-testable; index.js mounts each as a thin adapter on the loopback API
// server (the /send-attachment pattern). Room lifecycle side effects go
// through the injected invites manager (lib/agent-invites.js) and rooms
// registry (lib/agent-rooms.js); journal traffic goes through the publisher.

const ROOM_TITLE_MAX = 120;
const WAIT_SECONDS_CAP = 60;

// The two session_state values a room convo may hold. The journal's
// conversations table CHECKs session_state IN ('running','waiting','done',
// 'archived') — 'ended', which this file used to send for a dead room, is
// not one of them, so that upsert was rejected outright and a refused or
// errored room kept whatever state it was created with. Named constants
// here so the next value change is checked against that list once.
const ROOM_STATE_LIVE = 'waiting';
const ROOM_STATE_DEAD = 'done';

// The journal's own invite-field caps (matron-journal src/ws.js
// INVITE_TOPIC_MAX_CHARS / INVITE_TEXT_MAX_CHARS). The journal REJECTS
// over-length fields with bad_request, so clamp client-side — before any
// side effect — instead of letting a long topic strand a half-created room.
const INVITE_TOPIC_MAX_CHARS = 200;
const INVITE_TEXT_MAX_CHARS = 1000;

// The one-line epitaph for a room that never came alive, published into the
// room convo itself by chatStart. The refusal reason comes from the PEER and
// the error detail from the journal, so both go through peerField (coerce,
// flatten, cap) — a reason carrying '\n' must not be able to forge a second
// line in a message the bridge published. The reason clause is omitted
// entirely when there is no reason, rather than left dangling after a colon.
function deadRoomLine(outcome, peerName) {
  if (outcome.kind === 'refused') {
    const name = peerField(peerName, PEER_NAME_MAX);
    const why = peerField(outcome.reason, PEER_REASON_MAX);
    return `${name ? `Agent "${name}"` : 'The other agent'} refused this chat${why ? `: ${why}` : ''}`;
  }
  const detail = peerField(outcome.detail, PEER_REASON_MAX) || peerField(outcome.code, PEER_REASON_MAX) || 'unknown error';
  return `The chat could not be started: ${detail}`;
}

// How a session names ITSELF in a room announcement. The device name alone is
// ambiguous for a same-bridge room — both ends share it — so the session short
// (the same 2 chars withSessionShort puts on ordinary titles) disambiguates
// them. Exported because index.js publishes the user's-tap half of the same
// conversation (resolveRoomMuteTap) and the two lines land in one transcript:
// two implementations would eventually name the same session differently.
export function roomAgentLabel(name, session) {
  const who = name || 'an agent';
  const short = String(session?.claudeSessionId || session?.roomId || '').trim().slice(0, 2);
  return short ? `${who} [${short}]` : who;
}

// Shared participant/state gate for room-scoped operations — exported so
// lib/send-attachment.js applies the EXACT same rules (one fix site, not
// two). Returns null when access is allowed, else an {status, body} error.
// modes:
//   'send' (default): posting into the room. Requires state 'joined', or an
//     owner whose room is still 'pending' (post-chatStart, pre-accept). An
//     owner who left, was refused, or expired may NOT keep posting — the
//     owner exemption exists only for the pending window.
//   'read': transcript read. Requires PROVEN membership: owner, joined, or
//     'left' (post-leave catch-up). A never-joined pending/refused/expired
//     binding gets the same 404 as a stranger — a speculative chatJoin
//     record must never unlock another convo's transcript.
//   'any': just the participant binding (chatLeave).
export function roomAccessError(rooms, chatRoomId, sessionRoomId, { mode = 'send' } = {}) {
  if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'room_id is required' } };
  const room = rooms?.get(chatRoomId) || null;
  // The caller's OWN binding: a local (same-bridge) room binds two sessions
  // in one record, so the role/state the rules below run against must be the
  // CALLER's side, never the record's primary fields blindly.
  const binding = room ? (rooms.bindingFor ? rooms.bindingFor(chatRoomId, sessionRoomId)
    : room.sessionRoomId === sessionRoomId ? { role: room.role, state: room.state } : null) : null;
  if (!binding) return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
  if (mode === 'send' && binding.state !== 'joined' && !(binding.role === 'owner' && binding.state === 'pending')) {
    return { status: 409, body: { error: `room ${chatRoomId} is ${binding.state} — not joined` } };
  }
  if (mode === 'read' && binding.role !== 'owner' && binding.state !== 'joined' && binding.state !== 'left') {
    return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
  }
  return null;
}

// deps: sessions, publisher, rooms, invites,
//       awaitRoomMessage(chatRoomId, ms) -> Promise<{from, body}|null>
//         (index.js seam fed from journalOnRoomFrame; null on timeout),
//       pendingPeerFor(roomId) -> deviceId|null / clearPendingPeer(roomId)
//         (index.js pendingJoinRequests seam: who is join-requesting a room
//         this bridge OWNS — held OUTSIDE the rooms registry so a third
//         party's request can never clobber the owner's own record),
//       journalConvoIdFor(session) -> convoId|null (index.js seam; guards
//         chatJoin against binding one of this bridge's own session convos),
//       publishSessionNotice(sessionKey, text) -> void (index.js seam: a
//         plain one-line notice into that session's OWN conversation — how a
//         mute is announced to the other local member's user),
//       publishMuteCard({sessionKey, roomId, roomTitle, reason, agentName})
//         -> void (index.js publishRoomMuteCard: the 🔊 Unmute prompt card),
//       retireMuteCard(roomId, sessionKey) -> void (index.js seam onto the
//         mute-card registry; makes an outstanding card untappable),
//       dropPendingRoomMessages(sessionKey, roomId) -> count (index.js seam
//         onto roomDelivery.dropRoom: discards what this room already had
//         queued for that session, so a mute takes effect on the backlog and
//         not just on new frames),
//       serverLabel (bridge host label, e.g. '2'), log
export function createAgentChatHandlers({ sessions, publisher, rooms, invites, awaitRoomMessage = async () => null, pendingPeerFor = () => null, clearPendingPeer = () => {}, journalConvoIdFor = () => null, serverLabel = '', deliverLocalInvite = null, localAnswer = () => {}, routeLocalRoomMessage = () => {}, notifyRoomPeer = () => {}, publishSessionNotice = () => {}, publishMuteCard = () => {}, retireMuteCard = () => {}, dropPendingRoomMessages = () => 0, log = console } = {}) {

  function callerSession(data) {
    const { roomId } = data || {};
    if (!roomId || typeof roomId !== 'string') return { err: { status: 400, body: { error: 'roomId is required' } } };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    return { session, sessionKey: roomId };
  }

  function boundRoom(chatRoomId, sessionKey, opts) {
    const err = roomAccessError(rooms, chatRoomId, sessionKey, opts);
    if (err) return { err };
    return { room: rooms.get(chatRoomId) };
  }

  // The two hops one message into a room takes: the durable journal publish,
  // plus — for a same-bridge room — a direct hand-off to the other bound
  // session, because the journal drops the echo of an own-device agent frame
  // and the peer would otherwise never hear it. Shared by chatSend and
  // chatStart's reuse path so the two can't drift into one of them delivering
  // and the other not.
  function postIntoRoom(chatRoomId, room, sessionKey, message) {
    publisher.publishText(chatRoomId, { body: message, from: 'agent' });
    if (room?.guestSessionRoomId == null) return;
    try { routeLocalRoomMessage(chatRoomId, sessionKey, message); } catch (e) {
      try { log.warn(`[agent-chat] local room routing threw: ${e.message}`); } catch { }
    }
  }

  // Which local session key holds `convoId`, or null. Only meaningful for a
  // same-bridge target: it is how the reuse lookup keys a local room on the
  // two SESSIONS rather than on a device id both ends share.
  function localSessionKeyFor(convoId) {
    for (const [key, s] of sessions.entries()) {
      if (journalConvoIdFor(s) === convoId) return key;
    }
    return null;
  }

  function agentLabel(session) {
    return roomAgentLabel(publisher.identity()?.name || serverLabel, session);
  }

  // A room's human name for an announcement, falling back through the same
  // chain the delivery notices use before landing on the raw id.
  function roomLabel(room, chatRoomId) {
    return room?.title || room?.topic || chatRoomId;
  }

  // The OTHER member of a same-bridge room, or null for a remote one (whose
  // other member's chat lives on another box and is not ours to write into).
  function otherLocalMember(room, sessionKey) {
    if (!room || room.guestSessionRoomId == null) return null;
    const other = room.guestSessionRoomId === sessionKey ? room.sessionRoomId : room.guestSessionRoomId;
    return other && other !== sessionKey ? other : null;
  }

  return {
    async roster(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const self = publisher.identity();
      // Fail CLOSED on unknown identity (global constraint 8): without our
      // own device id we can't exclude ourselves, and a self-entry here is a
      // self-invite trap. Conversations stay listed (informational only —
      // chatStart independently refuses to run without identity).
      return { status: 200, body: {
        self: self ? { device_id: self.deviceId, name: self.name } : null,
        ...(self ? {} : { note: 'own identity unknown (no hello_ok yet) — agent list withheld' }),
        agents: self ? (r.agents || []).filter((a) => a.device_id !== self.deviceId) : [],
        conversations: (r.conversations || []).map((c) => ({
          id: c.id, title: c.title, session_state: c.session_state,
          summary: c.summary || '', agent_device_id: c.agent_device_id, last_ts: c.last_ts,
          agent_kind: c.agent_kind ?? null, // #619 outer-row-forwarder (T-1.3): forward the journal's per-convo agent_kind (claude|codex|null) for agent_sessions (§5)
        })),
      } };
    },

    async agentSessions(data) {
      const { session, err } = callerSession(data);
      if (err) return err;
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      // is_self keys on the caller's own JOURNAL convo id, not the bridge
      // session-map key (roomId): the roster lists journal convo ids, and
      // roomId != journalConvoId in general (F2). null selfConvo → nothing is
      // is_self (the caller has no journal convo bound yet), never a false match.
      const selfConvo = journalConvoIdFor(session);
      return { status: 200, body: {
        sessions: (r.conversations || []).map((c) => ({
          convo_id: c.id,
          title: c.title,
          session_state: c.session_state,
          agent_kind: c.agent_kind,
          is_self: selfConvo != null && c.id === selfConvo,
        })),
      } };
    },

    async agentMessage(data) {
      const { session, err } = callerSession(data);
      if (err) return err;
      const { target_convo: targetConvo, body, priority } = data;
      if (typeof targetConvo !== 'string' || targetConvo.trim() === '') {
        return { status: 400, body: { error: 'target_convo is required' } };
      }
      if (typeof body !== 'string' || body.trim() === '') {
        return { status: 400, body: { error: 'body is required' } };
      }
      // Attribution is the session's own JOURNAL convo id (journalConvoIdFor),
      // NOT the bridge session-map key / BRIDGE_ROOM_ID (F2). roomId != journalConvoId
      // in general (journalConvoId is set from the journal thread_id at runtime,
      // index.js), the journal validates from_convo against its conversations table
      // by convo id, and agent_sessions lists journal convo ids as the addressable
      // target_convo — so roomId-as-from_convo would be rejected by the journal
      // while the tool still reported success. Never accept model-supplied
      // attribution; fail loud if no journal convo is bound to this session yet.
      const fromConvo = journalConvoIdFor(session);
      if (!fromConvo) {
        return { status: 409, body: { error: 'session has no journal conversation yet — cannot attribute a peer message' } };
      }
      const outcome = await publisher.sendPeerMessage({
        targetConvo,
        fromConvo,
        body,
        // Forward the flag ONLY when explicitly true — a normal message carries no priority
        // key at any hop (the journal includes it in the stored payload only when true; see
        // ws.js reconstruction), so the base peer_message shape is unchanged.
        ...(priority === true ? { priority: true } : {}),
      });
      // This transport-confirmation durability model matches the journal's
      // existing send-op contract: ws.send success reports the op as durably
      // handed to the journal for append + fan, not that the target session
      // is online or has received it. The journal sends no success ack, so seq/duplicate
      // and delivered/offline are unknowable here and must not be fabricated.
      // Accepted residual (send-op parity): a silent journal append failure
      // after ws.send succeeds can still be reported as queued.
      const toolOutcome = outcome?.sent === true
        ? { queued: true }
        : { queued: false, uncertain: true };
      return { status: 200, body: toolOutcome };
    },

    async chatStart(data) {
      const { session, sessionKey, err } = callerSession(data);
      if (err) return err;
      const { target_convo_id: targetConvoId, justification, message } = data;
      if (!targetConvoId || typeof targetConvoId !== 'string') return { status: 400, body: { error: 'target_convo_id is required — pick one from agent_roster' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required — the opening message for the room' } };
      // Type/length discipline BEFORE any side effect: the journal rejects
      // over-length topic/justification with bad_request, which would strand
      // a just-created room; a non-string topic would render
      // "[object Object]" into the user's chat list via the title.
      if (data.topic !== undefined && typeof data.topic !== 'string') return { status: 400, body: { error: 'topic must be a string' } };
      const topic = data.topic ? data.topic.slice(0, INVITE_TOPIC_MAX_CHARS) : data.topic;
      const cleanJustification = justification.slice(0, INVITE_TEXT_MAX_CHARS);
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const target = (r.conversations || []).find((c) => c.id === targetConvoId);
      if (!target) return { status: 404, body: { error: `no conversation ${targetConvoId} in the roster` } };
      if (!Number.isInteger(target.agent_device_id)) return { status: 409, body: { error: 'that conversation has no owning agent to invite' } };
      const self = publisher.identity();
      // Fail CLOSED on unknown identity: without our own device id the
      // self-target guard below can't run, and a self-invite would wedge.
      if (!self) return { status: 503, body: { error: 'own identity unknown yet (no hello_ok from the journal) — cannot safely start an agent chat; try again shortly' } };
      // Same-bridge target: the journal never sees an invite (an own-device
      // agent frame would be dropped as an echo anyway) — the request is
      // injected into the target session locally and the room binds BOTH
      // sessions in one registry record (guest fields). Requires the
      // deliverLocalInvite seam; without it, keep the historical refusal.
      const isLocal = target.agent_device_id === self.deviceId;
      if (isLocal && !deliverLocalInvite) return { status: 400, body: { error: 'that conversation is on this bridge — talk to it directly' } };
      if (isLocal && journalConvoIdFor(session) === targetConvoId) {
        return { status: 400, body: { error: "that is this session's own conversation — you cannot start a chat with yourself" } };
      }

      // Reuse-first (2026-08-19): a pair of sessions keeps ONE open chat for
      // the life of both. agent_chat_leave used to be the way out of a room,
      // so agents closed rooms and opened fresh ones for every exchange and
      // the user's chat list filled with single-exchange ghosts. The leave
      // tool is gone (mute is the escape hatch), and a second chatStart at the
      // same target now hands back the room that already exists.
      //
      // Runs AFTER validation, so an unknown or agentless target still gets
      // its own error rather than being silently reused into. Terminal rooms
      // are never resurrected — findLivePair skips them, and a fresh start
      // creates a fresh room exactly as it always did.
      const peerSessionRoomId = isLocal ? localSessionKeyFor(targetConvoId) : null;
      const existing = rooms.findLivePair?.(sessionKey, {
        peerDeviceId: target.agent_device_id, targetConvoId, peerSessionRoomId,
      });
      if (existing) {
        // Reuse is a SEND, so it runs the send gate — findLivePair's notion of
        // live is deliberately wider (a pending invite is still reusable) than
        // the right to post into a room, which needs 'joined' or an owner in
        // its own pending window. Without this a guest that had not accepted
        // yet could "reuse" its way into posting: routeLocalRoomFrame drops a
        // non-joined recipient and the journal drops the own-device echo, so
        // the message reached nobody while the caller was told ok — and the
        // owner went on waiting for an answer to the invite the caller should
        // have accepted instead. Never a second room either: a duplicate is
        // the one thing this branch exists to prevent.
        const gate = roomAccessError(rooms, existing.roomId, sessionKey, { mode: 'send' });
        if (gate) {
          return { status: gate.status, body: { ...gate.body, room_id: existing.roomId,
            note: 'you already have a room with that session — answer its invite with agent_chat_accept instead of starting another' } };
        }
        // The opening message still goes IN. chatStart's contract is "say this
        // to that agent", and reuse must not quietly turn it into "say
        // nothing" — the caller would believe it had spoken while the peer
        // heard nothing at all. Same two hops chatSend makes, so a same-bridge
        // peer (whose journal echo is dropped as own-device) still hears it.
        postIntoRoom(existing.roomId, existing, sessionKey, message);
        // A muted room is the one the agent is most likely to "restart": the
        // peer looks dead to it because its own mute is dropping the replies.
        // Handing that room back under a plain "reused" note would leave it
        // waiting on a turn that can never arrive.
        return { status: 200, body: { ok: true, room_id: existing.roomId,
          note: rooms.isMuted?.(existing.roomId, sessionKey)
            ? 'existing room reused — but you have MUTED it, so replies will NOT be delivered to you as turns. Call agent_chat_unmute to resume.'
            : 'existing room reused — this pair keeps one open chat' } };
      }

      const chatRoomId = randomUUID();
      const targetAgent = (r.agents || []).find((a) => a.device_id === target.agent_device_id);
      // A local room's two ends share one device name, so the target side is
      // labelled by its conversation title instead — "mac ↔ mac" names nobody.
      const peerLabel = isLocal ? (target.title || 'same-box session')
        : (targetAgent?.name || `device ${target.agent_device_id}`);
      // A room title is exactly its two sides and an optional topic:
      // `Y:ab ↔️ Z:2h — ci triage`. Each side is the same `Letter:short` tag
      // the apps render beside every other chat (MatronShared SessionTag), so
      // a room reads like the rest of the list — "mac ↔ dev-2" said which
      // machines were talking but left four sessions on them
      // indistinguishable.
      //
      // The `↔️ [xx] ` machine prefix this used to carry is GONE (2026-08-19).
      // Neither half was earning its space:
      //   - The apps do not key the room tag on the ↔️ marker; they gate it on
      //     the conversation having ≥2 participants, so a room is still
      //     rendered as a room without it. SessionTag.splitTitle reads a title
      //     with no `[xx] ` prefix cleanly as "no short", and the coloured room
      //     tag degrades from `Y↔Z:32` to `Y↔Z` through its nil-short guard.
      //   - The room short existed to tell two rooms with the SAME pair apart.
      //     Rooms are now singletons per pair (chatStart is reuse-first, and
      //     agents cannot close one), so there is no second room to tell it
      //     from and the disambiguation job is gone.
      const ownName = self.name || serverLabel || 'agent';
      // The SAME id withSessionShort puts on this session's ordinary titles
      // (index.js passes claudeSessionId || roomId), so the two agree.
      const ownShort = String(session.claudeSessionId || session.roomId || '').trim().slice(0, 2);
      // The peer's short can only come from the title its OWN bridge
      // published — it bakes it in via withSessionShort. A local room's peer
      // is another session on this box, and its title carries the short the
      // same way.
      const peerShort = sessionShortFromTitle(target.title);
      // A local room's peer shares our device name, so its letter is ours.
      const peerName = isLocal ? ownName : peerLabel;
      // ONE name set for both letters. The strip is only meaningful across a
      // whole set, so deriving each side against a different one silently
      // disagrees: a roster that omits self (or a peer with no roster row at
      // all) gave `Y ↔️ D` for dev-y ↔️ dev-z — our side struck against both
      // names, the peer's against only its own.
      const boxNames = [...new Set([
        ...(r.agents || []).map((a) => a?.name).filter((n) => typeof n === 'string' && n),
        ownName, peerName,
      ])];
      const tagCharFor = (deviceId) => (r.agents || []).find((a) => a?.device_id === deviceId)?.tag_char ?? null;
      // No short, no tag: a bare `D:` says nothing, so that side falls back
      // to the label it has always had (device name, or the conversation
      // title for a same-bridge peer — "mac ↔️ mac" names nobody).
      const selfTag = ownShort ? `${boxLetterFor(ownName, boxNames, tagCharFor(self.deviceId))}:${ownShort}` : ownName;
      const peerTag = peerShort ? `${boxLetterFor(peerName, boxNames, tagCharFor(target.agent_device_id))}:${peerShort}` : peerLabel;
      const title = `${selfTag} ↔️ ${peerTag}${topic ? ` — ${topic}` : ''}`.slice(0, ROOM_TITLE_MAX);
      // 'waiting', not 'running'. A room is a conversation between two
      // agents, not a turn this bridge is executing, and nothing ever flips
      // it back — so 'running' pinned every agent-chat room on forever. The
      // apps read session_state to decide a turn is in flight: a pinned
      // 'running' put a floating Stop button over every room permanently,
      // and pressing it posted a literal "!esc" into the room, since the
      // journal input router sends user frames in a room straight to the
      // peers without bang-command handling.
      publisher.upsertConvo(chatRoomId, { title, sessionState: ROOM_STATE_LIVE });
      publisher.publishText(chatRoomId, { body: message, from: 'agent' });
      // targetConvoId is recorded because it is what keys the reuse lookup
      // above: the peer DEVICE is not enough — two sessions on the same box
      // are two different correspondents, and a device-only key would fold
      // them into one room.
      rooms.record(chatRoomId, { role: 'owner', state: 'pending', sessionRoomId: sessionKey, peerDeviceId: target.agent_device_id, peerName: isLocal ? peerLabel : (targetAgent?.name || null), topic: topic || null, title, targetConvoId });

      // targetConvoId, not just the device: the caller picked a specific
      // conversation and the receiving bridge needs to know which, or it is
      // left guessing among its own live sessions.
      // …and fromConvoId, so the card can name the session doing the asking
      // rather than just this box. Null when the session has no journal
      // conversation yet (nothing has been published from it): the journal
      // omits the field and the card falls back to the device name.
      let outcome;
      if (isLocal) {
        // Waiters first, inject second: the loopback ack (and a synchronous
        // refusal when nothing is resumable) can arrive in the same tick the
        // inject runs, and a waiter armed after that fires never settles.
        // inviteLocal arms both waiters before its first await, so calling
        // it un-awaited then injecting is the required order.
        const outcomeP = invites.inviteLocal({ roomId: chatRoomId });
        try {
          deliverLocalInvite({
            event: 'request', local: true, room_id: chatRoomId,
            from_device_id: self.deviceId, from_name: self.name,
            target_convo_id: targetConvoId,
            ...(journalConvoIdFor(session) ? { from_convo_id: journalConvoIdFor(session) } : {}),
            ...(topic ? { topic } : {}), justification: cleanJustification,
          });
        } catch (e) {
          try { log.warn(`[agent-chat] local invite delivery threw: ${e.message}`); } catch { }
        }
        outcome = await outcomeP;
      } else {
        outcome = await invites.invite({ roomId: chatRoomId, targetDeviceId: target.agent_device_id, targetConvoId, fromConvoId: journalConvoIdFor(session), topic, justification: cleanJustification });
      }
      if (outcome.kind === 'error' || outcome.kind === 'refused') {
        // The room never came alive (journal error/offline, or the peer
        // refused): don't leave a ghost live one-message convo in the
        // user's chat list. On 'refused' the registry state was already set
        // by onInviteFrame's answer handling; only a hard error expires the
        // otherwise-still-pending entry here (whole-branch review, I3).
        if (outcome.kind === 'error') rooms.setState(chatRoomId, 'expired');
        // …and say WHY it is dead: a finished one-message convo with no
        // explanation leaves the user guessing. This bridge OWNS this room
        // (it just created it), so the write is authorised — unlike an
        // INBOUND request, where the notice has to go to the session convo
        // instead (index.js journalInjectInviteRequest). One line, published
        // before the state flip so it is the last thing said in the room.
        publisher.publishText(chatRoomId, { body: deadRoomLine(outcome, isLocal ? peerLabel : targetAgent?.name), from: 'agent' });
        publisher.upsertConvo(chatRoomId, { title, sessionState: ROOM_STATE_DEAD });
      }
      return mapStartOutcome(chatRoomId, outcome);
    },

    async chatSend(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, message, wait_seconds: waitSeconds } = data;
      const b = boundRoom(chatRoomId, sessionKey);
      if (b.err) return b.err;
      if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required' } };
      // BEFORE arming the reply wait below: the routing is synchronous, and a
      // message that resolves a peer's waiter must not race one's own.
      postIntoRoom(chatRoomId, b.room, sessionKey, message);
      // Optional short reply wait: purely convenience — replies always arrive
      // as turns regardless, so a timeout here loses nothing. Skipped outright
      // while muted: delivery returns above the reply waiter, so the wait is
      // guaranteed dead time — up to a minute of it.
      const muted = !!rooms.isMuted?.(chatRoomId, sessionKey);
      const wait = muted ? 0 : Math.min(Math.max(Number(waitSeconds) || 0, 0), WAIT_SECONDS_CAP);
      if (wait > 0) {
        const reply = await awaitRoomMessage(chatRoomId, wait * 1000, sessionKey);
        if (reply) return { status: 200, body: { ok: true, reply } };
      }
      // Sending while muted is allowed — a mute is about what reaches THIS
      // agent, not about what it may say. But it must not look like an
      // ordinary send: the peer's answer will not arrive as a turn, and an
      // agent that thinks it will just waits forever.
      return { status: 200, body: { ok: true, note: muted
        ? 'sent — but you have muted this room, so replies will NOT be delivered to you as turns. Call agent_chat_unmute to resume, or agent_chat_read to catch up.'
        : 'sent — any reply will arrive as a later turn' } };
    },

    // agent_chat_mute — the escape hatch that replaced agent_chat_leave
    // (2026-08-19). A room now lives for the life of the two sessions, so an
    // agent that wants out of a peer which loops, spams, or malfunctions stops
    // taking delivery instead of closing the shared room out from under its
    // user. Per-side and purely bridge-local: no journal protocol field, and
    // the other member keeps hearing everything.
    async chatMute(data) {
      const { session, sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, reason } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'any' });
      if (b.err) return b.err;
      // The reason is mandatory and goes into the USER's chat, so it is peer
      // text: coerced, de-controlled, flattened to one line and capped, like
      // every other agent-authored string that lands in a line-structured
      // message the bridge signs. A reason that sanitises to nothing is no
      // reason at all — refuse rather than publish a bare colon.
      const cleanReason = peerField(reason, PEER_REASON_MAX);
      if (typeof reason !== 'string' || !cleanReason) {
        return { status: 400, body: { error: 'reason is required — say why you are muting this chat (the user sees it)' } };
      }
      if (rooms.isMuted(chatRoomId, sessionKey)) {
        return { status: 200, body: { ok: true, room_id: chatRoomId, muted: true, note: 'already muted — nothing changed' } };
      }
      if (!rooms.setMuted(chatRoomId, sessionKey, true, { reason: cleanReason })) {
        return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
      }
      // Whatever this room already had waiting for this session goes with the
      // mute. The gate in deliverRoomFrameTo only stops NEW frames, and the
      // headline case is precisely a backlog: a peer floods while the agent is
      // mid-turn (every frame queues), the agent mutes during that same turn —
      // the only moment it can act — and the turn-end flush would otherwise
      // inject the entire flood anyway, making the escape hatch a no-op right
      // when it was reached for.
      const dropped = Number(dropPendingRoomMessages(sessionKey, chatRoomId)) || 0;
      const who = agentLabel(session);
      const title = roomLabel(b.room, chatRoomId);
      const announcement = `🔇 ${who} muted "${quotedField(title)}": ${cleanReason}`;
      // Loud, deliberately. A member going quiet is exactly the kind of thing
      // that looks like a bug from the other side, so it is said in the room —
      // through postIntoRoom, not a bare publish: a same-bridge peer never
      // hears the journal echo of an own-device frame, so a bare publish would
      // announce the mute to everyone EXCEPT the agent that most needs to know.
      postIntoRoom(chatRoomId, b.room, sessionKey, announcement);
      // …and, for a same-bridge room, in the OTHER member's own chat, where
      // the user would otherwise just see their peer stop answering.
      const otherKey = otherLocalMember(b.room, sessionKey);
      if (otherKey) {
        try { publishSessionNotice(otherKey, announcement); } catch (e) {
          try { log.warn(`[agent-chat] mute peer notice threw: ${e.message}`); } catch { }
        }
      }
      // The dropped backlog had already published a ⏳ into this session's own
      // chat promising delivery at turn end. That promise is now void, so it
      // gets an outcome rather than being left hanging.
      if (dropped > 0) {
        try {
          publishSessionNotice(sessionKey, `🔇 Muted — ${dropped} queued message${dropped === 1 ? '' : 's'} from this chat ${dropped === 1 ? 'was' : 'were'} not delivered.`);
        } catch (e) {
          try { log.warn(`[agent-chat] mute backlog notice threw: ${e.message}`); } catch { }
        }
      }
      // …and as a card in the muting agent's own chat, so the user can undo it
      // with one tap. The agent chose to stop listening; the user gets the veto.
      // Best-effort — a session with no journal conversation yet has nowhere to
      // put it — so the result only promises the tap when there IS a card.
      let card = false;
      try { card = publishMuteCard({ sessionKey, roomId: chatRoomId, roomTitle: title, reason: cleanReason, agentName: who }) !== false; } catch (e) {
        try { log.warn(`[agent-chat] mute card publish threw: ${e.message}`); } catch { }
      }
      return { status: 200, body: { ok: true, room_id: chatRoomId, muted: true, dropped, card,
        note: `muted — messages in this room will not be delivered to you until you call agent_chat_unmute${card ? ' (or the user taps Unmute)' : ''}. The room stays open and agent_chat_read still works.` } };
    },

    // agent_chat_unmute — the agent's own way back. Symmetrical with the
    // user's card tap (index.js resolves that through the same registry
    // retirement), so whichever happens first, the other finds nothing live.
    async chatUnmute(data) {
      const { session, sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'any' });
      if (b.err) return b.err;
      const wasMuted = rooms.isMuted(chatRoomId, sessionKey);
      // Retire FIRST, before the state it describes changes: the card says
      // "this chat is muted", so the window in which it is tappable must close
      // before the mute does. Runs on the not-muted path too — a card outliving
      // its mute is precisely the stale tap this bookkeeping exists to stop.
      try { retireMuteCard(chatRoomId, sessionKey); } catch (e) {
        try { log.warn(`[agent-chat] mute card retire threw: ${e.message}`); } catch { }
      }
      if (!wasMuted) {
        return { status: 200, body: { ok: true, room_id: chatRoomId, muted: false, note: 'not muted — nothing changed' } };
      }
      rooms.setMuted(chatRoomId, sessionKey, false);
      // Says what did NOT happen as well as what did: nothing is replayed, so
      // an agent that assumes it has seen everything is wrong by exactly the
      // length of the mute. Through postIntoRoom for the same reason the mute
      // line is — a same-bridge peer never hears an own-device journal echo.
      postIntoRoom(chatRoomId, b.room, sessionKey,
        `🔊 ${agentLabel(session)} unmuted "${quotedField(roomLabel(b.room, chatRoomId))}" — messages sent while it was muted were not delivered; catching up with agent_chat_read.`);
      return { status: 200, body: { ok: true, room_id: chatRoomId, muted: false,
        note: 'unmuted — delivery resumes from now on. Nothing is replayed: use agent_chat_read to see what you missed.' } };
    },

    async chatAccept(data)  { return answerInvite(data, true); },
    async chatRefuse(data)  { return answerInvite(data, false); },

    async chatJoin(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, justification } = data;
      if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'room_id is required' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      // Reject one of this bridge's OWN session convo ids up front, BEFORE
      // rooms.record: from the record() instant the router carve-out
      // intercepts that convo ahead of the entire normal input path, so a
      // speculative binding to a live session convo (all of them listed by
      // agent_roster) would hijack that session's input — and a
      // pending_quiet outcome leaves the binding live for the full invite
      // TTL (rollback only covers kind 'error'; rolling back on pending
      // would break the legit busy-peer flow). Whole-branch review, I2.
      for (const s of sessions.values()) {
        if (journalConvoIdFor(s) === chatRoomId) {
          return { status: 400, body: { error: 'that id is a live session conversation on this bridge, not a room' } };
        }
      }
      // A room already bound to ANOTHER session must not be re-bound:
      // record() merges, so joining a known room id would overwrite its
      // sessionRoomId — locking the real participant out of its own room and
      // rerouting the peer's messages here. Same 404 a stranger gets.
      const prior = rooms.get(chatRoomId);
      if (prior && prior.sessionRoomId !== sessionKey) return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
      rooms.record(chatRoomId, { role: 'guest', state: 'pending', sessionRoomId: sessionKey });
      const outcome = await invites.join({ roomId: chatRoomId, justification: justification.slice(0, INVITE_TEXT_MAX_CHARS) });
      // Roll back a speculative binding the journal rejected outright —
      // otherwise the pending entry sticks for the invite TTL and (before
      // chatRead's proven-membership gate, exploitable; still misleading
      // after) shows up as a bound room that never existed.
      if (outcome.kind === 'error' && !prior) rooms.remove(chatRoomId);
      return mapStartOutcome(chatRoomId, outcome);
    },

    // Invite ANOTHER device's session into a room this caller ALREADY owns —
    // the proactive inverse of chatJoin (there a stranger asks in; here the
    // owner pulls one in). Reuses the SAME invite data layer chatStart uses
    // (invites.invite -> agent_invite op) but against an EXISTING room id
    // instead of a freshly-minted one, and creates NOTHING to tear down: the
    // invitee accepts through the normal agent_chat_accept path, and a refusal
    // or error leaves the room exactly as it was. The journal is N-party ready
    // (agent_invite adds an additive convo_agents row and fans membership on
    // accept — no pairwise cap).
    //
    // KNOWN v1 LIMITATION — the bridge's LOCAL room bookkeeping is still
    // pairwise, so a room that grows past two participants is not fully modelled
    // here yet. Two consequences (tracked for the per-participant-membership
    // follow-up, not fixable without reworking agent-rooms.js/agent-invites.js):
    //   • invites.invite() keys its delivered/ack/answer waiters by ROOM id
    //     only (the journal's delivered/ack frames carry no target device), so
    //     a second invite into the same room whose FIRST invite is still
    //     awaiting a late answer can cross-settle outcomes. Realistic single-
    //     add flows (invite one peer into a joined room, await it) do not hit
    //     this; rapid back-to-back invites into one room can.
    //   • onInviteFrame's 'left' handler marks the whole room 'left' on ANY
    //     peer departure (pairwise assumption), so if a 3-party room loses one
    //     member the owner is locally locked out of a room still live on the
    //     journal (recoverable by starting a new room; not data loss).
    // Same-bridge targets are refused outright below for the same reason.
    async chatInvite(data) {
      const { session, sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, target_convo_id: targetConvoId, justification } = data;
      if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'room_id is required — the existing room to invite into' } };
      if (!targetConvoId || typeof targetConvoId !== 'string') return { status: 400, body: { error: 'target_convo_id is required — pick one from agent_roster' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      // Same wire discipline as chatStart: the journal bad_requests an
      // over-length or non-string topic, which would fail the whole invite.
      if (data.topic !== undefined && typeof data.topic !== 'string') return { status: 400, body: { error: 'topic must be a string' } };
      // Caller must be able to ACT in the room — the same participant/state
      // gate posting uses (joined member, or the owner during its pending
      // window). One gate site, not a second copy of the rules. A stranger, or
      // a member whose binding went terminal, gets 404/409 exactly as chatSend
      // would.
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'send' });
      if (b.err) return b.err;
      const room = b.room;
      // …and specifically the OWNER: the journal's agent_invite refuses anyone
      // but the room owner ("only the room owner may invite", matron-journal
      // ws.js), so a joined GUEST's invite would fail server-side with a bare
      // 'forbidden'. Gate it here with an actionable message instead of letting
      // the round trip fail opaquely. This is the bridge-side half of consent:
      // only the room's owner may pull someone in; a guest asks the owner or
      // starts its own room.
      const binding = rooms.bindingFor ? rooms.bindingFor(chatRoomId, sessionKey) : { role: room.role, state: room.state };
      if (binding?.role !== 'owner') {
        return { status: 403, body: { error: `only the owner of room ${chatRoomId} may invite others — ask the owner to invite them, or start your own room with agent_chat_start` } };
      }
      // …and the room must be LIVE (joined), not still pending its FIRST guest.
      // roomAccessError('send') also admits an owner during the pending window
      // (post-chatStart, pre-accept); inviting a second party then is unsound
      // in v1's SINGLETON room-state model: if the first invite later refuses
      // or expires, onInviteFrame drives the one shared state terminal, and the
      // second party's acceptance cannot restore it (terminal states never
      // transition — agent-rooms.js setState), stranding a room the journal
      // considers live. Require joined so the room has a settled membership
      // before a second participant is added.
      if (binding.state !== 'joined') {
        return { status: 409, body: { error: `room ${chatRoomId} is ${binding.state}, not joined — wait until it is live before inviting others` } };
      }

      const topic = data.topic ? data.topic.slice(0, INVITE_TOPIC_MAX_CHARS) : data.topic;
      const cleanJustification = justification.slice(0, INVITE_TEXT_MAX_CHARS);
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const target = (r.conversations || []).find((c) => c.id === targetConvoId);
      if (!target) return { status: 404, body: { error: `no conversation ${targetConvoId} in the roster` } };
      if (!Number.isInteger(target.agent_device_id)) return { status: 409, body: { error: 'that conversation has no owning agent to invite' } };
      const self = publisher.identity();
      // Fail CLOSED on unknown identity: without our own device id the
      // self-target and same-bridge guards below can't run.
      if (!self) return { status: 503, body: { error: 'own identity unknown yet (no hello_ok from the journal) — cannot invite into a room; try again shortly' } };
      // Never invite this very session's own conversation into the room.
      if (journalConvoIdFor(session) === targetConvoId) {
        return { status: 400, body: { error: "that is this session's own conversation — you cannot invite yourself" } };
      }
      // Already a participant: the room's known peer IS this device. v1 rooms
      // track one peer binding locally; the journal is the full authority on
      // membership and will also reject a duplicate participant with a
      // conflict (surfaced as 409 by mapStartOutcome), so this is a fast,
      // clear local reject for the common pairwise case, not the only guard.
      if (room.peerDeviceId != null && room.peerDeviceId === target.agent_device_id) {
        return { status: 409, body: { error: `device ${target.agent_device_id} is already a participant of room ${chatRoomId}` } };
      }
      // Same-bridge target: a v1 room record holds a SINGLE guest binding, so a
      // second same-bridge participant can't be tracked or locally routed (the
      // journal drops own-device echoes, and routeLocalRoomMessage is pairwise)
      // — admitting one would corrupt the existing guest slot. Remote
      // participants need no local guest slot (their messages are journal-
      // fanned), so multi-party is remote-only in v1. Refuse rather than break
      // the room.
      if (target.agent_device_id === self.deviceId) {
        return { status: 400, body: { error: 'that conversation is on this bridge — same-bridge multi-party rooms are not supported in v1; invite a session on another box' } };
      }
      // Reuse the EXISTING invite data layer against the EXISTING room id. The
      // journal parks/delivers the invite to the target, who accepts via the
      // normal agent_chat_accept path. from_convo_id names the asking session
      // on the consent card (omitted-never-null when unbound). We record
      // NOTHING and roll back NOTHING: the room predates this call and outlives
      // any refusal.
      const outcome = await invites.invite({ roomId: chatRoomId, targetDeviceId: target.agent_device_id, targetConvoId, fromConvoId: journalConvoIdFor(session), topic, justification: cleanJustification });
      return mapStartOutcome(chatRoomId, outcome);
    },

    async chatLeave(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'any' });
      if (b.err) return b.err;
      const binding = rooms.bindingFor ? rooms.bindingFor(chatRoomId, sessionKey) : { state: b.room.state };
      // Already left (e.g. session eviction auto-left it) — the peer was
      // told the first time; re-surfacing the journal's conflict here would
      // read as a failure that never happened.
      if (binding?.state === 'left') return { status: 200, body: { ok: true, room_id: chatRoomId, note: 'already left' } };
      // Local room: there is no journal participant state to leave — flip
      // both bindings (v1 rooms are pairwise: one side leaving ends the room,
      // the same terminal state a remote peer's 'left' frame produces) and
      // tell the other session directly.
      if (b.room.guestSessionRoomId != null) {
        // A binding that ended some OTHER way (refused/expired) has nothing
        // to leave — and the peer must not be told "left the room" about a
        // room that already ended differently. The setState calls below
        // would no-op on terminal states, but the notify would still fire.
        if (binding?.state === 'refused' || binding?.state === 'expired') {
          return { status: 200, body: { ok: true, room_id: chatRoomId, note: `room already ${binding.state}` } };
        }
        const isGuest = b.room.guestSessionRoomId === sessionKey;
        // A guest leaving an invite it never answered IS the answer: route
        // it as a refusal so the owner's chatStart waiters settle (running
        // its dead-room cleanup) instead of timing out into "the answer
        // arrives later" over a room that can never answer.
        if (isGuest && binding?.state === 'pending') {
          rooms.setGuestState(chatRoomId, 'refused');
          try { localAnswer(chatRoomId, { accept: false, reason: 'left the room without answering' }); } catch (e) {
            try { log.warn(`[agent-chat] local leave answer threw: ${e.message}`); } catch { }
          }
          return { status: 200, body: { ok: true } };
        }
        const otherKey = isGuest ? b.room.sessionRoomId : b.room.guestSessionRoomId;
        rooms.setState(chatRoomId, 'left');
        rooms.setGuestState(chatRoomId, 'left');
        try { notifyRoomPeer(chatRoomId, otherKey, 'left the room'); } catch { }
        return { status: 200, body: { ok: true } };
      }
      // If the leave didn't take server-side the peer was NOT told —
      // marking the room left anyway would report a leave that didn't
      // happen, terminally (setState refuses to un-terminal 'left'). Keep
      // the state and surface the truth. The conflict case is the room
      // OWNER: the journal's leaveConvo only flips a convo_agents row in
      // state 'joined', and the owner has no such row (whole-branch
      // review, C2).
      const outcome = await invites.leave({ roomId: chatRoomId });
      if (outcome.kind !== 'left') {
        if (outcome.code === 'journal_unreachable') {
          return { status: 502, body: { error: 'journal unreachable — the peer was not told; try again' } };
        }
        return {
          status: outcome.code === 'conflict' ? 409 : 502,
          body: { error: `journal rejected the leave: ${outcome.detail || outcome.code || 'unknown error'} — the peer was not told` },
        };
      }
      // setState refuses transitions out of terminal states (refused/expired)
      // and returns null there — leaving an already-dead room is still ok.
      rooms.setState(chatRoomId, 'left');
      return { status: 200, body: { ok: true } };
    },

    async chatRead(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, limit } = data;
      // 'read' demands PROVEN membership (owner / joined / left — the last
      // for post-leave catch-up). A pending binding is NOT proof: chatJoin
      // records speculatively before the journal answers, and this bridge's
      // device authorization on the journal side covers every convo it owns
      // — so an unproven binding here would be a cross-session transcript
      // read (spec invariant: no cross-agent transcript reads in v1).
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'read' });
      if (b.err) return b.err;
      const res = await publisher.fetchMessages(chatRoomId, { limit: Math.min(Math.max(Number(limit) || 50, 1), 200) });
      if (!res) return { status: 502, body: { error: 'journal unreachable or read refused' } };
      return { status: 200, body: { room_id: chatRoomId, messages: shapeMessages(res.events) } };
    },
  };

  // chatRead-shaped message list from raw journal events — shared by
  // chatRead and answerInvite's accept-backfill so the two renderings can't
  // drift. Attachments carry their blob_ref (whole-branch review, M1): the
  // name alone gives the agent nothing to fetch.
  function shapeMessages(events) {
    return (events || [])
      .filter((e) => e.type === 'text' || e.type === 'file' || e.type === 'image')
      .map((e) => ({ sender: e.sender, type: e.type, ts: e.ts,
        body: e.type === 'text' ? e.payload?.body
          : `[${e.type} "${e.payload?.name || 'unnamed'}"${e.payload?.blob_ref ? ` (blob ${e.payload.blob_ref})` : ''}]`,
        ...(e.payload?.caption ? { caption: e.payload.caption } : {}) }));
  }

  // Maps an invites.invite()/join() outcome to a tool response. The invites
  // manager maps deliver-window timeouts to pending_quiet itself, so no raw
  // 'timeout' kind ever reaches this switch.
  function mapStartOutcome(chatRoomId, outcome) {
    switch (outcome.kind) {
      case 'accepted':      return { status: 200, body: { room_id: chatRoomId, status: 'accepted' } };
      case 'refused':       return { status: 200, body: { room_id: chatRoomId, status: 'refused', reason: outcome.reason || '' } };
      case 'pending_busy':  return { status: 200, body: { room_id: chatRoomId, status: 'pending_busy', note: 'peer is mid-turn; continue your own work — the answer arrives as a later turn' } };
      case 'pending_idle':
      case 'pending_quiet': return { status: 200, body: { room_id: chatRoomId, status: 'pending', note: 'no answer yet; continue your own work — the answer arrives as a later turn' } };
      case 'error':
        if (outcome.code === 'offline') return { status: 200, body: { room_id: chatRoomId, status: 'offline', error: 'target bridge is offline' } };
        if (outcome.code === 'conflict') return { status: 409, body: { room_id: chatRoomId, error: outcome.detail || 'conflicting invite state' } };
        return { status: 502, body: { room_id: chatRoomId, error: outcome.detail || outcome.code || 'journal error' } };
      default:
        try { log.warn(`[agent-chat] unexpected invite outcome for ${chatRoomId}: ${JSON.stringify(outcome)}`); } catch { }
        return { status: 502, body: { room_id: chatRoomId, error: 'unexpected invite outcome' } };
    }
  }

  async function answerInvite(data, accept) {
    const { sessionKey, err } = callerSession(data);
    if (err) return err;
    const { room_id: chatRoomId, reason } = data;
    // Same wire discipline as chatStart's topic: the journal bad_requests an
    // over-length reason, which would fail the whole answer.
    if (reason !== undefined && typeof reason !== 'string') return { status: 400, body: { error: 'reason must be a string' } };
    const room = rooms.get(chatRoomId);
    const isLocalGuest = !!room && room.guestSessionRoomId != null && room.guestSessionRoomId === sessionKey;
    if (!room || (room.sessionRoomId !== sessionKey && !isLocalGuest)) return { status: 404, body: { error: `no pending invite for room ${chatRoomId}` } };
    const cleanReason = reason ? reason.slice(0, INVITE_TEXT_MAX_CHARS) : reason;
    if (isLocalGuest) {
      // Same-bridge invite: no journal state exists to answer, so the answer
      // is a loopback frame into the invites manager — it settles the owner's
      // chatStart waiters (or surfaces as a late-answer turn) and flips the
      // owner binding via the same onInviteFrame path a journal answer takes.
      // The guest binding flips FIRST so an owner that sends the moment its
      // accept resolves finds the guest already routable.
      if (room.guestState !== 'pending') return { status: 409, body: { error: `room ${chatRoomId} is ${room.guestState} — nothing to answer` } };
      // The inviting session can be gone by answer time (idle-reaped or
      // ended — session teardown only auto-leaves 'joined' rooms, so this
      // still-pending record survives it). Accepting then would flip both
      // bindings 'joined' against a session key nothing routes to: a room
      // that looks live and answers nothing. Refusals still flow — they
      // only close the room out.
      if (accept && !sessions.get(room.sessionRoomId)?.alive) {
        return { status: 409, body: { error: `the inviting session is gone — room ${chatRoomId} can no longer be joined` } };
      }
      rooms.setGuestState(chatRoomId, accept ? 'joined' : 'refused');
      try { localAnswer(chatRoomId, { accept, reason: cleanReason }); } catch (e) {
        try { log.warn(`[agent-chat] local invite answer threw: ${e.message}`); } catch { }
      }
      if (!accept) return { status: 200, body: { ok: true, room_id: chatRoomId, refused: true } };
      // Same accept-backfill contract as the remote guest path below.
      const res = await publisher.fetchMessages(chatRoomId, { limit: 20 });
      return { status: 200, body: { ok: true, room_id: chatRoomId,
        ...(res ? { messages: shapeMessages(res.events) }
          : { note: 'joined, but the room backlog could not be fetched — use agent_chat_read' }) } };
    }
    if (room.role === 'owner') {
      // The OWNER is answering a third party's join_request. The requester
      // lives in the pendingJoinRequests seam, never in the room record —
      // record() merging the newcomer over an already-joined room is how a
      // refused join_request used to kill routing to the real peer forever
      // (whole-branch review, C1). Admitting/refusing a third party never
      // changes the owner's OWN membership, so no rooms.setState here.
      const peerDeviceId = pendingPeerFor(chatRoomId);
      if (peerDeviceId == null) return { status: 409, body: { error: `no pending join request for room ${chatRoomId} — nothing to answer` } };
      // A room whose local record went terminal (peer left, invite refused or
      // expired) is no longer routable here — admitting a requester into it
      // would strand them talking into a room this bridge drops on the floor
      // (scoped re-review of the C1 isolation).
      if (accept && !rooms.isActive(chatRoomId)) {
        return { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — start a new room instead of admitting into a dead one` } };
      }
      if (!accept) {
        // Refuse is fire-and-forget: a false local refusal on a dead request
        // is harmless — the requester was never admitted either way.
        if (!invites.answer({ roomId: chatRoomId, peerDeviceId, accept: false, reason: cleanReason })) {
          return { status: 502, body: { error: 'journal unreachable' } };
        }
        clearPendingPeer(chatRoomId);
        return { status: 200, body: { ok: true, room_id: chatRoomId, refused: true } };
      }
      // ADMIT is awaited (see the guest-accept contract below): "admitted"
      // may only be reported when the journal stayed silent for the answer.
      const admit = await invites.answerAwait({ roomId: chatRoomId, peerDeviceId, accept: true, reason: cleanReason });
      if (admit.kind !== 'answered') {
        if (admit.code === 'journal_unreachable') {
          // The frame never left the socket — nothing was consumed; retryable.
          return { status: 502, body: { error: 'journal unreachable' } };
        }
        // Only 'conflict'/'not_found' prove the request is dead server-side.
        // Every other code is transient — notably 'not_ready' (the journal
        // accepts ops between hello_ok and registration) and 'forbidden'
        // (answering one's own outstanding request) — and consuming the
        // request on those destroys a LIVE join request locally, which the
        // requester's own retry then conflicts with.
        const dead = admit.code === 'conflict' || admit.code === 'not_found';
        // Dead: consume it — the requester can re-ask (a row still 'invited'
        // would conflict a fresh agent_join, so only the codes that actually
        // clear the row make re-asking possible). Otherwise keep the pending
        // request so the admit itself is retryable.
        if (dead) clearPendingPeer(chatRoomId);
        return {
          status: admit.code === 'conflict' ? 409 : 502,
          body: { error: `journal rejected the admit: ${admit.detail || admit.code || 'unknown error'}${dead ? '' : ' — transient; the request is still pending, retry the admit'}` },
        };
      }
      clearPendingPeer(chatRoomId);
      return { status: 200, body: { ok: true, room_id: chatRoomId, admitted: true } };
    }
    if (room.state !== 'pending') return { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — nothing to answer` } };
    // A guest answering an invite addressed to itself omits peer_device_id
    // (protocol.md).
    if (!accept) {
      // Refuse is fire-and-forget: a false local 'refused' on a dead invite
      // is harmless — both states are terminal.
      if (!invites.answer({ roomId: chatRoomId, peerDeviceId: null, accept: false, reason: cleanReason })) {
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      rooms.setState(chatRoomId, 'refused');
      return { status: 200, body: { ok: true, room_id: chatRoomId, refused: true } };
    }
    // ACCEPT must not trust the socket-write boolean: the journal answers
    // agent_invite_answer only on FAILURE (room_id-stamped error frame), so
    // answerAwait treats silence within its window as the answer having taken
    // — the accepted cost is up to DEFAULT_DELIVER_WAIT_MS (5s) of accept
    // latency. A rejected accept (e.g. a server-expired invite) must NOT go
    // 'joined': every later send would succeed locally and go nowhere.
    const outcome = await invites.answerAwait({ roomId: chatRoomId, peerDeviceId: null, accept: true, reason: cleanReason });
    if (outcome.kind !== 'answered') {
      if (outcome.code === 'journal_unreachable') {
        // Never left the socket: the invite may still be live — the room
        // stays pending and the accept is retryable.
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      // Only 'conflict'/'not_found' prove the invite is dead server-side.
      // Other codes are transient and must NOT latch a terminal state:
      // 'not_ready' is a plain reconnect race (the journal answers hello_ok
      // before it finishes registering the connection, so an op sent in that
      // window fails while the invite stays live), and 'forbidden' is what an
      // agent gets for accepting its own outstanding join request. Expiring
      // on those destroys a live invite locally and permanently — the retry
      // conflicts, and an inbound answer frame only transitions a room out of
      // 'pending'. So leave it pending and report a retryable error.
      const dead = outcome.code === 'conflict' || outcome.code === 'not_found';
      // pending -> expired is an allowed transition; a dead invite's binding
      // must never turn routable.
      if (dead) rooms.setState(chatRoomId, 'expired');
      return {
        status: outcome.code === 'conflict' ? 409 : 502,
        body: { error: `journal rejected the accept: ${outcome.detail || outcome.code || 'unknown error'} — ${dead ? 'the invite is gone; ask for a fresh one' : 'transient; the invite is still pending, retry the accept'}` },
      };
    }
    rooms.setState(chatRoomId, 'joined');
    // Backfill the room so far — above all its opening message: fan-out is
    // participation-gated at publish time and the hello replay cursor has
    // moved on, so without this read the accepting agent never sees what the
    // room was opened WITH (whole-branch review, I1). Best-effort: the join
    // itself already succeeded, so a failed read degrades to a note.
    const res = await publisher.fetchMessages(chatRoomId, { limit: 20 });
    return { status: 200, body: { ok: true, room_id: chatRoomId,
      ...(res ? { messages: shapeMessages(res.events) }
        : { note: 'joined, but the room backlog could not be fetched — use agent_chat_read' }) } };
  }
}
