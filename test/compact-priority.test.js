import { describe, it, expect } from 'vitest';
import { isCompactCommand, isCompactEntry, compactBatchSize, hasQueuedCompact } from '../lib/compact-priority.js';

const text = (t) => [{ type: 'text', text: t }];
const media = (name) => [{ type: 'image', source: name }];

describe('isCompactCommand', () => {
  it('matches the bare command', () => {
    expect(isCompactCommand('/compact')).toBe(true);
  });

  it('matches the command with compaction instructions', () => {
    expect(isCompactCommand('/compact focus on the parser work')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isCompactCommand('  /compact  ')).toBe(true);
    expect(isCompactCommand('\n/compact keep the API notes\n')).toBe(true);
  });

  // `//` is the existing escape prefix meaning "queue this as literal text"
  // (isIvSlashPassthrough, lib/command-dispatch.js). Escaping must keep the
  // message on the ordinary FIFO path.
  it('does not match the // escape form', () => {
    expect(isCompactCommand('//compact')).toBe(false);
    expect(isCompactCommand('//compact now')).toBe(false);
  });

  it('requires a word boundary after the command', () => {
    expect(isCompactCommand('/compacted')).toBe(false);
    expect(isCompactCommand('/compact-now')).toBe(false);
  });

  it('does not match the word on its own or mid-sentence', () => {
    expect(isCompactCommand('compact')).toBe(false);
    expect(isCompactCommand('please run /compact when you are done')).toBe(false);
  });

  it('is safe on empty and non-string input', () => {
    expect(isCompactCommand('')).toBe(false);
    expect(isCompactCommand('   ')).toBe(false);
    expect(isCompactCommand(null)).toBe(false);
    expect(isCompactCommand(undefined)).toBe(false);
    expect(isCompactCommand(42)).toBe(false);
  });
});

describe('isCompactEntry', () => {
  it('matches a text-only queue entry holding the command', () => {
    expect(isCompactEntry(text('/compact'))).toBe(true);
  });

  it('joins multi-block text the way the flush does', () => {
    expect(isCompactEntry([{ type: 'text', text: '/compact' }, { type: 'text', text: 'keep the notes' }])).toBe(true);
  });

  it('rejects entries carrying media — a compact entry must be text-only', () => {
    expect(isCompactEntry(media('shot.png'))).toBe(false);
    expect(isCompactEntry([...text('/compact'), ...media('shot.png')])).toBe(false);
  });

  it('rejects ordinary text', () => {
    expect(isCompactEntry(text('now finish the refactor'))).toBe(false);
  });

  it('is safe on empty/null entries', () => {
    expect(isCompactEntry([])).toBe(false);
    expect(isCompactEntry(null)).toBe(false);
    expect(isCompactEntry(undefined)).toBe(false);
  });
});

// The flush contract: a compact always sits at index 0 (enqueue unshifts it),
// so the batch is a PREFIX of the queue — which is what lets both
// queuedMessages and queueNotifications be split with the same slice, and
// what keeps queuedReleaseItemIds' existing `slice(0, batchSize)` correct.
describe('compactBatchSize', () => {
  it('is 0 for an empty/absent queue', () => {
    expect(compactBatchSize([])).toBe(0);
    expect(compactBatchSize(null)).toBe(0);
    expect(compactBatchSize(undefined)).toBe(0);
  });

  it('takes the whole queue when no compact leads it', () => {
    expect(compactBatchSize([text('a'), text('b'), text('c')])).toBe(3);
  });

  it('takes just the compact when others are waiting behind it', () => {
    expect(compactBatchSize([text('/compact'), text('a'), text('b')])).toBe(1);
  });

  it('is a no-op split when the compact is alone', () => {
    expect(compactBatchSize([text('/compact')])).toBe(1);
  });

  // Enqueue unshifts, so a compact should never be found mid-queue. If one
  // ever is, it rides along in the merged batch rather than silently
  // reordering a queue someone else built.
  it('ignores a compact that is not at the front', () => {
    expect(compactBatchSize([text('a'), text('/compact')])).toBe(2);
  });
});

describe('hasQueuedCompact', () => {
  it('is false for an empty/absent queue', () => {
    expect(hasQueuedCompact(null)).toBe(false);
    expect(hasQueuedCompact(undefined)).toBe(false);
    expect(hasQueuedCompact([])).toBe(false);
  });

  it('finds the compact enqueue unshifted to the front', () => {
    expect(hasQueuedCompact([text('/compact'), text('a')])).toBe(true);
    expect(hasQueuedCompact([text('/compact keep the refactor'), text('a')])).toBe(true);
  });

  // Defensive whole-queue scan: the enqueue invariant puts a compact at
  // index 0, but if one ever rides mid-queue the dedupe should still see it
  // rather than let a second compaction run stack up behind it.
  it('finds a compact anywhere in the queue', () => {
    expect(hasQueuedCompact([text('a'), text('/compact')])).toBe(true);
  });

  it('is false for ordinary text and the // escape form', () => {
    expect(hasQueuedCompact([text('a'), text('//compact')])).toBe(false);
    expect(hasQueuedCompact([media('x.png'), text('compact')])).toBe(false);
  });
});
