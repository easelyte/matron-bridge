# `/compact` jumps the queue and travels alone

Date: 2026-08-06
Status: approved (Dan, 2026-08-06)

## Problem

While a print-mode session is busy, inbound text lands on
`session.queuedMessages`. At turn end `flushPendingSessionQueue` hands the
**whole** queue to `flushQueue` -> `planQueueFlush`, which merges every
text-only entry into a **single** text block (`'\n\n'` between entries) and
sends it as one user message.

That is correct for ordinary chatter and fatal for `/compact`. A queue of

```
["/compact", "now finish the refactor"]
```

is delivered as the single message `/compact\n\nnow finish the refactor`.
Claude reads that as `/compact` with *compaction instructions* `now finish
the refactor` — so the context is compacted, the refactor is never run, and
the user gets no indication their second message was swallowed.

The user also cannot express "compact, **then** do the rest": queue order is
strict FIFO, so a `/compact` queued after real work runs after that work has
already burned the context it was meant to reclaim.

## Behaviour

1. A queued `/compact` **jumps to the front** of the queue, ahead of anything
   already waiting.
2. It is flushed **alone** — never merged with another queued entry.
3. The remaining queue is held and delivered after the compaction completes.
4. The "📨 Queued" tile says it will jump, so the user is not surprised.
5. The rule holds for every flush path, including an explicit "⚡ Send all
   now" tap or a typed `send`/`interrupt` — merging corrupts `/compact`
   regardless of what triggered the flush.

Scope: print mode only. In interactive mode `isIvSlashPassthrough`
(`lib/command-dispatch.js`) types `/compact` straight into the TUI while
busy, so it never reaches this queue.

## Design

### The predicate — `lib/compact-priority.js` (new, pure)

```js
export function isCompactCommand(text)   // /^\/compact(\s|$)/ on trimmed text
export function isCompactEntry(blocks)   // text-only entry whose text isCompactCommand
export function compactBatchSize(queue)  // 1 when queue[0] is a lone-worthy compact, else queue.length
```

`/compact` and `/compact <instructions>` both match — the trailing form is a
legitimate use of the command, and it still must travel alone.

`//compact` does **not** match. `//` is the existing escape prefix meaning
"treat as literal text", so escaping keeps working with no extra code: after
the leading `/` the regex requires `compact`, and `//compact` supplies
`/compact`.

Non-text entries (media) never match, so the media enqueue path is untouched.

### Half A — enqueue puts it at the front

In `journalRouteTextToSession`'s busy branch (`index.js`), a compact command
`unshift`es onto `session.queuedMessages` instead of pushing, and
`notifyQueuedMessage` (`lib/busy-queue.js`) unshifts its notification record
in lockstep.

This is what makes "jumps the queue" literally true, and it buys the flush
side a strong invariant: **a queued compact is always at index 0**, so the
flush split is a prefix split rather than an arbitrary-index extraction.

### Half B — flush sends index 0 alone

Each flush site computes `batchSize = compactBatchSize(queue)` and splits
*both* `queuedMessages` and `queueNotifications` with
`slice(0, batchSize)` / `slice(batchSize)`.

The release-registry bookkeeping needs no change: `queuedReleaseItemIds`
already does `notifications.slice(0, batchSize)`, i.e. it was written against
exactly this "the batch is a prefix of the queue" invariant.

Sites — every path that hands a batch to `flushQueue`:

- `flushPendingSessionQueue` (`index.js`) — the turn-end flush.
- `handleBusyQueueMagicWord`'s `send` (`lib/busy-queue.js`) — typed
  `send`/`interrupt`.
- `resolveQueueReleaseTap`'s `send` and its legacy `interrupt` branch
  (`lib/busy-queue.js`) — Matron card tap.
- the `/interrupt` HTTP endpoint (`index.js`).

`lib/busy-queue.js` owns a local `splitFlushBatch(session)` over the two
arrays; `index.js` splits inline and scopes its release-registry seams to the
batch via `pendingFlushBatch(session)` (otherwise `finalizeSentQueue` would
emit `send` releases for messages still waiting in the queue).

`resolveQueueReleaseTap` gains a `notify` seam, wired to `journalPublishNotice`.
A card tap has no reply text of its own — the durable `queued_release`
prompt_reply is the record — and the one thing that record cannot express is
"I sent only the `/compact` and held the rest".

### Waiting for the compaction — no new machinery

In print mode a lone `/compact` **is** a turn: it emits `compact_boundary`
and then its own `result` event, which clears `busy` and calls
`flushPendingSessionQueue` (`index.js`, the `result` handler). The deferred
remainder therefore delivers itself on the path that already exists. Nothing
to poll, no timeout to invent, no new session flag.

If the compaction errors, `result` still fires and the remainder still goes —
identical to any other failed turn today.

Failure paths are unchanged: `restoreQueuedBatch` prepends the rejected batch,
so a compact that could not be sent lands back at index 0 and keeps jumping.

## User-facing copy

**On queue** — only when something else is already waiting (alone in the queue
there is nothing to jump and nothing to wait for, so the tile stays as-is):

> 📨 Queued: `/compact` — jumping ahead of 2 queued messages; they'll be sent
> once compaction finishes.

**On turn-end flush:**

> 📬 Sending `/compact` first — the other 2 queued messages follow once
> compaction finishes.

followed, after the boundary, by the normal
`📬 Sending 2 queued messages: …`.

**On "⚡ Send all now" / typed `send`:**

> ⚡ Sending `/compact` now — the other 2 messages will follow once compaction
> finishes.

**Card payload shape is unchanged** — action ids and values stay `send` /
`cancel`, so every shipped client renders and routes the card exactly as it
does today.

The jumping card's label *strings* do change, and deliberately: with a queue
behind it the existing logic would label it "⚡ Send all now", which is now
false — tapping it sends only the compact. It gets the single-item labels
("⚡ Send now" / "✕ Cancel") and a question that says where the rest went.
This is a small deviation from the originally-presented "labels unchanged"; the
compatibility promise was about the payload shape, and leaving a label that
misdescribes what the button does is worse than changing prose.

## Edge cases

- **Two queued `/compact`s** — each is delivered alone, back to back. The
  second unshift places it ahead of the first; harmless. No dedupe, no
  dropped input.
- **Compact alone in the queue** — `compactBatchSize` returns `queue.length`
  (1), so the flush is byte-identical to today's.
- **Codex sessions** — have no `/compact`; the predicate never matches and
  the existing interrupt/restore branch in `flushQueue` is unaffected.
- **Media entries** — never match; `journalQueueMedia` keeps pushing.
- **Known wart:** unshifting shifts the positional `cancel:<n>` value baked
  into already-posted tiles by one. Structured journal taps resolve by stable
  `itemId` (`entry.itemIds`) and are unaffected; only the legacy Matrix-shaped
  compat branch of `resolveQueueReleaseTap` — documented as unreachable in
  production since outbound Matrix was retired — could mis-target. Recorded
  in a code comment rather than fixed.

## Tests

- `test/compact-priority.test.js` (new, pure): `/compact`,
  `/compact focus on the parser`, `  /compact  `, `//compact`, `/compacted`,
  `compact`, empty, non-text entries; `compactBatchSize` for
  `[compact]`, `[compact, other]`, `[other, compact]`, `[]`.
- `test/busy-queue.test.js`: compact-in-queue cases for both `send` paths —
  one entry flushed, remainder and its notifications left in lockstep, reply
  copy reports the deferred count, a failed flush restores the compact to the
  front, a tap on a *non*-compact card still sends the compact first, and the
  no-compact / lone-compact / empty-queue cases stay byte-identical to today.
  Plus tile cases for the jump copy, the front insert, and the single-item
  labels with unchanged action ids/values.
- `test/busy-queue.test.js` (source inspection, matching the existing pins in
  that file): `flushPendingSessionQueue`'s split, its deferred retention, and
  that it retires only the flushed batch's notifications.
- `test/queue-flush.test.js`: a case pinning that a single compact entry
  merges to exactly one text block (`planQueueFlush` itself is unchanged).
