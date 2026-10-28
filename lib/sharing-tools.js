// Loopback handlers behind the contact_* / mission_share tools and the
// shared reads of mission_list / mission_get (spec: matron-journal
// 2026-10-02 matron-to-matron sharing, phase 1). HTTP-agnostic, same
// {status, body} contract as lib/missions-tools.js; index.js mounts them
// at /sharing/<op>.
//
// The journal is the gate. An agent's contact_add and mission_share send
// nothing to the other person: the journal parks the ask and puts a card
// in front of this session's own user. No tool here answers a card — not
// for this user's asks, not for another person's — because only a tap on
// the user's own device may (the journal refuses every agent, the
// Coordinator included). What an agent may do is ask, look, and reduce
// access (remove, block, unshare).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_MAX = 128;
const NO_ROUTES = 'this journal does not have contacts and sharing yet — deploy the journal update (matron-journal contacts and grants, phase 1)';

const bad = (error) => ({ status: 400, body: { error } });
const LEVELS = new Set(['read', 'contribute', 'owner']);
const BRIEF_MAX = 16000;
export const BRIEF_WHAT = 'where things stand, the repos involved, the next steps and the gotchas, written for someone who has seen none of this conversation. No secrets, file paths, box names or quotes from the transcript';
const KINDS = new Set(['user_input', 'progress']);
// A contributor files tasks, questions and decisions; a notice is the owner's.
const ITEM_KINDS = new Set(['task', 'question', 'decision']);
const RESOLUTIONS = new Set(['done', 'answered', 'decided', 'reversed', 'cancelled']);
const TITLE_MAX = 200;
const TEXT_MAX = 32768;
const STATUS_MAX = 600;
// What never rides on a write to another person's mission.
const NO_FILES = 'files do not cross to another person: leave attachments out (describe the file in words, or ask your user to share it some other way)';
const NO_BUTTONS = "one-tap buttons are for your own user only: leave actions out on another person's mission";
// A mission row that belongs to someone other than this session's user.
const isOthers = (m) => !!m && typeof m === 'object' && !!m.owner && typeof m.owner === 'object' && typeof m.owner.name === 'string';

export function createSharingHandlers({ sessions, journalConvoIdFor, client, resolveMission }) {
  function caller(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }
  const passthrough = (r) => (r.status === 0 ? { status: 502, body: { error: 'journal unreachable' } } : { status: r.status, body: r.data });
  // The collection routes only 404 when the journal predates them.
  const collection = (r) => (r.status === 404 ? { status: 404, body: { error: NO_ROUTES } } : passthrough(r));
  const contactRef = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= ID_MAX ? v.trim() : null);
  const num = (v) => (Number.isInteger(v) && v >= 1 ? v : null);

  // The mission a share tool acts on: the named number, or this
  // conversation's current mission.
  async function missionRef(session, convoId, mission) {
    if (mission !== undefined) return num(mission) ? { ref: mission } : { err: bad('mission must be a positive integer (a mission number)') };
    const r = await resolveMission(session, convoId);
    if (r.err) return { err: r.err };
    if (!r.id) return { err: { status: 409, body: { error: 'this conversation has no mission — pass mission: N to name one' } } };
    return { ref: r.id };
  }

  const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  const optText = (v, max) => {
    if (v === undefined) return { value: undefined };
    if (typeof v !== 'string' || v.length > max) return { err: bad(`text must be a string of at most ${max} characters`) };
    return { value: v };
  };
  const hasAny = (v) => Array.isArray(v) && v.length > 0;

  // shared_by + the owner's number, from the tool's arguments.
  function sharedTarget(data, field) {
    const owner = typeof data.shared_by === 'string' ? data.shared_by.trim() : '';
    if (!NAME_RE.test(owner)) return { err: bad('shared_by must be the name of the user who shared the mission') };
    if (!num(data[field])) return { err: bad(`${field} is required with shared_by — their mission number, from mission_list shared: true`) };
    return { owner, num: data[field] };
  }

  // The owner's mission number -> its id, checked to be another person's
  // mission the user may contribute to.
  async function sharedMission(owner, n) {
    const hit = await client.lookup(owner, n);
    if (hit.status !== 200) return { err: passthrough(hit) };
    if (hit.data?.kind !== 'mission' || typeof hit.data.id !== 'string') return { err: { status: 404, body: { error: 'not_found' } } };
    const r = await client.mission(hit.data.id);
    if (r.status !== 200) return { err: passthrough(r) };
    const m = r.data?.mission;
    if (!isOthers(m)) return { err: { status: 400, body: { error: 'own_mission' } } };
    const level = m?.grant?.level;
    if (level && level !== 'contribute') return { err: { status: 403, body: { error: 'read_only' } } };
    if (m.state && m.state !== 'open') return { err: { status: 409, body: { error: 'conflict', blocked_by: 'closed' } } };
    return { id: hit.data.id };
  }

  // An item of another person's mission: by id, or by the owner's number.
  async function sharedItem(data) {
    const owner = typeof data.shared_by === 'string' ? data.shared_by.trim() : '';
    if (!NAME_RE.test(owner)) return { err: bad('shared_by must be the name of the user who shared the mission') };
    const raw = typeof data.id === 'string' ? data.id.trim() : (Number.isInteger(data.id) ? String(data.id) : '');
    if (!raw) return { err: bad("id is required — the item's id, or its number on their side ('#12')") };
    if (/^it_[A-Za-z0-9_-]+$/.test(raw)) return { id: raw };
    const n = Number(raw.replace(/^#/, ''));
    if (!num(n)) return { err: bad("id must be an item id ('it_…') or their item number ('#12')") };
    const hit = await client.lookup(owner, n);
    if (hit.status !== 200) return { err: passthrough(hit) };
    if (hit.data?.kind !== 'item' || typeof hit.data.id !== 'string') return { err: { status: 404, body: { error: 'not_found' } } };
    return { id: hit.data.id };
  }

  return {
    async contact_list(data) {
      const { err } = caller(data);
      if (err) return err;
      const r = collection(await client.contacts());
      if (r.status !== 200 || data.users !== true) return r;
      const u = await client.users();
      return u.status === 200 && Array.isArray(u.data?.users) ? { status: 200, body: { ...r.body, users: u.data.users } } : r;
    },

    async contact_add(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const user = typeof data.user === 'string' ? data.user.trim() : '';
      if (!NAME_RE.test(user)) return bad('user is required — the name of another user on this journal (contact_list users: true lists them)');
      return passthrough(await client.contactAdd({ user, convo_id: convoId }));
    },

    async contact_remove(data) {
      const { err } = caller(data);
      if (err) return err;
      const c = contactRef(data.contact);
      if (!c) return bad('contact is required — a name or id from contact_list');
      return passthrough(await client.contactRemove(c));
    },

    async contact_block(data) {
      const { err } = caller(data);
      if (err) return err;
      const c = contactRef(data.contact);
      if (!c) return bad('contact is required — a name or id from contact_list');
      return passthrough(await client.contactBlock(c));
    },

    // mission_share. read: see it; contribute: also post milestones,
    // comment, file and close items, set the status; owner: a hand-over,
    // with a brief, of one mission or (project: N) every open mission of a
    // project. Every level parks the same way: a card for this session's own
    // user, then one for the other person.
    async share(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const c = contactRef(data.contact);
      if (!c) return bad('contact is required — a name or id from contact_list');
      const level = data.level === undefined ? 'read' : data.level;
      if (!LEVELS.has(level)) return bad("level must be 'read', 'contribute' or 'owner'");
      let brief;
      if (data.brief !== undefined) {
        if (typeof data.brief !== 'string') return bad('brief must be text');
        brief = data.brief.trim();
        if (level !== 'owner') return bad('a brief goes with a hand-over only (level: owner)');
      }
      if (level === 'owner' && !brief) return bad(`a hand-over (level: owner) needs a brief: ${BRIEF_WHAT}`);
      if (brief && brief.length > BRIEF_MAX) return bad(`brief must be at most ${BRIEF_MAX} characters`);
      if (data.keep_contributing !== undefined) {
        if (typeof data.keep_contributing !== 'boolean') return bad('keep_contributing must be true or false');
        if (level !== 'owner') return bad('keep_contributing goes with a hand-over only (level: owner)');
      }
      const body = { contact: c, level, convo_id: convoId };
      if (brief) body.brief = brief;
      // What the user keeps on the copy; their card has the final say.
      if (data.keep_contributing === true) body.keep_level = 'contribute';
      if (data.project !== undefined) {
        if (level !== 'owner') return bad('project is for handing over a whole project: pass level: owner and a brief');
        if (data.mission !== undefined) return bad('pass mission or project, not both');
        if (!num(data.project)) return bad('project must be a positive integer (a project number from project_list)');
        return passthrough(await client.shareProject(data.project, body));
      }
      const m = await missionRef(session, convoId, data.mission);
      if (m.err) return m.err;
      return passthrough(await client.share(m.ref, body));
    },

    // End a share: by grant id (either direction — mission_shares lists
    // them), or by contact (+ mission, default this conversation's) for one
    // this user gave.
    async unshare(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      if (data.grant !== undefined) {
        const g = contactRef(data.grant);
        if (!g) return bad('grant must be a grant id from mission_shares');
        return passthrough(await client.revoke(g));
      }
      const c = contactRef(data.contact);
      if (!c) return bad('pass grant (an id from mission_shares), or contact (and mission) for a share your user gave');
      const m = await missionRef(session, convoId, data.mission);
      if (m.err) return m.err;
      const list = await client.shares(m.ref);
      if (list.status !== 200) return passthrough(list);
      // By the contact's id as contact_list prints it (the owner's side of
      // a grant carries contact_id), or by name or address.
      const hit = (Array.isArray(list.data?.grants) ? list.data.grants : [])
        .find((g) => g?.contact_id === c || g?.grantee?.address === c || g?.grantee?.name === c);
      if (!hit) return { status: 404, body: { error: `that mission is not shared with ${c} — mission_shares lists what is` } };
      return passthrough(await client.revoke(hit.id));
    },

    async shares(data) {
      const { err } = caller(data);
      if (err) return err;
      return collection(await client.grants());
    },

    // mission_list shared: true. Every row of the shared scope carries
    // `owner` — the journal sets it only on another person's mission. A
    // journal from before that scope ignores the parameter and answers with
    // the user's OWN missions, which must never be rendered as someone
    // else's words: a row without an owner means exactly that journal.
    async shared_list(data) {
      const { err } = caller(data);
      if (err) return err;
      const r = passthrough(await client.sharedMissions());
      if (r.status !== 200) return r;
      const rows = Array.isArray(r.body?.missions) ? r.body.missions : [];
      if (rows.some((m) => !isOthers(m))) return { status: 404, body: { error: NO_ROUTES } };
      return r;
    },

    // mission_get shared_by + num: the owner's number is resolved to the
    // mission's id by the journal's lookup, under the same read rule.
    async shared_get(data) {
      const { err } = caller(data);
      if (err) return err;
      const owner = typeof data.shared_by === 'string' ? data.shared_by.trim() : '';
      if (!NAME_RE.test(owner)) return bad('shared_by must be the name of the user who shared the mission');
      if (!num(data.num)) return bad('num is required with shared_by — their mission number, from mission_list shared: true');
      const hit = await client.lookup(owner, data.num);
      if (hit.status !== 200) return passthrough(hit);
      if (hit.data?.kind !== 'mission' || typeof hit.data.id !== 'string') return { status: 404, body: { error: 'not_found' } };
      const r = passthrough(await client.mission(hit.data.id));
      // The lookup resolves the user's own name too; an own mission has no
      // `owner` and is never rendered as another person's.
      if (r.status === 200 && !isOthers(r.body?.mission)) return { status: 400, body: { error: 'own_mission' } };
      return r;
    },

    // --- Contributing to another person's mission (a contribute grant) ---
    // The owner's number is resolved to the mission's id through the
    // journal's lookup, as shared_get does; the write then goes to that id.
    // The journal is the gate (403 without a live contribute grant); the
    // checks here only turn the commonest mistakes into sentences first.

    // milestone_post shared_by + mission.
    async shared_post(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const t = sharedTarget(data, 'mission'); if (t.err) return t.err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'user_input' or 'progress'");
      const ti = text(data.title, TITLE_MAX); if (!ti) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optText(data.body, TEXT_MAX); if (b.err) return b.err;
      const m = await sharedMission(t.owner, t.num); if (m.err) return m.err;
      const body = { kind: data.kind, title: ti, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      return passthrough(await client.contribMilestone(m.id, body));
    },

    // mission_status shared_by + mission.
    async shared_status(data) {
      const { err } = caller(data);
      if (err) return err;
      const t = sharedTarget(data, 'mission'); if (t.err) return t.err;
      const st = text(data.status, STATUS_MAX); if (!st) return bad(`status is required (at most ${STATUS_MAX} characters)`);
      const m = await sharedMission(t.owner, t.num); if (m.err) return m.err;
      return passthrough(await client.contribStatus(m.id, { status: st }));
    },

    // item_create shared_by + mission.
    async shared_item_create(data) {
      const { err, convoId } = caller(data);
      if (err) return err;
      const t = sharedTarget(data, 'mission'); if (t.err) return t.err;
      if (!ITEM_KINDS.has(data.kind)) return bad("kind must be 'task', 'question' or 'decision' on another person's mission (a notice is the owner's to file)");
      const ti = text(data.title, TITLE_MAX); if (!ti) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optText(data.body, TEXT_MAX); if (b.err) return b.err;
      if (hasAny(data.attachments)) return bad(NO_FILES);
      if (hasAny(data.actions)) return bad(NO_BUTTONS);
      const m = await sharedMission(t.owner, t.num); if (m.err) return m.err;
      // convo_id: the conversation the owner's replies on this item come
      // back to (the journal never shows it to the owner).
      const body = { kind: data.kind, title: ti, convo_id: convoId };
      if (b.value !== undefined) body.body = b.value;
      if (Array.isArray(data.labels)) body.labels = data.labels;
      if (Array.isArray(data.links)) body.links = data.links;
      return passthrough(await client.contribItem(m.id, body));
    },

    // item_comment / item_close / item_reopen with shared_by: the item by
    // the owner's number ('#12' or 12) or by id.
    async shared_item_comment(data) {
      const { err } = caller(data);
      if (err) return err;
      const b = optText(data.body, TEXT_MAX); if (b.err) return b.err;
      if (!b.value || !b.value.trim()) return bad('body is required');
      if (hasAny(data.attachments)) return bad(NO_FILES);
      if (hasAny(data.actions)) return bad(NO_BUTTONS);
      const i = await sharedItem(data); if (i.err) return i.err;
      return passthrough(await client.itemComment(i.id, { body: b.value }));
    },

    async shared_item_close(data) {
      const { err } = caller(data);
      if (err) return err;
      if (!RESOLUTIONS.has(data.resolution)) return bad('resolution must be one of done, answered, decided, reversed, cancelled');
      const c = optText(data.comment, TEXT_MAX); if (c.err) return c.err;
      const i = await sharedItem(data); if (i.err) return i.err;
      const body = { resolution: data.resolution };
      if (c.value !== undefined) body.comment = c.value;
      return passthrough(await client.itemClose(i.id, body));
    },

    async shared_item_reopen(data) {
      const { err } = caller(data);
      if (err) return err;
      const c = optText(data.comment, TEXT_MAX); if (c.err) return c.err;
      const i = await sharedItem(data); if (i.err) return i.err;
      const body = {};
      if (c.value !== undefined) body.comment = c.value;
      return passthrough(await client.itemReopen(i.id, body));
    },
  };
}
