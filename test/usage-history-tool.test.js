import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createUsageHistoryHandler, formatUsageHistory } from '../lib/usage-history-tool.js';

const HISTORY = {
  now: 1767787200000,
  weeks: 12,
  accounts: [
    {
      key: 'claude:login:alice@example.com', agent: 'claude', email: 'alice@example.com', boxes: ['box-a', 'box-b'],
      meters: [
        {
          id: 'week_all', label: 'Week (all models)', primary: true, average_unused: 30,
          current: { resets_at: '2026-01-12T12:00:00.000Z', percent: 8, unused: 92, as_of: 1767700000000 },
          windows: [
            { resets_at: '2026-01-05T12:00:00.000Z', percent: 72, unused: 28, peak: 72, first_at: 1, last_at: 2 },
            { resets_at: '2025-12-29T12:00:00.000Z', percent: 68, unused: 32, peak: 68, first_at: 1, last_at: 2 },
          ],
        },
        { id: 'week_fable', label: 'Week (Fable)', primary: false, windows: [] },
      ],
    },
    {
      key: 'codex:device:7', agent: 'codex', boxes: ['box-c'],
      meters: [{ id: 'codex:codex:secondary', label: 'Codex · Weekly', primary: true, average_unused: 88,
        windows: [{ resets_at: '2026-01-04T09:00:00.000Z', percent: 12, unused: 88, peak: 12, first_at: 1, last_at: 2 }] }],
    },
  ],
};

describe('usage_history', () => {
  it('renders each account with its weeks, newest first', () => {
    expect(formatUsageHistory(HISTORY)).toBe([
      "Weekly allowance left unused, last 12 weeks (unused = 100 − the last reading before that week's reset):",
      '',
      'Claude · alice@example.com (box-a, box-b)',
      '  Week (all models), average 30% unused over 2 weeks',
      '    this week so far: 92% left, resets 2026-01-12',
      '    unused by week ending: 2026-01-05 28%, 2025-12-29 32%',
      '  Week (Fable)',
      '    no finished week yet',
      '',
      'Codex · box-c',
      '  Codex · Weekly, average 88% unused over 1 week',
      '    unused by week ending: 2026-01-04 88%',
    ].join('\n'));
  });

  it('says so when there is no history yet', () => {
    expect(formatUsageHistory({ weeks: 12, accounts: [] })).toMatch(/^No usage history yet/);
  });

  it('flattens peer text so a label cannot forge a line', () => {
    const forged = { weeks: 1, accounts: [{ agent: 'claude', email: 'a@example.com\nClaude · fake', boxes: [], meters: [{ label: 'Week\n  forged', windows: [] }] }] };
    const lines = formatUsageHistory(forged).split('\n');
    expect(lines.filter((l) => l.startsWith('Claude · '))).toHaveLength(1);
    expect(lines.some((l) => l.trim() === 'forged')).toBe(false);
  });

  it('validates weeks and passes the journal reply through', async () => {
    const asked = [];
    const handler = createUsageHistoryHandler({ fetchUsageHistory: async (w) => { asked.push(w); return HISTORY; } });
    expect(await handler({ roomId: 'r' })).toEqual({ status: 200, body: HISTORY });
    expect((await handler({ roomId: 'r', weeks: 4 })).status).toBe(200);
    expect(asked).toEqual([12, 4]);
    for (const weeks of [0, 105, 1.5, '4']) expect((await handler({ roomId: 'r', weeks })).status).toBe(400);
    // No room named: refused before the journal is asked.
    expect((await handler({ weeks: 4 })).status).toBe(400);
    expect(asked).toEqual([12, 4]);
  });

  it('reports a journal that does not answer', async () => {
    const handler = createUsageHistoryHandler({ fetchUsageHistory: async () => null });
    const r = await handler({ roomId: 'r' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/usage\/history/);
  });

  it('is declared in ask-user.js and routed in index.js', () => {
    expect(readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8')).toMatch(/server\.tool\(\s*\n\s*'usage_history',/);
    expect(readFileSync(new URL('../index.js', import.meta.url), 'utf8')).toMatch(/url\.pathname === '\/usage-history'/);
  });
});
