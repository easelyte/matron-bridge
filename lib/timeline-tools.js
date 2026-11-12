// Loopback handlers behind the timeline_week_read / timeline_week_write MCP
// tools. The Coordinator reads one week of the user's work (every project that
// moved, what is already written for the week, and for the current week the
// Went quiet list) and writes the week for Projects: one entry per project that
// mattered.
// Same {status, body} contract and Coordinator gate as lib/briefings-tools.js:
// the journal is the real gate (the Coordinator only, naming its own
// conversation, and it refuses private work); this layer refuses a
// non-Coordinator first with the clearer sentence and validates the call
// against the journal's limits so a bad call never costs a round trip.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = 'only the Coordinator may read or write the timeline — this conversation is not the Coordinator';

// The journal's limits, mirrored.
export const TIMELINE_LIMITS = Object.freeze({
  entriesMax: 8,
  sentenceMax: 300,
  nextMax: 300,
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

// A project reference: the id, or the number (12 or "#12").
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

function text(value, what, { min = 0, max }) {
  if (value === undefined || value === null) return min > 0 ? { err: `${what} is required` } : { value: '' };
  if (typeof value !== 'string') return { err: `${what} must be text` };
  const t = value.trim();
  if (t.length < min) return { err: `${what} is required` };
  if (t.length > max) return { err: `${what} is too long: at most ${max} characters (got ${t.length})` };
  return { value: t };
}

const duplicateProject = (ref) => `project ${ref || '(unnamed)'} has two entries — one entry per project`;

// A week is written as one entry per project. The tool schema refuses
// anything else in the call (a lede, stories, a title on an entry); for a
// caller that bypasses that schema it is ignored here, never forwarded.
export function validateTimelineWrite(data) {
  const wk = validateWeekKey(data?.week);
  if (!wk.ok) return wk;
  const fail = (msg) => ({ ok: false, err: bad(msg) });

  const rawEntries = data?.entries;
  if (!Array.isArray(rawEntries)) return fail(`entries is required: a list of up to ${L.entriesMax} entries, one per project (an empty list for a quiet week)`);
  if (rawEntries.length > L.entriesMax) return fail(`too many entries: at most ${L.entriesMax} (got ${rawEntries.length}) — one entry per project, for the projects that mattered most`);

  const entries = [];
  const seen = new Set();
  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(`${at} must be an object with project and sentence`);
    if (e.project === undefined || e.project === null) return fail(`${at} project is required: the project's id, or its number such as 12 or #12`);
    const project = normalizeRef(e.project);
    if (project === null) return fail(`${at} has a bad project ${JSON.stringify(e.project)} — use the id, or the number such as 12 or #12`);
    // Only the same reference twice is caught here; the journal also catches
    // an id and a number that name one project.
    const key = `${typeof project}:${project}`;
    if (seen.has(key)) return fail(duplicateProject(typeof project === 'number' ? `#${project}` : peerField(project, 80)));
    seen.add(key);
    const sentence = text(e.sentence, `${at} sentence`, { min: 1, max: L.sentenceMax });
    if (sentence.err) return fail(sentence.err);
    const next = text(e.next, `${at} next`, { max: L.nextMax });
    if (next.err) return fail(next.err);
    const out = { project, sentence: sentence.value };
    if (next.value) out.next = next.value;
    if (e.media_blob_id !== undefined && e.media_blob_id !== null && e.media_blob_id !== '') {
      if (typeof e.media_blob_id !== 'string' || !e.media_blob_id.trim()) return fail(`${at} media_blob_id must be a blob id from the week's media list`);
      const blob = e.media_blob_id.trim();
      if (blob.length > L.blobIdMax) return fail(`${at} media_blob_id is too long: at most ${L.blobIdMax} characters (got ${blob.length}) — use the blob id exactly as the week's media list gives it`);
      out.media_blob_id = blob;
    }
    entries.push(out);
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
  return { ok: true, value: { week: wk.value, entries, final: data?.final === true, notes } };
}

// One sentence an agent can act on for each thing the journal can say.
// `status` matters only for a 404 whose body carries no code (a journal that
// predates the route). `read` picks the wording for the read tool. A write
// goes to the per-project route, which an older journal does not have: its 404
// stores nothing. A current journal also answers 404 when it does not know the
// Coordinator's conversation, and the two cannot be told apart from here.
export function formatJournalTimelineError(data, status = 0, read = false) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const ref = data?.ref !== undefined && data?.ref !== null ? peerField(data.ref, 80) : '';
  if (detail === 'not_coordinator' || code === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: only the Coordinator agent may read or write the timeline';
  if (status === 404 || code === 'not_found') {
    return read
      ? 'the journal predates the timeline routes — deploy the journal update (Projects timeline) before using this tool'
      : 'the journal predates per-project weeks — deploy the journal update before writing (nothing was written; if the journal is up to date, it does not know this conversation on this box)';
  }
  if (code === 'conflict' && (detail === 'week_final' || !detail)) return 'that week is frozen; pass final: true to rewrite it on purpose';
  if (code === 'bad_request') {
    if (read && !detail) return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'bad_week') return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'week_out_of_range') return 'that week is outside the range the timeline covers (too old or in the future) — use a week from the timeline list';
    if (detail === 'week_not_ended') return 'a week can be frozen only after it ends (Monday 00:00 in the user\'s zone) — write the current week without final';
    if (detail === 'unknown_project') return `project ${ref || '(unnamed)'} is not one of the user's projects, or is private — a week never names private work`;
    if (detail === 'duplicate_project') return duplicateProject(ref);
    if (detail === 'unknown_blob') return `media_blob_id ${ref || '(unnamed)'} is not a picture or video from that week's work — pick one from the week's media list`;
    return 'the journal rejected the call — check the week and the entry limits (8 entries, one per project, sentences to 300 characters)';
  }
  if (code === 'journal unreachable') return 'journal unreachable';
  return peerField(code, 120) || 'unknown error';
}

// The Coordinator can take in a little under 50,000 characters of one tool
// result; the text of a read is never longer than this, which leaves room. A quiet list that does not fit is
// shortened; a page of the week that does not fit by itself is refused rather
// than cut off part-way.
export const TIMELINE_READ_MAX_CHARS = 40000;
const READ_TOO_LARGE = 'the journal\'s week read is too large for this tool — deploy the journal update';
const PROJECTS_TOO_LARGE = 'those projects are too large for one read — ask for fewer in a call';
const PREDATES_INDEX = 'the journal predates the week index — deploy the journal update, or read the week a page at a time';
export const TIMELINE_READ_PROJECTS_MAX = 12;

// What follows this page: { next } (the offset of the next page), 'complete',
// or 'cut' (more moved and there is no way to read it).
// A journal that pages sends next_offset on every page: null on the last, the
// next offset otherwise. Only an offset past the one ASKED FOR counts: one
// that stays put or goes back would have the reader ask for the same page for
// ever, and the offset the journal echoes is not the one to measure from.
// A journal without the key does not page: its count of projects left out is
// all there is to go by.
function afterPage(week, requested) {
  if (week && typeof week === 'object' && Object.hasOwn(week, 'next_offset')) {
    if (week.next_offset === null) return 'complete';
    return Number.isInteger(week.next_offset) && week.next_offset > requested ? { next: week.next_offset } : 'cut';
  }
  return week?.more_projects === true || Number(week?.more_projects) > 0 ? 'cut' : 'complete';
}
const requestedOffset = (data) => (Number.isInteger(data?.offset) && data.offset > 0 ? data.offset : 0);
const readAgain = (week, offset) => `call timeline_week_read again with week: ${JSON.stringify(week?.week ?? '')}, offset: ${offset}`;

// The index of a week lists every project that moved with counts only: each
// row carries its id at the top level. A journal that predates it ignores the
// parameter and answers with a page, whose rows carry a `project` and which
// (when the journal pages) has next_offset.
function isWeekIndex(week) {
  return Number.isInteger(week?.projects_total)
    && !Object.hasOwn(week, 'next_offset')
    && week.projects.every((p) => p && typeof p === 'object' && Object.hasOwn(p, 'id') && !Object.hasOwn(p, 'project'));
}

// The projects to read in detail: 1 to 12 references, each an id or a number.
// The same reference twice is asked for once.
function validateProjectRefs(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return { err: bad(`projects must be a list of 1 to ${TIMELINE_READ_PROJECTS_MAX} projects: ids, or numbers such as 12 or #12`) };
  if (projects.length > TIMELINE_READ_PROJECTS_MAX) return { err: bad(`too many projects: at most ${TIMELINE_READ_PROJECTS_MAX} a call (got ${projects.length}) — ask for the rest in another call`) };
  const refs = [];
  for (let i = 0; i < projects.length; i++) {
    const ref = normalizeRef(projects[i]);
    // The references travel as one comma-separated list.
    if (ref === null || (typeof ref === 'string' && ref.includes(','))) return { err: bad(`project ${i + 1} is a bad reference ${JSON.stringify(projects[i])} — use the id, or the number such as 12 or #12`) };
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs };
}

function quietLine(data) {
  const total = Number.isInteger(data.quiet_total) ? data.quiet_total : data.quiet.length;
  return `quiet (${data.quiet.length} of ${total}): ${JSON.stringify(data.quiet)}`;
}

// The read as text, shortest and most often missed part first: the Went quiet
// list (the first page of the current week only), then the page of the week,
// then whether there is another page to ask for. `data.offset` is the offset
// the read asked for (0 when absent). An index read (`data.index`) and a read
// of chosen projects (`data.asked`) end by saying what they were instead.
export function formatTimelineReadAck(data) {
  const lines = [];
  if (Array.isArray(data?.quiet)) lines.push(quietLine(data));
  if (data?.index && typeof data.index === 'object') {
    const index = data.index;
    lines.push(`index: ${JSON.stringify(index)}`);
    if (Number(index.more_projects) > 0) lines.push(`${Number(index.more_projects)} more projects moved and are not listed (the least active).`);
    lines.push(`Pick the projects that mattered (at most ${L.entriesMax} get a card), then call timeline_week_read with week: ${JSON.stringify(index.week ?? '')} and projects: [their ids or numbers] (up to ${TIMELINE_READ_PROJECTS_MAX} a call) for their milestones, items and pictures.`);
    return lines.join('\n');
  }
  const week = data?.week ?? {};
  lines.push(`week: ${JSON.stringify(week)}`);
  if (data?.asked === true) {
    lines.push('Those are the projects you asked for.');
    if (Array.isArray(week.omitted) && week.omitted.length > 0) lines.push(`Left out to fit: ${week.omitted.join(', ')} — ask for them in another call.`);
    return lines.join('\n');
  }
  const after = afterPage(week, requestedOffset(data));
  if (after === 'cut') {
    // More projects moved and there is no offset to read them from: a journal
    // without paging, or one whose next offset does not move on.
    lines.push('More projects moved this week than this read shows; the journal cannot page them — deploy the journal update.');
  } else if (after === 'complete') {
    lines.push('That is every project that moved this week.');
  } else {
    lines.push(`More projects: ${readAgain(week, after.next)}.`);
  }
  return lines.join('\n');
}

export function formatTimelineWriteAck(data) {
  const week = typeof data?.week === 'string' ? data.week : '?';
  const n = Number.isInteger(data?.entries) ? data.entries : 0;
  return `Week ${week} written (${n} ${n === 1 ? 'project' : 'projects'}${data?.final === true ? ', frozen' : ''}).`;
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
      const given = (v) => v !== undefined && v !== null;
      if (given(data?.index) && typeof data.index !== 'boolean') return bad('index must be true or false');
      const wantIndex = data?.index === true;
      const wantProjects = given(data?.projects);
      if (wantIndex && (wantProjects || given(data?.offset))) return bad('index cannot be combined with projects or offset — the index is the whole week in one read');
      if (wantProjects && given(data?.offset)) return bad('projects cannot be combined with offset — the projects asked for come in one read');
      let refs = null;
      if (wantProjects) {
        const v = validateProjectRefs(data.projects);
        if (v.err) return v.err;
        refs = v.refs;
      }
      let offset = 0;
      if (data?.offset !== undefined && data?.offset !== null) {
        if (!Number.isSafeInteger(data.offset) || data.offset < 0) return bad('offset must be a whole number, 0 or more — pass the offset the last read gave, or leave it out for the first page');
        offset = data.offset;
      }
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
      let raw;
      if (wantIndex) raw = await client.readWeekIndex(week);
      else if (refs) raw = await client.readWeekProjects(week, refs);
      else raw = await client.readWeekRaw(week, { offset });
      if (raw.status === 0 || raw.status >= 400) return failed(raw, true);
      // A phase-1 journal ignores ?raw=1 and answers with the apps' week detail.
      if (typeof raw.data?.current !== 'boolean' || !Array.isArray(raw.data?.projects)) return failed({ status: 404, data: {} }, true);
      // A journal that predates the index answers either call with a page of
      // the week: never pass that off as the whole week, or as the projects
      // asked for.
      if (wantIndex && !isWeekIndex(raw.data)) return { status: 502, body: { error: PREDATES_INDEX } };
      // A journal that reads chosen projects always says which it left out
      // (omitted, if only []). Without that list the answer is a page of the
      // whole week, even when the page is complete.
      if (refs && (!Array.isArray(raw.data.omitted) || afterPage(raw.data, 0) !== 'complete')) return { status: 502, body: { error: PREDATES_INDEX } };
      let body = { week: raw.data, offset };
      if (wantIndex) body = { index: raw.data };
      else if (refs) body = { week: raw.data, asked: true };
      // The Went quiet list goes with the index, or the first page, of the
      // current week only.
      if (raw.data?.current === true && !refs && offset === 0) {
        const q = await client.wentQuiet();
        if (q.status === 0 || q.status >= 400) return failed(q, true);
        body.quiet = Array.isArray(q.data?.rows) ? q.data.rows : [];
        body.quiet_total = Number.isInteger(q.data?.total) ? q.data.total : body.quiet.length;
      }
      const fits = () => formatTimelineReadAck(body).length <= TIMELINE_READ_MAX_CHARS;
      // The page comes first: quiet rows are dropped from the end until the
      // text fits (the quiet line says how many of the total it shows).
      if (body.quiet && !fits()) {
        body.quiet = [...body.quiet];
        while (body.quiet.length > 0 && !fits()) body.quiet.pop();
        // Even the empty quiet line is too much for a page that fits by
        // itself: the page goes out without it rather than being refused.
        if (!fits()) {
          delete body.quiet;
          delete body.quiet_total;
        }
      }
      // The page alone is too long: a journal without paging, or one page of
      // a journal that pages. Never cut it; say where to go on from if known.
      if (!fits()) {
        if (wantIndex) return { status: 502, body: { error: READ_TOO_LARGE } };
        if (refs) return { status: 502, body: { error: PROJECTS_TOO_LARGE } };
        const after = afterPage(raw.data, offset);
        return { status: 502, body: { error: typeof after === 'object' ? `this page of the week is too large for this tool — skip it and carry on: ${readAgain(raw.data, after.next)}` : READ_TOO_LARGE } };
      }
      return { status: 200, body };
    },

    async write(data) {
      const g = gate(data);
      if (g.err) return g.err;
      const v = validateTimelineWrite(data);
      if (!v.ok) return v.err;
      const { week, ...rest } = v.value;
      // The per-project route only: an older journal answers 404 and keeps the
      // week it has. Never fall back to the whole-week route, which would
      // replace that week.
      const r = await client.writeWeekEntries(week, { convo_id: g.convoId, ...rest });
      if (r.status === 0 || r.status >= 400) return failed(r);
      return { status: r.status, body: { ...r.data, week: r.data?.week ?? week, final: r.data?.final ?? rest.final, entries: Number.isInteger(r.data?.entries) ? r.data.entries : rest.entries.length } };
    },
  };
}
