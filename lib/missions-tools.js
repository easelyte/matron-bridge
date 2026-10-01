// Loopback handlers behind the mission_* / milestone_post MCP tools (spec
// 2026-09-10, "Agent tools"). HTTP-agnostic, same {status, body} contract
// as lib/items-tools.js; index.js mounts them with respondAgentChatRoute.
const KINDS = new Set(['user_input', 'progress']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;
// Mission status (spec 2026-09-28 missions dashboard §1): 1–600 characters
// after folding CRLF to LF and trimming, counted in UTF-16 units — JS
// String.length. The journal folds CRLF the same way before it counts, so
// folding here first is what keeps the two counts in agreement — without
// it, a status the bridge accepts could still land over the journal's limit.
const STATUS_MAX = 600;

const NO_ROUTES = 'this journal deployment does not have the /missions routes yet — deploy the journal update (matron-journal missions plan)';
const NO_MISSION = 'this conversation has no mission yet — call mission_start(title, body) first';
// mission_status's own no-mission sentence: the Coordinator never has a
// mission and must never mission_start one, so it has to hear about `mission`.
const NO_MISSION_STATUS = "this conversation has no mission yet — call mission_start(title, body) first, or pass mission: N to set another mission's status";
// POST /missions and POST /milestones 404 on the CONVERSATION, not the route:
// the convo has no journal row yet, or it already belongs to a mission this
// caller cannot see (the journal answers 404, never 403, so a hidden mission
// is not an existence oracle). Saying "routes not deployed" there sends the
// model to redeploy a journal that is working fine.
const NO_CONVO = 'the journal did not accept this conversation — it may have no journal row yet, or its mission is not visible to this session';
const UNREADABLE_LINKS = "the journal returned an unreadable list of this conversation's missions";
const notOnMission = (n) => `this conversation is not on mission #${n} — nothing to leave (a journal older than mission history cannot leave either: deploy the journal update)`;
// R3 (2026-09-30 preflight): a named-mission POST /milestones 404 is only
// ever the CONVERSATION (writableConvo) — an unknown, invisible or unlinked
// mission answers 409 not_linked instead, never 404. passthroughConvo's
// NO_CONVO sentence already says that; no separate "mission hidden" text.
const namedMissionIgnored = (n, got) => `this journal does not support posting to a named mission yet — the milestone went to this conversation's current mission #${got} instead of #${n}; deploy the journal update (mission links)`;
const BAD_TITLE = `title must be a non-empty string of at most ${TITLE_MAX} characters`;
const BAD_STATUS = `status must be a non-empty string of at most ${STATUS_MAX} characters`;
// attach:false never answers existing:true (the contract: the "convo
// already has a mission" short-circuit does not apply). A journal that does
// is one that ignored attach and handed back THIS conversation's mission.
const NO_ATTACH_FALSE = 'this journal does not support unassigned missions yet (it ignored attach:false and returned this conversation\'s own mission) — deploy the journal Coordinator update; no mission was created';

// Same journal, the other symptom: no convo mission to hand back, so it
// created one and attached this conversation to it.
const attachedAnyway = (num) => `this journal does not support unassigned missions yet (it ignored attach:false, created mission #${num ?? '?'} and joined THIS conversation to it) — deploy the journal Coordinator update`;

// mission_close with `mission: N` (item #4901, spec 2026-09-29 coordinator
// session control "Coordinator mission close"; corrected by final-review I1,
// 2026-09-30): closing ANOTHER mission by number is the journal's call
// alone — it allows a conversation with an active link to that mission
// (current or also-on), or its Coordinator, and 403s everyone else. The
// bridge never gates this itself and always sends the caller's own
// convo_id, so a session cannot pass the journal's check by lying about
// who it is; it only maps the journal's 403 to a sentence.
const journalNotCoordinatorForClose = (n) => `only a conversation on mission #${n}, or the Coordinator, may close it — mission_join it first, or ask the Coordinator`;

// Filing a mission in a project (spec 2026-09-30 §4.2): unknown project = 404,
// closed/merged project = 409 project_closed. A journal from before projects
// ignores `project` on POST /missions and on a PATCH that also changes a
// title/body, and 400s a PATCH carrying only `project`: detected by the
// mission row lacking the `project_id` key every new journal sends.
const projectOrConvo = (p) => `no project #${p} is visible to this session (project_list shows the projects), or the journal did not accept this conversation`;
const projectRejected = (p) => `this journal does not support projects yet — it rejected project: ${p}; deploy the journal projects update`;
const missionOrProject = (m, p) => `no mission${m ? ` #${m}` : ''} or project #${p} is visible to this session — mission_get and project_list check the numbers`;
const BAD_PROJECT = 'project must be a positive integer (a project number from project_list)';
const BAD_PROJECT_OR_NULL = 'project must be a positive integer, or null to take the mission out of its project';
const lacksProjectField = (r) => (r.status === 200 || r.status === 201) && r.body?.mission && typeof r.body.mission === 'object' && !('project_id' in r.body.mission);

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

export function createMissionsHandlers({ sessions, journalConvoIdFor, client, log = console }) {
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
  const statusText = (v) => {
    if (typeof v !== 'string') return null;
    const folded = v.replace(/\r\n/g, '\n').trim();
    return folded && folded.length <= STATUS_MAX ? folded : null;
  };
  // undefined → not given; a positive integer → the project number.
  const optProject = (v) => (v === undefined ? { ok: true } : (Number.isInteger(v) && v >= 1 ? { ok: true, value: v } : { ok: false }));
  // start/create: map a 404 to the project-or-conversation sentence and
  // mark what happened to the requested project for the ack. R5 (2026-09-30
  // preflight): an idempotent replay of an existing mission never re-applies
  // `project` (the journal's idem key omits it) — the mission comes back
  // with `project_id`/`project_num` set to whatever it already had, which can
  // differ from what was just requested; that is `project_not_applied`, not
  // `project_ignored` (the field IS present, just not what was asked for).
  function withProject(r, p) {
    if (r.status === 404) return { status: 404, body: { error: projectOrConvo(p) } };
    if (r.status !== 200 && r.status !== 201) return r;
    const body = { ...r.body, project_requested: p };
    if (lacksProjectField(r)) body.project_ignored = true;
    else if (!r.body.existing && r.body.mission?.project_num !== p) body.project_not_applied = true;
    return { status: r.status, body };
  }
  const idem = (data) => ({ idemKey: typeof data.idem_key === 'string' ? data.idem_key : null });

  // Cold resolve (spec 2026-09-30 projects §5). A conversation can be on
  // several missions; exactly one active link is CURRENT, or none is, and
  // that is the default target of every "this conversation's mission" op.
  // GET /conversations/:id/missions lists the links, current first — one
  // call. Only a link with current === true is cached: an active-but-not-
  // current or ended link is never a default. A 200 with no current link is
  // "no mission" (the model can mission_join or mission_start).
  // A journal from before mission links answers that route 404: fall back to
  // the old scan (scanForMission). Any other failure is an outage, reported
  // as such — scanning or answering "no mission" then would mint duplicates.
  // Returns {id} (id null = no current mission) or {err}, a ready response.
  async function resolveMission(session, convoId) {
    if (session.missionId) return { id: session.missionId };
    const r = await client.conversationMissions(convoId);
    if (r.status === 404) return scanForMission(session, convoId);
    if (r.status !== 200) return { err: passthrough(r) };
    if (!Array.isArray(r.data?.missions)) return { err: { status: 502, body: { error: UNREADABLE_LINKS } } };
    const current = r.data.missions.find((m) => m && m.current === true && typeof m.id === 'string' && m.id);
    if (!current) return { id: null };
    session.missionId = current.id;
    return { id: current.id };
  }

  // The pre-links fallback: a conversation's mission was a single column,
  // not a resource. Cold, find it in GET /missions by conversation
  // membership. A miss is a 404 the model can act on, never a guess.
  // The scan lists missions in EVERY state, not just open ones: after a
  // bridge restart a conversation whose mission is closed would otherwise
  // resolve to "no mission", the model would obey "call mission_start",
  // POST /missions would answer 200 existing:true with that same closed
  // mission, and the loop would never end. Listing closed missions too lets
  // the journal give the real answer — 409 closed on update/close/post.
  // Worst case (no origin_convo_id match) is O(missions): one GET
  // /missions/:id per mission until membership is found.
  async function scanForMission(session, convoId) {
    const r = await client.list();
    // A journal that cannot be reached, or is failing, is not "no mission":
    // telling the model to mission_start now would create a duplicate the
    // moment the journal is back. Surface the outage instead; only a clean
    // 200 with a readable (possibly empty) list means there is nothing to find.
    if (r.status !== 200) return { err: passthroughCollection(r) };
    if (!Array.isArray(r.data?.missions)) {
      return { err: { status: 502, body: { error: 'the journal returned an unreadable mission list' } } };
    }
    // A journal that sends project_id on its rows has the links route: its
    // 404 there meant "unknown conversation", not "old journal" — nothing to
    // scan for, and a per-mission GET sweep would be O(missions) for nothing.
    if (r.data.missions.some((m) => m && typeof m === 'object' && 'project_id' in m)) return { id: null };
    // Origin is provenance, not membership: mission_create (attach:false)
    // records the caller as origin_convo_id and does NOT join it, so a
    // conversation that just handed a mission to someone else would resolve
    // to that new mission on the origin shortcut and every "this
    // conversation's mission" op (get, close) would land on it. Origin
    // matches are checked first, as the cheapest likely hits, but each is
    // confirmed against the mission's conversations[] before it is taken.
    // A detail lookup that fails is an outage, reported like a failed list:
    // "not a member" here would become "no mission" and a duplicate
    // mission_start the moment the journal is back. A detail 404 is a skip
    // (that mission is gone), and the others may still match.
    const checked = new Set();
    const isMember = async (m) => {
      checked.add(m.id);
      const d = await client.get(m.id);
      if (d.status === 404) return false;
      if (d.status !== 200) return { err: passthrough(d) };
      // A 200 with no readable conversations[] must not pass through as
      // the op's own success (the caller would report a close or update
      // that never happened): it is unreadable, like an unreadable list.
      if (!Array.isArray(d.data?.conversations)) return { err: { status: 502, body: { error: `the journal returned an unreadable mission detail for #${m.num ?? '?'}` } } };
      return d.data.conversations.some((c) => c.id === convoId);
    };
    const take = async (m) => {
      const member = await isMember(m);
      if (member === true) { session.missionId = m.id; return { id: m.id }; }
      return member === false ? null : member;
    };
    for (const m of r.data.missions) {
      if (m.origin_convo_id !== convoId) continue;
      const out = await take(m); if (out) return out;
    }
    for (const m of r.data.missions) {
      if (checked.has(m.id)) continue;
      const out = await take(m); if (out) return out;
    }
    return { id: null };
  }

  const remember = (session, r) => { if ((r.status === 200 || r.status === 201) && r.body?.mission?.id) session.missionId = r.body.mission.id; return r; };

  // Resolve the session's mission, then call fn(id). If the journal answers
  // 404 for that id, the cache is stale (the mission was deleted, or never
  // existed) — clear it so the next call re-resolves cold instead of
  // repeating the same 404 forever. A 409 (closed, or other_mission from a
  // journal before mission links) means the mission still exists, so it
  // must NOT clear the cache.
  // noMission: the 404 sentence when the conversation has none.
  async function viaResolvedMission(session, convoId, fn, noMission = NO_MISSION) {
    const { id, err } = await resolveMission(session, convoId);
    if (err) return err;
    if (!id) return { status: 404, body: { error: noMission } };
    const r = await fn(id);
    if (r.status === 404) delete session.missionId;
    return r;
  }

  return {
    // Not a route (index.js mounts an allowlist of op names): the projects
    // handlers use it to find this conversation's current mission.
    resolveMission,

    async start(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const p = optProject(data.project); if (!p.ok) return bad(BAD_PROJECT);
      const body = { title: t, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      if (p.value !== undefined) body.project = p.value;
      const r = passthroughConvo(await client.start(body, idem(data)));
      return remember(session, p.value === undefined ? r : withProject(r, p.value));
    },

    // mission_create (spec 2026-09-23 §2d): a mission for work handed to
    // someone else. convo_id is provenance only (origin_convo_id); with
    // attach:false this conversation is not joined, so the mission is NOT
    // remembered as the session's own — that is what mission_start is for.
    async create(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const p = optProject(data.project); if (!p.ok) return bad(BAD_PROJECT);
      const body = { title: t, convo_id: convoId, attach: false };
      if (b.value !== undefined) body.body = b.value;
      if (p.value !== undefined) body.project = p.value;
      const sent = await client.create(body, idem(data));
      const r = p.value === undefined ? passthroughConvo(sent) : withProject(passthrough(sent), p.value);
      if (r.status === 200 && r.body?.existing === true) return { status: 502, body: { error: NO_ATTACH_FALSE } };
      // A journal that ignored attach:false and had no mission to hand back
      // created one and joined THIS conversation to it. Asked exactly, on a
      // fresh create (201) and an idempotent replay (200) alike: is this
      // conversation on that mission? (A conversation count cannot tell: a
      // replayed mission may legitimately have been assigned since.) The
      // journal has no convo→mission lookup, so the mission's own detail
      // (GET /missions/:id, conversations[]) answers it. A lookup that fails
      // cannot prove an attach, so the create stands and it is logged.
      const created = r.body?.mission;
      if ((r.status === 201 || r.status === 200) && created?.id) {
        const d = await client.get(created.id);
        if (d.status === 200 && Array.isArray(d.data?.conversations)) {
          if (d.data.conversations.some((c) => c?.id === convoId)) {
            return { status: 502, body: { error: attachedAnyway(created.num) } };
          }
        } else {
          try { log.warn?.(`[missions] mission_create: could not confirm mission #${created.num ?? '?'} is unassigned (detail lookup answered ${d.status}) — reporting it created`); } catch { /* logging must never throw */ }
        }
      }
      return r;
    },

    async post(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'user_input' or 'progress'");
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { convo_id: convoId, kind: data.kind, title: t };
      if (b.value !== undefined) body.body = b.value;
      if (data.mission === undefined) return remember(session, passthroughConvo(await client.postMilestone(body, idem(data))));
      // A named mission (spec 2026-09-30 §3): any mission this conversation
      // has an active link to; the journal answers 409 not_linked otherwise.
      // Never cached — the current mission stays the default target.
      if (!Number.isInteger(data.mission) || data.mission < 1) return bad('mission must be a positive integer');
      body.mission = data.mission;
      const r = passthroughConvo(await client.postMilestone(body, idem(data)));
      // A journal from before mission links ignores `mission` and posts to
      // the current mission: say so, never "posted to #N".
      const got = r.body?.mission?.num;
      if ((r.status === 200 || r.status === 201) && Number.isInteger(got) && got !== data.mission) {
        return { status: 502, body: { error: namedMissionIgnored(data.mission, got) } };
      }
      return r;
    },

    // mission_update: title, body and (spec 2026-09-30 §5) project — a
    // number files the mission, null takes it out. No `mission` → this
    // conversation's current mission, resolved and cached. An explicit
    // `mission` changes any mission the caller can see (any agent may file
    // missions; the Coordinator applies filings the user approved): by
    // number, never cached, its 404 must not clear this conversation's cache.
    async update(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(BAD_TITLE); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (data.project !== undefined) {
        if (data.project !== null && !(Number.isInteger(data.project) && data.project >= 1)) return bad(BAD_PROJECT_OR_NULL);
        patch.project = data.project;
      }
      if (!Object.keys(patch).length) return bad('title, body or project is required');
      if (data.mission !== undefined && !(Number.isInteger(data.mission) && data.mission >= 1)) return bad('mission must be a positive integer');
      const send = async (id) => {
        const r = passthrough(await client.update(id, patch));
        if (patch.project === undefined) return r;
        if (r.status === 400) return { status: 400, body: { error: projectRejected(patch.project ?? 'null') } };
        if (r.status === 404 && patch.project !== null) return { status: 404, body: { error: missionOrProject(data.mission, patch.project) } };
        if (lacksProjectField(r)) return { status: r.status, body: { ...r.body, project_ignored: true } };
        return r;
      };
      if (data.mission !== undefined) return send(data.mission);
      return viaResolvedMission(session, convoId, send);
    },

    // mission_status (spec 2026-09-28 missions dashboard §2): the status
    // paragraph on a mission's card. No `mission` → this conversation's own
    // mission, resolved and cached like update. An explicit `mission` is any
    // mission the caller can see (the Coordinator refreshes missions it is
    // not on): addressed by number, never cached, and its 404 must not clear
    // this conversation's cache. convo_id rides along either way — the
    // journal records it as status_convo_id when the conversation is the
    // caller's own. No idem key: a retried PATCH just overwrites.
    async status(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const s = statusText(data.status); if (!s) return bad(BAD_STATUS);
      const patch = { status: s, convo_id: convoId };
      if (data.mission !== undefined) {
        if (!Number.isInteger(data.mission) || data.mission < 1) return bad('mission must be a positive integer');
        return passthrough(await client.update(data.mission, patch));
      }
      return viaResolvedMission(session, convoId, async (id) => passthrough(await client.update(id, patch)), NO_MISSION_STATUS);
    },

    // mission_list: the user's missions, open by default — how the
    // Coordinator finds every mission to refresh (spec §2, "Coordinator
    // instructions"). GET /missions is the collection route, so its 404
    // honestly means the routes are missing.
    async list(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const state = data.state === undefined ? 'open' : data.state;
      if (state !== 'open' && state !== 'closed') return bad("state must be 'open' or 'closed'");
      return passthroughCollection(await client.list({ state }));
    },

    async join(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!Number.isInteger(data.num) || data.num < 1) return bad('num is required');
      return remember(session, passthrough(await client.join(data.num, { convo_id: convoId })));
    },

    // mission_leave (spec 2026-09-30 §3): end this conversation's link to
    // mission N. The journal moves `current` to the most recently joined
    // remaining active link, or to none, and returns it inline as
    // `current_mission` on the same response (R2, 2026-09-30 preflight) — so
    // the cache is dropped and reset from that field, no second call. A 200
    // from /leave only ever comes from a journal new enough to send it;
    // `current` is undefined only if a future journal ever omitted the
    // field, and the next call then resolves cold.
    async leave(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!Number.isInteger(data.num) || data.num < 1) return bad('num is required');
      const r = passthrough(await client.leave(data.num, { convo_id: convoId }));
      if (r.status === 404) return { status: 404, body: { error: notOnMission(data.num) } };
      if (r.status !== 200) return r;
      delete session.missionId;
      const cm = r.body?.current_mission;
      const current = cm && typeof cm === 'object' && typeof cm.id === 'string' && cm.id ? cm : (cm === null ? null : undefined);
      if (current) session.missionId = current.id;
      return { status: 200, body: { ...r.body, left: data.num, current } };
    },

    async get(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      const id = data.num;
      if (id === undefined) {
        // No num: resolve the conversation's own (current) mission and cache
        // it. An explicit num, below, is an arbitrary lookup — possibly not
        // this conversation's mission — so it must not clobber that cache.
        const r = await viaResolvedMission(session, convoId, async (resolved) => remember(session, passthrough(await client.get(resolved, { history: true }))));
        if (r.status !== 200) return r;
        // Every mission this conversation is on (spec 2026-09-30 §3), so an
        // agent on several knows which to name on milestone_post. Best
        // effort: an old journal (404) or a failure just leaves it out.
        const links = await client.conversationMissions(convoId);
        if (links.status === 200 && Array.isArray(links.data?.missions)) return { status: 200, body: { ...r.body, conversation_missions: links.data.missions } };
        return r;
      }
      if (!Number.isInteger(id) || id < 1) return bad('num must be a positive integer');
      // GET /missions/:id is id-addressed: its 404 means "no such mission",
      // not "this deployment lacks the /missions routes" — passthrough, not
      // passthroughCollection (that's reserved for the collection routes:
      // start / list / postMilestone).
      return passthrough(await client.get(id, { history: true }));
    },

    // The closing conversation rides along as convo_id either way: the
    // journal holds it to "on the mission, or the Coordinator" (a journal
    // from before the field ignores it). No `mission` → this conversation's
    // own mission, resolved and cached like update. An explicit `mission`
    // closes ANOTHER mission by number — the Coordinator does this for a
    // mission whose session has gone, but any conversation with an active
    // link to that mission may too: never cached, and its 404 must not
    // clear this conversation's own cache. Both item tiers block equally.
    async close(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (typeof data.summary !== 'string' || !data.summary.trim() || byteLen(data.summary) > BODY_MAX) return bad(`summary is required (at most ${BODY_MAX} bytes)`);
      const body = { summary: data.summary, convo_id: convoId };
      if (data.mission !== undefined) {
        if (!Number.isInteger(data.mission) || data.mission < 1) return bad('mission must be a positive integer');
        const r = passthrough(await client.close(data.mission, body));
        if (r.status === 403 && r.body?.detail === 'not_coordinator') return { status: 403, body: { error: journalNotCoordinatorForClose(data.mission) } };
        return r;
      }
      return viaResolvedMission(session, convoId, async (id) => passthrough(await client.close(id, body)));
    },
  };
}
