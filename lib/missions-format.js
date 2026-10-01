// Compact renderings of the journal's mission JSON for the mission_* tools.
// Pure and defensive (a journal a version ahead must degrade to a duller
// line, never throw inside a handler). One line per fact, never raw JSON.
import { formatConvoStatus } from './convo-status-format.js';

const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };

// The status paragraph (spec 2026-09-28 missions dashboard): when and by
// whom, so the Coordinator can tell a status newer than the last milestone.
export function statusLine(m) {
  const s = str(m?.status).trim();
  if (!s) return null;
  const by = m.status_by === 'user' ? ', by the user' : (m.status_by === 'agent' ? ', by an agent' : '');
  return `Status (${isoTime(m.status_updated_at)}${by}): ${s}`;
}

export function missionLine(m) {
  if (!m || typeof m !== 'object') return '(unknown mission)';
  const state = m.state === 'closed' ? `closed${m.closed_by ? ` by ${m.closed_by}` : ''}` : (str(m.state) || 'open');
  // Spec 2026-09-30 §4.2: rows gain the server-computed activity and the
  // project. Each shows only when sent, so an older journal's row renders
  // exactly as before. `project_id: null` (key present) is a new journal
  // saying "not in a project" — the Coordinator's filing sweep reads it.
  const activity = m.state !== 'closed' && str(m.activity) ? `, ${m.activity}` : '';
  let project = '';
  if (Number.isInteger(m.project_num)) project = `, project #${m.project_num}`;
  else if (str(m.project_id)) project = `, project ${m.project_id}`;
  else if ('project_id' in m) project = ', no project';
  const open = n(m.open_items); const need = n(m.needs_you);
  const openText = `${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`;
  const id = str(m.id);
  return `#${m.num ?? '?'} ${str(m.title) || '(untitled)'} — ${state}${activity}${project}, ${openText}, ${n(m.conversations)} conversation${n(m.conversations) === 1 ? '' : 's'}, ${n(m.milestones)} milestone${n(m.milestones) === 1 ? '' : 's'}${id ? ` (id ${id})` : ''}`;
}

// What happened to the project requested on mission_start / mission_create
// (lib/missions-tools.js withProject sets both fields).
const PROJECTS_UNSUPPORTED = 'this journal does not support projects yet';
function projectNote(data) {
  if (data?.project_ignored) return ` — but ${PROJECTS_UNSUPPORTED}, so it was not filed (deploy the journal projects update)`;
  // R5 (2026-09-30 preflight): an idempotent replay of an existing mission
  // never re-applies `project` — the field IS present (this journal supports
  // projects), just not what was just asked for.
  if (data?.project_not_applied) return ` — not filed in #${data.project_requested}: the journal returned an identical mission created moments ago; mission_update with mission: ${data.mission?.num ?? 'N'} and project: ${data.project_requested} files it`;
  if (Number.isInteger(data?.project_requested)) return ` in project #${data.project_requested}`;
  return '';
}

// A conversation that already has a current mission gets it back unchanged
// from POST /missions (spec 2026-09-30 leaves that route's existing:true
// as is). Moving on to new work is mission_create + mission_join.
export function formatStartAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission started.';
  const id = str(m.id) ? ` (id ${m.id})` : '';
  if (data.existing) {
    const p = data.project_requested;
    const file = Number.isInteger(p) ? `; to file this one, mission_update with project: ${p}` : '';
    return `Already in mission #${m.num ?? '?'} "${str(m.title)}" — nothing changed${id}. For different work, mission_create it and mission_join the new number${file}`;
  }
  return `Started mission #${m.num ?? '?'} "${str(m.title)}"${id}${projectNote(data)}`;
}

export function formatCreateAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission created (unassigned).';
  return `Mission #${m.num ?? '?'} "${str(m.title)}" created (unassigned)${projectNote(data)}`;
}

// mission_join (spec 2026-09-30 §3): adds or reactivates a link and makes it
// current; the missions it was on stay linked.
export function formatJoinAck(data) {
  const m = data?.mission;
  if (!m) return "Joined — it is now this conversation's current mission";
  const id = str(m.id) ? ` (id ${m.id})` : '';
  return `Joined mission #${m.num ?? '?'} "${str(m.title)}"${id} — it is now this conversation's current mission: milestones and new items go there by default. Missions it was already on stay linked; mission_leave N ends one`;
}

// mission_leave: `current` is the re-read link row, null (none), or
// undefined (the re-read failed — say nothing rather than guess).
export function formatLeaveAck(data) {
  const left = `Left mission #${data?.left ?? '?'}`;
  if (data?.current === null) return `${left} — this conversation has no current mission now; mission_join one before posting milestones`;
  if (data?.current && typeof data.current === 'object') return `${left} — the current mission is now #${data.current.num ?? '?'} "${str(data.current.title)}"`;
  return left;
}

export function formatUpdateAck(data) {
  const line = missionLine(data?.mission);
  return data?.project_ignored ? `${line} — but ${PROJECTS_UNSUPPORTED}, so the project was not changed (deploy the journal projects update)` : line;
}

export function formatMilestoneAck(data) {
  const l = data?.milestone; const m = data?.mission;
  return `Milestone #${l?.num ?? '?'} posted to mission #${m?.num ?? '?'} "${str(m?.title)}"`;
}

export function formatStatusAck(data) {
  const m = data?.mission;
  if (!m) return 'Status set.';
  return `Status set on mission #${m.num ?? '?'} "${str(m.title)}"`;
}

export function formatMissionDetail(data, { now = Date.now() } = {}) {
  const lines = [missionLine(data?.mission)];
  const body = str(data?.mission?.body).trim();
  if (body) lines.push(body);
  const status = statusLine(data?.mission);
  if (status) lines.push(status);
  if (data?.mission?.state === 'closed' && str(data.mission.close_summary).trim()) lines.push(`Closed: ${data.mission.close_summary.trim()}`);
  lines.push('');
  // Rendered in the order the journal returns them: GET /missions/:id is
  // newest first by contract, and this renderer never re-sorts.
  const ms = Array.isArray(data?.milestones) ? data.milestones : [];
  lines.push('Milestones (newest first):');
  if (!ms.length) lines.push('- (none yet)');
  for (const l of ms) lines.push(`- #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)} in ${str(l.convo_id) || '?'}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  lines.push('Open items:');
  if (!items.length) lines.push('- (none)');
  for (const i of items) lines.push(`- #${i.num ?? '?'} ${str(i.title)}${i.awaiting ? ` — awaiting ${i.awaiting}` : ''}`);
  const convos = Array.isArray(data?.conversations) ? data.conversations : [];
  lines.push('Conversations:');
  if (!convos.length) lines.push('- (none)');
  for (const c of convos) {
    // The session's persisted header (model, context gauge, stall) when the
    // journal has one — the Coordinator's "which session needs compacting".
    const status = formatConvoStatus(c.status, now);
    // Spec 2026-09-30 §3: a conversation that left keeps its row as history;
    // sub-chats are folded into their parent's row by default.
    const left = c.ended_at ? ` · left ${isoTime(c.ended_at)}` : '';
    const subs = n(c.subchat_count) > 0 ? ` · ${n(c.subchat_count)} sub-chat${n(c.subchat_count) === 1 ? '' : 's'}` : '';
    lines.push(`- ${str(c.id)} ${str(c.title)} (${str(c.box) || 'unknown box'}, ${str(c.state) || 'unknown'}${status ? ` · ${status}` : ''}${left}${subs})`);
  }
  // mission_get with no num attaches every mission THIS conversation is on
  // (lib/missions-tools.js get), so an agent on several can name one.
  if (Array.isArray(data?.conversation_missions)) {
    lines.push("This conversation's missions:");
    if (!data.conversation_missions.length) lines.push('- (none)');
    for (const l of data.conversation_missions) lines.push(`- #${l?.num ?? '?'} ${str(l?.title)} — ${linkState(l)}`);
  }
  return lines.join('\n');
}

function linkState(l) {
  if (l?.current === true) return 'current';
  if (l?.ended_at) return `earlier (left ${isoTime(l.ended_at)})`;
  if (l?.state === 'closed') return 'earlier (closed)';
  return 'also on';
}

const itemList = (items) => (Array.isArray(items) ? items : []).map((i) => `#${i.num ?? '?'} ${str(i.title)}`).join(', ');

export function formatBlocked(data) {
  // The code rides in blocked_by (house style: {error:'conflict', blocked_by})
  // or, for a route that answers with the bare code, in error.
  switch (data?.blocked_by ?? data?.error) {
    case 'no_mission': return 'this conversation has no mission — call mission_start(title, body) first, then post the milestone again';
    case 'closed': return 'mission is closed — no more milestones, joins or status changes';
    case 'user_items': return `blocked by items awaiting the user: ${itemList(data.items)} — only the user can clear those`;
    case 'agent_items': return `blocked by open items: ${itemList(data.items)} — close each with a real resolution (item_close), or item_move it to the mission it belongs to`;
    case 'not_linked': return 'this conversation is not on that mission — mission_join it first (it becomes the current mission), or leave out `mission` to post to the current one';
    // Only a journal from before mission links still refuses a second mission.
    case 'other_mission': return 'this journal still allows only one mission per conversation — deploy the journal update (mission history); nothing changed';
    // R4 (2026-09-30 preflight): a closed or merged project on start/create/update.
    case 'project_closed': return 'that project is closed (a merged project is closed too — project_get N shows where it went) — file the mission in an open project from project_list';
    default: return str(data?.error) || 'conflict';
  }
}

// The journal's non-409 errors are machine words — `not_found`,
// `bad_request` — and passthrough hands them to the model verbatim, which
// tells it nothing it can act on ("mission_get failed: not_found"). Map the
// ones it can actually hit to a sentence that names the next move. Anything
// else, including the bridge's own sentences, passes through unchanged.
export function formatJournalError(op, data) {
  switch (str(data?.error)) {
    case 'not_found': return "no mission with that number, or it isn't visible to this session";
    case 'bad_request':
      // A status-only PATCH to a journal from before mission status is a
      // 400 too (it sees no fields it knows) — say so, or the model retries
      // a status that was never the problem.
      if (op === 'status') return 'the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs (a journal older than mission status rejects every status: deploy the journal update)';
      return 'the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB; a mission already holding 200 conversations refuses joins)';
    // A colleague's shared mission is readable but not writable (journal
    // missions-http: getSharedMission → 403).
    case 'forbidden': return "that mission is shared with you by another user — only its owner's sessions can change it";
    default: return str(data?.error);
  }
}

// mission_list: GET /missions rows in the journal's order, each with its
// status and last milestone — what the Coordinator needs to decide which
// missions to refresh.
export function formatMissionList(data) {
  const ms = Array.isArray(data?.missions) ? data.missions : [];
  if (!ms.length) return 'No missions.';
  const lines = [];
  for (const m of ms) {
    lines.push(missionLine(m));
    lines.push(`  ${statusLine(m) || 'Status: (none yet)'}`);
    const l = m?.last_milestone;
    lines.push(l && typeof l === 'object'
      ? `  Last milestone: #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)}`
      : '  Last milestone: (none yet)');
  }
  return lines.join('\n');
}
