import { describe, it, expect } from 'vitest';
import { itemLine, formatItemList, formatItemDetail, formatCommentAck } from '../lib/items-format.js';

const open = { id: 'it_1', num: 12, kind: 'question', title: 'Which auth library?', state: 'open', awaiting: 'user', resolution: null };
const closed = { id: 'it_2', num: 13, kind: 'task', title: 'Ship it', state: 'closed', awaiting: null, resolution: 'done' };

describe('itemLine', () => {
  it('renders an open item with its awaiting party', () => {
    expect(itemLine(open)).toBe('#12 Which auth library? — open, awaiting user (id it_1)');
  });

  it('renders a closed item with its resolution and no awaiting clause', () => {
    expect(itemLine(closed)).toBe('#13 Ship it — closed, done (id it_2)');
  });

  it('omits both optional clauses when the item awaits nobody and is unresolved', () => {
    expect(itemLine({ id: 'it_3', num: 3, title: 'A decision', state: 'open', awaiting: null, resolution: null }))
      .toBe('#3 A decision — open (id it_3)');
  });

  it('survives a malformed or absent item rather than throwing', () => {
    expect(itemLine(null)).toBe('(unknown item)');
    expect(itemLine({})).toBe('#? (untitled) — open');
  });
});

describe('formatItemList', () => {
  it('renders one line per item', () => {
    expect(formatItemList({ items: [open, closed] })).toBe(
      '#12 Which auth library? — open, awaiting user (id it_1)\n#13 Ship it — closed, done (id it_2)',
    );
  });

  it('says (none) when nothing matches', () => {
    expect(formatItemList({ items: [] })).toBe('(none)');
    expect(formatItemList({})).toBe('(none)');
  });

  it('notes a truncated page so the model narrows instead of assuming it saw everything', () => {
    expect(formatItemList({ items: [open], next_cursor: 'abc' }))
      .toBe('#12 Which auth library? — open, awaiting user (id it_1)\n(more items match — narrow the filters or raise limit)');
  });
});

describe('formatItemDetail', () => {
  it('renders the item line, the body, and each comment with its author and time', () => {
    const text = formatItemDetail({
      item: { ...open, body: 'A or B?' },
      comments: [
        { id: 'ic_1', author: 'user', kind: 'comment', body: 'use A', attachments: [], created_at: 1757328000000 },
        { id: 'ic_2', author: 'agent', kind: 'comment', body: 'noted', attachments: [], created_at: 1757328060000 },
      ],
    });
    expect(text).toBe([
      '#12 Which auth library? — open, awaiting user (id it_1)',
      'A or B?',
      '',
      '- [user, 2025-09-08T10:40:00.000Z] use A',
      '- [agent, 2025-09-08T10:41:00.000Z] noted',
    ].join('\n'));
  });

  it('lists attachments under their comment, with the transcript when there is one', () => {
    const text = formatItemDetail({
      item: { ...open, body: '' },
      comments: [{
        id: 'ic_1', author: 'user', kind: 'comment', body: '', created_at: 1757328000000,
        attachments: [
          { blob_ref: 'b1', name: 'note.m4a', mime: 'audio/mp4', size: 10, transcript: 'use the second one' },
          { blob_ref: 'b2', name: 'shot.png', mime: 'image/png', size: 20 },
        ],
      }],
    });
    expect(text).toBe([
      '#12 Which auth library? — open, awaiting user (id it_1)',
      '',
      '- [user, 2025-09-08T10:40:00.000Z] (no text)',
      '  · note.m4a (audio/mp4) — transcript: use the second one',
      '  · shot.png (image/png)',
    ].join('\n'));
  });

  it('describes a bodiless status comment from its meta', () => {
    const text = formatItemDetail({
      item: closed,
      comments: [
        { id: 'ic_1', author: 'user', kind: 'status', body: '', attachments: [], created_at: 1757328000000, meta: { from: { state: 'open' }, to: { state: 'closed', resolution: 'done' } } },
        { id: 'ic_2', author: 'agent', kind: 'status', body: '', attachments: [], created_at: 1757328060000, meta: { from: { state: 'closed' }, to: { state: 'open', awaiting: 'agent' } } },
      ],
    });
    expect(text).toBe([
      '#13 Ship it — closed, done (id it_2)',
      '',
      '- [user, 2025-09-08T10:40:00.000Z] (closed as done)',
      '- [agent, 2025-09-08T10:41:00.000Z] (reopened, awaiting agent)',
    ].join('\n'));
  });

  it('says so when an item has no comments yet', () => {
    expect(formatItemDetail({ item: { ...open, body: 'A or B?' }, comments: [] })).toBe([
      '#12 Which auth library? — open, awaiting user (id it_1)',
      'A or B?',
      '',
      '(no comments)',
    ].join('\n'));
  });

  it('renders an unparseable timestamp without throwing', () => {
    const text = formatItemDetail({
      item: open,
      comments: [{ id: 'ic_1', author: 'user', kind: 'comment', body: 'hi', attachments: [], created_at: 'nonsense' }],
    });
    expect(text).toContain('- [user, unknown time] hi');
  });
});

describe('formatCommentAck', () => {
  it('names the item the comment landed on', () => {
    expect(formatCommentAck({ item: open })).toBe('Comment added to #12 "Which auth library?"');
  });

  it('reports the new awaiting party when one was requested', () => {
    expect(formatCommentAck({ item: open }, 'user')).toBe('Comment added to #12 "Which auth library?" — awaiting now user');
    expect(formatCommentAck({ item: open }, null)).toBe('Comment added to #12 "Which auth library?" — awaiting now nobody');
  });

  it('reports the failure instead of claiming an awaiting change that did not happen', () => {
    expect(formatCommentAck({ item: open, awaiting_error: 'journal unreachable' }, 'user'))
      .toBe('Comment added to #12 "Which auth library?" — but awaiting update failed: journal unreachable');
    // The key being present at all means the PATCH failed. When the journal
    // answered without an error string, lib/items-tools.js substitutes the
    // status (never undefined) — report that verbatim rather than swallowing
    // it into a success line.
    expect(formatCommentAck({ item: open, awaiting_error: 'HTTP 202' }, 'agent'))
      .toBe('Comment added to #12 "Which auth library?" — but awaiting update failed: HTTP 202');
  });

  it('falls back gracefully when the journal answered without an item', () => {
    expect(formatCommentAck({})).toBe('Comment added.');
  });
});
