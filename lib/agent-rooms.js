// Persisted registry of agent-chat rooms this bridge participates in.
// A "room" here is a journal conversation (top-level UUID) plus this
// bridge's relationship to it: which local session it is bound to, whether
// we created it (owner) or were invited (guest), and where the invite
// lifecycle stands. Survives restarts so room delivery resumes (spec:
// agent chat phase 3, "Room↔session mapping persisted to disk").

// A pending invite the server would have expired must not stay routable
// forever if we miss the answer frame (invite frames are ephemeral, never
// replayed). Matches the server's ~30-minute invite expiry default.
export const INVITE_TTL_MS = 30 * 60 * 1000;
// A room with another PERSON waits on two people, each answering a card in
// their own time: the asking user's card (up to a day) and then the other
// person's (up to a week for a talk request). Its pending binding has to
// outlive both, or the answer would land on a room this bridge had already
// forgotten and the other side's replies would have nowhere to go.
export const PERSON_INVITE_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const pendingTtl = (r) => (r && typeof r.person === 'string' && r.person ? PERSON_INVITE_TTL_MS : INVITE_TTL_MS);

const STATES = new Set(['pending', 'joined', 'refused', 'left', 'expired']);
// Terminal states can only be renewed via record() (a fresh invite/join),
// never resurrected by setState (late/duplicate answer frames).
const TERMINAL = new Set(['refused', 'left', 'expired']);
// Is ONE binding of a room still live right now? 'joined' always; 'pending'
// only inside the invite TTL — past it the server has expired the invite and
// the load-time reaper would drop the record, so an in-memory pending entry
// past the TTL must not be handed back as reusable either (it would hand an
// agent a room id nothing will ever answer on).
//
// `since` is the binding's OWN pendingSince stamp, not the record's updatedAt.
// updatedAt is bumped by any write to the record — the other binding's
// setState, a setMuted, a partial re-record — so an invite nobody ever
// answered looked fresh again every time something unrelated happened to the
// room, which is exactly the staleness this TTL exists to catch. Falls back to
// updatedAt for records written before the stamp existed, so a legacy pending
// entry ages out on its old (approximate) clock rather than never or at once.
function bindingIsLive(state, since, updatedAt, ttl = INVITE_TTL_MS) {
  if (state === 'joined') return true;
  return state === 'pending' && Date.now() - (since ?? updatedAt ?? 0) < ttl;
}

// The key an announced mute is filed under when its line named nobody (and
// what a record from before per-member mutes reads as).
const UNNAMED_MUTER = '';
// A record's announced mutes, upgrading the single `peerMuted` flag older
// records carry into one unnamed entry.
function peerMuteMap(r) {
  if (r.peerMutes && typeof r.peerMutes === 'object' && !Array.isArray(r.peerMutes)) return r.peerMutes;
  return r.peerMuted ? { [UNNAMED_MUTER]: { reason: null, at: r.updatedAt || 0 } } : {};
}
// The box part of a session label: "box-a [3f]" -> "box-a".
export function labelBox(label) {
  return String(label || '').replace(/ \[[^\]]*\]$/u, '');
}

export function createAgentRooms({ load, save, log = console } = {}) {
  let loaded;
  try { loaded = load?.() || {}; } catch { loaded = {}; }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) loaded = {};
  // Room ids are wire-derived: a null-prototype map keeps them plain keys
  // (no inherited hits, no prototype pollution) — same stance as
  // lib/journal-rpc.js / lib/mcp-config.js.
  const rooms = Object.assign(Object.create(null), loaded);
  for (const [id, r] of Object.entries(rooms)) {
    // Drop malformed persisted entries so every consumer can trust the shape.
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.sessionRoomId !== 'string') { delete rooms[id]; continue; }
    // Prune dead weight at load, since nothing else ever removes it and
    // every inbound request rewrites the whole file: any non-joined entry
    // (terminal refused/left/expired, or a pending invite the server will
    // have expired) whose last update is past the invite TTL is unroutable
    // and unanswerable, so it only bloats the registry.
    if (r.state !== 'joined' && Date.now() - (r.updatedAt || 0) > (r.state === 'pending' ? pendingTtl(r) : INVITE_TTL_MS)) delete rooms[id];
  }

  function persist() {
    try { save?.({ ...rooms }); } catch (e) { try { log.warn(`[agent-rooms] persist failed: ${e.message}`); } catch { } }
  }

  // Every OTHER member that has muted the room, as seen from this session's
  // binding: [{ who, reason }], `who` null when it cannot be named. A
  // same-bridge room reads the other binding's own flag; announced mutes
  // from remote members are added for both room shapes. Total: [] for an
  // unknown room or a session with no binding.
  function peerMutesFor(roomId, sessionRoomId) {
    const r = rooms[roomId];
    if (!r) return [];
    const out = [];
    if (r.guestSessionRoomId != null) {
      if (r.sessionRoomId === sessionRoomId) {
        if (r.guestMuted) out.push({ who: r.guestMutedBy || null, reason: r.guestMutedReason || null });
      } else if (r.guestSessionRoomId === sessionRoomId) {
        if (r.muted) out.push({ who: r.mutedBy || null, reason: r.mutedReason || null });
      } else {
        return [];
      }
    } else if (r.sessionRoomId !== sessionRoomId) {
      return [];
    }
    for (const [k, v] of Object.entries(peerMuteMap(r))) {
      out.push({ who: k === UNNAMED_MUTER ? null : k, reason: v?.reason ?? null });
    }
    return out;
  }

  return {
    // role: 'owner'|'guest'; state: 'pending'|'joined'|'refused'|'left'|'expired'
    // ('pending' ≙ the server's 'invited'; 'expired' is bridge-local, the server has no such state).
    //
    // guestSessionRoomId/guestState: the SECOND local binding of a same-bridge
    // ("local") room — both participants live on this bridge, so one record
    // holds the owner binding in sessionRoomId/role/state and the invited
    // session in the guest fields. Remote rooms never set them. A room is
    // local iff guestSessionRoomId != null.
    // person/talk: a room with another PERSON's agent (their name, as the
    // journal knows them), and whether it was asked for by name rather than
    // at one of their shared sessions. Never cleared by a partial re-record.
    record(roomId, { role, state, sessionRoomId, peerDeviceId, peerName, topic, title, targetConvoId, guestSessionRoomId, guestState, person, talk } = {}) {
      // Merge semantics: only supplied keys overwrite; null defaults apply
      // only when the room is new (a partial re-record must not null out
      // previously learned peer fields — nor, since mute rides on the same
      // record, silently unmute a member).
      const patch = {};
      for (const [k, v] of Object.entries({ role, state, sessionRoomId, peerDeviceId, peerName, topic, title, targetConvoId, guestSessionRoomId, guestState, person, talk })) {
        if (v !== undefined) patch[k] = v;
      }
      // Each binding's invite clock starts when THAT binding enters 'pending',
      // and restarts if a fresh invite re-records it — record() is the only
      // way a terminal binding is renewed, so it is where the clock resets.
      const now = Date.now();
      if (patch.state === 'pending') patch.pendingSince = now;
      if (patch.guestState === 'pending') patch.guestPendingSince = now;
      const existing = rooms[roomId];
      rooms[roomId] = {
        ...(existing || {
          peerDeviceId: null, peerName: null, topic: null, title: null,
          targetConvoId: null, guestSessionRoomId: null, guestState: null,
          pendingSince: null, guestPendingSince: null,
          muted: false, mutedReason: null, guestMuted: false, guestMutedReason: null,
        }),
        ...patch,
        updatedAt: Date.now(),
        createdAt: existing?.createdAt ?? Date.now(),
      };
      persist();
      return { ...rooms[roomId] };
    },
    setState(roomId, state) {
      const r = rooms[roomId];
      if (!r) return null;
      if (!STATES.has(state)) return null;
      if (TERMINAL.has(r.state)) return null;
      // Nothing in the bridge transitions INTO 'pending' this way today (a
      // fresh invite goes through record()), but the clock belongs with the
      // state either way — a stamp that only some writers maintain is how a
      // binding ends up judged against a timestamp that means something else.
      rooms[roomId] = { ...r, state, ...(state === 'pending' ? { pendingSince: Date.now() } : {}), updatedAt: Date.now() };
      persist();
      return { ...rooms[roomId] };
    },
    // Guest-binding twin of setState, same terminal discipline: a refused or
    // left guest binding is not resurrected by a late answer.
    setGuestState(roomId, state) {
      const r = rooms[roomId];
      if (!r || r.guestSessionRoomId == null) return null;
      if (!STATES.has(state)) return null;
      if (TERMINAL.has(r.guestState)) return null;
      rooms[roomId] = { ...r, guestState: state, ...(state === 'pending' ? { guestPendingSince: Date.now() } : {}), updatedAt: Date.now() };
      persist();
      return { ...rooms[roomId] };
    },
    get(roomId) {
      const r = rooms[roomId];
      return r ? { ...r } : null;
    },
    // The caller's OWN relationship to a room: which binding (if any) this
    // session key holds, as {role, state}. The primary binding wins when a
    // room somehow binds one session on both sides — record() is what
    // prevents that, this just makes the lookup total.
    bindingFor(roomId, sessionRoomId) {
      const r = rooms[roomId];
      if (!r) return null;
      if (r.sessionRoomId === sessionRoomId) return { role: r.role, state: r.state, binding: 'primary' };
      if (r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId) {
        return { role: 'guest', state: r.guestState, binding: 'guest' };
      }
      return null;
    },
    // --- Per-side mute (2026-08-19) ---
    //
    // Mute is the escape hatch that replaced agent_chat_leave: a room now
    // lives for the life of the two conversations (across reaps, restarts
    // and the box sleeping, 2026-09-21), so the only way out of a peer
    // that loops or spams is for ONE member to stop taking delivery. It is
    // purely bridge-local (no journal protocol field) and per BINDING — the
    // muting agent's own side — so a local room's two ends mute
    // independently. It rides on the room record, which is what makes its
    // durability exactly the registry's: persisted if the registry is,
    // in-memory if it isn't. No second store.
    //
    // Returns the updated record, or null when this session holds no binding
    // on this room (same "not a participant" answer every other lookup gives).
    setMuted(roomId, sessionRoomId, muted, { reason = null, who = null } = {}) {
      const r = rooms[roomId];
      if (!r) return null;
      const isPrimary = r.sessionRoomId === sessionRoomId;
      const isGuest = r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId;
      if (!isPrimary && !isGuest) return null;
      // The reason is only meaningful while the mute is on: clearing it with
      // the flag stops a stale "why" surviving into the next mute.
      // `who` is the muting session's own label, kept so the OTHER binding of
      // a same-bridge room can be told exactly who stopped listening.
      const patch = isPrimary
        ? { muted: !!muted, mutedReason: muted ? reason : null, mutedBy: muted ? who : null }
        : { guestMuted: !!muted, guestMutedReason: muted ? reason : null, guestMutedBy: muted ? who : null };
      rooms[roomId] = { ...r, ...patch, updatedAt: Date.now() };
      persist();
      return { ...rooms[roomId] };
    },
    // Total: an unknown room or a session with no binding is not muted (it
    // simply gets nothing), so delivery callers need no null dance.
    isMuted(roomId, sessionRoomId) {
      const r = rooms[roomId];
      if (!r) return false;
      if (r.sessionRoomId === sessionRoomId) return !!r.muted;
      if (r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId) return !!r.guestMuted;
      return false;
    },

    // --- Other members' mutes, as last announced ---
    //
    // A REMOTE member's mute is held by its own bridge; this side only learns
    // of it from the 🔇/🔊 lines that bridge posts into the room (index.js
    // journalOnRoomFrame). Recorded so agent_chat_send can tell the sender
    // its messages are going nowhere — and to WHOM. A room can hold three or
    // more members, so this is a record per muting member, keyed by the
    // label its line names ("box-a [3f]"), never one flag for "the other
    // side": a single flag let a third member's mute read as the owner's.
    // `who` null is an announcement nobody could be named from; it is kept
    // under a placeholder so the sender is still warned.
    setPeerMuted(roomId, muted, { who = null, reason = null } = {}) {
      const r = rooms[roomId];
      if (!r) return null;
      const key = who || UNNAMED_MUTER;
      const mutes = { ...peerMuteMap(r) };
      if (muted) {
        if (mutes[key] && mutes[key].reason === reason) return { ...r };
        mutes[key] = { reason, at: Date.now() };
      } else if (who) {
        // A member unmuting whose mute was never filed under its name must
        // be the unnamed entry (a record from before members were named, or a
        // line nobody could be read from): the unmute is the only word it will
        // ever send, so that entry goes. A member that WAS filed by name
        // clears only its own — the unnamed one is someone else's.
        if (mutes[key]) delete mutes[key];
        else if (mutes[UNNAMED_MUTER]) delete mutes[UNNAMED_MUTER];
        else return { ...r };
      } else {
        // An unmute nobody could be named from: the older single-flag
        // behaviour, which cleared everything.
        if (!Object.keys(mutes).length) return { ...r };
        for (const k of Object.keys(mutes)) delete mutes[k];
      }
      const { peerMuted: _legacy, ...rest } = r;
      rooms[roomId] = { ...rest, peerMutes: mutes, updatedAt: Date.now() };
      persist();
      return { ...rooms[roomId] };
    },
    // A member left the room: whatever mute it announced goes with it. Matched
    // on the box part of the label, which is all a leave frame names.
    clearPeerMutesForBox(roomId, boxName) {
      const r = rooms[roomId];
      if (!r || !boxName) return 0;
      const mutes = { ...peerMuteMap(r) };
      let n = 0;
      for (const k of Object.keys(mutes)) {
        if (labelBox(k) === boxName) { delete mutes[k]; n++; }
      }
      if (!n) return 0;
      const { peerMuted: _legacy, ...rest } = r;
      rooms[roomId] = { ...rest, peerMutes: mutes, updatedAt: Date.now() };
      persist();
      return n;
    },
    peerMutesFor,
    // Has any OTHER member muted the room? Total, like isMuted.
    isPeerMuted(roomId, sessionRoomId) {
      return peerMutesFor(roomId, sessionRoomId).length > 0;
    },

    // The LIVE room this session already has with the same target, or null —
    // the lookup behind reuse-first chatStart (one persistent room per session
    // pair, 2026-08-19). Agents used to close a room and open a new one for
    // every exchange; now a second chatStart at the same target returns the
    // room they already have.
    //
    // The two room shapes are keyed differently on purpose:
    //
    //   REMOTE — peerDeviceId + targetConvoId (the conversation the caller
    //     picked out of agent_roster). The device alone is not enough: two
    //     sessions on the same box are two different correspondents, and a
    //     device-only key would fold them into one room. Records written
    //     before targetConvoId existed carry null and so never match — an old
    //     room fails safe into "start a new one".
    //
    //   LOCAL — the two SESSION KEYS, in either direction. Both ends live in
    //     this one record and each names the OTHER's conversation, so the two
    //     sides would supply different targetConvoIds; keying a local room on
    //     it would only ever match the side that created it, and the peer
    //     would open a duplicate room back. The other binding must also still
    //     be live: a half-dead local room routes nothing.
    // `person`: the pair is this session and another PERSON — any live room
    // this session asked them for (by name or at one of their sessions).
    findLivePair(sessionRoomId, { peerDeviceId = null, targetConvoId = null, peerSessionRoomId = null, person = null } = {}) {
      if (!sessionRoomId) return null;
      for (const [id, r] of Object.entries(rooms)) {
        const isPrimary = r.sessionRoomId === sessionRoomId;
        const isGuest = r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId;
        if (!isPrimary && !isGuest) continue;
        if (!bindingIsLive(isPrimary ? r.state : r.guestState,
          isPrimary ? r.pendingSince : r.guestPendingSince, r.updatedAt, pendingTtl(r))) continue;
        if (person) {
          if (isPrimary && r.role === 'owner' && r.person === person) return { roomId: id, ...r };
          continue;
        }
        if (r.guestSessionRoomId != null) {
          if (!peerSessionRoomId) continue;
          const otherKey = isPrimary ? r.guestSessionRoomId : r.sessionRoomId;
          const otherState = isPrimary ? r.guestState : r.state;
          const otherSince = isPrimary ? r.guestPendingSince : r.pendingSince;
          if (otherKey !== peerSessionRoomId) continue;
          if (!bindingIsLive(otherState, otherSince, r.updatedAt)) continue;
        } else {
          if (!targetConvoId || r.targetConvoId !== targetConvoId) continue;
          if (peerDeviceId == null || r.peerDeviceId !== peerDeviceId) continue;
        }
        return { roomId: id, ...r };
      }
      return null;
    },
    isActive(roomId) {
      const r = rooms[roomId];
      if (!r) return false;
      if (r.state === 'joined') return true;
      return r.state === 'pending' && Date.now() - r.updatedAt < pendingTtl(r);
    },
    forSession(sessionRoomId) {
      // Guest bindings are reported with the BINDING's role/state substituted
      // in, plus `binding` so callers (the teardown loop) can tell which side
      // of a local room this session holds without re-deriving it.
      const out = [];
      for (const [id, r] of Object.entries(rooms)) {
        if (r.sessionRoomId === sessionRoomId) out.push({ roomId: id, ...r, binding: 'primary' });
        else if (r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId) {
          out.push({ roomId: id, ...r, role: 'guest', state: r.guestState, binding: 'guest' });
        }
      }
      return out;
    },
    remove(roomId) {
      if (!rooms[roomId]) return false;
      delete rooms[roomId];
      persist();
      return true;
    },
    list() { return Object.entries(rooms).map(([id, r]) => ({ roomId: id, ...r })); },
  };
}
