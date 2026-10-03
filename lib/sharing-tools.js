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

    async share(data) {
      const { err, session, convoId } = caller(data);
      if (err) return err;
      const c = contactRef(data.contact);
      if (!c) return bad('contact is required — a name or id from contact_list');
      if (data.level !== undefined && data.level !== 'read') return bad("level must be 'read' — it is the only level so far");
      const m = await missionRef(session, convoId, data.mission);
      if (m.err) return m.err;
      return passthrough(await client.share(m.ref, { contact: c, level: 'read', convo_id: convoId }));
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
  };
}
