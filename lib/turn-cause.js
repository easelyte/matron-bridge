// What started a session's turn. The bridge records it when a turn begins —
// the user's message, a tap or reply on a tracker item, a routine firing, a
// room message, a spawn outcome, a reminder — and sends it as `causes` on the
// asks the agent makes during that turn, so the journal can check an ask
// against the thing that actually prompted it rather than taking the agent's
// word for it. Pure helpers only: index.js and the turn routers own the
// session state and call these to build, merge and read it.

// The shared vocabulary with the journal. A kind the journal does not know is
// a bug here, not data, so cause() throws on one rather than sending it.
export const CAUSE_KINDS = [
  'user_message', 'item_reply', 'item_tap', 'routine', 'spawn_outcome',
  'room_message', 'reminder', 'carry_on', 'alert', 'handoff', 'other',
];
const KIND_SET = new Set(CAUSE_KINDS);

// One turn can be started by several things at once (queued messages flushed
// together, a batch of room messages); the journal only needs enough to find
// the one that matters, so the list is capped rather than grown without bound.
export const CAUSES_MAX = 8;
// A ref is an id, never prose; the cap keeps a peer-supplied id (a room id,
// a routine name) from blowing up every ask the turn makes.
export const CAUSE_REF_MAX = 200;

export function cause(kind, ref = null) {
  if (!KIND_SET.has(kind)) throw new Error(`unknown cause kind: ${kind}`);
  const c = { kind };
  if (ref != null) c.ref = String(ref).slice(0, CAUSE_REF_MAX);
  c.at = Date.now();
  return c;
}

export function userMessageCause(convoId, seq) {
  return cause('user_message', `${convoId}:${seq}`);
}

// The label the user tapped, if the comment is a one-tap reply, or null for
// typed words. It lives on the COMMENT (`comment.action`, or
// `comment.meta.action` from a journal a version behind); lib/items-turn.js
// renders the same label in the turn text. The marker's own `payload.action`
// is the event verb ('commented', 'created'…), a string on every marker, so it
// cannot tell a tap from a typed reply.
export function tappedAction(comment) {
  if (!comment || typeof comment !== 'object') return null;
  if (typeof comment.action === 'string' && comment.action.trim()) return comment.action;
  const meta = comment.meta;
  if (meta && typeof meta === 'object' && typeof meta.action === 'string' && meta.action.trim()) return meta.action;
  return null;
}

// ref `item:<num>@<created_at>` names the exact comment the journal can look
// up (the item number plus the comment's created_at, in ms, as item_get prints
// it). Without both there is nothing to look up, so there is no cause.
export function itemCause(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const num = payload.num;
  const createdAt = payload.comment?.created_at;
  if (!Number.isInteger(num) || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return cause(tappedAction(payload.comment) != null ? 'item_tap' : 'item_reply', `item:${num}@${d.toISOString()}`);
}

// firedAt is the journal's own ISO string, passed through untouched so the
// journal matches it byte for byte against its fire log.
export function routineCause({ name, firedAt } = {}) {
  return cause('routine', `routine:${name}@${firedAt}`);
}

export function spawnOutcomeCause(requestId) {
  return cause('spawn_outcome', `spawn:${requestId}`);
}

const isSeq = (n) => Number.isSafeInteger(n) && n > 0;

// ref `room:<id>@<seq>` names one room message, `room:<id>@<from>-<to>` the
// messages of one room a turn took together (the journal looks up which of
// them the Coordinator had a hand in, so a batch is one cause, not one per
// message); bare `room:<id>` when the seqs are unknown (a same-bridge room's
// direct hand-off), which the journal reads as "any message of that room".
export function roomMessageCause(roomId, fromSeq = null, toSeq = fromSeq) {
  if (!isSeq(fromSeq)) return cause('room_message', `room:${roomId}`);
  const to = isSeq(toSeq) && toSeq > fromSeq ? toSeq : fromSeq;
  return cause('room_message', to === fromSeq ? `room:${roomId}@${fromSeq}` : `room:${roomId}@${fromSeq}-${to}`);
}

// One cause per room for a batch of room messages ({roomId, seq?}), each
// spanning the seqs of that room's messages; a room with any message of
// unknown seq gets the bare cause, since its range would not cover it.
// -> Map roomId -> cause, rooms in the order their first message came.
export function roomBatchCauses(msgs) {
  const byRoom = new Map();
  for (const m of msgs || []) {
    if (!m?.roomId) continue;
    const r = byRoom.get(m.roomId) || { min: null, max: null, unknown: false };
    if (isSeq(m.seq)) {
      r.min = r.min == null ? m.seq : Math.min(r.min, m.seq);
      r.max = r.max == null ? m.seq : Math.max(r.max, m.seq);
    } else {
      r.unknown = true;
    }
    byRoom.set(m.roomId, r);
  }
  return new Map([...byRoom].map(([roomId, r]) => [roomId, r.unknown ? roomMessageCause(roomId) : roomMessageCause(roomId, r.min, r.max)]));
}

// A Coordinator carry-on names the journal's record of it (`carry_on_id`,
// relayed with the RPC), so the journal can follow it back to the
// Coordinator's own turn. Without an id (a journal that predates it) the
// kind alone, which the journal refuses to vouch for.
export const CARRY_ON_ID_RE = /^co_[0-9a-f]{16}$/;
export function carryOnCause(carryOnId = null) {
  return cause('carry_on', typeof carryOnId === 'string' && CARRY_ON_ID_RE.test(carryOnId) ? `carry_on:${carryOnId}` : null);
}

// A spawned session's opening turn: the harness started it, with the task
// of the journal's spawn `spawnId` (relayed with the start RPC). `other`,
// which never carries the user's authority, with the spawn as its ref so the
// journal can follow the child's asks back to whoever asked for the spawn.
// An older journal sends no id: then `other` alone.
const SPAWN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export function spawnedCause(spawnId = null) {
  return cause('other', typeof spawnId === 'string' && SPAWN_ID_RE.test(spawnId) ? `spawned:${spawnId}` : null);
}

// reminder / alert / handoff / other: nothing the journal could look up, so
// the kind alone.
export function plainCause(kind) {
  return cause(kind);
}

// Lists (or single causes) -> one list: flattened one level, falsy and
// malformed entries dropped, deduped by kind+ref keeping the first, capped.
// Past the cap the last slot becomes `other`/`truncated`: a dropped cause may
// have been the untrusted one, so the cut must never read as a cleaner turn.
// null when nothing is left, so "no causes" has exactly one shape.
export function mergeCauses(lists) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(lists) ? lists : []) {
    for (const c of Array.isArray(entry) ? entry : [entry]) {
      if (!c || typeof c !== 'object' || !KIND_SET.has(c.kind)) continue;
      const key = `${c.kind}\0${c.ref ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= CAUSES_MAX) {
        out.length = CAUSES_MAX - 1;
        out.push(cause('other', 'truncated'));
        return out;
      }
      out.push(c);
    }
  }
  return out.length ? out : null;
}

// A turn already on the session gaining more causes (an iv prompt seam
// clears busy but keeps the turn; mid-turn input joins it): merged, never
// replaced, and a side with no causes counts as `other` — what started it is
// unknown, which must never make the turn look more trusted than it was.
export function mergeTurnCauses(existing, incoming) {
  return mergeCauses([
    mergeCauses([existing]) ?? [plainCause('other')],
    mergeCauses([incoming]) ?? [plainCause('other')],
  ]);
}

// mergeTurnCauses into the session's turn, keeping its start time; a
// session with no turn gets one, its unknown start counted as `other`.
export function mergeIntoTurn(session, incoming) {
  const turn = session.currentTurn;
  if (turn) turn.causes = mergeTurnCauses(turn.causes, incoming);
  else session.currentTurn = { causes: mergeTurnCauses(null, incoming), startedAt: Date.now() };
}

// The causes of a session's queued entries (each may carry `cause`), for the
// turn that flushes them together.
export function queueCauses(queued) {
  return mergeCauses((queued || []).map((e) => e?.cause));
}

// A queued or resume-held message (a blocks array) keeps the causes of the
// send that queued it, for queueCauses to merge when the queue flushes as one
// turn. Non-enumerable, like lib/queue-flush.js's journal-origin mark, so it
// never leaks into a stdin frame or a debug dump and rides wherever the same
// array object goes. No causes leaves the entry as it was.
export function tagCauses(entry, causes) {
  const list = mergeCauses([causes]);
  if (!list || !entry || typeof entry !== 'object') return entry;
  try {
    Object.defineProperty(entry, 'cause', { value: list, enumerable: false, writable: true, configurable: true });
  } catch { /* frozen/exotic: the flush simply has no cause for it */ }
  return entry;
}

export function beginTurn(session, causes) {
  session.currentTurn = { causes: mergeCauses([causes]), startedAt: Date.now() };
}

// The turn seam for anything about to make the session busy (sendToSession,
// and the raw tool_result writes that answer a question or approve a plan):
// call it BEFORE setting busy. A session with no turn begins one with these
// causes; one that already holds a turn only gains them (mergeIntoTurn) —
// always when the session is idle (an iv prompt seam clears busy but keeps
// the turn), and when busy only if there are causes to add. True when this
// call began the turn, so a failed dispatch knows the turn is its to end.
export function beginOrJoinTurn(session, causes) {
  const turnStarts = !session.busy;
  const began = turnStarts && !session.currentTurn;
  if (began) beginTurn(session, causes);
  else if (turnStarts || causes) mergeIntoTurn(session, causes);
  return began;
}

// Causes for a turn that must already be running (an iv plan hook it is
// blocked on, say): merged into it, and nothing else. Unlike mergeIntoTurn,
// a session with no turn is left with none. A hook can outlive its turn (an
// interrupted turn's pending decision lingers until its timeout), and a turn
// created for it here would never be ended by agent output, so the next
// room message or routine send would merge into it and inherit these
// causes. True when they were merged.
export function joinHeldTurn(session, causes) {
  if (!session?.currentTurn || !mergeCauses([causes])) return false;
  mergeIntoTurn(session, causes);
  return true;
}

export function endTurn(session) {
  session.currentTurn = null;
}

export function causesForAsk(session) {
  return session?.currentTurn?.causes ?? null;
}
