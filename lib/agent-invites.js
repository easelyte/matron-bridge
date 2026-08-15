// Invite lifecycle + correlation for agent-chat rooms. Owns (a) building and
// sending the five room-op frames via the publisher, (b) one-shot waiters so
// tool calls can await delivered/ack/answer, (c) inbound kind:'invite' frame
// handling -> registry updates + request-turn injection. All side effects are
// injected (spec: agent chat phase 3, "Room lifecycle" / "Error handling").

import { peerField, PEER_NAME_MAX, PEER_TOPIC_MAX, PEER_REASON_MAX, PEER_ID_MAX } from './peer-text.js';

const DEFAULT_ANSWER_WAIT_MS = 10_000;   // idle peer: wait briefly for the answer
const DEFAULT_DELIVER_WAIT_MS = 5_000;   // delivered/offline/error resolution

// The USER's copy of an inbound chat request — one line, published into the
// conversation where the decision is being made (index.js's
// journalInjectInviteRequest). Without it Dan sees his agent answer "I'll
// accept that chat request" with nothing above it saying what was asked.
//
// Deliberately NOT the same text as the agent's injected turn:
//   - no agent_chat_accept/agent_chat_refuse syntax — that is an instruction
//     to the agent, and reads as a demand on the user if shown to them;
//   - who is asking, about what, and the justification VERBATIM — the
//     justification is the "what it says" half of the ask.
//
// Every interpolated field (from_name, topic, justification, room title,
// from_device_id) is written by a REMOTE agent, so each goes through
// peerField: coerced, de-controlled, flattened to one line and capped. A
// justification carrying '\n' must not be able to add a second line to a
// message published in the bridge's own voice — that is line forgery in the
// user's chat, not a cosmetic issue.
export function formatInviteRequestNotice(frame, { roomTitle = null } = {}) {
  const f = frame || {};
  const name = peerField(f.from_name, PEER_NAME_MAX);
  const who = name ? `Agent "${name}"` : `An agent (device ${peerField(f.from_device_id, PEER_ID_MAX) || 'unknown'})`;
  const why = peerField(f.justification, PEER_REASON_MAX);
  const because = why ? `: ${why}` : '';
  if (f.event === 'join_request') {
    // A join_request is about a room that is NOT this conversation, so name
    // it — the notice lands in the session convo, not in the room convo.
    const room = peerField(roomTitle, PEER_TOPIC_MAX) || peerField(f.room_id, PEER_ID_MAX) || 'a room';
    return `🤝 ${who} asks to join the chat "${room}"${because}`;
  }
  const topic = peerField(f.topic, PEER_TOPIC_MAX);
  // "with this session", not just "a chat": this notice is published into
  // the addressed session's own conversation, and before target_convo_id
  // that placement was a guess — so which session was being asked for was
  // exactly the thing a reader could not tell. Saying it makes the
  // placement a claim rather than an implication.
  return `🤝 ${who} requests a chat with this session${topic ? ` about "${topic}"` : ''}${because}`;
}

// deps:
//   sendRoomOp(frame) -> bool        (publisher, Task 2d)
//   onOpError(cb)                    (wired by index.js from publisher option)
//   rooms                            (agent-rooms registry, Task 3)
//   injectRequestTurn(frame)         frame.event: 'request'|'join_request'
//   notifyRoom(roomId, text)         inject an FYI turn into the bound session
//   log
export function createAgentInvites({ sendRoomOp, rooms, injectRequestTurn, notifyRoom, log = console } = {}) {
  // waiters: roomId -> [{events:Set<string>, resolve, timer}]
  const waiters = new Map();

  // Returns { promise, cancel }. The waiter is registered synchronously so
  // callers can arm several stages up front; cancel() (clearTimeout + unhook)
  // MUST be called on any armed waiter a caller abandons, otherwise a later
  // frame settles into the void instead of taking the late-answer path.
  function awaitEvent(roomId, events, timeoutMs) {
    const entry = { events: new Set(events), resolve: null, timer: null };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => {
        unhook(roomId, entry);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      entry.timer.unref?.();
      if (!waiters.has(roomId)) waiters.set(roomId, []);
      waiters.get(roomId).push(entry);
    });
    return { promise, cancel: () => { clearTimeout(entry.timer); unhook(roomId, entry); } };
  }
  function unhook(roomId, entry) {
    const list = waiters.get(roomId) || [];
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) waiters.delete(roomId);
  }
  function settle(roomId, key, value) {
    for (const entry of [...(waiters.get(roomId) || [])]) {
      if (entry.events.has(key)) {
        clearTimeout(entry.timer);
        unhook(roomId, entry);
        entry.resolve(value);
      }
    }
  }
  // settle() variant that reports whether anyone was waiting.
  function settleReturns(roomId, key, value) {
    const had = (waiters.get(roomId) || []).some((e) => e.events.has(key));
    settle(roomId, key, value);
    return had;
  }

  return {
    // ---- outbound (tool-call side) ----
    async invite({ roomId, targetDeviceId, targetConvoId, fromConvoId, topic, justification }) {
      // target_convo_id says WHICH of the target device's conversations this
      // ask is for. Omitted, never null, when unknown: the journal treats a
      // present value as authorisation (it must be a top-level convo that
      // device owns) and the receiving bridge treats its absence as "not
      // addressed" — see index.js resolveInviteTargetSession.
      //
      // from_convo_id is the mirror image: WHICH of our own sessions is
      // asking, so the user's consent card can name it instead of showing a
      // bare device. Same omitted-never-null shape, and the journal
      // validates it against this device the way it does target_convo_id —
      // so sending one we do not own would fail the whole invite, not just
      // the label.
      if (!sendRoomOp({ op: 'agent_invite', room_id: roomId, target_device_id: targetDeviceId, ...(targetConvoId ? { target_convo_id: targetConvoId } : {}), ...(fromConvoId ? { from_convo_id: fromConvoId } : {}), ...(topic ? { topic } : {}), justification })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // Journal answers with EITHER an error frame (ref:'agent_invite') OR
      // {event:'delivered'}; then ack/answer follow on their own schedule.
      // ALL stage waiters are armed before the first await: ws can emit a
      // whole batch of frames in one synchronous tick (delivered+ack+answer
      // back-to-back from one TCP chunk), and a waiter created only after
      // that batch drains would miss its frame. Each stage's timeout covers
      // the full elapsed budget since arming. Waiters abandoned on an early
      // return are cancelled so a genuinely late answer still surfaces via
      // the notifyRoom path instead of settling into the void.
      const deliveredW = awaitEvent(roomId, ['delivered', 'error:agent_invite'], DEFAULT_DELIVER_WAIT_MS);
      const outcomeW = awaitEvent(roomId, ['ack', 'answer'], DEFAULT_DELIVER_WAIT_MS + DEFAULT_ANSWER_WAIT_MS);
      const answerW = awaitEvent(roomId, ['answer'], DEFAULT_DELIVER_WAIT_MS + 2 * DEFAULT_ANSWER_WAIT_MS);
      const delivered = await deliveredW.promise;
      if (delivered.kind !== 'delivered') {
        outcomeW.cancel(); answerW.cancel();
        // A slow-but-healthy round trip is "quiet", not a raw timeout.
        return delivered.kind === 'timeout' ? { kind: 'pending_quiet' } : delivered;
      }
      const outcome = await outcomeW.promise;
      if (outcome.kind === 'timeout') { answerW.cancel(); return { kind: 'pending_quiet' }; }
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') { answerW.cancel(); return { kind: 'pending_busy' }; }
      if (outcome.kind === 'ack') {
        // idle ack — the real answer should be close behind; wait once more
        const answer = await answerW.promise;
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      return outcome; // answer — the same frame settled answerW, nothing left to cancel
    },
    // Same-bridge invite: no journal op and no 'delivered' stage — delivery
    // IS the synchronous local inject the caller performs right after this
    // arms its waiters, and the ack/answer arrive as loopback frames through
    // onInviteFrame exactly as journal ones do. Waiters MUST be armed before
    // the inject runs (call inviteLocal first, then deliver, then await the
    // returned promise): the loopback ack can fire in the same tick.
    async inviteLocal({ roomId }) {
      const outcomeW = awaitEvent(roomId, ['ack', 'answer'], DEFAULT_ANSWER_WAIT_MS);
      const answerW = awaitEvent(roomId, ['answer'], 2 * DEFAULT_ANSWER_WAIT_MS);
      const outcome = await outcomeW.promise;
      if (outcome.kind === 'timeout') { answerW.cancel(); return { kind: 'pending_quiet' }; }
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') { answerW.cancel(); return { kind: 'pending_busy' }; }
      if (outcome.kind === 'ack') {
        const answer = await answerW.promise;
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      return outcome; // answer — the same frame settled answerW, nothing left to cancel
    },
    async join({ roomId, justification }) {
      if (!sendRoomOp({ op: 'agent_join', room_id: roomId, justification })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // Same up-front arming + cancellation discipline as invite() above.
      const deliveredW = awaitEvent(roomId, ['delivered', 'error:agent_join'], DEFAULT_DELIVER_WAIT_MS);
      const outcomeW = awaitEvent(roomId, ['ack', 'answer'], DEFAULT_DELIVER_WAIT_MS + DEFAULT_ANSWER_WAIT_MS);
      const answerW = awaitEvent(roomId, ['answer'], DEFAULT_DELIVER_WAIT_MS + 2 * DEFAULT_ANSWER_WAIT_MS);
      const delivered = await deliveredW.promise;
      if (delivered.kind !== 'delivered') {
        outcomeW.cancel(); answerW.cancel();
        return delivered.kind === 'timeout' ? { kind: 'pending_quiet' } : delivered;
      }
      const outcome = await outcomeW.promise;
      if (outcome.kind === 'timeout') { answerW.cancel(); return { kind: 'pending_quiet' }; }
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') { answerW.cancel(); return { kind: 'pending_busy' }; }
      if (outcome.kind === 'ack') {
        const answer = await answerW.promise;
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      return outcome;
    },
    ack({ roomId, peerDeviceId = null, sessionState }) {
      return sendRoomOp({ op: 'agent_invite_ack', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), session_state: sessionState });
    },
    answer({ roomId, peerDeviceId = null, accept, reason }) {
      return sendRoomOp({ op: 'agent_invite_answer', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), accept, ...(reason ? { reason } : {}) });
    },
    // Awaited answer(). The journal answers agent_invite_answer ONLY on
    // failure (fail() stamps ref:'agent_invite_answer'); silence within the
    // error window means the answer took — the same contract as leave().
    // Required for accept paths: acting on the socket-write boolean alone can
    // mark a room 'joined' whose answer the journal rejected (server-expired
    // invite), a permanent local/remote split. Refuse paths may keep the
    // fire-and-forget answer(): a false local 'refused' on a dead invite is
    // harmless and terminal either way.
    async answerAwait({ roomId, peerDeviceId = null, accept, reason }) {
      // Armed before the send — same up-front discipline as invite()/leave():
      // the error frame may arrive in the first synchronous batch the socket
      // drains after we yield.
      const errW = awaitEvent(roomId, ['error:agent_invite_answer'], DEFAULT_DELIVER_WAIT_MS);
      if (!sendRoomOp({ op: 'agent_invite_answer', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), accept, ...(reason ? { reason } : {}) })) {
        errW.cancel();
        return { kind: 'error', code: 'journal_unreachable' };
      }
      const res = await errW.promise;
      return res.kind === 'timeout' ? { kind: 'answered' } : res;
    },
    async leave({ roomId }) {
      if (!sendRoomOp({ op: 'agent_leave', room_id: roomId })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // The journal answers agent_leave ONLY on failure (fail() stamps
      // ref:'agent_leave' — e.g. conflict "not a joined participant", which
      // is what a room OWNER always gets: it has no convo_agents row to
      // leave). Success is silent to the leaver (only the remaining
      // participant hears 'left'), so arm an error waiter and treat its
      // timeout as the leave having taken (whole-branch review, C2).
      const errW = awaitEvent(roomId, ['error:agent_leave'], DEFAULT_DELIVER_WAIT_MS);
      const res = await errW.promise;
      return res.kind === 'timeout' ? { kind: 'left' } : res;
    },

    // ---- inbound (wired as publisher onInviteFrame / onOpError) ----
    onInviteFrame(frame) {
      const { event, room_id: roomId } = frame;
      if (event === 'delivered') { settle(roomId, 'delivered', { kind: 'delivered' }); return; }
      if (event === 'ack') { settle(roomId, 'ack', { kind: 'ack', sessionState: frame.session_state }); return; }
      if (event === 'answer') {
        // A server-side expiry answer has no from_device_id; a peer refusal
        // does (even one whose reason text happens to say "expired").
        const expired = !frame.accept && frame.from_device_id == null;
        const value = frame.accept
          ? { kind: 'accepted', peerDeviceId: frame.peer_device_id }
          : { kind: 'refused', reason: frame.reason || (expired ? 'expired' : ''), peerDeviceId: frame.peer_device_id };
        const room = rooms.get(roomId);
        if (room) {
          // Only a pending room transitions on an answer: a duplicate or
          // out-of-order answer must not resurrect a refused/left room.
          // Waiters are still settled and late answers still notify.
          if (room.state === 'pending') {
            rooms.setState(roomId, frame.accept ? 'joined' : (expired ? 'expired' : 'refused'));
          }
          // Late answers (after the tool stopped waiting) surface as a turn.
          if (!settleReturns(roomId, 'answer', value) && notifyRoom) {
            const what = frame.accept ? 'accepted the chat' : `refused the chat${value.reason ? `: ${value.reason}` : ''}`;
            try { notifyRoom(roomId, what); } catch { }
          }
        } else {
          settle(roomId, 'answer', value);
        }
        return;
      }
      if (event === 'request' || event === 'join_request') {
        try { injectRequestTurn(frame); } catch (e) { try { log.warn(`[agent-invites] injectRequestTurn threw: ${e.message}`); } catch { } }
        return;
      }
      if (event === 'left') {
        const room = rooms.get(roomId);
        if (room) {
          // v1 rooms are pairwise: the peer leaving ends the room. Mark it
          // so isActive/chatSend stop treating it as live (chatRead still
          // works — it does not require 'joined').
          rooms.setState(roomId, 'left');
          if (notifyRoom) { try { notifyRoom(roomId, 'left the room'); } catch { } }
        }
        return;
      }
    },
    onOpError({ code, ref, detail, roomId = null }) {
      if (ref !== 'agent_invite' && ref !== 'agent_join' && ref !== 'agent_leave' && ref !== 'agent_invite_answer') return;
      // Newer journals stamp the failing op's room_id on the error frame
      // (publisher surfaces it as roomId, null when absent). A correlated
      // error settles ONLY that room — and consumes the frame even when
      // nobody is waiting there, because falling through to the scan would
      // mis-settle some OTHER room's in-flight waiter with this room's
      // error.
      if (roomId) {
        settleReturns(roomId, `error:${ref}`, { kind: 'error', code, detail });
        return;
      }
      // Unstamped fallback (older journals, and any frame whose error path
      // loses the room_id): correlate at ref level, but ONLY when the match
      // is unambiguous — settle iff EXACTLY ONE room currently holds a
      // waiter for this ref, otherwise settle none.
      //
      // Picking the first match instead would guess whenever several ops of
      // one family are in flight (eviction fires a BATCH of agent_leave ops;
      // two accepts can overlap), and a wrong guess is a false TERMINAL
      // outcome on a live room — 'left'/'expired' that no later frame undoes.
      // Letting the real failure fall through to its own timeout is the
      // benign failure; mis-settling is not. Deciding by ambiguity rather
      // than by journal capability also means nothing to infer, nothing to
      // latch, and no wrong behaviour after a journal downgrade.
      const key = `error:${ref}`;
      let only = null;
      for (const [rid, list] of waiters) {
        if (!list.some((e) => e.events.has(key))) continue;
        if (only !== null) return; // two or more rooms match — uncorrelatable
        only = rid;
      }
      if (only !== null) settle(only, key, { kind: 'error', code, detail });
    },
  };
}
