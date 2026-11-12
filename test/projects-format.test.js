import { describe, it, expect } from 'vitest';
import { projectLine, formatProjectList, formatProjectDetail, formatProjectCreateAck, formatProjectStatusAck, formatProjectMergeAck, formatProjectBlocked, formatProjectJournalError } from '../lib/projects-format.js';

// Spec 2026-09-30 §4.2 shapes. Replace with real journal bodies (a
// fixtures/projects-journal-shapes.json like the missions one) once the
// journal half has shipped.
const row = {
  id: 'pj_1', num: 70, title: 'Promo launch', state: 'open',
  status: 'Launch day set for 6 Oct; SEO phase 2 waiting on copy.', status_by: 'agent', status_updated_at: 1700000000000,
  missions: { running: 1, waiting: 2, idle: 0, quiet: 1, closed: 3 }, needs_you: 2, open_items: 5, last_activity_at: 1700000000000,
};

describe('projects-format', () => {
  it('projectLine: number, title, state, mission activity, items, last activity, id', () => {
    expect(projectLine(row)).toBe('#70 Promo launch — open, 4 open missions (1 running, 2 waiting, 1 quiet), 3 closed, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_1)');
    expect(projectLine({ id: 'pj_2', num: 71, title: 'Old', state: 'closed', merged_into: 'pj_1', merged_into_num: 70 })).toBe('#71 Old — closed (merged into #70) (id pj_2)');
    expect(projectLine({ num: 72, title: 'Bare', state: 'closed', merged_into: 'pj_1' })).toBe('#72 Bare — closed (merged into pj_1)');
    expect(projectLine({ num: 73, title: 'Empty', missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 }, open_items: 0, needs_you: 0 })).toBe('#73 Empty — open, 0 open missions, 0 open items');
    expect(projectLine(null)).toBe('(unknown project)');
  });

  it('list: one block per project with its status or none; empty list', () => {
    const out = formatProjectList({ projects: [row, { ...row, id: 'pj_3', num: 74, title: 'Site', status: null, missions: undefined }] });
    expect(out.split('\n')).toEqual([
      '#70 Promo launch — open, 4 open missions (1 running, 2 waiting, 1 quiet), 3 closed, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_1)',
      '  Status (2023-11-14T22:13:20.000Z, by an agent): Launch day set for 6 Oct; SEO phase 2 waiting on copy.',
      '#74 Site — open, 5 open items (2 need you), last activity 2023-11-14T22:13:20.000Z (id pj_3)',
      '  Status: (none yet)',
    ]);
    expect(formatProjectList({ projects: [] })).toBe('No projects.');
    expect(formatProjectList({})).toBe('No projects.');
  });

  // What the list handler sends for a long list: one page of rows, with the
  // count after filtering and where the page starts.
  const many = (count, status = 'On track.') => Array.from({ length: count }, (_, i) => ({ ...row, id: `pj_${i + 1}`, num: i + 1, title: `Project ${i + 1}`, status }));
  const page = (rows, offset, limit, extra = {}) => ({ projects: rows.slice(offset, offset + limit), total: rows.length, offset, ...extra });
  const shown = (out) => out.split('\n').filter((l) => /^#\d+ /.test(l)).map((l) => Number(l.match(/^#(\d+) /)[1]));

  it('list: a page that is not the end closes with how many remain and the offset to pass', () => {
    const rows = many(400);
    const out = formatProjectList(page(rows, 0, 60));
    expect(shown(out)).toEqual(rows.slice(0, 60).map((p) => p.num));
    expect(out.split('\n').at(-1)).toBe('340 more: call project_list again with offset: 60');
    const last = formatProjectList(page(rows, 360, 60));
    expect(shown(last)).toEqual(rows.slice(360).map((p) => p.num));
    expect(last).not.toMatch(/more: call project_list/);
  });

  it('list: output never exceeds 40,000 characters; it is cut between projects and the offset follows the cut', () => {
    const rows = many(400, 'x'.repeat(600));
    const seen = [];
    let offset = 0;
    for (let calls = 0; offset < rows.length; calls += 1) {
      expect(calls, 'paging did not finish').toBeLessThan(400);
      const out = formatProjectList(page(rows, offset, 60));
      expect(out.length).toBeLessThanOrEqual(40000);
      const nums = shown(out);
      expect(nums.length).toBeGreaterThan(0);
      expect(nums.length).toBeLessThan(60);
      // Every project shown is whole: its line and its status line.
      expect(out.split('\n').filter((l) => l.startsWith('  Status')).length).toBe(nums.length);
      seen.push(...nums);
      offset += nums.length;
      const tail = out.split('\n').at(-1);
      if (offset < rows.length) expect(tail).toBe(`${rows.length - offset} more: call project_list again with offset: ${offset}`);
      else expect(tail).not.toMatch(/more: call project_list/);
    }
    expect(seen).toEqual(rows.map((p) => p.num));
  });

  it('list: one oversized project is cut to fit rather than sent whole or dropped', () => {
    const out = formatProjectList(page(many(3, 'x'.repeat(50000)), 0, 60));
    expect(out.length).toBeLessThanOrEqual(40000);
    expect(shown(out)).toEqual([1]);
    expect(out.split('\n').at(-1)).toBe('2 more: call project_list again with offset: 1');
  });

  it('list brief: one line per project, no status line', () => {
    const rows = [
      row,
      { ...row, id: 'pj_2', num: 71, title: 'Site', missions: { running: 0, waiting: 1, idle: 0, quiet: 0, closed: 4 }, needs_you: 0 },
      { ...row, id: 'pj_3', num: 72, title: 'Shop', missions: { running: 1, waiting: 0, idle: 0, quiet: 0, closed: 0 }, needs_you: 1, mission: { num: 61, title: 'Checkout "v2"' } },
      { ...row, id: 'pj_4', num: 73, title: 'Old', state: 'closed', missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 2 }, needs_you: 0, last_activity_at: undefined },
      { ...row, id: 'pj_5', num: 74, title: 'Pair', mission: { num: 62, title: 'Not the only one' } },
      { num: 75, title: 'Bare' },
    ];
    expect(formatProjectList(page(rows, 0, 150, { brief: true })).split('\n')).toEqual([
      '#70 Promo launch — 4 open missions, 3 closed, 2 need you, last activity 2023-11-14',
      '#71 Site — 1 open mission, 4 closed, last activity 2023-11-14',
      '#72 Shop — 1 open mission, mission #61 "Checkout "v2"", 1 need you, last activity 2023-11-14',
      '#73 Old — closed, 0 open missions, 2 closed',
      '#74 Pair — 4 open missions, 3 closed, 2 need you, last activity 2023-11-14',
      '#75 Bare',
    ]);
    const long = formatProjectList(page(many(400), 0, 150, { brief: true }));
    expect(long).not.toMatch(/Status/);
    expect(long.split('\n')).toHaveLength(151);
    expect(long.split('\n').at(-1)).toBe('250 more: call project_list again with brief: true, offset: 150');
  });

  it('list brief: a project whose one open mission is not its only mission says how many are closed', () => {
    const one = { ...row, id: 'pj_6', num: 76, title: 'Goal', missions: { running: 1, waiting: 0, idle: 0, quiet: 0, closed: 5 }, needs_you: 0, mission: { num: 63, title: 'Last step' } };
    expect(formatProjectList(page([one], 0, 150, { brief: true }))).toBe('#76 Goal — 1 open mission, 5 closed, mission #63 "Last step", last activity 2023-11-14');
    expect(formatProjectList(page([{ ...one, missions: { ...one.missions, closed: 0 } }], 0, 150, { brief: true }))).toBe('#76 Goal — 1 open mission, mission #63 "Last step", last activity 2023-11-14');
  });

  it('list: the closing line repeats the filters of the call, so it can be followed as written', () => {
    const rows = many(400);
    const tail = (limit, extra) => formatProjectList(page(rows, 0, limit, extra)).split('\n').at(-1);
    expect(tail(150, { live: true, brief: true })).toBe('250 more: call project_list again with live: true, brief: true, offset: 150');
    expect(tail(60, { live: true })).toBe('340 more: call project_list again with live: true, offset: 60');
    expect(tail(20, { state: 'closed', limit: 20 })).toBe('380 more: call project_list again with state: "closed", limit: 20, offset: 20');
    expect(tail(40, { live: true, brief: true, limit: 40 })).toBe('360 more: call project_list again with live: true, brief: true, limit: 40, offset: 40');
    // Nothing passed, nothing repeated: an open state and false flags are the defaults.
    expect(tail(60, { state: 'open', live: false, brief: false })).toBe('340 more: call project_list again with offset: 60');
    // The longest closing line still fits the reply.
    const long = formatProjectList(page(many(400, 'x'.repeat(600)), 0, 200, { state: 'closed', limit: 200 }));
    expect(long.length).toBeLessThanOrEqual(40000);
    expect(long.split('\n').at(-1)).toMatch(/^\d+ more: call project_list again with state: "closed", limit: 200, offset: \d+$/);
  });

  it('list: an offset past the end says so', () => {
    expect(formatProjectList({ projects: [], total: 12, offset: 60 })).toBe('No projects from offset 60 (12 in all).');
    expect(formatProjectList({ projects: [], total: 0, offset: 0 })).toBe('No projects.');
  });

  it('detail: project, body, status, missions with status, needs you, recent milestones, sessions by box', () => {
    const out = formatProjectDetail({
      project: { id: 'pj_1', num: 70, title: 'Promo launch', state: 'open', body: 'Everything for the 6 Oct launch', status: 'On track.', status_by: 'user', status_updated_at: 1700000000000 },
      missions: [{ id: 'ms_1', num: 47, title: 'Launch day', state: 'open', activity: 'running', project_id: 'pj_1', project_num: 70, open_items: 1, needs_you: 1, conversations: 2, milestones: 4, status: 'Copy final.', status_by: 'agent', status_updated_at: 1700000000000 }],
      needs_you: [{ num: 5000, title: 'Approve the hero shot?', mission_num: 47 }],
      recent_milestones: [{ num: 5001, kind: 'progress', title: 'Blog post drafted', created_at: 1700000000000, mission_num: 45 }],
      sessions_by_box: { 'alice-mac': 3, 'box-2': 1 },
    });
    expect(out.split('\n')).toEqual([
      '#70 Promo launch — open (id pj_1)',
      'Everything for the 6 Oct launch',
      'Status (2023-11-14T22:13:20.000Z, by the user): On track.',
      '',
      'Missions:',
      '- #47 Launch day — open, running, project #70, 1 open item (1 need you), 2 conversations, 4 milestones (id ms_1)',
      '    Status (2023-11-14T22:13:20.000Z, by an agent): Copy final.',
      'Needs you:',
      '- #5000 Approve the hero shot? (mission #47)',
      'Recent milestones:',
      '- #5001 [progress] Blog post drafted — 2023-11-14T22:13:20.000Z (mission #45)',
      'Sessions by box: alice-mac 3, box-2 1',
    ]);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('[object Object]');
  });

  it('detail with nothing in it, and a closed project with its summary', () => {
    const out = formatProjectDetail({ project: { num: 71, title: 'Old', state: 'closed', close_summary: 'Merged into #70' } });
    expect(out.split('\n')).toEqual([
      '#71 Old — closed', 'Closed: Merged into #70', '',
      'Missions:', '- (none)', 'Needs you:', '- (none)', 'Recent milestones:', '- (none)', 'Sessions by box: (none)',
    ]);
  });

  // R7: GET /projects/<merged> answers 200 with the target's own detail plus
  // merged_from — say so, or project_get on a merged number silently shows
  // the wrong project with no hint it was merged.
  it('detail: merged_from names the project that was folded into this one', () => {
    const out = formatProjectDetail({ project: { num: 70, title: 'Promo launch', state: 'open' }, merged_from: { id: 'pj_2', num: 71 } });
    expect(out.split('\n').slice(0, 2)).toEqual(['#70 Promo launch — open', '(#71 was merged into this project)']);
  });

  it('acks', () => {
    expect(formatProjectCreateAck({ project: { id: 'pj_1', num: 70, title: 'Promo launch' } })).toBe('Created project #70 "Promo launch" (id pj_1) — file missions into it with mission_update project: 70, or mission_start / mission_create with project: 70');
    expect(formatProjectCreateAck({})).toBe('Project created.');
    expect(formatProjectStatusAck({ project: { num: 70, title: 'Promo launch' } })).toBe('Status set on project #70 "Promo launch"');
    // R8: the journal's merge 200 body is {project: <into, kept>, merged: <this, now closed>}.
    // data.project is the KEPT project, not the one folded away.
    expect(formatProjectMergeAck({ project: { num: 70, title: 'Promo launch' }, merged: { num: 71, title: 'Promo' } }, { num: 71, into: 70 })).toBe('Merged project #71 "Promo" into #70 "Promo launch" — its missions are in #70 now, and #71 points there');
    expect(formatProjectMergeAck({}, { num: 71, into: 70 })).toBe('Merged project #71 into #70 — its missions are in #70 now, and #71 points there');
  });

  it('blocked: open_missions lists them when sent; closed; into_closed; anything else passes through', () => {
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'open_missions', missions: [{ num: 47, title: 'Launch day' }] })).toBe('the project still has open missions: #47 Launch day — only the user can close a project with open missions; ask them (a question item) before closing it');
    expect(formatProjectBlocked({ error: 'open_missions' })).toBe('the project still has open missions — only the user can close a project with open missions; ask them (a question item) before closing it');
    expect(formatProjectBlocked({ error: 'open_missions' })).not.toMatch(/moving/);
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'closed' })).toBe('project is closed — it takes no changes (project_get shows where a merged project went)');
    // R9: the journal's merge route has a distinct 409 for a closed `into`.
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'into_closed' })).toMatch(/^the project to merge into is closed/);
    expect(formatProjectBlocked({ error: 'weird' })).toBe('weird');
    expect(formatProjectBlocked(null)).toBe('conflict');
  });

  it('journal errors become sentences; merge not_found names both numbers', () => {
    expect(formatProjectJournalError('get', { error: 'not_found' })).toBe("no project with that number, or it isn't visible to this session");
    expect(formatProjectJournalError('merge', { error: 'not_found' })).toBe("no project with one of those numbers, or it isn't visible to this session — project_list shows them");
    expect(formatProjectJournalError('status', { error: 'bad_request' })).toBe('the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs');
    // R9: `into` rejects on type/self, not on being closed (that is into_closed above).
    expect(formatProjectJournalError('merge', { error: 'bad_request' })).toBe('the journal rejected the merge — `into` must be a different project from num');
    expect(formatProjectJournalError('update', { error: 'bad_request' })).toBe('the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB)');
    expect(formatProjectJournalError('update', { error: 'forbidden' })).toBe('the journal refused it — this session may not change that project');
    expect(formatProjectJournalError('list', { error: 'this journal deployment does not have the /projects routes yet — deploy the journal update (matron-journal projects plan)' })).toMatch(/^this journal deployment/);
    expect(formatProjectJournalError('get', null)).toBe('');
  });
});
