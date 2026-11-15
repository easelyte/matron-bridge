import { describe, it, expect } from 'vitest';
import { rosterLine } from '../lib/roster-format.js';

const NOW = 1700000120000;
describe('rosterLine', () => {
  it('renders the status block after the state when present', () => {
    expect(rosterLine({ id: 'c1', title: 'Work', session_state: 'waiting', agent_device_id: 7, summary: 'porting',
      status: { model: 'claude-opus-5-5', context: { tokens: 87000, window: 1000000, pct: 9 }, reported_at: NOW - 120000 } }, 1, NOW))
      .toBe('- c1 — "Work" [waiting · opus-5-5 · 87k/1m 9% · reported 2 min ago] (agent 7): porting');
  });
  it('keeps the old shape without a status, and marks this bridge / no agent', () => {
    expect(rosterLine({ id: 'c2', title: '', session_state: 'running', agent_device_id: 1, summary: '' }, 1, NOW)).toBe('- c2 — "untitled" [running] (this bridge)');
    expect(rosterLine({ id: 'c3', title: 'X', agent_device_id: null, summary: 'y'.repeat(300) }, 1, NOW)).toMatch(/^- c3 — "X" \[unknown\] \(no agent\): y{200}$/);
    expect(rosterLine({ id: 'c4', title: 'X', session_state: 'waiting', agent_device_id: 7, status: {} }, null, NOW)).toBe('- c4 — "X" [waiting] (agent 7)');
  });
  it('names the current mission when the journal sends mission_num, and ignores anything that is not a mission number', () => {
    expect(rosterLine({ id: 'c5', title: '[mv] Bridge titles', session_state: 'waiting', agent_device_id: 7, summary: 'porting', mission_num: 61 }, 1, NOW))
      .toBe('- c5 — "[mv] Bridge titles" [waiting] (agent 7) · mission #61: porting');
    for (const mission_num of [null, 0, '61', 1.5]) {
      expect(rosterLine({ id: 'c6', title: 'X', session_state: 'waiting', agent_device_id: 7, mission_num }, 1, NOW)).toBe('- c6 — "X" [waiting] (agent 7)');
    }
  });
  it('shows the user\'s pin label before the title of a pinned conversation', () => {
    expect(rosterLine({ id: 'c5', title: '[aa] Yes, I accept', session_state: 'waiting', agent_device_id: 7, pin: { label: 'Docs chat', emoji: '📚' } }, 1, NOW))
      .toBe('- c5 — 📌 📚 Docs chat · "[aa] Yes, I accept" [waiting] (agent 7)');
    expect(rosterLine({ id: 'c6', title: 'X', session_state: 'waiting', agent_device_id: 7, pin: { label: 'Release\nnotes', emoji: '' } }, 1, NOW))
      .toBe('- c6 — 📌 Release notes · "X" [waiting] (agent 7)');
    expect(rosterLine({ id: 'c7', title: 'X', session_state: 'waiting', agent_device_id: 7, pin: { label: '' } }, 1, NOW))
      .toBe('- c7 — "X" [waiting] (agent 7)');
  });
});
