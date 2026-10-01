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

  it('detail: project, body, status, missions with status, needs you, recent milestones, sessions by box', () => {
    const out = formatProjectDetail({
      project: { id: 'pj_1', num: 70, title: 'Promo launch', state: 'open', body: 'Everything for the 6 Oct launch', status: 'On track.', status_by: 'user', status_updated_at: 1700000000000 },
      missions: [{ id: 'ms_1', num: 4907, title: 'Launch day', state: 'open', activity: 'running', project_id: 'pj_1', project_num: 70, open_items: 1, needs_you: 1, conversations: 2, milestones: 4, status: 'Copy final.', status_by: 'agent', status_updated_at: 1700000000000 }],
      needs_you: [{ num: 5000, title: 'Approve the hero shot?', mission_num: 4907 }],
      recent_milestones: [{ num: 5001, kind: 'progress', title: 'Blog post drafted', created_at: 1700000000000, mission_num: 4905 }],
      sessions_by_box: { 'dan-mac': 3, 'dev-2': 1 },
    });
    expect(out.split('\n')).toEqual([
      '#70 Promo launch — open (id pj_1)',
      'Everything for the 6 Oct launch',
      'Status (2023-11-14T22:13:20.000Z, by the user): On track.',
      '',
      'Missions:',
      '- #4907 Launch day — open, running, project #70, 1 open item (1 need you), 2 conversations, 4 milestones (id ms_1)',
      '    Status (2023-11-14T22:13:20.000Z, by an agent): Copy final.',
      'Needs you:',
      '- #5000 Approve the hero shot? (mission #4907)',
      'Recent milestones:',
      '- #5001 [progress] Blog post drafted — 2023-11-14T22:13:20.000Z (mission #4905)',
      'Sessions by box: dan-mac 3, dev-2 1',
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
    expect(formatProjectBlocked({ error: 'conflict', blocked_by: 'open_missions', missions: [{ num: 4907, title: 'Launch day' }] })).toBe('the project still has open missions: #4907 Launch day — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission');
    expect(formatProjectBlocked({ error: 'open_missions' })).toBe('the project still has open missions — only the user can close a project with open missions; ask them (a question item) before closing or moving any mission');
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
