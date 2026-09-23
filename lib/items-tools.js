// Loopback handlers behind the item_* MCP tools (spec: Agent tools).
// HTTP-agnostic, same {status, body} contract as lib/agent-chat.js and
// lib/send-attachment.js; index.js mounts them with respondAgentChatRoute.
import { buildFilesDeepLink, appendFilesDeepLink } from './file-link-guard.js';

const KINDS = new Set(['task', 'question', 'decision']);
const RESOLUTIONS = new Set(['done', 'answered', 'decided', 'reversed', 'cancelled']);
const AWAITING = new Set(['user', 'agent']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;
// Server-constrained field limits, mirrored from the journal's item contract
// (journal src/items.js: LABELS_MAX/LABEL_MAX/LINKS_MAX/URL_MAX/TITLE_MAX).
// We validate labels/links on the bridge side BEFORE uploading attachment
// blobs so an invalid request is rejected up front — otherwise uploadAll runs,
// the journal then 400s the create, and the blob is permanently orphaned
// (retention.js never reaps unreferenced uploads). Keep these in lockstep with
// the journal.
const LABEL_MAX = 40;
const LABELS_MAX = 50;
const LINKS_MAX = 50;
const URL_MAX = 2048;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// `list` and `create` address the collection, not an item: there is no id in
// the path, so a 404 cannot mean "no such item" — it can only mean the journal
// has no /items route at all. Say which upgrade is missing, or the model reads
// a bare "not found" as an empty backlog and files nothing.
const NO_ITEMS_ROUTES = 'this journal deployment does not have the /items routes yet — deploy the journal update (matron-journal PR #73)';

const bad = (error) => ({ status: 400, body: { error } });

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}

// passthrough for the two collection routes — see NO_ITEMS_ROUTES.
function passthroughCollection(r) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: NO_ITEMS_ROUTES } };
  return out;
}

// awaiting is nullable (null clears the waiting state), so undefined is the
// only "not provided" sentinel — distinguish it from null explicitly rather
// than with a falsy check.
function validAwaiting(v) {
  return v === null || AWAITING.has(v);
}

export function createItemsHandlers({ sessions, journalConvoIdFor, client, uploadLocalFile, webBaseUrl = '' }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  async function uploadAll(session, paths) {
    if (paths === undefined) return { ok: true, attachments: [], deepLinks: [] };
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) return { ok: false, err: bad('attachments must be an array of file paths') };
    if (paths.length > 20) return { ok: false, err: bad('at most 20 attachments') };
    // Multi-attachment atomicity (loop #763): validate EVERY path (local,
    // non-network gates only) before uploading ANY blob. Otherwise an earlier
    // file uploads, a later one fails validation, and the earlier blob is
    // permanently orphaned (retention.js never reaps unreferenced uploads). The
    // validation pass is skipped for a single attachment (nothing earlier to
    // orphan) to avoid a redundant realpath/stat round.
    if (paths.length > 1) {
      for (const p of paths) {
        const v = await uploadLocalFile(session, p, { validateOnly: true });
        if (!v.ok) return { ok: false, err: { status: v.status, body: v.body } };
      }
    }
    const out = [];
    const deepLinks = [];
    for (const p of paths) {
      const r = await uploadLocalFile(session, p);
      if (!r.ok) return { ok: false, err: { status: r.status, body: r.body } };
      out.push({ blob_ref: r.media.blob_ref, mime: r.media.mime, name: r.media.name, size: r.media.size });
      // Files deep link (loop #739): so the operator can browse to the handed-off doc rather than
      // being given a raw path. resolveAndUploadLocalFile already gated the path within the
      // session workdir + non-sensitive, so this is null only when WEB_BASE_URL is unset.
      const link = buildFilesDeepLink(r.media.absPath, r.media.workdir, webBaseUrl);
      if (link) deepLinks.push({ name: r.media.name, link });
    }
    return { ok: true, attachments: out, deepLinks };
  }

  // Fold the per-attachment Files deep links into the item body as trailing "open in Files" lines,
  // so they surface in the operator's item thread alongside the inline attachment. Additive: the
  // agent's own body text stays first. No-op when there are no links (WEB_BASE_URL unset).
  //
  // Bounded by the journal's BODY_MAX contract, measured in UTF-8 BYTES (the "32 KiB" wire limit),
  // NOT JS code units: the 📁 in the trailer is 4 bytes / 2 units, so a code-unit check would let a
  // body slip 1-2 bytes over. The agent's body already passed validation at (up to) BODY_MAX, so
  // appending a trailer could push the request over the limit — the journal would then 400 the whole
  // call AFTER the media blobs were uploaded, orphaning them (and every retry re-uploads). So a link
  // line is appended only while the result stays within BODY_MAX bytes; any line that would overflow
  // is SKIPPED (continue, not break — trailer size varies with filename + encoded path, so a later
  // shorter one may still fit). The attachment itself is unaffected — only the convenience link is
  // dropped — keeping the request contract-valid.
  function bodyWithDeepLinks(body, deepLinks) {
    if (!Array.isArray(deepLinks) || deepLinks.length === 0) return body;
    let out = typeof body === 'string' ? body : '';
    for (const { name, link } of deepLinks) {
      const next = appendFilesDeepLink(out, link, name);
      if (Buffer.byteLength(next, 'utf8') > BODY_MAX) continue; // no room for THIS trailer — try the rest
      out = next;
    }
    return out;
  }

  const optStr = (v, name, max) => {
    if (v === undefined) return { ok: true };
    if (typeof v !== 'string' || v.length > max) return { ok: false, err: bad(`${name} must be a string of at most ${max} characters`) };
    return { ok: true };
  };

  const requireId = (data) => (typeof data.id === 'string' && data.id) || Number.isInteger(data.id) ? { ok: true } : { ok: false, err: bad('id is required') };

  // Mirror the journal's labels/links contract (journal src/items.js
  // validateItemFields) so an invalid create is rejected on the bridge side
  // BEFORE uploadAll runs — a 400 after the upload would orphan the blob.
  const optLabels = (v) => {
    if (v === undefined) return { ok: true };
    if (!Array.isArray(v) || v.length > LABELS_MAX) return { ok: false, err: bad(`labels must be an array of at most ${LABELS_MAX} non-empty strings of at most ${LABEL_MAX} characters`) };
    for (const l of v) {
      if (typeof l !== 'string' || !l.trim() || l.trim().length > LABEL_MAX) return { ok: false, err: bad(`labels must be an array of at most ${LABELS_MAX} non-empty strings of at most ${LABEL_MAX} characters`) };
    }
    return { ok: true };
  };

  const optLinks = (v) => {
    if (v === undefined) return { ok: true };
    const err = { ok: false, err: bad(`links must be an array of at most ${LINKS_MAX} { url } objects, each url an http(s) string of at most ${URL_MAX} characters and an optional title string of at most ${TITLE_MAX} characters`) };
    if (!Array.isArray(v) || v.length > LINKS_MAX) return err;
    for (const l of v) {
      if (!isPlainObject(l) || typeof l.url !== 'string' || l.url.length > URL_MAX || !/^https?:\/\//i.test(l.url)) return err;
      if (l.title !== undefined && (typeof l.title !== 'string' || l.title.length > TITLE_MAX)) return err;
    }
    return { ok: true };
  };

  return {
    async create(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'task', 'question' or 'decision'");
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > TITLE_MAX) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      if (data.awaiting !== undefined && !validAwaiting(data.awaiting)) return bad("awaiting must be 'user', 'agent' or null");
      if (data.position !== undefined && data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
      if (data.on_behalf_of !== undefined && data.on_behalf_of !== 'user') return bad("on_behalf_of may only be 'user'");
      // Validate server-constrained fields BEFORE uploading blobs: a journal
      // 400 after uploadAll would orphan the uploaded attachment (loop #759).
      const lbl = optLabels(data.labels); if (!lbl.ok) return lbl.err;
      const lnk = optLinks(data.links); if (!lnk.ok) return lnk.err;
      // supersedes pre-check (loop #763): the journal validates supersedes
      // existence server-side and 400s the create AFTER uploadAll — orphaning the
      // just-uploaded blob, which retention.js never reaps. Existence is a DB
      // lookup no static bridge check can cover, so when attachments are present
      // do a pre-check round-trip and confirm the target exists BEFORE uploading;
      // a bad supersedes id then fails with nothing to orphan. Skipped when there
      // are no attachments — a 400 there orphans nothing, so the extra round-trip
      // is not worth it.
      if (data.supersedes !== undefined && Array.isArray(data.attachments) && data.attachments.length > 0) {
        const chk = await client.get(data.supersedes);
        if (chk.status !== 200) {
          return chk.status === 404
            ? bad(`supersedes item ${data.supersedes} not found`)
            : { status: chk.status || 502, body: chk.data };
        }
      }
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const body = { kind: data.kind, title: data.title.trim(), convo_id: convoId };
      const finalBody = bodyWithDeepLinks(data.body, up.deepLinks);
      if (finalBody !== undefined && finalBody !== '') body.body = finalBody;
      if (data.labels !== undefined) body.labels = data.labels;
      if (data.links !== undefined) body.links = data.links;
      if (up.attachments.length) body.attachments = up.attachments;
      if (data.awaiting !== undefined) body.awaiting = data.awaiting;
      if (data.position !== undefined) body.position = data.position;
      if (data.supersedes !== undefined) body.supersedes = data.supersedes;
      if (data.on_behalf_of !== undefined) body.on_behalf_of = data.on_behalf_of;
      return passthroughCollection(await client.create(body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
    },

    async list(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const scope = data.scope ?? 'convo';
      if (scope !== 'convo' && scope !== 'all') return bad("scope must be 'convo' or 'all'");
      const state = data.state ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'any') return bad("state must be 'open', 'closed' or 'any'");
      if (data.kind !== undefined && !KINDS.has(data.kind)) return bad('kind is invalid');
      if (data.awaiting !== undefined && !AWAITING.has(data.awaiting)) return bad('awaiting is invalid');
      const lb = optStr(data.label, 'label', LABEL_MAX); if (!lb.ok) return lb.err;
      return passthroughCollection(await client.list({
        convo: scope === 'convo' ? convoId : undefined,
        kind: data.kind, state: state === 'any' ? undefined : state, awaiting: data.awaiting,
        label: data.label, since: data.since,
        // `rank` is the backlog's own order — what the user dragged it into,
        // and the right answer to "what should I do next". But `since` asks a
        // different question ("what changed while I was away"), and rank would
        // answer it with the oldest untouched item first; sort those by
        // recency instead.
        sort: data.since ? 'updated' : 'rank',
        limit: data.limit, cursor: data.cursor,
      }));
    },

    async get(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      return passthrough(await client.get(data.id));
    },

    async comment(data) {
      const { err, session } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      if (data.awaiting !== undefined && !validAwaiting(data.awaiting)) return bad("awaiting must be 'user', 'agent' or null");
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const text = typeof data.body === 'string' ? data.body : '';
      if (!text.trim() && up.attachments.length === 0) return bad('body or attachments is required');
      const body = { body: bodyWithDeepLinks(text, up.deepLinks) };
      if (up.attachments.length) body.attachments = up.attachments;
      const r = passthrough(await client.comment(data.id, body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
      if (data.awaiting !== undefined && (r.status === 200 || r.status === 201)) {
        const ur = await client.update(data.id, { awaiting: data.awaiting });
        if (ur.status !== 200 && ur.status !== 204) {
          // Never undefined: formatCommentAck reports the key's PRESENCE as a
          // failure, so a journal that answered with no error text (or a 2xx
          // this handler doesn't accept) must still name what went wrong.
          const why = (ur.status === 0 ? 'journal unreachable' : ur.data?.error) || `HTTP ${ur.status}`;
          r.body = { ...r.body, awaiting_error: why };
        }
      }
      return r;
    },

    async close(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      if (!RESOLUTIONS.has(data.resolution)) return bad('resolution must be one of done, answered, decided, reversed, cancelled');
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = { resolution: data.resolution };
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.close(data.id, body));
    },

    async reopen(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = {};
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.reopen(data.id, body));
    },

    async reorder(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const provided = ['position', 'after', 'before'].filter((k) => data[k] !== undefined);
      if (provided.length !== 1) return bad('exactly one of position, after or before is required');
      const body = {};
      if (data.position !== undefined) {
        if (data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
        body.position = data.position;
      }
      if (data.after !== undefined) body.after = data.after;
      if (data.before !== undefined) body.before = data.before;
      return passthrough(await client.rank(data.id, body));
    },

    // Missions (spec 2026-09-10): move an item to a mission by number, or
    // detach it (null). The only way an agent ever changes items.mission_id.
    async move(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      let mission;
      if (data.mission === null) mission = null;
      else if (Number.isInteger(data.mission) && data.mission > 0) mission = `#${data.mission}`;
      // Same invariant as the integer branch: a mission number is positive,
      // so '#0' is refused here rather than handed to the journal.
      else if (typeof data.mission === 'string' && /^#[1-9]\d*$/.test(data.mission)) mission = data.mission;
      else return bad("mission must be a mission number (61 or '#61') or null to detach");
      return passthrough(await client.update(data.id, { mission }));
    },
  };
}
