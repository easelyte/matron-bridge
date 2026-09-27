// Loopback handlers behind the memory_* MCP tools (spec: 2026-09-27
// memories, "Bridge"). HTTP-agnostic, same {status, body} contract as
// lib/items-tools.js and lib/missions-tools.js; index.js mounts them with
// respondAgentChatRoute. Validation mirrors the journal's so a bad call gets
// a specific reason instead of a bare `bad_request`.
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DESCRIPTION_MAX = 200;
export const BODY_MAX = 8192; // bytes
export const MEMORIES_MAX = 200;
// C0/C1 controls (covers \n, \r, \t) and the Unicode line/paragraph
// separators — the description is the one line the Coordinator sees at
// spawn, so it must stay a line.
// eslint-disable-next-line no-control-regex -- the control range is the point
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const NO_ROUTES = 'this journal deployment does not have the /memories routes yet — deploy the journal update (matron-journal PR #94)';
// PUT cannot 404 on the name (it creates): a 404 there is the missing
// routes, or the journal refusing this session's conversation / a name it
// may not see (private origin, ordinary agent) — never "no such memory".
const SAVE_REFUSED = `the journal refused the write (404): ${NO_ROUTES}, or the conversation or name is not writable by this session`;
const TOO_MANY = `the journal holds the maximum of ${MEMORIES_MAX} memories — delete one first`;
const BAD_NAME = 'name must be a kebab-case slug: lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters';
const BAD_DESCRIPTION = `description must be one non-empty line of at most ${DESCRIPTION_MAX} characters (no line breaks or control characters)`;
const BAD_BODY = `body must be a string of at most ${BODY_MAX} bytes`;
const BAD_TYPE = `type must be one of ${MEMORY_TYPES.join(', ')}`;

const bad = (error) => ({ status: 400, body: { error } });

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  if (r.status === 409) return { status: 409, body: { error: TOO_MANY } };
  return { status: r.status, body: r.data };
}
// Only GET /memories (the collection) can honestly 404 because the routes
// are missing; a 404 on a named memory is about that memory.
function passthroughCollection(r) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: NO_ROUTES } };
  return out;
}
function passthroughNamed(r, name) {
  const out = passthrough(r);
  if (out.status === 404) return { status: 404, body: { error: `no memory named "${name}"` } };
  return out;
}

export function validateName(v) {
  return typeof v === 'string' && NAME_RE.test(v) ? { ok: true, value: v } : { ok: false, err: bad(BAD_NAME) };
}

// The journal's validateMemoryFields, with reasons. body omitted → omitted
// (the journal clears it; the tool description says to send it back).
export function validateFields({ description, body, type }) {
  if (typeof description !== 'string') return { ok: false, err: bad(BAD_DESCRIPTION) };
  const desc = description.trim();
  if (!desc || desc.length > DESCRIPTION_MAX || LINE_BAD_CHARS.test(desc)) return { ok: false, err: bad(BAD_DESCRIPTION) };
  const out = { description: desc };
  if (body !== undefined) {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > BODY_MAX) return { ok: false, err: bad(BAD_BODY) };
    out.body = body;
  }
  if (type !== undefined) {
    if (!MEMORY_TYPES.includes(type)) return { ok: false, err: bad(BAD_TYPE) };
    out.type = type;
  }
  return { ok: true, value: out };
}

export function createMemoryHandlers({ sessions, journalConvoIdFor, client }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  return {
    async save(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      const name = validateName(data.name);
      if (!name.ok) return name.err;
      const v = validateFields(data);
      if (!v.ok) return v.err;
      const r = await client.save(name.value, { ...v.value, convo_id: c.convoId });
      if (r.status === 201 || r.status === 200) return { status: r.status, body: { ...r.data, created: r.status === 201 } };
      const out = passthrough(r);
      if (out.status === 404) return { status: 404, body: { error: SAVE_REFUSED } };
      return out;
    },
    async list(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      return passthroughCollection(await client.list());
    },
    async get(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      const name = validateName(data.name);
      if (!name.ok) return name.err;
      return passthroughNamed(await client.get(name.value), name.value);
    },
    async delete(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      const name = validateName(data.name);
      if (!name.ok) return name.err;
      return passthroughNamed(await client.remove(name.value), name.value);
    },
  };
}
