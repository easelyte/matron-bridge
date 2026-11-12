// Loopback handlers behind the project_* MCP tools (spec 2026-09-30
// projects §5). HTTP-agnostic, the same {status, body} contract as
// lib/missions-tools.js; index.js mounts them at /projects/<op>.
//
// Any agent may list, read, create, rename and set a project's status.
// project_close and project_merge are the Coordinator's: the
// bridge refuses anyone else first with a clear sentence, and the journal
// gates them too (403 not_coordinator on the calling convo_id).
import { openMissions } from './projects-format.js';

const TITLE_MAX = 200;
const BODY_MAX = 32768;
// Same rule as mission status: 1–600 UTF-16 units after folding CRLF and
// trimming, counted as the journal counts.
const STATUS_MAX = 600;
// project_list pages: enough rows for a reply that stays readable. A brief
// row is one short line, so more of them fit.
const LIST_LIMIT = 60;
const LIST_LIMIT_BRIEF = 150;
const LIST_LIMIT_MAX = 200;

const NO_ROUTES = 'this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)';
// POST /projects 404s on the conversation gate (no journal row yet, or not
// writable by this session) as much as on a route the journal doesn't have —
// the same ambiguity missions-tools.js's passthroughConvo covers for
// mission_start/mission_create. Say both, never render it as a project number.
const CREATE_404 = 'the journal refused the project — this deployment may not have the /projects routes yet (deploy the journal projects update), or this conversation has no journal row yet or is not writable by this session';
const NO_MISSION = 'this conversation has no current mission, so no project — pass num (project_list shows the projects)';
const MISSION_UNREADABLE = "this conversation's current mission could not be read — mission_get checks it, or pass num";
const notFiled = (num) => `this conversation's mission #${num ?? '?'} is not in a project — project_list shows the projects; file it with mission_update project: N`;
const BAD_TITLE = `title must be a non-empty string of at most ${TITLE_MAX} characters`;
const BAD_STATUS = `status must be a non-empty string of at most ${STATUS_MAX} characters`;
const notCoordinator = (tool) => `only the Coordinator may call ${tool} — this conversation is not the Coordinator`;
const JOURNAL_NOT_COORDINATOR = 'the journal does not list this conversation as the Coordinator';

const LIVE_CLOSED = 'live lists open projects with open missions — leave out state, or leave out live';

const bad = (error) => ({ status: 400, body: { error } });
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
const isNum = (v) => Number.isInteger(v) && v >= 1;

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}

export function createProjectsHandlers({ sessions, journalConvoIdFor, client, missionsClient, resolveMission, isCoordinator = (session) => session?.coordinator === true }) {
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
  const idem = (data) => ({ idemKey: typeof data.idem_key === 'string' ? data.idem_key : null });
  const gate = (session, convoId, tool) => (isCoordinator(session, convoId) ? null : { status: 403, body: { error: notCoordinator(tool) } });
  const journalRole = (r) => (r.status === 403 && (r.body?.detail === 'not_coordinator' || r.body?.error === 'not_coordinator')
    ? { status: 403, body: { error: JOURNAL_NOT_COORDINATOR } } : r);

  return {
    // GET /projects is the collection route: its 404 honestly means the
    // routes are missing.
    async list(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const state = data.state === undefined ? 'open' : data.state;
      if (state !== 'open' && state !== 'closed') return bad("state must be 'open' or 'closed'");
      for (const flag of ['live', 'brief']) {
        if (data[flag] !== undefined && typeof data[flag] !== 'boolean') return bad(`${flag} must be true or false`);
      }
      if (state === 'closed' && data.live === true) return bad(LIVE_CLOSED);
      const offset = data.offset === undefined ? 0 : data.offset;
      if (!Number.isInteger(offset) || offset < 0) return bad('offset must be a whole number, 0 or more');
      const brief = data.brief === true;
      const defaultLimit = brief ? LIST_LIMIT_BRIEF : LIST_LIMIT;
      const limit = data.limit === undefined ? defaultLimit : data.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return bad(`limit must be a whole number from 1 to ${LIST_LIMIT_MAX}`);
      const r = passthrough(await client.list({ state }));
      if (r.status === 404) return { status: 404, body: { error: NO_ROUTES } };
      if (r.status !== 200 || !Array.isArray(r.body?.projects)) return r;
      // The journal sends every project; the filter and the page are cut
      // here. A row without mission counts is not known to be idle: kept.
      const rows = data.live === true
        ? r.body.projects.filter((p) => !p?.missions || typeof p.missions !== 'object' || openMissions(p.missions) > 0)
        : r.body.projects;
      // The filters go back with the page, so its closing line can name the
      // next call in full.
      return { status: 200, body: { ...r.body, projects: rows.slice(offset, offset + limit), total: rows.length, offset, brief, live: data.live === true, state, limit: limit === defaultLimit ? undefined : limit } };
    },

    // An explicit num is any project the caller can see (a merged project's
    // number redirects to its target on the journal side). No num: the
    // project of this conversation's CURRENT mission — read through the
    // missions resolver (whose cache it shares, and never writes itself).
    async get(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (data.num !== undefined) {
        if (!isNum(data.num)) return bad('num must be a positive integer');
        return passthrough(await client.get(data.num));
      }
      const resolved = await resolveMission(session, convoId);
      if (resolved.err) return resolved.err;
      if (!resolved.id) return { status: 404, body: { error: NO_MISSION } };
      const m = passthrough(await missionsClient.get(resolved.id));
      if (m.status === 404) return { status: 404, body: { error: MISSION_UNREADABLE } };
      if (m.status !== 200) return m;
      const mission = m.body?.mission;
      // A journal from before projects sends no project_id key at all.
      if (!mission || typeof mission !== 'object' || !('project_id' in mission)) return { status: 404, body: { error: NO_ROUTES } };
      if (typeof mission.project_id !== 'string' || !mission.project_id) return { status: 404, body: { error: notFiled(mission.num) } };
      return passthrough(await client.get(mission.project_id));
    },

    async create(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const t = title(data.title); if (!t) return bad(BAD_TITLE);
      const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`);
      const body = { title: t };
      if (b.value !== undefined) body.body = b.value;
      body.convo_id = convoId;
      const r = passthrough(await client.create(body, idem(data)));
      return r.status === 404 ? { status: 404, body: { error: CREATE_404 } } : r;
    },

    async update(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      const patch = {};
      if (data.title !== undefined) { const t = title(data.title); if (!t) return bad(BAD_TITLE); patch.title = t; }
      if (data.body !== undefined) { const b = optBody(data.body); if (!b.ok) return bad(`body must be a string of at most ${BODY_MAX} bytes`); patch.body = b.value; }
      if (!Object.keys(patch).length) return bad('title or body is required');
      patch.convo_id = convoId;
      return passthrough(await client.update(data.num, patch));
    },

    // No idem key: a retried PATCH just overwrites.
    async status(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      const s = statusText(data.status); if (!s) return bad(BAD_STATUS);
      return passthrough(await client.update(data.num, { status: s, convo_id: convoId }));
    },

    async close(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      if (typeof data.summary !== 'string' || !data.summary.trim() || byteLen(data.summary) > BODY_MAX) return bad(`summary is required (at most ${BODY_MAX} bytes)`);
      const refused = gate(session, convoId, 'project_close'); if (refused) return refused;
      return journalRole(passthrough(await client.close(data.num, { summary: data.summary, convo_id: convoId })));
    },

    async merge(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!isNum(data.num)) return bad('num is required');
      if (!isNum(data.into)) return bad('into is required (the project number to merge into)');
      if (data.num === data.into) return bad('into must be a different project from num');
      const refused = gate(session, convoId, 'project_merge'); if (refused) return refused;
      return journalRole(passthrough(await client.merge(data.num, { into: data.into, convo_id: convoId })));
    },
  };
}
