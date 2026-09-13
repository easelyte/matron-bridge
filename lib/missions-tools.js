// Loopback handlers behind the mission_* / milestone_post MCP tools (spec
// 2026-09-10, "Agent tools"). HTTP-agnostic, same {status, body} contract
// as lib/items-tools.js; index.js mounts them with respondAgentChatRoute.
const KINDS = new Set(['user_input', 'progress']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;

const NO_ROUTES = 'this journal deployment does not have the /missions routes yet — deploy the journal update (matron-journal missions plan)';
const NO_MISSION = 'this conversation has no mission yet — call mission_start(title, body) first';
// POST /missions and POST /milestones 404 on the CONVERSATION, not the route:
// the convo has no journal row yet, or it already belongs to a mission this
// caller cannot see (the journal answers 404, never 403, so a hidden mission
// is not an existence oracle). Saying "routes not deployed" there sends the
// model to redeploy a journal that is working fine.
const NO_CONVO = 'the journal did not accept this conversation — it may have no journal row yet, or its mission is not visible to this session';
const BAD_TITLE = `title must be a non-empty string of at most ${TITLE_MAX} characters`;

const bad = (error) => ({ status: 400, body: { error } });
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}
// Only GET /missions (the collection) can honestly 404 because the routes
// are missing — every other 404 on these paths is about a mission or a
// conversation, so each has its own sentence.
function passthroughCollection(r) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: NO_ROUTES } };
  return out;
}
function passthroughConvo(r) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: NO_CONVO } };
  return out;
}

export function createMissionsHandlers({ sessions, journalConvoIdFor, client }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  const title = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= TITLE_MAX ? v.trim() : null);
  const optBody = (v) => (v === undefined ? { ok: true } : (typeof v === 'string' && byteLen(v) <= BODY_MAX ? { ok: true, value: v } : { ok: false }));
  const idem = (data) => ({ idemKey: typeof data.idem_key === 'string' ? data.idem_key : null });

  // The journal has no "mission for this conversation" route by design (a
  // conversation's mission is a column, not a resource). The bridge
  // remembers the mission it last saw for the session and, cold, finds it
  // in GET /missions by conversation membership. A miss is a 404 the model
  // can act on, never a guess.
  // The scan lists missions in EVERY state, not just open ones: after a
  // bridge restart a conversation whose mission is closed would otherwise
  // resolve to "no mission", the model would obey "call mission_start",
  // POST /missions would answer 200 existing:true with that same closed
  // mission, and the loop would never end. Listing closed missions too lets
  // the journal give the real answer — 409 closed on update/close/post.
  // Worst case (no origin_convo_id match) is O(missions): one GET
  // /missions/:id per mission until membership is found.
  // Returns {id} (id null = no mission for this conversation) or {err}, a
  // ready-made response when the collection route itself is unavailable.
  async function resolveMission(session, convoId) {
    if (session.missionId) return { id: session.missionId };
    const r = await client.list();
    // A journal that cannot be reached, or is failing, is not "no mission":
    // telling the model to mission_start now would create a duplicate the
    // moment the journal is back. Surface the outage instead; only a clean
    // 200 with a readable (possibly empty) list means there is nothing to find.
    if (r.status !== 200) return { err: passthroughCollection(r) };
    if (!Array.isArray(r.data?.missions)) {
      return { err: { status: 502, body: { error: 'the journal returned an unreadable mission list' } } };
    }
    for (const m of r.data.missions) {
      if (m.origin_convo_id === convoId) { session.missionId = m.id; return { id: m.id }; }
    }
    for (const m of r.data.missions) {
      const d = await client.get(m.id);
      if (d.status === 200 && Array.isArray(d.data?.conversations) && d.data.conversations.some((c) => c.id === convoId)) {
        session.missionId = m.id; return { id: m.id };
      }
    }
    return { id: null };
  }

  const remember = (session, r) => { if ((r.status === 200 || r.status === 201) && r.body?.mission?.id) session.missionId = r.body.mission.id; return r; };

  // Resolve the session's mission, then call fn(id). If the journal answers
  // 404 for that id, the cache is stale (the mission was deleted, or never
  // existed) — clear it so the next call re-resolves cold instead of
  // repeating the same 404 forever. A 409 (closed / other_mission) means
  // the mission still exists, so it must NOT clear the cache.
  async function viaResolvedMission(session, convoId, fn) {
    const { id, err } = await resolveMission(session, convoId);
    if (err) return err;
    if (!id) return { status: 404, body: { error: NO_MISSION } };
    const r = await fn(id);
    if (r.status === 404) delete session.missionId;
    return r;
  }

  return {
    async start(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { title: t, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      return remember(session, passthroughConvo(await client.start(body, idem(data))));
    },

    async post(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'user_input' or 'progress'");
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { convo_id: convoId, kind: data.kind, title: t };
      if (b.value !== undefined) body.body = b.value;
      return remember(session, passthroughConvo(await client.postMilestone(body, idem(data))));
    },

    async update(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(BAD_TITLE); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (!Object.keys(patch).length) return bad('title or body is required');
      return viaResolvedMission(session, convoId, async (id) => passthrough(await client.update(id, patch)));
    },

    async join(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!Number.isInteger(data.num) || data.num < 1) return bad('num is required');
      return remember(session, passthrough(await client.join(data.num, { convo_id: convoId })));
    },

    async get(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const id = data.num;
      if (id === undefined) {
        // No num: resolve the conversation's own mission and cache it. An
        // explicit num, below, is an arbitrary lookup — possibly not this
        // conversation's mission — so it must not clobber that cache.
        return viaResolvedMission(session, convoId, async (resolved) => remember(session, passthrough(await client.get(resolved))));
      }
      if (!Number.isInteger(id) || id < 1) return bad('num must be a positive integer');
      // GET /missions/:id is id-addressed: its 404 means "no such mission",
      // not "this deployment lacks the /missions routes" — passthrough, not
      // passthroughCollection (that's reserved for the collection routes:
      // start / list / postMilestone).
      return passthrough(await client.get(id));
    },

    async close(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (typeof data.summary !== 'string' || !data.summary.trim() || byteLen(data.summary) > BODY_MAX) return bad(`summary is required (at most ${BODY_MAX} bytes)`);
      return viaResolvedMission(session, convoId, async (id) => passthrough(await client.close(id, { summary: data.summary })));
    },
  };
}
