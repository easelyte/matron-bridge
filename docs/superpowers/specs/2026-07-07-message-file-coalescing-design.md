# Coalescing a message + file(s) into one Claude turn — design

**Date:** 2026-07-07
**Status:** Draft (pending spec review)
**Repo:** easelyte/claude-matrix-bridge (`/opt/matron/bridge`)
**Mode scope:** print/SDK mode (`MATRON_INTERACTIVE_MODE=0`, the live deployment). iv-mode paths are dormant and out of scope except where noted.

## Problem

An operator wants to send **a text message alongside one or more file/image attachments** and have Claude receive them as a **single turn** ("review these mockups: …" + 3 images → one prompt). Today the bridge fragments this:

- **Matrix has no native "one message = text + N files" event.** Every client (Element web/desktop/mobile) sends **each attachment as its own timeline event**, and the composer text as *yet another* event. Element uploads files **in parallel**, so events emit as each upload finishes — arriving **out of send-order** (small files first) and **spread over seconds** for large files. Gallery grouping (MSC2881) and multi-caption remain unmerged proposals, not deployable. (Sources: MSC2530, MSC2881, Element roadmap #13.)
- **The bridge dispatches one Claude turn per idle event.** In `index.js` the `room.message` handler (registered `client.on('room.message', async …)`, line 4418) reaches the idle path at 4978-5057 and calls `sendToSession` / `sendTextToSession` **immediately, per event**. A burst of "text + 3 files" becomes up to 4 uncorrelated turns.
- **Handlers run concurrently.** `matrix-bot-sdk` emits `room.message` synchronously and does **not await** the async listener; there is **no per-room mutex**. Media handlers `await downloadMatrixFile` (3345) before doing anything, so sibling events interleave and a text event can beat its own files. Any fix must be **timer-flushed, not order-dependent**.

There is already a coalescer for the **busy** path: while `session.busy` is true, messages queue (`session.queuedMessages`, gate at 4821) and `flushQueue` (2632-2661) merges them into **one** `sendToSession` on turn-end (`case 'result'`, 2181-2194). The **idle** path has no equivalent hold. This design adds one.

### Secondary defect surfaced during the trace (fold into this work)

`buildMediaContentBlocks` (3338-3402) mishandles **captioned media**:
- The caption append at 3396-3399 is gated on `content.msgtype === 'm.file'`, so **`m.image` captions are dropped** (this half *is* m.image-specific).
- The filename-from-body defect is **not** m.image-specific: `fileName = content.body || 'file'` (3346) is computed once and used by **both** the m.image branch (3364) and the generic/m.file branch (3374). Per MSC2530, when a caption is present `filename` holds the real name and **`body` holds the caption** — so **both** a captioned image *and* a captioned m.file are saved under the caption-as-filename today; the image additionally drops its caption.

The spec-correct rule (MSC2530, now in the CS API): *`body` is the caption when `filename` is present and `body !== filename`; `formatted_body` takes priority as caption text if present.* `lib/iv-uploads.js:resolveUploadMeta` already encodes the filename/caption half of this correctly (minus `formatted_body`).

## Goal

1. A burst of Matrix events (0–1 text + N attachments) whose **inter-event gaps stay under the quiet window** (`COALESCE_QUIET_MS`, which resets on each event up to the hard cap) lands as **one Claude turn** with all content blocks merged, when the session is idle. Two honest bounds: (a) **timing** — a burst whose events are spread *wider* than the quiet window splits (inherent to any debounce; the window is tunable, and the hard-cap extends it while events keep flowing); (b) **ordering** — the **universal** opt-in coalesces any ordering within the timing bound, while the **media-anchored default** additionally does not coalesce a text event arriving strictly before all of its own files (degrades to two turns — text, then files). Neither *splits* case loses data; the one accepted loss is a **bridge-process restart while events are buffered** (see Restart limitation). See "Hold-trigger policy" for why media-anchored is the default.
2. Captioned images and files are saved under their **real filename** and their **caption is delivered** to Claude (both m.image and m.file; honor `formatted_body` when present).
3. Solo text chat and single-file sends keep working with **minimal added latency** and an explicit **kill-switch** (`MATRON_COALESCE_WINDOW_MS=0`) back to today's exact **idle-dispatch** behavior (W1 only; see Config note).
4. The coalescing + merge logic is **unit-testable in isolation** (today `index.js` has zero handler-path test coverage).
5. No regression to the busy/queue path or to bridge-command handling: a command arriving during a hold resolves the hold deterministically (discard for `!esc`/`!stop`/`!clearall`/`!flush`; flush-then-dispatch otherwise) rather than leaving a stale buffer to flush later.

## Key facts (verified against code)

| Fact | Location |
|---|---|
| Event handler is un-awaited `async`, no mutex → concurrent interleaved handlers per room | `index.js:4418` |
| Idle path = immediate one-turn-per-event | `index.js:4978-5057` |
| Busy path = queue → `flushQueue` merges into one turn on `case 'result'` | `index.js:4821`, `2181-2194`, `2632-2661` |
| `flushQueue` merge semantics: accumulate consecutive text (join `\n\n`), splice media in arrival order, single `sendToSession` | `index.js:2636-2657` |
| Quiet-timer debounce idiom (reset-on-input, flush-on-quiet, hard-cap, unref'd) | `startResumeReadyWatcher`, `index.js:2543-2609` |
| Unref'd-timer idiom (store on session, guard `.unref`) | `index.js:4970-4975` |
| `sendToSession` sets `busy=true` and writes one stdin JSON = one turn | `index.js:2405-2515` |
| m.image caption dropped (m.image-only); filename-from-body bug affects **both** m.image + m.file | `index.js:3346` (used at 3364 & 3374), `3396-3399` |
| Bridge commands (`!esc`/`!stop`/`!clearall`/`!flush`/`/model`/`/effort`) intercepted at top of handler, `return` before session dispatch | `index.js:4468-4485` |
| `isClaudeSlashCommand` requires `session.iv` → always false in print/SDK mode (`/compact` fallback is dead code here) | `index.js:4783-4784`, `4967-4976` |
| `firstMessageCaptured` one-shot latch (room naming) set at first idle event | `index.js:5006-5012`, `5030-5055` |
| Spec caption rule (`body`=caption when `filename` present & `≠ body`; `formatted_body` wins) | MSC2530 |
| No test imports `index.js`; only `lib/*` is unit-tested (`iv-uploads.test.js`) | `test/` |

## Design

Four workstreams. **W1** is the feature (idle coalescing); **W2** the caption fix (same media→blocks path); **W3** the testability extraction + shared flush core; **W4** busy-queue unification (buffer events, download at flush — removes a pre-existing media-stranding bug and shares W1's flush model). A fifth workstream — restart durability via a dispatch-driven dedup watermark — was designed and then **dropped** after review proved it unsound (matrix-bot-sdk commits the sync token to disk *before* dispatching events, so the homeserver never re-delivers in-flight events on restart; the watermark-move recovers nothing). See Restart limitation.

### W1 — Idle-path coalescing window ("idle-side flushQueue")

Insert a **per-room hold** in front of the idle dispatch. A new session buffer accumulates the **raw Matrix events**; a quiet-timer debounce then downloads all their media and dispatches **one** `sendToSession`.

**Architecture note — buffer events, not blocks (why this shape).** The obvious design buffers the *downloaded content blocks*: on receive, `await buildMediaContentBlocks`, then append. But `buildMediaContentBlocks` awaits a download (3345), and because `room.message` handlers are un-awaited and interleave (no mutex), a download resolving **after** its hold already flushed/discarded/tore-down is a straggler that must be re-routed or dropped — a problem that needs epoch tokens, in-flight counters, and resolution-kind flags, and that three review rounds each found a fresh hole in. **Buffering the raw event instead makes receive→buffer fully synchronous** (no `await` before the buffer), and moves every download into the flush, where they run **serially under one claimed turn**. The entire straggler class disappears: nothing is ever in flight between receive and buffer. This is the load-bearing simplification.

**New session state:**
- `session._coalesceBuf` — array of `{ event, meta }` in arrival order. `event` is the raw Matrix event; `meta` caches `{ msgtype, name }` (from `content.body`/`filename`) for room-naming, extracted synchronously at buffer time so naming never needs a download.
- `session._coalesceQuietTimer` / `session._coalesceHardCap` — the two unref'd timers.
- `session._coalesceStartedAt` — window open time (hard-cap + collecting-notice threshold).
- `session._coalesceNoticeEventId` — optional "collecting…" receipt event id (see UX).

(No `_coalesceInflight`, `_coalesceEpoch`, or `_coalesceResolution` — buffering events synchronously removes the concurrency that required them.)

**Where the hold hooks into `room.message`.** The handler order is: dedup (4430) → parse msgtype/text (4444) → **bridge-command detection + `handleCommand` + `return`** (4468-4485) → session lookup (4488) → **busy-queue gate** (4821) → idle dispatch (4978-5057). Commands intercept and return **before** session dispatch, so hold logic wires in at **two** points and the command branch **is** modified.

**Caption-is-not-a-command fix (W2-adjacent, Codex round-6 B3).** Today the parse step copies a **media** event's `content.body` into `text` (4450) for m.image/m.file/m.audio, and command detection (4468) then treats any `text` starting with `!`/`/` as a bridge command. So a captioned image with caption `!status` (i.e. `filename:"mock.png"`, `body:"!status"`) **executes `!status` and drops the attachment** — pre-existing, but it directly breaks W2's caption-delivery contract. Fix: **gate bridge-command detection on `msgtype === 'm.text' || msgtype === 'm.notice'`** (equivalently `!hasMedia`). A media event's caption is never a command — it flows into the media/hold path and the caption is delivered as W2 specifies. (Genuine text commands are unaffected; only the media-caption case changes.)

**P0 — command/hold resolution (at the command-detection branch, ~4468-4485).** The hold lives on the session but the command branch runs *before* the existing session lookup (4488), so P0 does an **early best-effort `const held = sessions.get(roomId)`** (read-only; no auto-start). If `held?._coalesceBuf?.length`, resolve the hold per the command's effect on the **current room's** session (`bridgeCommandNames`, 4469-4475):
- **Discard set** = `esc`, `escape`, `stop`, `restart`, `clearall`, `flush` — the commands that cancel the current turn or kill the current-room session/queue. → clear `_coalesceBuf` + both timers, edit the "collecting…" notice (if one exists) to "✕ discarded (N buffered)" (**N = `_coalesceBuf.length`**, exact — nothing is in flight), then run the command. Avoids `!restart`/`!stop` flushing a burst into a process they immediately SIGTERM (Codex/Sonnet round-2 B). `!flush`/`!clearall` discard **supersedes** their normal "nothing queued" reply.
- **Flush-then-dispatch set** = every other bridge command. This includes `start`, `resume`, `workdir` — which create a **new** room + session and leave the current-room session **untouched** (verified: they call `createSessionRoom`, never `killSession`/`sessions.delete` on the current room; Sonnet round-3 B1) — plus the read-only/config commands (`status`, `show`, `sessions`, `help`, `mcp`, `model`, `effort`, `cost`, `usage`, `tools`, `label`, `role`, `who`). → `_flushCoalesceBuffer(held)` first (dispatches the burst to the current session), then dispatch the command. **No `!send` token** — immediate flush is reachable via the "collecting…" **Send now** button.
- No hold (or no session) → proceed exactly as today.

**P1 — idle-path buffering (replaces the immediate dispatch at 4978-5057; reached only when the busy-gate at 4821 found the session idle).** Fully synchronous — no `await`. The trigger gate depends on the hold-trigger policy:
- **Default (media-anchored):** if the event is **media** → buffer it (steps 1-2 below), opening the hold if closed. If the event is **text**: buffer it *only if a hold is already open* (`_coalesceBuf.length > 0` or a timer is armed); otherwise fall through to **today's immediate dispatch** (`sendTextToSession`, 5018) with no hold — zero added latency.
- **Universal (`MATRON_COALESCE_UNIVERSAL=1`):** every event (text or media) buffers.

Buffering steps:
1. Push `{ event, meta }` onto `_coalesceBuf` (extract `meta = { msgtype, name }` from `event.content` now).
2. Arm/extend the window: open if closed (`_coalesceStartedAt = Date.now()`, start both timers) or reset the quiet timer. Boundary: if `Date.now() - _coalesceStartedAt >= COALESCE_HARDCAP_MS` at arm, flush immediately instead of scheduling.

Because there is no `await` between "event received" and "event buffered," two interleaved handlers cannot race the buffer — each push is atomic on the single JS thread.

**Flush (`_flushCoalesceBuffer(session, reason)`)** — `reason ∈ {quiet, hardcap, command, button}`:
1. **Claim the events synchronously (before any `await`):** if `_coalesceBuf` is empty → clear timers + notice, return. Else snapshot `_coalesceBuf`, then **clear `_coalesceBuf` + both timers + `_coalesceNoticeEventId`** and start the typing indicator. This claims the *events* (a concurrent timer/command flush now finds an empty buffer and no-ops) but does **not** set `session.busy` — that stays false until the actual `sendToSession` in step 4. Deliberately *not* claiming `busy` here: setting it before the downloads would route a concurrent event through the existing busy-queue path (4897), which `await`s its own download before pushing — and if this turn ends before that push, the event strands (Codex round-5 B2). Leaving `busy` false keeps a concurrent event inside *this* coalescer (its own window / immediate dispatch), where downloads always complete before dispatch.
2. **Per-entry build (await, serial):** for each snapshot entry:
   - **text** entry → `blocks = [{ type:'text', text: entry.event.content.body }]` (no download; `buildMediaContentBlocks` returns `[]` for a text event since it has no mxc URL, so text MUST take this explicit path — Codex round-5 B1).
   - **`m.audio`** entry → post the existing "Transcribing voice note…" notice, `await buildMediaContentBlocks`, then edit the notice with the transcription preview — **preserving the voice-note UX (4982-5001)** the pivot would otherwise drop.
   - **other media** entry → `blocks = await buildMediaContentBlocks(entry.event, session)`.
   Wrap each media build in `try/catch`. A per-event download failure (network/404/E2E) is **fail-visible**: post an operator notice naming the attachment ("⚠️ Couldn't download `<meta.name>` — sending the rest without it") **and** insert a marker block `[attachment "<meta.name>" failed to download and was omitted]` at that entry's position, so Claude is told a file is missing rather than silently answering incomplete context (V6). Skip only the binary content, never abort the burst.
3. **Merge:** `mergeContentBlockGroups(perEventBlocks)` (already `blocks[][]`) → one content-block array. Failure markers and text blocks merge normally. The merge is non-empty whenever the snapshot was non-empty (text always yields a block; a failed media entry always yields a marker); defensive-empty → return.
4. **Dispatch (the one busy check):** if `session.busy` (a queued turn started while we were downloading) → route merged to the existing `queuedMessages` path (it flushes at that turn's end; note the merged blocks are already downloaded, so no stranding). Else `sendToSession(session, merged)` → one turn. **Implementation invariant (MUST):** no `await` between the busy read and the dispatch call, and `sendToSession` stays synchronous through its `session.busy = true` + `stdin.write` (2405-2513) — this run-to-completion atomicity is what serializes two concurrent flushes (the loser reads the winner's `busy` and routes to the queue; Sonnet round-4 verified). Add a code comment. False `sendToSession` → existing "session not available" reply.
5. **Room-naming gated on `!session.firstMessageCaptured`** (preserves the one-shot latch; auto-resume pre-sets it at 4498): if unset, name from the snapshot's text member (Gemini title) else the first attachment's `meta.name`; set the latch once.
6. **`chatHistory` only when text present:** push one combined string of all text segments **iff ≥1 exists** (media-only burst writes nothing, matching 5017-5029); persist.

**Dual-timer mechanism (matches `startResumeReadyWatcher`, 2543-2609).** `_coalesceQuietTimer` (reset on each arm) + `_coalesceHardCap` (armed once at window open). Quiet fire → `_flushCoalesceBuffer(_, 'quiet')`; hard-cap fire → `_flushCoalesceBuffer(_, 'hardcap')`. Either flush clears the other timer in step 1, so the hard-cap is always honored as the ceiling (`COALESCE_HARDCAP_MS` bounds total buffering time; the subsequent serial downloads are ordinary turn latency, not hold extension). Both unref'd.

**Window semantics.** Quiet resets on each arm (`COALESCE_QUIET_MS = 800`), extending up to `COALESCE_HARDCAP_MS = 12000`. Since buffering is download-free, the window measures inter-event silence only — a lone slow attachment can't fire the timer early or hold it open (its event is already buffered; the download waits for flush).

**Hold-trigger policy — media-anchored default (settled at spec-review round 4):**

- **Default = media-anchored.** A **media** event (m.image/m.file/m.audio) opens or extends the hold; a **text** event *joins* an already-open hold but, if no hold is open, **dispatches immediately** (exactly today's behavior — zero added latency). This delivers the actual goal — text + files coalesce in the common Element pattern where the composer text is sent at/after the attachments — while (a) never adding latency to solo text chat and (b) never merging two independent rapid text messages into one turn (the universal-hold side effect flagged in round 4). The one uncovered ordering — a text event arriving *strictly before* all of its own files — degrades to two turns (text, then files), not data loss.
- **Opt-in: universal hold** (`MATRON_COALESCE_UNIVERSAL=1`). *Every* idle message (text or media) enters the window, additionally catching the text-strictly-before-files ordering, at the cost of ~`COALESCE_QUIET_MS` latency on every solo text **and** coalescing independent rapid texts. Off by default.
- **Kill-switch / tuning.** `MATRON_COALESCE_WINDOW_MS` overrides `COALESCE_QUIET_MS`; **`0` disables W1 coalescing entirely** → exact current per-event idle behavior (adapter-kill-switch pattern). Lower to 300 if 800ms feels laggy on a media hold.

**Concurrency model.** Handlers are un-awaited and interleave, but the coalescer touches shared state only in **synchronous** critical sections: (a) P1 buffers `{event, meta}` with no `await`, so interleaved receives can't race the push; (b) flush step 1 synchronously snapshots-and-clears the buffer + timers before any `await`, so two flushes (dual timers, or a command + a timer) never process the same events — the second finds an empty buffer and no-ops; (c) all downloads happen in flush step 2 *after* that claim, and a new event arriving mid-download sees the session still idle (we don't set `busy` until step 4) and enters *this* coalescer — its own media window or an immediate text dispatch — **not** the existing busy-queue path, so it can't strand there. The single `session.busy` check in flush step 4 serializes two concurrent flushes: whichever reaches step 4 first sends and sets `busy` (synchronously, no `await` between check and send), the other reads `busy=true` and routes its *already-downloaded* merged blocks to `queuedMessages` (flushes at turn-end, no stranding). No epoch/inflight/resolution machinery is needed — nothing is in flight between receive and buffer.

*Accepted minor — cross-burst ordering:* if burst A (media, slow download) is overtaken by a later burst B (fast/text) whose flush reaches step 4 first, B's turn lands before A's and A defers to `queuedMessages` behind it. Rare (needs a second burst inside A's multi-second download window), no data loss, self-heals at turn-end. Accepted rather than fixed with a pre-download `busy` claim, because that claim reintroduces the worse B2 stranding path (Codex round-5). Block order *within* a merged turn follows arrival order — cosmetic; Claude reads all blocks in one turn.

**Teardown is fail-visible (P3).** At `killSession` (5794) and the idle-reaper/`_autoStopped` auto-stop branch (5828), a **non-empty** `_coalesceBuf` → clear both timers, emit an operator notice ("⚠️ Session ended before dispatch — N buffered message(s) discarded; resend to continue") with **N = `_coalesceBuf.length`** (exact), and `console.log` count + room. Best-effort (no auto-requeue in this scope), but never silent. A flush already past its step-1 event-claim when teardown fires is a normal in-turn teardown (buffer already cleared) — the merged turn either sent or hits the dead-session guard in `sendToSession`.

**Interaction matrix:**
- **Busy when a member arrives** → existing queue path (4821), unchanged. The coalescer governs the idle path only.
- **Command during a hold** → P0 (early best-effort session lookup): **discard** for `esc`/`escape`/`stop`/`restart`/`clearall`/`flush`; **flush-then-dispatch** for all others (incl. `start`/`resume`/`workdir`, which spin up a new room and leave the current session's burst to flush cleanly).
- **Slash-shaped text in print/SDK mode** (`/compact` etc. that are *not* bridge commands) → `isClaudeSlashCommand` requires `session.iv`, **always false in this mode**, so such text is an ordinary `m.text` event buffered and folded into the coalesced turn as literal text. No `_operatorCompactPending` interaction here (iv-only dead code in print mode).
- **Teardown during a hold** → fail-visible discard (above).

**UX — "collecting" affordance.** When a hold's total elapsed time (`Date.now() - _coalesceStartedAt`) crosses a threshold (default 1500ms) with ≥1 buffered event, post one "📎 Collecting attachments…" notice with a **Send now** button (reuse `sendButtonMessage`; the button calls `_flushCoalesceBuffer(session, 'button')`). Edit/clear on flush or discard **only if `_coalesceNoticeEventId` exists** (sub-threshold holds never posted one — skip silently). Signed-link fallback where buttons are unavailable (4925-4938).

**Restart limitation (accepted — restart-durability was investigated and is not worth the cost).** A bridge-process restart (crash or `restart.sh` SIGTERM) while events are buffered — in the idle hold (≤`COALESCE_HARDCAP_MS`) or the busy-queue — loses those un-dispatched events. **Root cause is in the SDK, not this feature:** `matrix-bot-sdk@0.8.0` runs with `persistTokenAfterSync=false` (default, unmodified) and commits the next sync token to disk *synchronously, before* `processSync` emits any `room.message` for the batch (`MatrixClient.ts:709`, `SimpleFsStorageProvider.ts:39`; verified round-7). So on restart the homeserver does **not** re-deliver in-flight events — no app-level watermark change can recover them. **This is a pre-existing, bridge-wide property**: any event mid-batch at restart is lost today, feature or not. The coalescer widens the exposure by up to `COALESCE_HARDCAP_MS`; the busy-queue already had an unbounded version of it. Real fixes (defer the SDK sync-token commit until post-dispatch, or persist buffered events to a local store — persist-then-acknowledge) are materially larger and riskier than the coalescing feature and were dropped as not worth it for a rare, resend-recoverable loss. **Cheap lever:** a lower `COALESCE_HARDCAP_MS` shrinks the hold exposure. If crash-durability is ever wanted, it belongs in its own spec (it's a bridge-wide sync-contract change, not a coalescer detail).

### W2 — Caption correctness in `buildMediaContentBlocks`

Generalize caption handling to all media msgtypes and fix the filename bug. Note the filename-from-body defect is **not** m.image-specific: `fileName = content.body || 'file'` (3346) is computed once and used by **both** the m.image branch (`deduplicateFilename(uploadsDir, fileName)`, 3364) and the generic/m.file branch (3374), so a captioned **m.file** is *also* saved under its caption-as-filename today. W2 fixes both.

- Derive `{ filename, caption }` **once** via `resolveUploadMeta(content)` (already spec-correct for filename/caption) and use `filename` for the on-disk name across **all** branches, replacing the raw-`body` derivation at 3346. Real filename even when captioned.
- Replace the m.file-only caption append (3396-3399) with a **msgtype-agnostic** append: if `caption` is non-null, push `{ type:'text', text: caption }`. Covers m.image, m.file, m.video.
- **`formatted_body` precedence** (MSC2530: formatted caption wins) is applied **in `buildMediaContentBlocks` (the print-mode caption block)**, *not* in `resolveUploadMeta`. `resolveUploadMeta` lives in `lib/iv-uploads.js` and is shared with the (out-of-scope, dormant) iv-mode branch at 3356; leaving its behavior byte-identical keeps W2 from silently altering iv-mode. So: `caption = stripToText(content.formatted_body) || resolveUploadMeta(content).caption`.
- Voice notes (m.audio) keep transcription; a caption on audio (rare) can also be appended.

Independently correct, ~15 lines. Ships with W1 because W1 feeds these blocks into the merge and captioned bursts are a primary use case. **Rollback for W2/W3 is `git revert`, not the `MATRON_COALESCE_WINDOW_MS=0` kill-switch** — that flag disables only W1's idle hold (see Config summary note); W2 is a low-risk bug fix touching the media→blocks path.

### W3 — Extract merge + window into `lib/message-coalescer.js` (testability)

`index.js` is imported by **no test**. To make W1 reviewable, extract the pure/near-pure logic into a `lib/` module (the repo's established testable-unit pattern, like `iv-uploads.js`):

- `mergeContentBlockGroups(groups: blocks[][]) → blocks[]` — the `flushQueue` merge, pure, extracted so every path shares one merge.
- `downloadAndMerge(entries, session) → blocks[]` — the shared **flush core**: serial per-entry build (text → text block; media → `buildMediaContentBlocks`; per-entry `try/catch` + fail-visible marker per W1 step 2), then `mergeContentBlockGroups`. Used by **both** the coalescer flush *and* the busy-queue flush (W4), so the two buffering paths can't drift. **Location (Sonnet round-7 M1):** `downloadAndMerge` stays in `index.js`, *not* `lib/message-coalescer.js` — it calls `buildMediaContentBlocks` (index-private, coupled to `downloadMatrixFile`/`transcribeAudio`/fs), so moving it to `lib/` would create a circular import. Only the **pure, index-independent** pieces go to `lib/message-coalescer.js`: `mergeContentBlockGroups` and the download-free window controller. That's enough for the unit-test goal (the download orchestration is thin; the merge + windowing hold the logic worth testing in isolation).
- A download-free **window controller** with an **injectable clock/timer** (so tests are deterministic): `push(entry)`, `onFlush(cb)`, honoring quiet + hard-cap. `index.js` wires the real `setTimeout`; tests inject a fake — fully unit-testable without Matrix/network mocking.

### W4 — Busy-queue unification: buffer events, download at flush

The existing busy-queue path **awaits a media download before pushing** to `queuedMessages` (4897-4900); an event whose download outlasts the turn pushes *after* the turn-end flush (2181) and strands (then is nulled at the next turn start). Fix — make the busy-queue mirror the coalescer's buffering model:
- When busy, push the raw `{ event, meta }` (synchronous, **no download**), not pre-built blocks.
- `flushQueue` becomes **async** and routes through the shared `downloadAndMerge` (W3) — download each queued event serially, merge, `sendToSession`. The result-handler call site (2193) is already un-awaited with nothing after it in the `case 'result'` block (verified — `break` at 2196), so awaiting it is safe.
- Removes the await-then-push stranding and makes queued media survive the turn boundary. The idle-coalescer and busy-queue now share one buffering model (buffer `{event,meta}` → `downloadAndMerge` at flush), differing only in flush trigger (timer vs turn-end).
- **Entry-shape migration — all consumers (Sonnet round-7 M1).** The queued entry changes `blocks[]` → `{event,meta}`, so **every** reader must migrate, not just the index-based verbs (`!clearall`/`!flush`/`send`/`interrupt`/`cancel`, 4823-4891, which are shape-agnostic and unchanged). `formatQueueSummary` (2611-2630) **does** inspect block internals (`blocks.every(b=>b.type==='text')` / `blocks.filter(...)`) and must instead derive its preview from `meta` (`meta.msgtype`/`meta.name`); update it and **all its callers**: the busy `case 'result'` flush (2185), iv-mode `onTurnEnd` (978), the button `interrupt` handler (4602), the `send`/`interrupt` command (4848), and the `/flush-queued` HTTP endpoint (5587).
- **iv-mode boundary (Sonnet round-7 M2).** `flushQueue`/`formatQueueSummary` are shared with the iv-mode `onTurnEnd` path (941-989, out of scope per Non-goals). Making `flushQueue` async turns its un-awaited call at 987 into fire-and-forget inside a synchronous callback. This is acceptable (no code after it depends on completion) but MUST be explicitly verified and, if the download-at-flush can throw, wrapped so an iv-mode turn-end can't surface an unhandled rejection. Carve this out in Non-goals: W4 *does* touch the shared `flushQueue`/`formatQueueSummary` functions, but not iv-mode-specific behavior.

## Testing

New `test/message-coalescer.test.js` (Node built-in test runner, matching existing `test/*.test.js`):
- **merge**: single text passes through; consecutive texts joined `\n\n`; media splice preserves order; text+media interleaved → correct merged array; empty groups skipped.
- **window** (fake clock, download-free controller): single entry flushes after quiet elapses; rapid entries reset the quiet timer and flush once; hard-cap fires even under a never-quiet stream and always clears the quiet timer (ceiling honored); boundary (`elapsed >= hardcap` at arm) flushes immediately; flush-then-late-arrival opens a fresh window.
- **text buffering + merge** (Codex round-5 B1): a text entry in the buffer produces a `[{type:'text', …}]` block from `event.content.body` (NOT `buildMediaContentBlocks`, which returns `[]` for text) and appears in the merged turn; an image+text burst dispatches one turn containing both.
- **flush claim/dispatch** (model `buildMediaContentBlocks`/`sendToSession`/`queuedMessages` as spies): empty buffer → no-op; step-1 clears the buffer synchronously so a second concurrent flush finds it empty and no-ops (no double-process); `busy` is NOT set until step 4; two flushes reaching step 4 → first sends+sets `busy`, second reads `busy=true` and routes its already-downloaded merged blocks to `queuedMessages` (no double-send, no stranding); dead session at dispatch → "not available" reply.
- **partial media failure** (fail-visible): one of several attachments rejects → an operator notice names `<meta.name>`, a `[attachment "…" failed…]` marker block is inserted at that position, and the rest of the burst still dispatches as one turn.
- **audio status:** an `m.audio` entry posts "Transcribing voice note…" before its download and edits it with the preview after — preserved through the flush path.
- **media-anchored gate:** a solo text event (no open hold) dispatches immediately via `sendTextToSession` (no window); a text event with an open media hold joins it; under `MATRON_COALESCE_UNIVERSAL=1` a solo text opens a window.
- **caption-is-not-a-command** (Codex round-6 B3): a captioned media event with `body:"!status"` / `body:"/model x"` is treated as media (buffered, caption delivered), NOT dispatched to `handleCommand`; a genuine `m.text` `!status` still routes to the command handler.
- **split-burst timing bound:** events spaced wider than the quiet window flush as separate turns (documents the debounce bound, not a bug); events within the window coalesce; the hard-cap bounds a fast never-quiet stream.
- **W4 busy-queue** (spied `downloadAndMerge`/`sendToSession`): a media event received while busy is queued as raw `{event,meta}` (no download at enqueue); async `flushQueue` downloads at turn-end and dispatches; a media download that would outlast the turn no longer strands; `!clearall`/`cancel`/`send` queue verbs operate correctly on `{event,meta}` entries; `formatQueueSummary` derives its preview from `meta` (not block internals) and all five call sites (result-flush, onTurnEnd, button-interrupt, send/interrupt cmd, /flush-queued) render correctly with the new entry shape.
- **command/hold resolution:** discard-set command (`!esc`/`!stop`/`!restart`/`!clearall`/`!flush`) with an open hold → buffer+timers cleared, notice N = buffer length, no dispatch; `start`/`resume`/`workdir` and read-only commands → flush-then-dispatch ordering; `!restart` specifically does **not** flush into a doomed session.
- **teardown:** non-empty buffer on session death → operator notice with N = buffer length, count logged, timers cleared.
- **media-only burst:** flush writes nothing to `chatHistory` (no empty-string entry).
- **caption** (extend `test/iv-uploads.test.js` or new `test/media-blocks.test.js` if `buildMediaContentBlocks` is extracted enough to test): m.image with caption → real filename + caption block; captioned m.file → real filename (not caption) + caption block; `formatted_body` precedence applied in the block builder (and `resolveUploadMeta` behavior unchanged); no-caption unchanged.

Manual smoke on the live bridge (a real Element burst) after unit green, since the handler itself stays untested end-to-end.

## Config summary

| Var | Default | Effect |
|---|---|---|
| `MATRON_COALESCE_WINDOW_MS` | `800` | Quiet window ms; **`0` disables coalescing** (exact current behavior). |
| `MATRON_COALESCE_HARDCAP_MS` | `12000` | Max total hold per burst. |
| `MATRON_COALESCE_UNIVERSAL` | `0` | `1` → universal hold (every idle message enters the window). Default is media-anchored: media opens the hold, solo text with no open hold dispatches immediately. |

**Kill-switch scope:** `MATRON_COALESCE_WINDOW_MS=0` disables **only W1's idle hold** (falls back to today's per-event idle dispatch). It does **not** revert W2 (caption/filename correctness), W3 (extraction), or W4 (busy-queue unification) — those are always-on and roll back via `git revert`. **W4 in particular is *not* covered by the runtime kill-switch** — disabling W1 leaves the busy-queue refactor live, so a production regression in the queue path requires a code revert, not an env flip. It touches a load-bearing path; the kill-switch protects W1 only.

## Rollout

Branch off `main` (current checkout is on `integrate/upstream-sync-20260613` — do **not** build on that). Ship with `MATRON_COALESCE_WINDOW_MS` defaulted on; the `0` kill-switch is the instant rollback if the hold misbehaves in production. Restart via the service's `restart.sh`.

## Scope cuts (from the ambitious default, if needed)

- **A (slim):** W2 caption fix only (~15 lines) — delivers captioned single-image sends, skips coalescing. The operator declined this (chose C).
- **B (phased):** W1 + W3 without the "collecting" Send-now UI and without the `MATRON_COALESCE_UNIVERSAL` lever — media-anchored coalescing works, minus the big-burst affordance and the universal opt-in.
- **C (default, chosen):** W1 + W2 + W3, **media-anchored** default hold, `MATRON_COALESCE_UNIVERSAL` opt-in, `MATRON_COALESCE_WINDOW_MS=0` kill-switch, collecting affordance.

## Non-goals

- Server-side gallery grouping (MSC2881) — not deployable.
- Restart/crash durability of buffered events — a bridge-wide SDK sync-contract concern (see Restart limitation), explicitly out of scope; if wanted, its own spec.
- iv-mode (`MATRON_INTERACTIVE_MODE=1`) coalescing — dormant deployment; the PTY input path (2433-2501) would need separate handling and is out of scope. **Carve-out:** W4 does modify the shared `flushQueue`/`formatQueueSummary` functions that iv-mode's `onTurnEnd` also calls (unavoidable — they're shared); it does not add iv-mode-specific behavior, and the async-`flushQueue` change at the iv-mode call site (987) is verified fire-and-forget-safe.
