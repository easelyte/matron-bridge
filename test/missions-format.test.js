import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { missionLine, formatStartAck, formatCreateAck, formatMilestoneAck, formatMissionDetail, formatBlocked, formatJournalError, formatStatusAck, formatMissionList, formatJoinAck, formatLeaveAck, formatUpdateAck, statusLine } from '../lib/missions-format.js';

// Real journal response bodies (see the file's _source): these renderers are
// the only place the bridge reads the mission JSON, so the contract is
// pinned against the shapes the journal actually returns, not against
// hand-written objects that agree with the renderer by construction.
const shapes = JSON.parse(readFileSync(new URL('./fixtures/missions-journal-shapes.json', import.meta.url), 'utf8'));

const mission = { id: 'ms_1', num: 61, title: 'Missions', state: 'open', body: 'Ship it', open_items: 2, needs_you: 1, conversations: 3, milestones: 5 };

describe('missions-format', () => {
  it('missionLine carries number, title, state and counts', () => {
    expect(missionLine(mission)).toBe('#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, state: 'closed', open_items: 0, needs_you: 0, closed_by: 'agent' })).toBe('#61 Missions — closed by agent, 0 open items, 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine(null)).toBe('(unknown mission)');
  });
  it('start ack distinguishes new from existing', () => {
    expect(formatStartAck({ mission })).toBe('Started mission #61 "Missions" (id ms_1)');
    expect(formatStartAck({ mission, existing: true })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1). For different work, mission_create it and mission_join the new number');
  });
  it('create ack uses the contract wording', () => {
    expect(formatCreateAck({ mission })).toBe('Mission #61 "Missions" created (unassigned)');
    expect(formatCreateAck({})).toBe('Mission created (unassigned).');
  });
  it('milestone ack names both numbers', () => {
    expect(formatMilestoneAck({ milestone: { num: 63, kind: 'progress', title: 'Landed PR' }, mission })).toBe('Milestone #63 posted to mission #61 "Missions"');
  });
  it('detail lists milestones newest first, open items, conversations', () => {
    const out = formatMissionDetail({
      mission,
      milestones: [{ num: 63, kind: 'progress', title: 'Landed', created_at: 1700000000000, convo_id: 'c1' }],
      items: [{ num: 64, title: 'Q?', awaiting: 'user' }, { num: 65, title: 'T', awaiting: 'agent' }],
      conversations: [
        { id: 'c1', title: 'Session', box: 'dev-2', state: 'running' },
        { id: 'c2', title: 'Full', box: 'ang', state: 'waiting', status: { model: 'claude-opus-5-5', context: { tokens: 870000, window: 1000000, pct: 87 }, reported_at: 1700000000000 } },
      ],
    }, { now: 1700000120000 });
    expect(out.split('\n')).toEqual([
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      'Ship it', '',
      'Milestones (newest first):',
      '- #63 [progress] Landed — 2023-11-14T22:13:20.000Z in c1',
      'Open items:',
      '- #64 Q? — awaiting user',
      '- #65 T — awaiting agent',
      'Conversations:',
      '- c1 Session (dev-2, running)',
      '- c2 Full (ang, waiting · opus-5-5 · 870k/1m 87% · reported 2 min ago)',
    ]);
  });
  it('blocked renders every 409 reason as an instruction', () => {
    expect(formatBlocked({ error: 'conflict', blocked_by: 'no_mission' })).toMatch(/call mission_start\(title, body\) first/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toMatch(/closed/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] })).toBe('blocked by items awaiting the user: #64 Q? — only the user can clear those');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'agent_items', items: [{ num: 71, title: 'T' }] })).toBe('blocked by open items: #71 T — close each with a real resolution (item_close), or item_move it to the mission it belongs to');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).toBe('this journal still allows only one mission per conversation — deploy the journal update (mission history); nothing changed');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).not.toMatch(/already belongs/);
    expect(formatBlocked({ error: 'weird' })).toBe('weird');
  });

  it('renders the journal error codes a model can hit as sentences, and passes anything else through', () => {
    expect(formatJournalError('get', shapes.error_404_not_found)).toBe("no mission with that number, or it isn't visible to this session");
    expect(formatJournalError('join', shapes.error_400_bad_request)).toBe('the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB; a mission already holding 200 conversations refuses joins)');
    // The bridge's own sentences and any future journal error survive intact.
    expect(formatJournalError('update', { error: 'this conversation has no mission yet — call mission_start(title, body) first' })).toBe('this conversation has no mission yet — call mission_start(title, body) first');
    expect(formatJournalError('get', {})).toBe('');
    expect(formatJournalError('get', null)).toBe('');
  });

  it('missionLine shows activity and project only when the journal sends them', () => {
    expect(missionLine({ ...mission, activity: 'quiet', project_id: 'pj_7', project_num: 70 })).toBe('#61 Missions — open, quiet, project #70, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, project_id: null })).toBe('#61 Missions — open, no project, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, project_id: 'pj_7' })).toBe('#61 Missions — open, project pj_7, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    // A closed mission's activity is noise.
    expect(missionLine({ ...mission, state: 'closed', activity: 'quiet' })).toBe('#61 Missions — closed, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
  });

  it('start/create acks say where the mission was filed, or that the journal could not file it', () => {
    expect(formatStartAck({ mission, project_requested: 7 })).toBe('Started mission #61 "Missions" (id ms_1) in project #7');
    expect(formatStartAck({ mission, project_requested: 7, project_ignored: true })).toBe('Started mission #61 "Missions" (id ms_1) — but this journal does not support projects yet, so it was not filed (deploy the journal projects update)');
    expect(formatStartAck({ mission, existing: true, project_requested: 7 })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1). For different work, mission_create it and mission_join the new number; to file this one, mission_update with project: 7');
    expect(formatCreateAck({ mission, project_requested: 7 })).toBe('Mission #61 "Missions" created (unassigned) in project #7');
    expect(formatCreateAck({ mission, project_requested: 7, project_ignored: true })).toBe('Mission #61 "Missions" created (unassigned) — but this journal does not support projects yet, so it was not filed (deploy the journal projects update)');
    // R5 (2026-09-30 preflight): an idempotent replay never re-applies
    // `project` — the mission comes back unfiled (or filed elsewhere), which
    // is not the same as the journal rejecting projects outright.
    expect(formatCreateAck({ mission, project_requested: 7, project_not_applied: true })).toBe('Mission #61 "Missions" created (unassigned) — not filed in #7: the journal returned an identical mission created moments ago; mission_update with mission: 61 and project: 7 files it');
  });

  it('join, leave and update acks', () => {
    expect(formatJoinAck({ mission })).toBe("Joined mission #61 \"Missions\" (id ms_1) — it is now this conversation's current mission: milestones and new items go there by default. Missions it was already on stay linked; mission_leave N ends one");
    expect(formatJoinAck({})).toBe("Joined — it is now this conversation's current mission");
    expect(formatLeaveAck({ left: 61, current: { num: 3, title: 'Other' } })).toBe('Left mission #61 — the current mission is now #3 "Other"');
    expect(formatLeaveAck({ left: 61, current: null })).toBe('Left mission #61 — this conversation has no current mission now; mission_join one before posting milestones');
    expect(formatLeaveAck({ left: 61 })).toBe('Left mission #61');
    expect(formatUpdateAck({ mission })).toBe(missionLine(mission));
    expect(formatUpdateAck({ mission, project_ignored: true })).toBe(`${missionLine(mission)} — but this journal does not support projects yet, so the project was not changed (deploy the journal projects update)`);
  });

  it('detail: link history on conversations, and this conversation\'s missions when attached', () => {
    const out = formatMissionDetail({
      mission, milestones: [], items: [],
      conversations: [
        { id: 'c1', title: 'Now', box: 'dev-2', state: 'running', current: true, subchat_count: 2 },
        { id: 'c2', title: 'Before', box: 'ang', state: 'idle', current: false, ended_at: 1700000000000, subchat_count: 1 },
      ],
      conversation_missions: [
        { num: 61, title: 'Missions', state: 'open', current: true, active: true },
        { num: 3, title: 'Other', state: 'open', current: false, active: true },
        { num: 2, title: 'Old', state: 'open', current: false, active: false, ended_at: 1700000000000 },
        { num: 1, title: 'Done', state: 'closed', current: false, active: true },
      ],
    });
    expect(out.split('\n').slice(-8)).toEqual([
      'Conversations:',
      '- c1 Now (dev-2, running · 2 sub-chats)',
      '- c2 Before (ang, idle · left 2023-11-14T22:13:20.000Z · 1 sub-chat)',
      "This conversation's missions:",
      '- #61 Missions — current',
      '- #3 Other — also on',
      '- #2 Old — earlier (left 2023-11-14T22:13:20.000Z)',
      '- #1 Done — earlier (closed)',
    ]);
  });

  it('blocked: not_linked is an instruction; either field carries the code', () => {
    const text = 'this conversation is not on that mission — mission_join it first (it becomes the current mission), or leave out `mission` to post to the current one';
    expect(formatBlocked({ error: 'conflict', blocked_by: 'not_linked' })).toBe(text);
    expect(formatBlocked({ error: 'not_linked' })).toBe(text);
    // R4 (2026-09-30 preflight): a closed or merged project on start/create/update.
    expect(formatBlocked({ error: 'conflict', blocked_by: 'project_closed' })).toMatch(/^that project is closed/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'project_required' })).toMatch(/^every mission is in a project/);
  });

  it('statusLine is exported for the project renderers', () => {
    expect(statusLine({ status: ' x ', status_by: 'agent', status_updated_at: 1700000000000 })).toBe('Status (2023-11-14T22:13:20.000Z, by an agent): x');
    expect(statusLine({})).toBeNull();
  });
});

describe('missions-format against real journal response bodies', () => {
  it('renders POST /missions 201 and its 200 existing replay', () => {
    expect(formatStartAck(shapes.start_201)).toBe('Started mission #1 "Missions & milestones" (id ms_7Kq2XwvN)');
    expect(formatStartAck(shapes.start_200_existing)).toBe('Already in mission #1 "Missions & milestones" — nothing changed (id ms_7Kq2XwvN). For different work, mission_create it and mission_join the new number');
    expect(missionLine(shapes.start_201.mission)).toBe('#1 Missions & milestones — open, 0 open items, 1 conversation, 0 milestones (id ms_7Kq2XwvN)');
  });

  it('renders POST /milestones 201', () => {
    expect(formatMilestoneAck(shapes.milestone_201)).toBe('Milestone #2 posted to mission #1 "Missions & milestones"');
  });

  it('renders GET /missions rows, closed one included, with needs_you and the last_milestone object', () => {
    const [open, closed] = shapes.list_200.missions;
    expect(missionLine(open)).toBe('#1 Missions & milestones — open, 2 open items (1 need you), 2 conversations, 2 milestones (id ms_7Kq2XwvN)');
    expect(missionLine(closed)).toBe('#6 Items tracker — closed by agent, 0 open items, 1 conversation, 4 milestones (id ms_0Fh4Ly)');
    // last_milestone is a nested object on every row; no renderer may leak it
    // as [object Object], and its shape is part of the contract.
    expect(Object.keys(open.last_milestone).sort()).toEqual(['created_at', 'kind', 'num', 'title']);
    expect(missionLine(open)).not.toContain('[object Object]');
  });

  it('renders GET /missions/:id detail — milestones newest first, items[].awaiting, conversations[].box', () => {
    const out = formatMissionDetail(shapes.detail_200);
    expect(out.split('\n')).toEqual([
      '#1 Missions & milestones — open, 2 open items (1 need you), 2 conversations, 2 milestones (id ms_7Kq2XwvN)',
      'Ship it', '',
      'Milestones (newest first):',
      '- #5 [progress] Journal half deployed — 2026-09-10T16:20:00.000Z in c2',
      '- #2 [user_input] Dan asked for missions — 2026-09-10T16:10:00.000Z in c1',
      'Open items:',
      '- #3 Which bucket for idem keys? — awaiting user',
      '- #4 Deploy the bridge half — awaiting agent',
      'Conversations:',
      '- c1 Session (dev-2, running)',
      '- c2 Other (shared-2, idle)',
    ]);
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('undefined');
  });

  it('renders the real 409 bodies as instructions', () => {
    expect(formatBlocked(shapes.blocked_409_no_mission)).toMatch(/call mission_start\(title, body\) first/);
    expect(formatBlocked(shapes.blocked_409_user_items)).toBe('blocked by items awaiting the user: #3 Which bucket for idem keys? — only the user can clear those');
  });

  it('status ack names the mission', () => {
    expect(formatStatusAck({ mission })).toBe('Status set on mission #61 "Missions"');
    expect(formatStatusAck({})).toBe('Status set.');
  });

  it('detail shows the status with when and by whom, only when one is set', () => {
    const withStatus = { ...mission, status: 'PR #12 open; waiting on review.', status_by: 'agent', status_updated_at: 1700000000000 };
    expect(formatMissionDetail({ mission: withStatus, milestones: [], items: [], conversations: [] }).split('\n')).toEqual([
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      'Ship it',
      'Status (2023-11-14T22:13:20.000Z, by an agent): PR #12 open; waiting on review.',
      '',
      'Milestones (newest first):', '- (none yet)',
      'Open items:', '- (none)',
      'Conversations:', '- (none)',
    ]);
    expect(formatMissionDetail({ mission: { ...withStatus, status_by: 'user' } })).toContain('Status (2023-11-14T22:13:20.000Z, by the user): PR #12');
    expect(formatMissionDetail({ mission: { ...mission, status: null, status_by: null, status_updated_at: null } })).not.toContain('Status');
    expect(formatMissionDetail({ mission: { ...mission, status: '   ' } })).not.toContain('Status');
  });

  it('mission list: one block per mission — line, status or none, last milestone or none', () => {
    const [open, closed] = shapes.list_200.missions;
    const out = formatMissionList({ missions: [
      { ...open, status: 'Journal half deployed; bridge next.', status_by: 'agent', status_updated_at: 1789057300000 },
      closed,
      { ...mission, last_milestone: null },
    ] });
    expect(out.split('\n')).toEqual([
      '#1 Missions & milestones — open, 2 open items (1 need you), 2 conversations, 2 milestones (id ms_7Kq2XwvN)',
      '  Status (2026-09-10T16:21:40.000Z, by an agent): Journal half deployed; bridge next.',
      '  Last milestone: #5 [progress] Journal half deployed — 2026-09-10T16:20:00.000Z',
      '#6 Items tracker — closed by agent, 0 open items, 1 conversation, 4 milestones (id ms_0Fh4Ly)',
      '  Status: (none yet)',
      '  Last milestone: #12 [progress] All PRs merged — 2026-09-09T18:00:00.000Z',
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      '  Status: (none yet)',
      '  Last milestone: (none yet)',
    ]);
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('undefined');
    expect(formatMissionList({ missions: [] })).toBe('No missions.');
    expect(formatMissionList({})).toBe('No missions.');
  });

  it('status errors: bad_request names the limits AND an old journal; forbidden and closed are sentences', () => {
    expect(formatJournalError('status', shapes.error_400_bad_request)).toBe('the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs (a journal older than mission status rejects every status: deploy the journal update)');
    // Every other op keeps the existing sentence.
    expect(formatJournalError('update', shapes.error_400_bad_request)).toMatch(/^the journal rejected it — check the number and the limits/);
    expect(formatJournalError('status', { error: 'forbidden' })).toBe("that mission is shared with you by another user — only its owner's sessions can change it");
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toBe('mission is closed — no more milestones, joins or status changes');
  });
});
