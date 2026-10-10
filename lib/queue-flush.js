// Origin-aware queue flushing for the bridge's queued-while-busy (and
// resume-hold) message paths. Pure — no I/O, no session state — so the
// merge/grouping rules are unit-testable without index.js.
//
// Why origin matters: sendToSession's journal mirror is the single choke
// point that records a user's message in the journal. Matrix-originated
// messages MUST mirror there (the journal has no other way of learning
// them); journal-originated messages (Matron client `send` rows routed back
// in through the return path) must NOT — the journal already has the user's
// own row, and re-mirroring on flush would surface a duplicate in every
// journal client. Immediate sends carry that distinction as a call-site
// flag (skipJournalMirror), but a queued/held message outlives its call
// site — so the origin travels WITH the queued blocks (markJournalOrigin).
//
// Why ONE send (Bugbot finding #1, PR #97 regression): an earlier version of
// this module split a mixed-origin queue into one sendToSession call per
// origin run. In iv mode that's fatal — lib/interactive-session.js sendText()
// types a bracketed paste then arms a single delayed Enter, CANCELLING any
// still-pending Enter from a prior sendText call. Two back-to-back
// sendToSession calls therefore paste twice into the same input line and
// submit as ONE garbled, concatenated message — the opposite of what
// per-origin splitting was trying to achieve. So planQueueFlush now always
// produces a single merged send for the whole queue (matching pre-#97
// transport behavior exactly), and origin instead drives a separate,
// out-of-band `mirrorText` value: the caller sends `blocks` with
// skipJournalMirror true, then mirrors `mirrorText` itself (e.g. via
// journalPublishUserItem) — journal-originated entries contribute nothing to
// it, since the journal already has their row.

const JOURNAL_ORIGIN_KEY = '_journalOrigin';

// Tag a blocks array as journal-originated. A non-enumerable property so it
// never leaks into JSON.stringify (stdin frames, debug dumps) or block
// iteration; the tag rides along wherever the same array object goes
// (queuedMessages, _resumeOutbox, cross-restart carry).
export function markJournalOrigin(blocks) {
  try {
    Object.defineProperty(blocks, JOURNAL_ORIGIN_KEY, { value: true, enumerable: false });
  } catch { /* frozen/exotic array — treat as unmarked rather than throw */ }
  return blocks;
}

export function isJournalOrigin(blocks) {
  return !!(blocks && blocks[JOURNAL_ORIGIN_KEY]);
}

const QUEUED_CLEANUP_KEY = '_queuedCleanup';

// Attach a cleanup closure to a queued blocks array — invoked iff the entry is
// DISCARDED without dispatch (cancelled, evicted, or dropped against a dead
// session), to unlink a media file that was saved to disk when the entry was
// built. Non-enumerable so it never leaks into JSON.stringify / block
// iteration, and it rides along wherever the same array object goes
// (cross-restart / cross-switch queue carry) exactly like the origin tag. NOT
// called on a successful flush — a dispatched entry's file is consumed by the
// session and must survive.
export function attachQueuedCleanup(blocks, cleanup) {
  if (typeof cleanup !== 'function') return blocks;
  try {
    Object.defineProperty(blocks, QUEUED_CLEANUP_KEY, { value: cleanup, enumerable: false, configurable: true });
  } catch { /* frozen/exotic array — treat as untagged rather than throw */ }
  return blocks;
}

// Run (once) the cleanup for a discarded queued entry. Idempotent: the tag is
// cleared after firing so a double-discard (e.g. splice + queue-null) can't
// unlink twice. Never throws — cleanup is best-effort disk hygiene.
export function runQueuedCleanup(blocks) {
  const cleanup = blocks && blocks[QUEUED_CLEANUP_KEY];
  if (typeof cleanup !== 'function') return false;
  try { Object.defineProperty(blocks, QUEUED_CLEANUP_KEY, { value: null, enumerable: false, configurable: true }); } catch { /* ignore */ }
  try { cleanup(); } catch { /* best-effort */ }
  return true;
}

// Turn a queue of blocks-arrays (each entry one queued message, possibly
// origin-marked) into a SINGLE merged send: `{ blocks, mirrorText }`.
//
// `blocks` reproduces the pre-#97 merge exactly, across the whole queue
// regardless of origin: consecutive text-only entries merge into one text
// block ('\n' within an entry, '\n\n' between entries), media entries flush
// any accumulated text first and then ride in the same array.
//
// `mirrorText` is the Matrix-origin subset of that same text, concatenated
// in queue order with the same '\n' (within an entry) / '\n\n' (between
// entries) convention — the exact text sendToSession would have mirrored for
// each Matrix-origin entry had it been sent on its own. Journal-origin
// entries (including the text portion of a mixed text+media entry) never
// contribute to it.
export function planQueueFlush(queued) {
  if (!Array.isArray(queued) || queued.length === 0) return { blocks: [], mirrorText: '' };

  const blocks = [];
  const mirrorParts = [];
  let textAccum = [];

  const flushText = () => {
    if (textAccum.length === 0) return;
    const combined = textAccum.map(entry => entry.map(b => b.text).join('\n')).join('\n\n');
    blocks.push({ type: 'text', text: combined });
    textAccum = [];
  };

  for (const entry of queued) {
    const isTextOnly = entry.every(b => b.type === 'text');
    if (isTextOnly) {
      textAccum.push(entry);
    } else {
      flushText();
      blocks.push(...entry);
    }

    if (!isJournalOrigin(entry)) {
      const entryText = entry.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (entryText) mirrorParts.push(entryText);
    }
  }
  flushText();

  return { blocks, mirrorText: mirrorParts.join('\n\n') };
}
