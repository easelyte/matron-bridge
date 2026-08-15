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
    record(roomId, { role, state, sessionRoomId, peerDeviceId, peerName, topic, title, guestSessionRoomId, guestState } = {}) {
      // Merge semantics: only supplied keys overwrite; null defaults apply
      // only when the room is new (a partial re-record must not null out
      // previously learned peer fields).
      const patch = {};
      for (const [k, v] of Object.entries({ role, state, sessionRoomId, peerDeviceId, peerName, topic, title, guestSessionRoomId, guestState })) {
        if (v !== undefined) patch[k] = v;
      }
      const existing = rooms[roomId];
      rooms[roomId] = {
        ...(existing || { peerDeviceId: null, peerName: null, topic: null, title: null, guestSessionRoomId: null, guestState: null }),
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
      rooms[roomId] = { ...r, state, updatedAt: Date.now() };
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
      rooms[roomId] = { ...r, guestState: state, updatedAt: Date.now() };
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
