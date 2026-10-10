import { describe, it, expect, vi } from 'vitest';
import {
  markJournalOrigin, isJournalOrigin, planQueueFlush,
  attachQueuedCleanup, runQueuedCleanup,
} from '../lib/queue-flush.js';
import { attachPendingMediaMirror, pendingMediaMirror } from '../lib/media-mirror.js';

const text = (t) => [{ type: 'text', text: t }];
const media = (name) => [{ type: 'image', source: name }];

describe('markJournalOrigin / isJournalOrigin', () => {
  it('marks and detects a blocks array', () => {
    const blocks = text('hi');
    expect(isJournalOrigin(blocks)).toBe(false);
    expect(markJournalOrigin(blocks)).toBe(blocks); // returns the same array
    expect(isJournalOrigin(blocks)).toBe(true);
  });

  it('is safe on null/undefined', () => {
    expect(isJournalOrigin(null)).toBe(false);
    expect(isJournalOrigin(undefined)).toBe(false);
  });
});

describe('attachQueuedCleanup / runQueuedCleanup', () => {
  it('runs the attached cleanup once, then is idempotent (no double-unlink on double-discard)', () => {
    const cleanup = vi.fn();
    const blocks = text('File saved to /w/x.pdf');
    expect(attachQueuedCleanup(blocks, cleanup)).toBe(blocks); // same array
    // Non-enumerable: never leaks into iteration / JSON.
    expect(Object.keys(blocks)).toEqual(['0']);
    expect(runQueuedCleanup(blocks)).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(runQueuedCleanup(blocks)).toBe(false); // tag cleared after firing
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an untagged entry or null', () => {
    expect(runQueuedCleanup(text('hi'))).toBe(false);
    expect(runQueuedCleanup(null)).toBe(false);
    expect(runQueuedCleanup(undefined)).toBe(false);
  });

  it('ignores a non-function cleanup and never throws when the cleanup throws', () => {
    const blocks = text('hi');
    expect(attachQueuedCleanup(blocks, null)).toBe(blocks);
    expect(runQueuedCleanup(blocks)).toBe(false);

    const boom = attachQueuedCleanup(text('x'), () => { throw new Error('unlink failed'); });
    expect(() => runQueuedCleanup(boom)).not.toThrow();
  });

  it('rides along with the same array object across a queue carry', () => {
    const cleanup = vi.fn();
    const entry = attachQueuedCleanup(media('x.png'), cleanup);
    // A cross-restart/switch carry copies the entry REFERENCES, not the arrays.
    const carried = [entry];
    expect(runQueuedCleanup(carried[0])).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

// New contract (post mixed-origin-garble fix, Bugbot finding #1): planQueueFlush
// always produces a SINGLE merged send for the whole queue — the PTY's
// sendText only tracks one pending Enter timer, so two back-to-back
// sendToSession calls in iv mode cancel each other's Enter and submit one
// concatenated, garbled message (see lib/interactive-session.js sendText).
// Journal mirroring is now computed out-of-band as a separate `mirrorText`
// string (the Matrix-origin text subset, in queue order) instead of driving
// a second send — callers send `blocks` with skipJournalMirror true and
// mirror `mirrorText` themselves via journalPublishUserItem.
describe('planQueueFlush', () => {
  it('returns an empty send for an empty/null/undefined queue', () => {
    expect(planQueueFlush([])).toEqual({ blocks: [], mirrorText: '' });
    expect(planQueueFlush(null)).toEqual({ blocks: [], mirrorText: '' });
    expect(planQueueFlush(undefined)).toEqual({ blocks: [], mirrorText: '' });
  });

  it('all-Matrix queue: one merged send, mirrors everything (unchanged external behavior)', () => {
    const { blocks, mirrorText } = planQueueFlush([text('one'), text('two'), text('three')]);
    expect(blocks).toEqual([{ type: 'text', text: 'one\n\ntwo\n\nthree' }]);
    expect(mirrorText).toBe('one\n\ntwo\n\nthree');
  });

  // planQueueFlush itself is unchanged by the compact-first rule — the split
  // happens upstream (lib/compact-priority.js), and what arrives here is a
  // one-entry batch. Pinned because the whole point of the split is that
  // /compact reaches Claude as its own clean message, not concatenated with
  // anything: merged with a second entry it reads as *compaction
  // instructions* and that entry's work is silently never done.
  it('a lone compact batch becomes exactly one text block, uncontaminated', () => {
    const { blocks, mirrorText } = planQueueFlush([text('/compact')]);
    expect(blocks).toEqual([{ type: 'text', text: '/compact' }]);
    expect(mirrorText).toBe('/compact');
  });

  it('all-Matron (journal-origin) queue: one merged send, mirrors nothing', () => {
    const { blocks, mirrorText } = planQueueFlush([
      markJournalOrigin(text('a')),
      markJournalOrigin(text('b')),
    ]);
    expect(blocks).toEqual([{ type: 'text', text: 'a\n\nb' }]);
    expect(mirrorText).toBe('');
  });

  it('mixed origin: still ONE merged send (not split), mirror-text is only the Matrix-origin subset, in order', () => {
    const { blocks, mirrorText } = planQueueFlush([
      text('matrix-1'),
      markJournalOrigin(text('matron-1')),
      markJournalOrigin(text('matron-2')),
      text('matrix-2'),
    ]);
    // Single send: every entry's text merged in original queue order,
    // regardless of origin — origin no longer partitions the send.
    expect(blocks).toEqual([{ type: 'text', text: 'matrix-1\n\nmatron-1\n\nmatron-2\n\nmatrix-2' }]);
    // Mirror payload: Matrix-origin entries only, in queue order.
    expect(mirrorText).toBe('matrix-1\n\nmatrix-2');
  });

  it('media entries flush accumulated text first, then ride in the same (single) send', () => {
    const { blocks, mirrorText } = planQueueFlush([text('caption'), media('pic.png'), text('after')]);
    expect(blocks).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', source: 'pic.png' },
      { type: 'text', text: 'after' },
    ]);
    expect(mirrorText).toBe('caption\n\nafter');
  });

  it('multiple text blocks within one entry merge with \\n, entries with \\n\\n (existing behavior)', () => {
    const twoBlocks = [{ type: 'text', text: 'l1' }, { type: 'text', text: 'l2' }];
    const { blocks, mirrorText } = planQueueFlush([twoBlocks, text('next')]);
    expect(blocks).toEqual([{ type: 'text', text: 'l1\nl2\n\nnext' }]);
    expect(mirrorText).toBe('l1\nl2\n\nnext');
  });

  it('an origin flip next to a media entry: still one send; mirror-text skips the journal-origin entry', () => {
    const { blocks, mirrorText } = planQueueFlush([
      media('a.png'),
      markJournalOrigin(text('matron')),
    ]);
    expect(blocks).toEqual([
      { type: 'image', source: 'a.png' },
      { type: 'text', text: 'matron' },
    ]);
    expect(mirrorText).toBe('');
  });

  it('a mixed-content entry (text + media in the SAME entry) mirrors its text portion when Matrix-origin', () => {
    const entry = [{ type: 'text', text: 'File saved to /x' }, { type: 'image', source: 'x.png' }];
    const { blocks, mirrorText } = planQueueFlush([entry]);
    expect(blocks).toEqual(entry);
    expect(mirrorText).toBe('File saved to /x');
  });

  it('a mixed-content entry does not mirror when journal-origin', () => {
    const entry = markJournalOrigin([{ type: 'text', text: 'from matron' }, { type: 'image', source: 'x.png' }]);
    const { blocks, mirrorText } = planQueueFlush([entry]);
    expect(blocks).toEqual([{ type: 'text', text: 'from matron' }, { type: 'image', source: 'x.png' }]);
    expect(mirrorText).toBe('');
  });
});

// Reproduces the exact queue-entry shapes index.js's journalQueueMedia builds
// for busy-time journal media, then flushes them at turn end. Guards the two
// contracts that keep Matron media consistent with journal text and Matrix
// media: (1) delivery is one merged send in arrival order, interleaved with any
// queued text; (2) a saved file/image queued from the journal is journal-origin
// AND has its pending-media-mirror tag stripped, so the flush never re-mirrors a
// file the journal already recorded as the client's own event — while a
// voice-note transcript stays Matrix-origin so it IS mirrored, matching the
// immediate sendTextToSession.
describe('journal media busy-queue → turn-end flush', () => {
  // journalQueueMedia's transform: spread-copy the built blocks (dropping the
  // non-enumerable pending-media-mirror tag) and mark origin per mirrorToJournal.
  const queueSavedMedia = (blocks) => markJournalOrigin([...blocks]);      // mirrorToJournal:false
  const queueVoiceNote = (text) => [...[{ type: 'text', text }]];          // mirrorToJournal:true

  it('flushes queued text and media in arrival order, one merged send', () => {
    const queued = [
      markJournalOrigin(text('matron typed while busy')),                  // queued Matron text
      queueVoiceNote('[Voice note transcription]: buy milk'),             // queued voice note
      queueSavedMedia([{ type: 'text', text: 'File saved to /w/report.pdf' }, { type: 'document', source: {} }]),
    ];
    const { blocks, mirrorText } = planQueueFlush(queued);
    // The two text-only entries merge; the saved-media entry (text + document)
    // flushes that accumulator first, then rides in with its own blocks intact.
    expect(blocks).toEqual([
      { type: 'text', text: 'matron typed while busy\n\n[Voice note transcription]: buy milk' },
      { type: 'text', text: 'File saved to /w/report.pdf' },
      { type: 'document', source: {} },
    ]);
    // Only the voice-note transcript mirrors (Matrix-origin); the Matron text
    // and the saved file are journal-origin and never re-mirror.
    expect(mirrorText).toBe('[Voice note transcription]: buy milk');
  });

  it('the spread copy strips the pending-media-mirror tag, so a flushed saved file never double-mirrors', () => {
    // What buildSavedMediaBlocks returns: blocks carrying a deferred mirror tag.
    const built = [{ type: 'text', text: 'File saved to /w/a.pdf' }];
    attachPendingMediaMirror(built, { buffer: Buffer.from('x'), mime: 'application/pdf', name: 'a.pdf' });
    expect(pendingMediaMirror(built).length).toBe(1); // tag present on the built array

    const queuedEntry = queueSavedMedia(built);        // journalQueueMedia's transform
    expect(pendingMediaMirror(queuedEntry).length).toBe(0); // tag gone after the spread copy
    expect(isJournalOrigin(queuedEntry)).toBe(true);
  });
});
