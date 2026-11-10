// Loopback handlers behind the timeline_week_read / timeline_week_write MCP
// tools. The Coordinator reads one week of the user's work (every project that
// moved, what is already written for the week, and for the current week the
// Went quiet list) and writes the week's stories for the Projects timeline.
// Same {status, body} contract and Coordinator gate as lib/briefings-tools.js:
// the journal is the real gate (the Coordinator only, naming its own
// conversation, and it refuses private work); this layer refuses a
// non-Coordinator first with the clearer sentence and validates the call
// against the journal's limits so a bad call never costs a round trip.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = 'only the Coordinator may read or write the timeline — this conversation is not the Coordinator';

// The journal's limits, mirrored.
export const TIMELINE_LIMITS = Object.freeze({
  ledeMax: 600,
  storiesMax: 8,
  titleMax: 80,
  sentenceMax: 300,
  nextMax: 300,
  projectRefsMax: 10,
  itemRefsMax: 10,
  notesMax: 50,
  noteMax: 300,
  blobIdMax: 128,
});
const L = TIMELINE_LIMITS;

const bad = (error) => ({ status: 400, body: { error } });
const WEEK_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A week is named by its Monday, YYYY-MM-DD.
export function validateWeekKey(week) {
  const m = typeof week === 'string' ? week.trim().match(WEEK_RE) : null;
  if (!m) return { ok: false, err: bad('week must be the Monday of the week as YYYY-MM-DD') };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  if (!real) return { ok: false, err: bad(`week ${week.trim()} is not a real date — pass the Monday of the week as YYYY-MM-DD`) };
  if (d.getUTCDay() !== 1) return { ok: false, err: bad(`week ${week.trim()} is not a Monday — a week is named by its Monday, as YYYY-MM-DD`) };
  return { ok: true, value: week.trim() };
}

// A project or item reference: the id, or the number (12 or "#12").
export function normalizeRef(ref) {
  if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : null;
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  if (!s) return null;
  const n = s.match(/^#?(\d+)$/);
  if (n) {
    const v = Number(n[1]);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }
  return s.startsWith('#') ? null : s;
}

function refList(value, what, { min, max }) {
  if (value === undefined || value === null) {
    return min > 0 ? { err: `${what} is required: 1 to ${max} project ids or numbers` } : { value: [] };
  }
  if (!Array.isArray(value)) return { err: `${what} must be a list of ids or numbers` };
  if (value.length < min || value.length > max) return { err: min > 0 ? `${what} needs ${min} to ${max} entries (got ${value.length})` : `${what} has at most ${max} entries (got ${value.length})` };
  const out = [];
  for (const r of value) {
    const n = normalizeRef(r);
    if (n === null) return { err: `${what} has a bad reference ${JSON.stringify(r)} — use the id, or the number such as 12 or #12` };
    out.push(n);
  }
  return { value: out };
}

function text(value, what, { min = 0, max }) {
  if (value === undefined || value === null) return min > 0 ? { err: `${what} is required` } : { value: '' };
  if (typeof value !== 'string') return { err: `${what} must be text` };
  const t = value.trim();
  if (t.length < min) return { err: `${what} is required` };
  if (t.length > max) return { err: `${what} is too long: at most ${max} characters (got ${t.length})` };
  return { value: t };
}

export function validateTimelineWrite(data) {
  const wk = validateWeekKey(data?.week);
  if (!wk.ok) return wk;
  const fail = (msg) => ({ ok: false, err: bad(msg) });

  const lede = text(data?.lede, 'lede', { max: L.ledeMax });
  if (lede.err) return fail(lede.err);

  const rawStories = data?.stories;
  if (!Array.isArray(rawStories)) return fail('stories is required: a list of up to 8 stories (an empty list for a quiet week)');
  if (rawStories.length > L.storiesMax) return fail(`too many stories: at most ${L.storiesMax} (got ${rawStories.length}) — group related projects into one story`);

  const stories = [];
  for (let i = 0; i < rawStories.length; i++) {
    const s = rawStories[i];
    const at = `story ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(`${at} must be an object with title, sentence and project_ids`);
    const title = text(s.title, `${at} title`, { min: 1, max: L.titleMax });
    if (title.err) return fail(title.err);
    const sentence = text(s.sentence, `${at} sentence`, { min: 1, max: L.sentenceMax });
    if (sentence.err) return fail(sentence.err);
    const next = text(s.next, `${at} next`, { max: L.nextMax });
    if (next.err) return fail(next.err);
    const projects = refList(s.project_ids, `${at} project_ids`, { min: 1, max: L.projectRefsMax });
    if (projects.err) return fail(projects.err);
    const items = refList(s.item_ids, `${at} item_ids`, { min: 0, max: L.itemRefsMax });
    if (items.err) return fail(items.err);
    const out = { title: title.value, sentence: sentence.value, project_ids: projects.value };
    if (next.value) out.next = next.value;
    if (items.value.length) out.item_ids = items.value;
    if (s.media_blob_id !== undefined && s.media_blob_id !== null && s.media_blob_id !== '') {
      if (typeof s.media_blob_id !== 'string' || !s.media_blob_id.trim()) return fail(`${at} media_blob_id must be a blob id from the week's media list`);
      const blob = s.media_blob_id.trim();
      if (blob.length > L.blobIdMax) return fail(`${at} media_blob_id is too long: at most ${L.blobIdMax} characters (got ${blob.length}) — use the blob id exactly as the week's media list gives it`);
      out.media_blob_id = blob;
    }
    stories.push(out);
  }

  const notes = [];
  if (data?.notes !== undefined && data?.notes !== null) {
    if (!Array.isArray(data.notes)) return fail('notes must be a list of { project_id, note }');
    if (data.notes.length > L.notesMax) return fail(`too many notes: at most ${L.notesMax} (got ${data.notes.length})`);
    for (let i = 0; i < data.notes.length; i++) {
      const n = data.notes[i];
      const at = `note ${i + 1}`;
      if (!n || typeof n !== 'object' || Array.isArray(n)) return fail(`${at} must be an object with project_id and note`);
      const ref = normalizeRef(n.project_id);
      if (ref === null) return fail(`${at} has a bad project_id ${JSON.stringify(n.project_id)} — use the id, or the number such as 12 or #12`);
      const note = text(n.note, `${at} note`, { min: 1, max: L.noteMax });
      if (note.err) return fail(note.err);
      notes.push({ project_id: ref, note: note.value });
    }
  }

  if (data?.final !== undefined && data?.final !== null && typeof data.final !== 'boolean') return fail('final must be true or false');
  const value = { week: wk.value, stories, final: data?.final === true, notes };
  if (lede.value) value.lede = lede.value;
  return { ok: true, value };
}

// One sentence an agent can act on for each thing the journal can say.
// `status` matters only for a 404 whose body carries no code (a journal that
// predates the route). `read` picks the wording for the read tool: a write can
// also 404 when the journal does not know the Coordinator's conversation.
export function formatJournalTimelineError(data, status = 0, read = false) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const ref = data?.ref !== undefined && data?.ref !== null ? peerField(data.ref, 80) : '';
  if (detail === 'not_coordinator' || code === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: only the Coordinator agent may read or write the timeline';
  if (status === 404 || code === 'not_found') {
    return read
      ? 'the journal predates the timeline routes — deploy the journal update (Projects timeline) before using this tool'
      : 'the journal predates the timeline routes, or does not know this conversation on this box — deploy the journal update (Projects timeline), or check this conversation has reached the journal';
  }
  if (code === 'conflict' && (detail === 'week_final' || !detail)) return 'that week is frozen; pass final: true to rewrite it on purpose';
  if (code === 'bad_request') {
    if (read && !detail) return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'bad_week') return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'week_out_of_range') return 'that week is outside the range the timeline covers (too old or in the future) — use a week from the timeline list';
    if (detail === 'week_not_ended') return 'a week can be frozen only after it ends (Monday 00:00 in the user\'s zone) — write the current week without final';
    if (detail === 'unknown_project') return `project ${ref || '(unnamed)'} is not one of the user's projects, or is private — stories never name private work`;
    if (detail === 'unknown_item') return `item ${ref || '(unnamed)'} is not one of the user's items, or is private — name only items still waiting on the user`;
    if (detail === 'unknown_blob') return `media_blob_id ${ref || '(unnamed)'} is not a picture or video from that week's work — pick one from the week's media list`;
    return 'the journal rejected the call — check the week and the story limits (8 stories, titles to 80 characters, sentences to 300)';
  }
  if (code === 'journal unreachable') return 'journal unreachable';
  return peerField(code, 120) || 'unknown error';
}

export function formatTimelineReadAck(data) {
  return JSON.stringify(data ?? {});
}

export function formatTimelineWriteAck(data) {
  const week = typeof data?.week === 'string' ? data.week : '?';
  const n = Number.isInteger(data?.stories_count) ? data.stories_count : 0;
  return `Week ${week} written (${n} ${n === 1 ? 'story' : 'stories'}${data?.final === true ? ', frozen' : ''}).`;
}

// `isCoordinator(session, convoId)` decides the local refusal, as for the
// briefing tools: index.js passes one that also asks the journal's current
// role holder.
export function createTimelineHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true }) {
  // The shared session / Coordinator / conversation gate.
  function gate(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!isCoordinator(session, convoId)) return { err: { status: 403, body: { error: NOT_COORDINATOR } } };
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { convoId };
  }
  const failed = (r, read = false) => (r.status === 0
    ? { status: 502, body: { error: 'journal unreachable' } }
    : { status: r.status, body: { ...r.data, error: formatJournalTimelineError(r.data, r.status, read) } });

  return {
    async read(data) {
      const g = gate(data);
      if (g.err) return g.err;
      let week;
      if (data?.week === undefined || data?.week === null || data?.week === '') {
        const list = await client.listWeeks({ limit: 1 });
        if (list.status === 0 || list.status >= 400) return failed(list, true);
        const first = Array.isArray(list.data?.weeks) ? list.data.weeks[0] : null;
        if (!first || typeof first.week !== 'string') return { status: 404, body: { error: 'the journal lists no weeks yet — pass a week (the Monday, YYYY-MM-DD)' } };
        week = first.week;
      } else {
        const v = validateWeekKey(data.week);
        if (!v.ok) return v.err;
        week = v.value;
      }
      const raw = await client.readWeekRaw(week);
      if (raw.status === 0 || raw.status >= 400) return failed(raw, true);
      // A phase-1 journal ignores ?raw=1 and answers with the apps' week detail.
      if (typeof raw.data?.current !== 'boolean' || !Array.isArray(raw.data?.projects)) return failed({ status: 404, data: {} }, true);
      const body = { week: raw.data };
      if (raw.data?.current === true) {
        const q = await client.wentQuiet();
        if (q.status === 0 || q.status >= 400) return failed(q, true);
        body.quiet = Array.isArray(q.data?.rows) ? q.data.rows : [];
        if (Number.isInteger(q.data?.total)) body.quiet_total = q.data.total;
      }
      return { status: 200, body };
    },

    async write(data) {
      const g = gate(data);
      if (g.err) return g.err;
      const v = validateTimelineWrite(data);
      if (!v.ok) return v.err;
      const { week, ...rest } = v.value;
      const r = await client.writeWeek(week, { convo_id: g.convoId, ...rest });
      if (r.status === 0 || r.status >= 400) return failed(r);
      return { status: r.status, body: { ...r.data, week: r.data?.week ?? week, final: r.data?.final ?? rest.final, stories_count: rest.stories.length } };
    },
  };
}
