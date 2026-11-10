// Queue-priority rules for `/compact`. Pure — no I/O, no session state — so
// the "jumps the queue, travels alone" decision is unit-testable without
// index.js, exactly like lib/queue-flush.js's merge rules.
//
// Why this exists: while a print-mode session is busy, inbound text lands on
// session.queuedMessages, and at turn end planQueueFlush merges every
// text-only entry into ONE message ('\n\n' between entries). That is right
// for ordinary chatter and fatal for /compact — a queue of
// ["/compact", "now finish the refactor"] arrives as the single message
// "/compact\n\nnow finish the refactor", which Claude reads as /compact with
// *compaction instructions* "now finish the refactor". The context gets
// compacted, the refactor never runs, and nothing tells the user their
// second message was swallowed.
//
// Two halves, one invariant. Enqueue UNSHIFTS a compact command onto the
// queue (and its "📨 Queued" notification onto queueNotifications, in
// lockstep) instead of pushing, so a queued compact is always at index 0.
// Flush then splits off just that entry. Keeping the batch a PREFIX of the
// queue is what lets both arrays be split by the same slice, and what keeps
// queuedReleaseItemIds' existing `notifications.slice(0, batchSize)` correct
// without touching the release-registry bookkeeping at all.
//
// Print mode only, in practice: interactive sessions send /compact straight
// into the TUI while busy (isIvSlashPassthrough, lib/command-dispatch.js), so
// it never reaches this queue.

// `/compact` or `/compact <instructions>` — the trailing-instructions form is
// a legitimate use of the command and must travel alone just the same.
//
// `//compact` deliberately does NOT match: `//` is the existing escape prefix
// meaning "queue this as literal text", and it falls out for free — after the
// leading `/` the pattern requires `compact`, but the escaped form supplies
// `/compact`.
import { firstHeldIndex } from './queue-edit-hold.js';

const COMPACT_RE = /^\/compact(\s|$)/;

export function isCompactCommand(text) {
  return typeof text === 'string' && COMPACT_RE.test(text.trim());
}

// Does one queue entry (an array of content blocks) hold the compact command?
// Text-only entries only: an entry carrying media can't be a slash command,
// and merging text with media is planQueueFlush's business, not this rule's.
// Multi-block text is joined with '\n' — the same way planQueueFlush and
// formatQueueSummary read an entry's text.
export function isCompactEntry(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  if (!blocks.every(b => b?.type === 'text')) return false;
  return isCompactCommand(blocks.map(b => b.text).join('\n'));
}

// Is a compact already waiting in the queue? Enqueue uses this to refuse a
// SECOND /compact: each flush sends the front compact alone
// (compactBatchSize), so two queued compacts would never merge — the second
// would run a whole second compaction right after the first finishes. The
// scan covers the whole queue rather than trusting the index-0 invariant, so
// a compact that somehow rode along mid-queue still counts as queued.
export function hasQueuedCompact(queue) {
  return Array.isArray(queue) && queue.some(isCompactEntry);
}

// How many leading entries the next flush should send. A compact at the front
// goes out ALONE (1); everything else takes the whole queue, i.e. today's
// behaviour byte-for-byte. `queue.length - compactBatchSize(queue)` is the
// number of messages being held back, which is also what the user-facing copy
// counts.
//
// A compact found anywhere other than index 0 is ignored: enqueue unshifts, so
// that shouldn't happen, and if it ever does it rides along in the merged
// batch rather than silently reordering a queue someone else built.
//
// An entry held for editing (lib/queue-edit-hold.js) caps the batch too: the
// batch stops just before it, so it and everything behind it wait for the
// edit while the messages ahead of it still go. A held entry at the front
// makes the batch empty (0) — callers treat that as "nothing to send yet".
// Why a flush batch left messages behind: a leading /compact sent alone, or
// an entry held for editing. Only meaningful when the batch is shorter than
// the queue.
export function batchDeferralReason(batch) {
  return Array.isArray(batch) && batch.length === 1 && isCompactEntry(batch[0]) ? 'compact' : 'edit';
}

export function compactBatchSize(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return 0;
  const held = firstHeldIndex(queue);
  if (held === 0) return 0;
  if (isCompactEntry(queue[0])) return 1;
  return held > 0 ? held : queue.length;
}
