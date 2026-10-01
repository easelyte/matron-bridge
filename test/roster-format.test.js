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
});
