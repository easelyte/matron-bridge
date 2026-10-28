// Pure tagging helpers that let a media blocks-array carry its deferred
// journal-mirror payload (Bugbot finding #4). No I/O, no session state — in
// the style of markJournalOrigin/isJournalOrigin in lib/queue-flush.js.
//
// The bug: buildMediaContentBlocks (index.js) used to call
// journalMirrorUserMedia — which uploads the blob AND publishes the
// file/image event AND advances the read marker — at BUILD time, i.e. the
// moment a media message is turned into content blocks. That's also
// the queue-attachment-while-busy path: a message queued behind a busy
// session gets its journal entry (and markRead) recorded immediately, before
// Claude has actually received anything. Cancelling that queued message
// (the "cancel" button/command, or any full-queue clear) then leaves a
// phantom journal entry — and an advanced read marker — for something
// Claude never saw.
//
// The fix: buildMediaContentBlocks no longer mirrors anything itself. It
// attaches the (buffer, mime, name, dims) journalMirrorUserMedia would have
// needed onto the returned blocks array via attachPendingMediaMirror, and
// the actual send path — the immediate hasMedia dispatch AND flushQueue/the
// resume-hold flush — reads it back with pendingMediaMirror and performs the
// mirror only for blocks that actually go out. A cancelled/dropped queue
// entry simply never has pendingMediaMirror called on it: no upload, no
// publish, no markRead.

const PENDING_MEDIA_MIRROR_KEY = '_pendingMediaMirror';

// Tag a blocks array with the journal-mirror payload(s) it still owes, once
// it's actually dispatched. A non-enumerable property, exactly like
// markJournalOrigin, so it never leaks into JSON.stringify (stdin frames,
// debug dumps) or block iteration, and rides along wherever the array object
// goes (queuedMessages, _resumeOutbox, cross-restart carry). Accepts either
// a single payload or an array; attaching an empty list is a no-op.
export function attachPendingMediaMirror(blocks, payloads) {
  const list = Array.isArray(payloads) ? payloads : [payloads];
  if (list.length === 0) return blocks;
  try {
    Object.defineProperty(blocks, PENDING_MEDIA_MIRROR_KEY, { value: list, enumerable: false });
  } catch { /* frozen/exotic array — treat as untagged rather than throw */ }
  return blocks;
}

// Read back the payload(s) a blocks array is carrying, or [] if none/unsafe
// input. Deliberately a peek, not a take: each blocks array is only ever
// dispatched or dropped once, so there's nothing to guard against a second
// read racing a first.
export function pendingMediaMirror(blocks) {
  const list = blocks && blocks[PENDING_MEDIA_MIRROR_KEY];
  return Array.isArray(list) ? list : [];
}
