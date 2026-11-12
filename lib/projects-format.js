// Compact renderings of the journal's project JSON for the project_* tools
// (spec 2026-09-30 projects §4.2, §5). Pure and defensive, like
// lib/missions-format.js: a journal a version ahead degrades to a duller
// line, never a throw. One line per fact, never raw JSON.
import { missionLine, statusLine } from './missions-format.js';

const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };
const ACTIVITY = ['running', 'waiting', 'idle', 'quiet'];

// A tool result is readable up to a little under 50,000 characters.
export const LIST_MAX = 40000;

// GET /projects rows carry missions:{running, waiting, idle, quiet, closed}.
export const openMissions = (ms) => ACTIVITY.reduce((sum, k) => sum + n(ms?.[k]), 0);

function missionsSummary(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const open = openMissions(ms);
  const parts = ACTIVITY.filter((k) => n(ms[k]) > 0).map((k) => `${n(ms[k])} ${k}`);
  const closed = n(ms.closed);
  return `${open} open mission${open === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}${closed ? `, ${closed} closed` : ''}`;
}

export function projectLine(p) {
  if (!p || typeof p !== 'object') return '(unknown project)';
  let state = str(p.state) || 'open';
  if (p.state === 'closed' && (p.merged_into_num || str(p.merged_into))) {
    state = `closed (merged into ${Number.isInteger(p.merged_into_num) ? `#${p.merged_into_num}` : str(p.merged_into)})`;
  }
  const parts = [state];
  const ms = missionsSummary(p.missions);
  if (ms) parts.push(ms);
  if (p.open_items !== undefined || p.needs_you !== undefined) {
    const open = n(p.open_items); const need = n(p.needs_you);
    parts.push(`${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`);
  }
  if (p.last_activity_at) parts.push(`last activity ${isoTime(p.last_activity_at)}`);
  const id = str(p.id);
  return `#${p.num ?? '?'} ${str(p.title) || '(untitled)'} — ${parts.join(', ')}${id ? ` (id ${id})` : ''}`;
}

// One line for the brief list: the goal, how much of it is open and how
// much closed, whether it waits on the user, and when it last moved. The
// single open mission is named only when the row carries it.
function briefLine(p) {
  if (!p || typeof p !== 'object') return '(unknown project)';
  const parts = [];
  if (str(p.state) && p.state !== 'open') parts.push(p.state);
  if (p.missions && typeof p.missions === 'object') {
    const open = openMissions(p.missions);
    const closed = n(p.missions.closed);
    parts.push(`${open} open mission${open === 1 ? '' : 's'}${closed > 0 ? `, ${closed} closed` : ''}`);
    const m = p.mission;
    if (open === 1 && m && typeof m === 'object' && Number.isInteger(m.num) && str(m.title)) parts.push(`mission #${m.num} "${m.title}"`);
  }
  if (n(p.needs_you) > 0) parts.push(`${n(p.needs_you)} need you`);
  if (p.last_activity_at) {
    const at = isoTime(p.last_activity_at);
    parts.push(`last activity ${at === 'unknown time' ? at : at.slice(0, 10)}`);
  }
  const head = `#${p.num ?? '?'} ${str(p.title) || '(untitled)'}`;
  return parts.length ? `${head} — ${parts.join(', ')}` : head;
}

// The closing line of a page that is not the last: the call to make next,
// with the filters of this one, so it can be followed as written.
function moreLine(remaining, next, data) {
  const args = [];
  if (data?.state === 'closed') args.push('state: "closed"');
  if (data?.live === true) args.push('live: true');
  if (data?.brief === true) args.push('brief: true');
  if (Number.isInteger(data?.limit)) args.push(`limit: ${data.limit}`);
  args.push(`offset: ${next}`);
  return `${remaining} more: call project_list again with ${args.join(', ')}`;
}

// The list handler sends one page: {projects, total, offset, brief}, and
// the filters of the call (state, live, a limit that is not the default).
// The text never exceeds LIST_MAX characters: it stops between projects,
// and the closing line counts from the last project actually shown, so
// the next call neither repeats nor skips one.
export function formatProjectList(data) {
  const ps = Array.isArray(data?.projects) ? data.projects : [];
  const offset = n(data?.offset);
  const total = Number.isInteger(data?.total) && data.total >= 0 ? data.total : offset + ps.length;
  if (!ps.length) return offset > 0 ? `No projects from offset ${offset} (${total} in all).` : 'No projects.';
  const brief = data?.brief === true;
  const blocks = ps.map((p) => (brief ? briefLine(p) : `${projectLine(p)}\n  ${statusLine(p) || 'Status: (none yet)'}`));
  // Room for the closing line at its longest, and the newline before it.
  const budget = LIST_MAX - moreLine(total, total, data).length - 1;
  const kept = [];
  let size = 0;
  for (const block of blocks) {
    const add = block.length + (kept.length ? 1 : 0);
    if (size + add > budget) break;
    kept.push(block);
    size += add;
  }
  // A single project too long for a whole reply is cut rather than dropped,
  // or the list could never be read past it.
  if (!kept.length) kept.push(`${blocks[0].slice(0, budget - 1)}…`);
  const next = offset + kept.length;
  if (next < total) kept.push(moreLine(total - next, next, data));
  return kept.join('\n');
}

export function formatProjectDetail(data) {
  const p = data?.project;
  const lines = [projectLine(p)];
  // R7: GET /projects/<merged> answers 200 with the TARGET's own detail plus
  // merged_from — without this, project_get on a merged number silently
  // renders the target with no word that the requested number was folded in.
  if (data?.merged_from && typeof data.merged_from === 'object') {
    lines.push(`(#${data.merged_from.num ?? '?'} was merged into this project)`);
  }
  const body = str(p?.body).trim();
  if (body) lines.push(body);
  const status = statusLine(p);
  if (status) lines.push(status);
  if (p?.state === 'closed' && str(p.close_summary).trim()) lines.push(`Closed: ${p.close_summary.trim()}`);
  lines.push('');
  const missions = Array.isArray(data?.missions) ? data.missions : [];
  lines.push('Missions:');
  if (!missions.length) lines.push('- (none)');
  for (const m of missions) {
    lines.push(`- ${missionLine(m)}`);
    const s = statusLine(m);
    if (s) lines.push(`    ${s}`);
  }
  const needs = Array.isArray(data?.needs_you) ? data.needs_you : [];
  lines.push('Needs you:');
  if (!needs.length) lines.push('- (none)');
  for (const i of needs) lines.push(`- #${i?.num ?? '?'} ${str(i?.title)}${i?.mission_num ? ` (mission #${i.mission_num})` : ''}`);
  const recent = Array.isArray(data?.recent_milestones) ? data.recent_milestones : [];
  lines.push('Recent milestones:');
  if (!recent.length) lines.push('- (none)');
  for (const l of recent) lines.push(`- #${l?.num ?? '?'} [${str(l?.kind) || 'progress'}] ${str(l?.title)} — ${isoTime(l?.created_at)}${l?.mission_num ? ` (mission #${l.mission_num})` : ''}`);
  const boxes = data?.sessions_by_box && typeof data.sessions_by_box === 'object' ? Object.entries(data.sessions_by_box) : [];
  lines.push(`Sessions by box: ${boxes.length ? boxes.map(([box, count]) => `${box} ${n(count)}`).join(', ') : '(none)'}`);
  return lines.join('\n');
}

export function formatProjectCreateAck(data) {
  const p = data?.project;
  if (!p) return 'Project created.';
  const id = str(p.id) ? ` (id ${p.id})` : '';
  const num = p.num ?? '?';
  return `Created project #${num} "${str(p.title)}"${id} — file missions into it with mission_update project: ${num}, or mission_start / mission_create with project: ${num}`;
}

export function formatProjectStatusAck(data) {
  const p = data?.project;
  if (!p) return 'Status set.';
  return `Status set on project #${p.num ?? '?'} "${str(p.title)}"`;
}

// R8: POST /projects/:id/merge's 200 body is {project: <into, kept, with
// rollup>, merged: <this, now closed>} — data.project is the KEPT project,
// not the one folded away, so its title belongs on `into`, not on `from`.
export function formatProjectMergeAck(data, args) {
  const from = args?.num ?? data?.merged?.num ?? '?';
  const into = args?.into ?? data?.project?.num ?? '?';
  const fromTitle = str(data?.merged?.title) ? ` "${data.merged.title}"` : '';
  const intoTitle = str(data?.project?.title) ? ` "${data.project.title}"` : '';
  return `Merged project #${from}${fromTitle} into #${into}${intoTitle} — its missions are in #${into} now, and #${from} points there`;
}

const missionList = (ms) => (Array.isArray(ms) && ms.length ? `: ${ms.map((m) => `#${m?.num ?? '?'} ${str(m?.title)}`).join(', ')}` : '');

export function formatProjectBlocked(data) {
  switch (data?.blocked_by ?? data?.error) {
    case 'open_missions': return `the project still has open missions${missionList(data.missions)} — only the user can close a project with open missions; ask them (a question item) before closing it`;
    case 'closed': return 'project is closed — it takes no changes (project_get shows where a merged project went)';
    // R9: the merge route's own 409 for a closed `into`, distinct from the
    // `id`-is-closed case above.
    case 'into_closed': return 'the project to merge into is closed — pick an open one from project_list (project_get N shows where a merged project went)';
    default: return str(data?.error) || 'conflict';
  }
}

// The journal's machine words, as sentences that name the next move.
// Anything else (including the bridge's own sentences) passes through.
export function formatProjectJournalError(op, data) {
  switch (str(data?.error)) {
    case 'not_found':
      return op === 'merge'
        ? "no project with one of those numbers, or it isn't visible to this session — project_list shows them"
        : "no project with that number, or it isn't visible to this session";
    case 'bad_request':
      if (op === 'status') return 'the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs';
      // R9: a closed `into` is its own 409 (into_closed, see formatProjectBlocked);
      // this 400 is only a type error or `into` equal to `id`.
      if (op === 'merge') return 'the journal rejected the merge — `into` must be a different project from num';
      return 'the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB)';
    case 'forbidden': return 'the journal refused it — this session may not change that project';
    default: return str(data?.error);
  }
}
