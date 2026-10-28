// The stateful half of foreign turns (lib/foreign-turn.js is the pure
// policy): which session is in a turn another person started, the one-shot
// approvals its user granted, the "Allow once" asks waiting on a tap, and the
// person-room context the journal gives each room. Everything I/O-shaped is
// injected so this is testable without a journal or a claude process.
//
// deps:
//   sharing.personRoom(roomId) -> {status, data:{person_room}}
//   sharing.mission(id) -> {status, data:{mission}}   (optional: the grant level)
//   sharing.lookup(user, num) -> {status, data:{kind, id}} (optional: their numbers)
//   items.get(id) / items.create(body) / items.close(id, body) -> {status, data}
//   journalConvoIdFor(session) -> convo id the session publishes into
//   sendText(session, text) -> bool       (inject a turn, skipJournalMirror)
//   publishNotice(convoId, text)
//   isOccupied(session) -> bool           (busy / prompt open)
//   flag: { set(roomKey), clear(roomKey) } (set throws when it cannot write)
//   store: { load() -> object, save(object) }  (pending asks, survives restarts)
//   now() -> ms
import {
  decideForeignCall, foreignRouteAllowed, foreignTurnBanner, allowanceTurnText, actionRequestItem, actionHash, personLabel,
  canonicalJson, ACTION_INPUT_MAX, ACTION_PENDING_MAX,
} from './foreign-turn.js';
import { formatItemTurn } from './items-turn.js';

// The level of a grant as the journal reports it on a mission row: on the
// person-room row's mission (`level`), or on a shared mission (`grant`).
const levelOf = (m) => (typeof m?.level === 'string' ? m.level : (typeof m?.grant?.level === 'string' ? m.grant.level : null));

// An "Allow once" item nobody tapped is forgotten after a week.
export const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A room's person-room context is re-read at most this often.
const CONTEXT_TTL_MS = 30_000;

export const ALLOW_LABEL = 'Allow once';
export const DECLINE_LABEL = 'Decline';

export function createForeignSessions({ sharing, items, journalConvoIdFor, sendText, publishNotice, isOccupied, flag, store, now = Date.now, log = console } = {}) {
  // journal room id -> {at, row|null}
  const contexts = new Map();
  // Comment ids already turned into a foreign item turn (replays on
  // reconnect must not start a second one). Bounded.
  const seenComments = new Set();
  // session roomKey -> {allow: Map(hash -> itemId), parked: [{turn, text, hash?, itemId}], routeOnce: number, filing: number}
  const perSession = new Map();
  let pending = loadPending();

  const state = (key) => {
    if (!perSession.has(key)) perSession.set(key, { allow: new Map(), parked: [], routeOnce: 0, filing: 0 });
    return perSession.get(key);
  };

  function loadPending() {
    let raw;
    try { raw = store?.load?.() || {}; } catch { raw = {}; }
    const out = new Map();
    const cutoff = now() - ACTION_TTL_MS;
    for (const [id, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && v.createdAt > cutoff) out.set(id, v);
    }
    return out;
  }
  function savePending() {
    try { store?.save?.(Object.fromEntries(pending)); } catch (e) { try { log.warn(`[foreign] saving pending asks failed: ${e.message}`); } catch { } }
  }

  // The person-room row for a journal room, as the journal sees it now.
  // Cached briefly; a failed read leaves the turn at its narrowest (room
  // only), never wider.
  async function refreshContext(roomId) {
    try {
      const r = await sharing.personRoom(roomId);
      let row = r?.status === 200 ? (r.data?.person_room ?? null) : null;
      // The guest side's level on the attached mission (phase 3): from the
      // row when the journal says it, else from the mission's own grant.
      if (row?.role === 'guest' && row.mission?.id && !levelOf(row.mission)) {
        const level = await grantLevel(row.mission.id);
        if (level) row = { ...row, mission: { ...row.mission, level } };
      }
      contexts.set(roomId, { at: now(), row });
      return row;
    } catch {
      contexts.set(roomId, { at: now(), row: null });
      return null;
    }
  }
  async function contextFor(roomId) {
    const c = contexts.get(roomId);
    if (c && now() - c.at < CONTEXT_TTL_MS) return c.row;
    return refreshContext(roomId);
  }

  // A mission row as the journal serves it to this user: own, or another
  // person's with `owner` and `grant` set.
  async function readMission(id) {
    if (typeof sharing?.mission !== 'function') return null;
    try {
      const r = await sharing.mission(id);
      return r?.status === 200 ? (r.data?.mission ?? null) : null;
    } catch { return null; }
  }
  async function grantLevel(missionId) {
    const m = await readMission(missionId);
    return m?.owner ? levelOf(m) : null;
  }

  // The turn object the gate decides on. `person` comes from the frame (the
  // journal's own stamp); role and mission from the person-room row.
  function turnFor(roomId, person, row) {
    const mission = row?.mission && Number.isInteger(row.mission.num) ? { id: row.mission.id, num: row.mission.num, owner: row.mission.owner, title: row.mission.title } : null;
    const role = row?.role === 'owner' ? 'owner' : 'guest';
    return { roomId, person, role, mission, ...(mission && role === 'guest' && levelOf(row.mission) === 'contribute' ? { contribute: true } : {}) };
  }

  // The turn for another person's comment on a tracker item (phase 3): no
  // room, scoped to the item's mission. Own mission -> owner side; another
  // person's (the journal sets `owner` on it) -> guest side, contributing
  // when the grant says so. Anything unreadable -> no mission, the
  // narrowest turn.
  async function itemTurnFor(payload, person) {
    const base = { roomId: null, person, role: 'guest', mission: null, item: { id: payload.item_id, num: Number.isInteger(payload.num) ? payload.num : null } };
    // The journal names the item's mission on the marker (`mission_id`);
    // a marker without it falls back to reading the item.
    let missionId = typeof payload.mission_id === 'string' && payload.mission_id ? payload.mission_id : null;
    if (!missionId) {
      let item;
      try {
        const r = await items.get(payload.item_id);
        item = r?.status === 200 ? (r.data?.item ?? null) : null;
      } catch { item = null; }
      missionId = typeof item?.mission_id === 'string' && item.mission_id ? item.mission_id : null;
    }
    if (!missionId) return base;
    const m = await readMission(missionId);
    if (!m || m.id !== missionId || !Number.isInteger(m.num)) return base;
    const theirs = !!m.owner && typeof m.owner === 'object' && typeof m.owner.name === 'string';
    // On the contributor's side the marker says whose mission it is
    // (`shared_by`); it must agree with the mission as read.
    const sharedBy = payload.shared_by && typeof payload.shared_by === 'object' ? payload.shared_by.name : null;
    if (sharedBy && (!theirs || sharedBy !== m.owner.name)) return base;
    const mission = { id: m.id, num: m.num, owner: theirs ? m.owner.name : null, title: m.title };
    if (!theirs) return { ...base, role: 'owner', mission };
    return { ...base, role: 'guest', mission, ...(levelOf(m) === 'contribute' ? { contribute: true } : {}) };
  }

  function begin(session, turn) {
    try { flag.set(session.roomId); } catch (e) {
      try { log.warn(`[foreign] could not arm the gate for ${session.roomId}: ${e.message} — not delivering`); } catch { }
      return false;
    }
    session.foreignTurn = turn;
    return true;
  }

  function end(session) {
    if (!session) return;
    if (session.foreignTurn) {
      session.foreignTurn = null;
      const st = perSession.get(session.roomId);
      if (st) { st.allow.clear(); st.routeOnce = 0; }
    }
    // Cleared even without a turn on record: a flag left by a previous
    // process must never outlive the turn it was for.
    try { flag.clear(session.roomId); } catch { }
  }

  // Inject one foreign turn: arm the gate, then send. A send the session
  // refuses disarms again.
  function inject(session, text, turn) {
    if (!begin(session, turn)) return false;
    let ok;
    try { ok = sendText(session, `${foreignTurnBanner(turn)}\n${text}`); } catch { ok = false; }
    if (!ok) end(session);
    return ok;
  }

  return {
    refreshContext,
    contextFor,
    // The last context read for a room, synchronously (null when never read
    // or the read failed: the narrowest turn).
    cachedContext: (roomId) => contexts.get(roomId)?.row ?? null,
    turnFor,
    begin,
    end,
    inject,

    // POST /foreign-check: the hook's question for one tool call.
    async check(session, hookInput) {
      const turn = session?.foreignTurn;
      if (!turn) return { decision: 'allow' };
      const st = state(session.roomId);
      const d = await decideForeignCall({
        turn,
        toolName: hookInput?.tool_name,
        toolInput: hookInput?.tool_input,
        allowances: st.allow,
        // shared_by + their number ('#12') resolves through the journal's
        // lookup, exactly as the shared item tools do.
        lookupItem: async (id, sharedBy) => {
          let itemId = id;
          if (sharedBy && !/^it_/.test(id)) {
            const n = Number(String(id).replace(/^#/, ''));
            if (!Number.isInteger(n) || n < 1 || typeof sharing?.lookup !== 'function') return null;
            const hit = await sharing.lookup(sharedBy, n);
            if (hit?.status !== 200 || hit.data?.kind !== 'item' || typeof hit.data.id !== 'string') return null;
            itemId = hit.data.id;
          }
          const r = await items.get(itemId);
          return r?.status === 200 ? (r.data?.item ?? null) : null;
        },
      });
      if (d.decision === 'allow' && d.consume) {
        st.allow.delete(d.consume);
        // An approved ask-user call reaches one of the bridge's own routes:
        // let the next one through the route layer, once. Any other tool
        // (Bash, a file read) never reaches a route, so it opens nothing.
        if (typeof hookInput?.tool_name === 'string' && hookInput.tool_name.startsWith('mcp__ask-user__')) st.routeOnce += 1;
      }
      return d;
    },

    // The route layer's question (index.js, before dispatching an ask-user
    // route).
    routeAllowed(session, pathname, data) {
      const turn = session?.foreignTurn;
      if (!turn) return true;
      if (foreignRouteAllowed(turn, pathname, data)) return true;
      const st = state(session.roomId);
      if (st.routeOnce > 0) { st.routeOnce -= 1; return true; }
      return false;
    },

    // foreign_action_request: file the "Allow once" item for the user.
    async requestAction(session, { tool_name: toolName, tool_input: toolInput, why }) {
      const turn = session?.foreignTurn;
      if (!turn) return { status: 409, body: { error: 'Only needed in a turn another person started. In your own user\'s turns, just make the call.' } };
      if (typeof toolName !== 'string' || !toolName || toolName.length > 200) return { status: 400, body: { error: 'tool_name is required' } };
      if (toolInput != null && typeof toolInput !== 'object') return { status: 400, body: { error: 'tool_input must be an object' } };
      // The card shows the whole input, so an input the card cannot carry
      // is refused rather than cut: the user must never approve a call they
      // could not read in full.
      if (Buffer.byteLength(canonicalJson(toolInput ?? {}), 'utf8') > ACTION_INPUT_MAX) {
        return { status: 400, body: { error: `tool_input is too large to show your user in full (over ${ACTION_INPUT_MAX} bytes as JSON) — split it into smaller calls and ask for each` } };
      }
      // The slot is taken before the journal round trip: asks filed in
      // parallel must count against each other, or the cap bounds nothing.
      const st = state(session.roomId);
      let open = st.filing;
      for (const v of pending.values()) if (v.roomKey === session.roomId) open += 1;
      if (open >= ACTION_PENDING_MAX) {
        return { status: 429, body: { error: `${ACTION_PENDING_MAX} requests are already waiting on your user — wait for an answer before asking again` } };
      }
      const spec = actionRequestItem({ turn, toolName, toolInput: toolInput ?? {}, why });
      const convoId = journalConvoIdFor(session);
      st.filing += 1;
      let r;
      try { r = await items.create({ ...spec, convo_id: convoId, awaiting: 'user', position: 'top' }); } finally { st.filing -= 1; }
      const item = r?.data?.item;
      if (!(r?.status >= 200 && r.status < 300) || !item?.id) {
        return { status: 502, body: { error: `could not file the request: ${r?.data?.error ?? 'journal unreachable'}` } };
      }
      pending.set(item.id, {
        roomKey: session.roomId, toolName, toolInput: toolInput ?? {}, hash: actionHash(toolName, toolInput ?? {}),
        why: typeof why === 'string' ? why.slice(0, 1000) : '', turn, num: item.num ?? null, createdAt: now(),
      });
      savePending();
      return { status: 200, body: { ok: true, item: item.num != null ? `#${item.num}` : item.id, note: 'Filed for your user. Tell the other side you have asked; if your user allows it, you get a turn to make exactly that call.' } };
    },

    // A user marker on an item. Returns true when it was an answer to an
    // "Allow once" ask and has been handled here (no 📌 turn for it).
    onItemReply(session, payload) {
      const id = payload?.item_id;
      if (typeof id !== 'string' || !pending.has(id)) return false;
      if (payload.action !== 'commented') return false;
      const label = typeof payload.comment?.action === 'string' ? payload.comment.action.trim()
        : (typeof payload.comment?.meta?.action === 'string' ? payload.comment.meta.action.trim() : null);
      // Typed prose on the item is the user talking to their own agent: an
      // ordinary 📌 turn, and the ask stays open for a tap.
      if (label !== ALLOW_LABEL && label !== DECLINE_LABEL) return false;
      const ask = pending.get(id);
      pending.delete(id);
      savePending();
      // Codex has no PreToolUse gate, so a Codex session never takes a turn
      // another person started, a continuation included (the conversation
      // may have been switched to Codex while the ask was open).
      if (session?.codex) {
        Promise.resolve(items.close(id, { resolution: 'answered', comment: 'Not run: this conversation now runs on Codex, which cannot take a turn another person started.' })).catch(() => {});
        try { publishNotice(journalConvoIdFor(session), '⚠️ Not run: this conversation now runs on Codex, which cannot take a turn another person started. Switch it back to Claude and ask again.'); } catch { }
        return true;
      }
      const allowIt = label === ALLOW_LABEL;
      Promise.resolve(items.close(id, { resolution: 'answered', comment: allowIt ? 'Allowed once.' : 'Declined.' })).catch(() => {});
      const st = state(session.roomId);
      const text = allowanceTurnText(ask.turn, { toolName: ask.toolName, decision: allowIt ? 'allow' : 'decline', why: ask.why });
      // Answers queue: a second tap while the session is busy must not
      // overwrite the first (its item is already closed).
      st.parked.push({ turn: ask.turn, text, hash: allowIt ? ask.hash : null, itemId: id });
      this.drainParked(session);
      return true;
    },

    // Start the oldest parked continuation when the session is free, one
    // per turn. Returns true when a turn started.
    drainParked(session) {
      const st = perSession.get(session?.roomId);
      if (!st?.parked.length || isOccupied(session)) return false;
      if (session.codex) {
        // Same rule as onItemReply: nothing another person started runs in
        // a Codex session. Drop what is parked and say so.
        st.parked.length = 0;
        try { publishNotice(journalConvoIdFor(session), '⚠️ Not run: this conversation now runs on Codex, which cannot take a turn another person started.'); } catch { }
        return false;
      }
      const p = st.parked.shift();
      if (!begin(session, p.turn)) return false;
      if (p.hash) st.allow.set(p.hash, p.itemId);
      let ok;
      try { ok = sendText(session, p.text); } catch { ok = false; }
      if (!ok) {
        end(session);
        try { publishNotice(journalConvoIdFor(session), '⚠️ Could not hand your answer to the agent — the session is not available. Nothing ran.'); } catch { }
      }
      return ok;
    },

    // Another person's comment (or close / reopen) on a tracker item:
    // a foreign turn scoped to the item's mission. Parked behind a running
    // turn, started at the next turn-end seam (drainParked). Returns true
    // when the turn was started or parked.
    async deliverItemTurn(session, payload, person) {
      const commentId = typeof payload?.comment?.id === 'string' ? payload.comment.id : null;
      if (commentId && seenComments.has(commentId)) return false;
      const turn = await itemTurnFor(payload, person);
      // Files never cross people: the comment's attachments are named only.
      const comment = payload?.comment && typeof payload.comment === 'object'
        ? { ...payload.comment, attachments: (Array.isArray(payload.comment.attachments) ? payload.comment.attachments : []).map((a) => ({ name: a?.name, mime: a?.mime })) }
        : payload?.comment;
      const via = payload?.person && typeof payload.person === 'object' ? payload.person.via : null;
      const text = formatItemTurn({ ...payload, comment }, { username: personLabel(person, via) });
      if (!text) return false;
      // Recorded as delivered only once parked or injected (as the item
      // router does): a turn that could not start stays deliverable.
      const delivered = () => {
        if (!commentId) return;
        seenComments.add(commentId);
        if (seenComments.size > 500) seenComments.delete(seenComments.values().next().value);
      };
      if (isOccupied(session)) {
        state(session.roomId).parked.push({ turn, text: `${foreignTurnBanner(turn)}\n${text}`, hash: null, itemId: null });
        delivered();
        return true;
      }
      if (inject(session, text, turn)) { delivered(); return true; }
      try { publishNotice(journalConvoIdFor(session), `⚠️ Not delivered: a comment from ${personLabel(person, via)} on item #${payload.num ?? '?'} could not be handed to the agent — the session is not available. It is safe on the item.`); } catch { /* a notice must never throw */ }
      return false;
    },

    hasParked: (session) => !!perSession.get(session?.roomId)?.parked.length,
    pendingCount: () => pending.size,
  };
}
