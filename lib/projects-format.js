// Compact renderings of the journal's project JSON for the project_* tools
// (spec 2026-09-30 projects §4.2, §5). Pure and defensive, like
// lib/missions-format.js: a journal a version ahead degrades to a duller
// line, never a throw. One line per fact, never raw JSON.
import { missionLine, statusLine } from './missions-format.js';

const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };
const ACTIVITY = ['running', 'waiting', 'idle', 'quiet'];

// GET /projects rows carry missions:{running, waiting, idle, quiet, closed}.
function missionsSummary(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const open = ACTIVITY.reduce((sum, k) => sum + n(ms[k]), 0);
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

export function formatProjectList(data) {
  const ps = Array.isArray(data?.projects) ? data.projects : [];
  if (!ps.length) return 'No projects.';
  const lines = [];
  for (const p of ps) {
    lines.push(projectLine(p));
    lines.push(`  ${statusLine(p) || 'Status: (none yet)'}`);
  }
  return lines.join('\n');
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
    case 'open_missions': return `the project still has open missions${missionList(data.missions)} — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission`;
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
