// Loopback handlers behind the unseen_list / unseen_mine / unseen_flag MCP
// tools (spec: matron-journal docs/superpowers/specs/2026-09-30-read-state-
// design.md). The journal records what the user has actually seen; these
// tools let the Coordinator ask what the user missed, and any agent ask which
// of its OWN messages the user hasn't seen. Same {status, body} contract as
// lib/consent-tools.js. The journal is the gate (Coordinator only for the
// full list; an agent may flag only its own messages); this layer refuses a
// non-Coordinator unseen_list first with the clearer sentence. Snippets are
// other agents' words — peer text, one-lined and capped before they land in
// a tool result.
import { peerField, quotedField } from './peer-text.js';
import { parseDuration } from './timer-command.js';

const NOT_COORDINATOR = "only the Coordinator may list what the user hasn't seen across conversations — use unseen_mine for your own messages";
const TITLE_MAX = 80;
const SNIPPET_MAX = 200;
const ID_MAX = 128;
const REFS_MAX = 100;
const DAY = 86400000;

export const UNSEEN_FRAME_KIND = 'unseen';

const bad = (error) => ({ status: 400, body: { error } });

const REASON_TEXT = {
  awaiting_user: 'waiting on the user',
  question: 'a question',
  prompt: 'an unanswered prompt',
  permission: 'an unanswered permission request',
  final: "the session's last message before it stopped",
  failure: 'a failure',
};

export function formatJournalUnseenError(data) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  if (code === 'forbidden' && detail === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: an agent may only flag its own messages in its own conversation';
  if (code === 'not_found') return 'the journal does not let this session read that conversation';
  if (code === 'bad_request') return 'the journal rejected the request — check the durations, importance (important|all), limit (1–200) and refs (as unseen_list or unseen_mine gave them)';
  if (code === 'journal unreachable') return 'journal unreachable';
  return code || 'unknown error';
}

const age = (ts, now) => {
  const ms = now - Number(ts || now);
  if (!(ms > 0)) return 'just now';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

// Peer text inside "…": capped and one-lined, then quotes escaped so an
// agent can't close the quote and forge a ref or reason after it.
const quoted = (v) => quotedField(peerField(v, SNIPPET_MAX));
// A title inside a markdown link label: brackets and parens dropped so it
// can't close the label and forge a link of its own.
const linkLabel = (v) => peerField(v, TITLE_MAX).replace(/[[\]()]/g, '');
// Refs and ids end up in tool calls and URLs: keep them to their own
// alphabet (the journal's refs are msg:<convo id>:<seq> / item:<id>:<ms>).
const safeRef = (v) => (typeof v === 'string' && /^[A-Za-z0-9_:.@!-]{1,200}$/.test(v) ? v : '?');

const reasonsText = (reasons) => (Array.isArray(reasons) ? reasons : [])
  .map((r) => REASON_TEXT[r] || peerField(r, 32)).filter(Boolean).join(', ');

function entryLine(e, now) {
  const ref = safeRef(e?.ref);
  const why = reasonsText(e?.reasons);
  const snippet = quoted(e?.snippet);
  if (e?.kind === 'item') {
    const num = Number.isInteger(e?.item_num) ? `#${e.item_num}` : 'an item';
    return `  - tracker ${num} (${peerField(e?.item_kind, 16) || 'item'}) · ${age(e?.ts, now)}${why ? ` · ${why}` : ''}: "${snippet}" — link [#${e?.item_num}](matron://item/${e?.item_num}) · ref ${ref}`;
  }
  const who = peerField(e?.sender, 64);
  return `  - ${age(e?.ts, now)}${who ? ` · ${who}` : ''}${why ? ` · ${why}` : ''}: "${snippet}" · ref ${ref}`;
}

// Grouped by conversation, in the journal's order (important first).
function grouped(entries, now) {
  const groups = new Map();
  for (const e of entries) {
    const key = typeof e?.convo_id === 'string' ? e.convo_id : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const [convoId, list] of groups) {
    const first = list[0];
    const title = linkLabel(first?.convo_title) || 'untitled conversation';
    const id = safeRef(convoId) === '?' ? '' : convoId;
    const bits = [
      id ? `[${title}](matron://convo/${id})` : title,
      Number.isInteger(first?.mission_num) ? `mission #${first.mission_num}` : null,
      first?.session_state ? peerField(first.session_state, 16) : null,
      first?.is_room ? 'agent room' : null,
    ].filter(Boolean);
    out.push([bits.join(' · '), ...list.map((e) => entryLine(e, now))].join('\n'));
  }
  return out;
}

export function formatUnseenList(data, { now = Date.now() } = {}) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return 'Nothing matching is unseen — the user has seen it, it is too recent to count, or it was already raised.';
  const n = entries.length;
  const head = `${n}${data?.truncated ? '+' : ''} thing${n === 1 ? '' : 's'} the user hasn't seen, important first. Raise only what matters — one line each, lead with why it matters, link the conversation or item — then call unseen_flag with the refs you raised so they are never raised again.`;
  return [head, ...grouped(entries, now)].join('\n\n');
}

export function formatUnseenMine(data, { now = Date.now() } = {}) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return 'The user has seen everything you sent here, or it is too recent to tell.';
  return [
    `The user hasn't seen ${entries.length === 1 ? 'this message' : `these ${entries.length} messages`} of yours in this conversation:`,
    ...entries.map((e) => entryLine(e, now)),
    'If one of them matters, restate it once, briefly, in your closing message ("Earlier I said X; you may have missed it"), then call unseen_flag with its ref. Never repeat a restatement, and never tell the user they haven\'t read something.',
  ].join('\n');
}

// The turn the Coordinator gets for a journal {kind:'unseen', event:'pending'}
// frame: important things unseen for 2 h or more. Names them and the tools;
// the decision stays the Coordinator's.
export function formatUnseenNudge(frame, { now = Date.now() } = {}) {
  const entries = Array.isArray(frame?.entries) ? frame.entries : [];
  if (!entries.length) return null;
  const count = Number.isInteger(frame?.count) && frame.count > 0 ? frame.count : entries.length;
  return [
    `🔔 ${count} important thing${count === 1 ? ' has' : 's have'} gone unseen by the user for over 2 hours${count > entries.length ? ` (the newest ${entries.length} below; unseen_list shows all)` : ''}:`,
    ...grouped(entries, now),
    "Decide whether it's worth telling the user now: a short message, one line each, leading with why it matters. Otherwise leave it for the next status update. Call unseen_flag on what you raise. You won't be nudged about these again.",
  ].join('\n\n');
}

export function formatFlagAck(data, refs) {
  const n = Number.isInteger(data?.flagged) ? data.flagged : refs.length;
  return `Recorded ${n} of ${refs.length} as raised with the user${n < refs.length ? ' (the rest already were)' : ''}. They won't be listed or nudged about again.`;
}

// '30m' / '3d' → ms; a number is taken as ms. null = absent; undefined = bad.
function durationArg(v, max) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : parseDuration(v);
  if (!Number.isFinite(ms) || ms < 0 || ms > max) return undefined;
  return Math.round(ms);
}

export function createUnseenHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true }) {
  function caller(data, { coordinator }) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (coordinator && !isCoordinator(session, convoId)) return { err: { status: 403, body: { error: NOT_COORDINATOR } } };
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { session, convoId };
  }
  const OLD_JOURNAL = 'this journal has no /unseen routes yet — deploy the journal update (matron-journal read state)';
  // The Coordinator's own conversation always passes the journal's
  // ownership check, so a 404 there means the route itself is missing.
  const passthrough = (r, { coordinatorList = false } = {}) => {
    if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
    if (r.status === 404 && (coordinatorList || r.data?.error !== 'not_found')) return { status: 404, body: { error: OLD_JOURNAL } };
    if (r.status === 404) return { status: 404, body: { error: `${formatJournalUnseenError(r.data)} (or the journal has no /unseen routes yet)` } };
    if (r.status >= 400) return { status: r.status, body: { ...r.data, error: formatJournalUnseenError(r.data) } };
    return { status: r.status, body: r.data };
  };

  return {
    async list(data) {
      const { err, convoId } = caller(data, { coordinator: true });
      if (err) return err;
      const older = durationArg(data.older_than, 30 * DAY);
      const since = durationArg(data.since, 30 * DAY);
      if (older === undefined || since === undefined) return bad('older_than and since are durations like 30m, 2h or 3d (at most 30d)');
      const importance = data.importance ?? 'important';
      if (importance !== 'important' && importance !== 'all') return bad("importance is 'important' or 'all'");
      const limit = data.limit ?? null;
      if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return bad('limit is 1–200');
      const mission = data.mission ?? null;
      if (mission != null && (!Number.isInteger(mission) || mission < 1)) return bad('mission is a mission number');
      const inConvo = data.conversation ?? null;
      if (inConvo != null && (typeof inConvo !== 'string' || !inConvo || inConvo.length > ID_MAX)) return bad('conversation is a conversation id');
      return passthrough(await client.list(convoId, {
        older_than_ms: older, since_ms: since, importance, limit, mission, in_convo_id: inConvo, include_flagged: data.include_flagged === true,
      }), { coordinatorList: true });
    },
    async mine(data) {
      const { err, convoId } = caller(data, { coordinator: false });
      if (err) return err;
      const older = durationArg(data.older_than, 30 * DAY);
      if (older === undefined) return bad('older_than is a duration like 10m or 1h (at most 30d)');
      const room = data.room_id ?? null;
      if (room != null && (typeof room !== 'string' || !room || room.length > ID_MAX)) return bad('room_id is a chat room id you take part in');
      return passthrough(await client.list(room ?? convoId, { mine: true, older_than_ms: older }));
    },
    async flag(data) {
      const { err, session, convoId } = caller(data, { coordinator: false });
      if (err) return err;
      const refs = Array.isArray(data.refs) ? [...new Set(data.refs.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()))] : [];
      if (!refs.length || refs.length > REFS_MAX) return bad(`refs is 1–${REFS_MAX} refs exactly as unseen_list or unseen_mine gave them`);
      if (isCoordinator(session, convoId)) {
        const r = passthrough(await client.flag(convoId, refs));
        if (r.status >= 400) return r;
        return { status: 200, body: { ...r.body, refs } };
      }
      // Any other agent flags its own messages, in whichever of its
      // conversations or rooms each one is: one call per conversation.
      const byConvo = new Map();
      for (const ref of refs) {
        const m = /^msg:(.+):(\d+)$/.exec(ref);
        if (!m) return bad('only your own messages can be flagged — refs as unseen_mine gave them (msg:…)');
        if (!byConvo.has(m[1])) byConvo.set(m[1], []);
        byConvo.get(m[1]).push(ref);
      }
      let flagged = 0;
      for (const [target, list] of byConvo) {
        const r = passthrough(await client.flag(target, list));
        if (r.status >= 400) return r;
        flagged += Number.isInteger(r.body?.flagged) ? r.body.flagged : 0;
      }
      return { status: 200, body: { flagged, refs } };
    },
  };
}
