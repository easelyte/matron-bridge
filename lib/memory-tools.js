// Loopback handlers behind the memory_* MCP tools (spec: 2026-09-27
// memories, "Bridge"). HTTP-agnostic, same {status, body} contract as
// lib/items-tools.js and lib/missions-tools.js; index.js mounts them with
// respondAgentChatRoute. Validation mirrors the journal's so a bad call gets
// a specific reason instead of a bare `bad_request`.
import { validScope, audienceScopes, splitByAudience } from './memory-scope.js';
import { causesForAsk } from './turn-cause.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DESCRIPTION_MAX = 200;
export const BODY_MAX = 8192; // bytes
export const MEMORIES_MAX = 200;
export const MEMORY_TIERS = ['always', 'on_demand'];
export const TOPIC_MAX = 40;
export const RECALL_QUERY_MAX = 1000;
export const RECALL_TEXT_MAX = 4000; // the journal's cap on recall text
// Recall on a turn's text (recallTurn) gives at most this many memories,
// and skips text shorter than this ("ok", "go ahead"): nothing to match.
export const RECALL_TURN_LIMIT = 3;
export const RECALL_TURN_MIN_CHARS = 12;
// The journal has to answer inside the hook's own time limit
// (hooks/memory-recall.mjs): a turn never waits long for its reminders.
export const RECALL_TURN_TIMEOUT_MS = 2500;
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
const TOO_MANY_PENDING = 'too many memory proposals from this conversation (or for this user) are already waiting for the user\'s approval — nothing was recorded; wait for some to be answered rather than retrying';
const BAD_NAME = 'name must be a kebab-case slug: lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters';
const BAD_DESCRIPTION = `description must be one non-empty line of at most ${DESCRIPTION_MAX} characters (no line breaks or control characters)`;
const BAD_BODY = `body must be a string of at most ${BODY_MAX} bytes`;
const BAD_TYPE = `type must be one of ${MEMORY_TYPES.join(', ')}`;
const BAD_SCOPE = 'scope must be global, coordinator, or repo:<name> (the bare repo name: letters, digits, dots, dashes and underscores)';
const BAD_ALL = 'all must be true or false';
const NO_RECALL = 'this journal deployment cannot recall memories yet (no POST /memories/recall) — use memory_list and memory_get until the journal is updated';
const BAD_TIER = `tier must be one of ${MEMORY_TIERS.join(', ')}`;
const BAD_TOPIC = `topic must be one line of at most ${TOPIC_MAX} characters ("" clears it)`;
const BAD_QUERY = `query must be a non-empty string of at most ${RECALL_QUERY_MAX} characters`;
const BAD_LIMIT = 'limit must be a whole number from 1 to 10';

const bad = (error) => ({ status: 400, body: { error } });

// 202: the journal kept the write as a proposal for the user to answer on a
// tracker item (journal docs/protocol.md "Memory proposals"). Nothing was
// saved or deleted; the outcome reaches the session later as a turn.
function pendingAnswer(r, name, action) {
  const item = r.data?.item;
  return {
    status: 202,
    body: {
      pending: true, action, name,
      item_num: Number.isInteger(item?.num) ? item.num : null,
      item_id: typeof item?.id === 'string' ? item.id : null,
    },
  };
}

// The write as the journal needs it to judge who asked: the session's
// conversation and the causes of the turn making the call (the same list
// a spawn or chat ask carries, lib/turn-cause.js).
function written(session, convoId) {
  const causes = causesForAsk(session);
  return { convo_id: convoId, ...(causes ? { causes } : {}) };
}

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  if (r.status === 409) return { status: 409, body: { error: r.data?.blocked_by === 'too_many_asks' ? TOO_MANY_PENDING : TOO_MANY } };
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
export function validateFields({ description, body, type, scope, tier, topic }) {
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
  if (scope !== undefined) {
    if (!validScope(scope)) return { ok: false, err: bad(BAD_SCOPE) };
    out.scope = scope;
  }
  if (tier !== undefined) {
    if (!MEMORY_TIERS.includes(tier)) return { ok: false, err: bad(BAD_TIER) };
    out.tier = tier;
  }
  if (topic !== undefined) {
    if (topic !== null && typeof topic !== 'string') return { ok: false, err: bad(BAD_TOPIC) };
    const t = (topic ?? '').trim();
    if (t.length > TOPIC_MAX || LINE_BAD_CHARS.test(t)) return { ok: false, err: bad(BAD_TOPIC) };
    out.topic = t;
  }
  return { ok: true, value: out };
}

// isCoordinator(session, convoId) and repoFor(session) describe the caller
// (spec 2026-10-01 memory scopes): memory_list gives an ordinary session the
// memories in its audience unless it asks for `all`; the Coordinator always
// gets every one. Both default to "ordinary, no repo" so an older mount
// keeps working.
export function createMemoryHandlers({ sessions, journalConvoIdFor, client, isCoordinator = () => false, repoFor = () => null }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  // The scopes a session is given, for the journal's recall filter; null
  // (every scope) for the Coordinator.
  function scopesFor(session, convoId) {
    const audience = { coordinator: isCoordinator(session, convoId) === true, repo: repoFor(session) ?? null };
    return audience.coordinator ? null : audienceScopes(audience);
  }

  return {
    async save(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      const name = validateName(data.name);
      if (!name.ok) return name.err;
      const v = validateFields(data);
      if (!v.ok) return v.err;
      const r = await client.save(name.value, { ...v.value, ...written(c.session, c.convoId) });
      if (r.status === 201 || r.status === 200) return { status: r.status, body: { ...r.data, created: r.status === 201 } };
      if (r.status === 202) return pendingAnswer(r, name.value, 'save');
      const out = passthrough(r);
      if (out.status === 404) return { status: 404, body: { error: SAVE_REFUSED } };
      return out;
    },
    async list(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      if (data.all !== undefined && typeof data.all !== 'boolean') return bad(BAD_ALL);
      const out = passthroughCollection(await client.list());
      if (out.status !== 200 || !Array.isArray(out.body?.memories)) return out;
      const audience = { coordinator: isCoordinator(c.session, c.convoId) === true, repo: repoFor(c.session) ?? null };
      if (data.all === true || audience.coordinator) return { status: 200, body: { ...out.body, scopes: null, omitted: 0, omitted_scopes: [] } };
      const split = splitByAudience(out.body.memories, audience);
      return { status: 200, body: { ...out.body, memories: split.shown, scopes: audienceScopes(audience), omitted: split.omitted.length, omitted_scopes: split.omittedScopes } };
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
      const r = await client.remove(name.value, written(c.session, c.convoId));
      if (r.status === 202) return pendingAnswer(r, name.value, 'delete');
      return passthroughNamed(r, name.value);
    },
    // The `recall` tool: the memories in this session's scopes that bear
    // on a question in the agent's own words, whole.
    async recall(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      if (typeof data.query !== 'string' || !data.query.trim() || data.query.length > RECALL_QUERY_MAX) return bad(BAD_QUERY);
      if (data.limit !== undefined && (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > 10)) return bad(BAD_LIMIT);
      const scopes = scopesFor(c.session, c.convoId);
      const r = await client.recall({
        text: data.query.trim(), mode: 'query', limit: data.limit ?? 5, ...(scopes ? { scopes } : {}),
      });
      const out = passthrough(r);
      if (out.status === 404) return { status: 404, body: { error: NO_RECALL } };
      return out;
    },
    // The memory-recall hook (hooks/memory-recall.mjs): the on-demand
    // memories that bear on the text of a turn the agent is about to take,
    // each given to a session once. Never an error the turn would see: any
    // failure answers 200 with no memories. A turn another person started
    // gets nothing: the user's own rules are not for reading out to them.
    async recallTurn(data) {
      const c = callerSession(data);
      if (c.err) return c.err;
      const none = { status: 200, body: { memories: [] } };
      if (c.session.foreignTurn) return none;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (text.length < RECALL_TURN_MIN_CHARS) return none;
      const given = (c.session._recalledMemories ||= new Set());
      const scopes = scopesFor(c.session, c.convoId);
      const r = await client.recall({
        text: text.slice(0, RECALL_TEXT_MAX), mode: 'auto', tier: 'on_demand',
        limit: RECALL_TURN_LIMIT, exclude: [...given].slice(-200), ...(scopes ? { scopes } : {}),
      }, { timeoutMs: RECALL_TURN_TIMEOUT_MS });
      if (r.status !== 200 || !Array.isArray(r.data?.memories)) return none;
      const memories = r.data.memories.filter((m) => m && typeof m.name === 'string');
      for (const m of memories) given.add(m.name);
      return { status: 200, body: { memories } };
    },
  };
}
