import { describe, it, expect } from 'vitest';
import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, SUMMARY_WINDOW_CAP } from '../lib/summary-pass.js';

const msgs = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${start + i}` }));

describe('summaryWindow', () => {
  it('slices strictly after the last summarized message', () => {
    const h = msgs(12);
    const { messages, newCount, nextCount } = summaryWindow(h, 7);
    expect(messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(newCount).toBe(5);
    expect(nextCount).toBe(12);
  });
  it('caps at 200 keeping the NEWEST overflow, and still advances past dropped messages', () => {
    const h = msgs(450);
    const { messages, newCount, nextCount } = summaryWindow(h, 100);
    expect(messages).toHaveLength(SUMMARY_WINDOW_CAP);
    expect(messages[0].text).toBe('m250'); // oldest overflow (m100..m249) dropped
    expect(messages.at(-1).text).toBe('m449');
    expect(newCount).toBe(350);
    expect(nextCount).toBe(450); // cursor passes the dropped region — never re-summarized
  });
  it('tolerates a cursor beyond the history (restart clamp)', () => {
    const { messages, nextCount } = summaryWindow(msgs(3), 99);
    expect(messages).toEqual([]);
    expect(nextCount).toBe(3);
  });
});

describe('buildSummaryPrompt', () => {
  it('embeds messages as role: text and keeps ROSTER as the last format key', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).toContain('user: m0');
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('TITLE:'));
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('SUMMARY:'));
  });
  it('includes the prior roster inside a fenced preamble, and uses NEW: when cumulative exists', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: 'Was fixing auth.\nTITLE: sneaky', hasCumulative: true });
    expect(p).toContain('Was fixing auth.');
    expect(p).toContain('NEW:');
    // the fenced preamble sits before the format block so a hostile roster line can't terminate it
    expect(p.indexOf('Was fixing auth.')).toBeLessThan(p.indexOf('Format:'));
  });
  it('omits the preamble when there is no prior roster', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).not.toContain('previous rolling summary');
  });
});

describe('gate constants', () => {
  it('exports the gate constants the index.js wiring consumes', () => {
    expect(SUMMARY_MIN_NEW).toBe(1);
    expect(SUMMARY_WINDOW_CAP).toBe(200);
  });
});
