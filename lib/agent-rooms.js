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
function bindingIsLive(state, since, updatedAt) {
  if (state === 'joined') return true;
  return state === 'pending' && Date.now() - (since ?? updatedAt ?? 0) < INVITE_TTL_MS;
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
    if (r.state !== 'joined' && Date.now() - (r.updatedAt || 0) > INVITE_TTL_MS) delete rooms[id];
  }

  function persist() {
    try { save?.({ ...rooms }); } catch (e) { try { log.warn(`[agent-rooms] persist failed: ${e.message}`); } catch { } }
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
    record(roomId, { role, state, sessionRoomId, peerDeviceId, peerName, topic, title, targetConvoId, guestSessionRoomId, guestState } = {}) {
      // Merge semantics: only supplied keys overwrite; null defaults apply
      // only when the room is new (a partial re-record must not null out
      // previously learned peer fields — nor, since mute rides on the same
      // record, silently unmute a member).
      const patch = {};
      for (const [k, v] of Object.entries({ role, state, sessionRoomId, peerDeviceId, peerName, topic, title, targetConvoId, guestSessionRoomId, guestState })) {
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
    // lives for the life of the two sessions, so the only way out of a peer
    // that loops or spams is for ONE member to stop taking delivery. It is
    // purely bridge-local (no journal protocol field) and per BINDING — the
    // muting agent's own side — so a local room's two ends mute
    // independently. It rides on the room record, which is what makes its
    // durability exactly the registry's: persisted if the registry is,
    // in-memory if it isn't. No second store.
    //
    // Returns the updated record, or null when this session holds no binding
    // on this room (same "not a participant" answer every other lookup gives).
    setMuted(roomId, sessionRoomId, muted, { reason = null } = {}) {
      const r = rooms[roomId];
      if (!r) return null;
      const isPrimary = r.sessionRoomId === sessionRoomId;
      const isGuest = r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId;
      if (!isPrimary && !isGuest) return null;
      // The reason is only meaningful while the mute is on: clearing it with
      // the flag stops a stale "why" surviving into the next mute.
      const patch = isPrimary
        ? { muted: !!muted, mutedReason: muted ? reason : null }
        : { guestMuted: !!muted, guestMutedReason: muted ? reason : null };
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
    findLivePair(sessionRoomId, { peerDeviceId = null, targetConvoId = null, peerSessionRoomId = null } = {}) {
      if (!sessionRoomId) return null;
      for (const [id, r] of Object.entries(rooms)) {
        const isPrimary = r.sessionRoomId === sessionRoomId;
        const isGuest = r.guestSessionRoomId != null && r.guestSessionRoomId === sessionRoomId;
        if (!isPrimary && !isGuest) continue;
        if (!bindingIsLive(isPrimary ? r.state : r.guestState,
          isPrimary ? r.pendingSince : r.guestPendingSince, r.updatedAt)) continue;
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
      return r.state === 'pending' && Date.now() - r.updatedAt < INVITE_TTL_MS;
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
