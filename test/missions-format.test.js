import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { missionLine, formatStartAck, formatMilestoneAck, formatMissionDetail, formatBlocked, formatJournalError } from '../lib/missions-format.js';

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
    expect(formatStartAck({ mission, existing: true })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1)');
  });
  it('milestone ack names both numbers', () => {
    expect(formatMilestoneAck({ milestone: { num: 63, kind: 'progress', title: 'Landed PR' }, mission })).toBe('Milestone #63 posted to mission #61 "Missions"');
  });
  it('detail lists milestones newest first, open items, conversations', () => {
    const out = formatMissionDetail({
      mission,
      milestones: [{ num: 63, kind: 'progress', title: 'Landed', created_at: 1700000000000, convo_id: 'c1' }],
      items: [{ num: 64, title: 'Q?', awaiting: 'user' }, { num: 65, title: 'T', awaiting: 'agent' }],
      conversations: [{ id: 'c1', title: 'Session', box: 'dev-2', state: 'running' }],
    });
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
    ]);
  });
  it('blocked renders every 409 reason as an instruction', () => {
    expect(formatBlocked({ error: 'conflict', blocked_by: 'no_mission' })).toMatch(/call mission_start\(title, body\) first/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toMatch(/closed/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] })).toBe('blocked by items awaiting the user: #64 Q? — only the user can clear those');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'agent_items', items: [{ num: 71, title: 'T' }] })).toBe('blocked by open items: #71 T — close each with a real resolution (item_close), or item_move it to the mission it belongs to');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).toMatch(/another mission/);
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
});

describe('missions-format against real journal response bodies', () => {
  it('renders POST /missions 201 and its 200 existing replay', () => {
    expect(formatStartAck(shapes.start_201)).toBe('Started mission #1 "Missions & milestones" (id ms_7Kq2XwvN)');
    expect(formatStartAck(shapes.start_200_existing)).toBe('Already in mission #1 "Missions & milestones" — nothing changed (id ms_7Kq2XwvN)');
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
});
