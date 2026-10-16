import { describe, it, expect } from 'vitest';
import { formatSearchAll } from '../lib/search-format.js';

// GET /search/all (spec 2026-10-12 unified search): one tiered, cross-kind
// lookup over missions, items, memories and projects. formatSearchAll is
// the only place the bridge turns that JSON into the text the `search` tool
// returns, so it is pinned against the documented shapes, not re-derived.
describe('formatSearchAll', () => {
  it('formats tiers, mission numbers and chats compactly', () => {
    const out = formatSearchAll({
      semantic: 'ready',
      results: [
        { kind: 'mission', num: 12, title: 'Refund export', state: 'closed', why: 'words', field: 'status', snippet: 'the **refund** **export** shipped' },
        { kind: 'item', num: 30, title: 'Which CSV columns', state: 'open', why: 'similar', field: 'text', snippet: 'columns for the ledger', mission_num: 12 },
      ],
      chats: [{ convo_id: 'c1', title: 'Refund export', mission_num: 12, count: 4, top: { seq: 99, excerpt: 'refund export' } }],
    });
    expect(out).toMatch(/^\[words\] mission #12 \(closed\) Refund export — the \*\*refund\*\*/m);
    expect(out).toMatch(/^\[similar\] item #30 \(open, mission #12\) Which CSV columns/m);
    expect(out).toMatch(/Chats:\n- Refund export \(mission #12, 4 matches\) convo c1 seq 99/);
  });

  it('no results and no chats → one helpful line', () => {
    expect(formatSearchAll({ results: [], chats: [], semantic: 'ready' }))
      .toBe('No match. Describe it differently, or put an exact name or number in quotes.');
  });

  it('semantic off is mentioned once', () => {
    expect(formatSearchAll({
      results: [{ kind: 'memory', num: null, name: 'quiet-hours', title: 'deploy in the evening', why: 'exact', field: 'text', snippet: 'x' }],
      semantic: 'off',
    })).toMatch(/meaning-based matching is off/);
  });

  it('semantic indexing is mentioned once', () => {
    expect(formatSearchAll({
      results: [{ kind: 'project', num: 5, title: 'Launch', why: 'exact', snippet: '' }],
      semantic: 'indexing',
    })).toMatch(/still indexing/);
  });

  it('a some_words hit is labelled like any other tier', () => {
    const out = formatSearchAll({
      results: [{ kind: 'item', num: 7, title: 'Loose match', state: 'open', why: 'some_words', snippet: 'one of the words' }],
      semantic: 'ready',
    });
    expect(out).toMatch(/^\[some_words\] item #7 \(open\) Loose match/m);
  });

  it('a chat row missing top, or with a null mission_num, renders without crashing', () => {
    const out = formatSearchAll({
      results: [],
      chats: [
        { convo_id: 'c2', title: 'No mission', mission_num: null, count: 1 },
        { convo_id: 'c3', title: 'No top either', count: 2 },
      ],
      semantic: 'ready',
    });
    expect(out).toContain('- No mission (1 matches) convo c2');
    expect(out).toContain('- No top either (2 matches) convo c3');
    expect(out).not.toMatch(/undefined/);
  });

  it('defaults missing results/chats to empty rather than throwing', () => {
    expect(formatSearchAll({})).toBe('No match. Describe it differently, or put an exact name or number in quotes.');
    expect(formatSearchAll(undefined)).toBe('No match. Describe it differently, or put an exact name or number in quotes.');
  });

  it('collapses whitespace in a result title and a chat title, not only in snippets', () => {
    const out = formatSearchAll({
      results: [{ kind: 'item', num: 1, title: 'Which   CSV\ncolumns', state: 'open', why: 'exact', snippet: 'a\n  b' }],
      chats: [{ convo_id: 'c1', title: 'Refund  \n export', count: 1 }],
      semantic: 'ready',
    });
    expect(out).toMatch(/^\[exact\] item #1 \(open\) Which CSV columns — a b$/m);
    expect(out).toContain('- Refund export (1 matches) convo c1');
  });

  it('truncates a long snippet by code point, appends an ellipsis, and drops a dangling ** marker', () => {
    const snippet = `${'x'.repeat(158)}**bold tail that never closes`;
    const out = formatSearchAll({ results: [{ kind: 'item', num: 1, title: 'Long', state: 'open', why: 'exact', snippet }], semantic: 'ready' });
    const shown = out.split(' — ')[1];
    expect(shown.endsWith('…')).toBe(true);
    expect((shown.match(/\*\*/g) || []).length % 2).toBe(0);
    expect(shown).not.toContain('**');
  });

  it('never splits a surrogate pair when truncating', () => {
    const snippet = `${'a'.repeat(159)}😀 trailing text past the cut`;
    const out = formatSearchAll({ results: [{ kind: 'item', num: 1, title: 'Emoji', state: 'open', why: 'exact', snippet }], semantic: 'ready' });
    const shown = out.split(' — ')[1];
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).not.toMatch(/�/);
    expect(Array.from(shown.slice(0, -1)).length).toBe(160);
  });

  it('a short snippet is left exactly as is, with no ellipsis', () => {
    const out = formatSearchAll({ results: [{ kind: 'item', num: 1, title: 'Short', state: 'open', why: 'exact', snippet: 'a short one' }], semantic: 'ready' });
    expect(out).toContain('— a short one');
    expect(out).not.toContain('…');
  });

  it('keeps the semantic notice when nothing matched', () => {
    expect(formatSearchAll({ results: [], chats: [], semantic: 'indexing' }))
      .toBe('No match. Describe it differently, or put an exact name or number in quotes.\n\n(meaning-based matching is still indexing; results may be incomplete)');
    expect(formatSearchAll({ results: [], chats: [], semantic: 'off' })).toMatch(/^No match\..*\n\n\(meaning-based matching is off/s);
  });
});
