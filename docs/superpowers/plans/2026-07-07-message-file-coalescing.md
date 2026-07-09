# Message + File Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-07-message-file-coalescing-design.md` (converged, 7 review rounds)

**Goal:** Make a burst of Matrix events (a text message + N file/image attachments) sent close together arrive as one Claude turn instead of N fragmented turns, and fix captioned-media handling — in the `claude-matrix-bridge` running in print/SDK mode.

**Architecture:** A per-room debounce window buffers *raw Matrix events* synchronously on receive; on flush (quiet timer, hard-cap, command, or Send-now button) it downloads all media serially and dispatches one merged turn. Media-anchored trigger by default (a file opens the hold; text joins an open hold else dispatches immediately). When the session is busy, the coalescer pushes its merged blocks onto the existing **synchronous, unchanged** busy-queue (the async-flush unification of that queue was descoped to a follow-up). Caption correctness is fixed in the media→blocks builder. Pure logic (merge + window controller) is extracted to a `lib/` module for unit testing; download orchestration stays in `index.js` to avoid a circular import.

**Tech Stack:** Node.js (ESM), `matrix-bot-sdk@0.8.0`, vitest (test runner — `import { describe, it, expect } from 'vitest'`), single ~262KB `index.js` + `lib/*.js` helper modules.

**Risk:** medium. Touches the load-bearing message-ingress path in `index.js` (no auth/RLS/payments/data-loss surfaces, so not heavy-tier). The busy-queue and `flushQueue`/`formatQueueSummary` stay **synchronous and unchanged** (the async-flush unification was descoped) — the coalescer only *pushes* its merged `blocks[]` onto the existing queue, so no queue-consumer migration.

## Global Constraints

- **Mode:** print/SDK only (`MATRON_INTERACTIVE_MODE=0`). iv-mode paths are dormant; do not add iv-mode behavior. This plan does not modify `flushQueue`/`formatQueueSummary` (the async-flush unification was descoped), so the shared iv-mode `onTurnEnd` queue path is untouched.
- **No new runtime deps.** Use existing modules only.
- **Kill-switch:** `MATRON_COALESCE_WINDOW_MS=0` must fully restore today's per-event idle dispatch (W1 off). W2/W3 are always-on (revert via git).
- **Config defaults:** `COALESCE_QUIET_MS=800`, `COALESCE_HARDCAP_MS=12000`, media-anchored default (`MATRON_COALESCE_UNIVERSAL=0`), collecting-notice threshold `1500ms`.
- **Concurrency invariant (MUST):** in `_flushCoalesceBuffer` step 4, no `await` between the `session.busy` read and the `sendToSession` call; `sendToSession` stays synchronous through `busy=true` + `stdin.write`. This run-to-completion atomicity serializes concurrent flushes.
- **Branch off `main`** at execution (the working checkout is on `integrate/upstream-sync-20260613` — do not build on it).
- No son-of-anton principle files exist in this repo; judge implementation on engineering merit.

## Dependency graph

```
Phase 0 (branch preflight)  ──►  Phase 1 (shared helpers + caption)  ──►  Phase 2 (W1 coalescer core)
                                                                                    │
                                                                                    ▼
                                          Phase 3 (W1 commands/teardown)  ──►  Phase 4 (integration tests + smoke + docs)
```

All code changes land in `index.js` + `lib/message-coalescer.js`; phases are **sequential** (shared-file contention makes parallel execution unsafe). Phase 4 depends only on Phase 1's `downloadAndMerge` but is ordered after Phase 3 to avoid concurrent `index.js` edits.

---

## Phase 0 — Branch preflight (executable prerequisite, Codex round-5 M2)

### T-0.1: Land on a correct implementation branch off the trunk

**Files:** none (git only)

> **Execution-time premise correction (2026-07-08).** The plan as drafted said "branch off `main`." At execution the repo topology contradicted that: this bridge repo has **no `main`** — its default branch is `master`, and `master` is **stale** (45 commits behind `integrate/upstream-sync-20260613`, index.js differing by ~489 lines). `integrate/upstream-sync-20260613` is the live trunk the plan's line anchors were read against and is what the running service is checked out on. Branching off `master` would invalidate every anchor and set up a 45-commit merge collision. **Corrected base: `integrate/upstream-sync-20260613` (local HEAD `d0db1d6`); PR target: `integrate`, not master.** Executed via a dedicated `git worktree` (not an in-place branch switch) so the live `/opt/matron/bridge` checkout stays on integrate and the running service's on-disk `index.js` is never disturbed.

- [x] **Step 1 (done):** Created an isolated worktree off the trunk, leaving the live checkout untouched:
```bash
git -C /opt/matron/bridge worktree add -b vps-message-file-coalescing \
  /opt/matron/bridge-coalescing integrate/upstream-sync-20260613
ln -s /opt/matron/bridge/node_modules /opt/matron/bridge-coalescing/node_modules  # share deps (same package.json as integrate)
# worktree-local git exclude for the node_modules symlink so implementer git-add can't stage it
```
- [x] **Step 2 (done):** `git -C /opt/matron/bridge-coalescing branch --show-current` → `vps-message-file-coalescing`. Baseline `npx vitest run` green (20 files / 242 tests) before any edit. All subsequent commits land on this branch in the worktree.
- [ ] **Step 3:** Commit the design docs (copied into the worktree — untracked) as the branch's first commit: `git -C /opt/matron/bridge-coalescing add docs/superpowers/specs/2026-07-07-message-file-coalescing-design.md docs/superpowers/plans/2026-07-07-message-file-coalescing.md && git -C /opt/matron/bridge-coalescing commit -m "docs(bridge): message+file coalescing spec + plan"`. (The live bridge process is unaffected — docs aren't loaded by `index.js`, and the worktree never touches the live checkout.)

---

## Phase 1 — Shared helpers + caption correctness (foundation)

### T-1.1: Extract `mergeContentBlockGroups` into `lib/message-coalescer.js`

**Files:**
- Create: `lib/message-coalescer.js`
- Modify: `index.js` (`flushQueue`, `index.js:2632-2661` — replace its inline merge with a call to the extracted fn; add import near `index.js:24`)
- Test: `test/message-coalescer.test.js`

**Interfaces:**
- Produces: `mergeContentBlockGroups(groups: Array<Array<Block>>) : Array<Block>` — accumulates consecutive text-only groups (join with `\n\n`), splices media groups in arrival order. Pure, no `await`, no side effects.

- [ ] **Step 1: Write the failing test**
```js
import { describe, it, expect } from 'vitest';
import { mergeContentBlockGroups } from '../lib/message-coalescer.js';

describe('mergeContentBlockGroups', () => {
  it('passes a single text group through', () => {
    expect(mergeContentBlockGroups([[{ type: 'text', text: 'hi' }]]))
      .toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('joins consecutive text groups with double newline', () => {
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
    ])).toEqual([{ type: 'text', text: 'a\n\nb' }]);
  });
  it('splices media groups in arrival order, flushing text runs around them', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
    expect(mergeContentBlockGroups([
      [{ type: 'text', text: 'before' }],
      [{ type: 'text', text: 'saved' }, img],
      [{ type: 'text', text: 'after' }],
    ])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'saved' }, img,
      { type: 'text', text: 'after' },
    ]);
  });
  it('skips empty groups', () => {
    expect(mergeContentBlockGroups([[], [{ type: 'text', text: 'x' }], []]))
      .toEqual([{ type: 'text', text: 'x' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: FAIL — `mergeContentBlockGroups` is not exported.

- [ ] **Step 3: Implement (port the exact `flushQueue` merge semantics from `index.js:2632-2654`)**
```js
// lib/message-coalescer.js
export function mergeContentBlockGroups(groups) {
  const merged = [];
  let textAccum = [];
  const flushText = () => {
    if (textAccum.length === 0) return;
    const combined = textAccum
      .map((blocks) => blocks.map((b) => b.text).join('\n'))
      .join('\n\n');
    merged.push({ type: 'text', text: combined });
    textAccum = [];
  };
  for (const blocks of groups) {
    if (blocks.length === 0) continue;
    const isTextOnly = blocks.every((b) => b.type === 'text');
    if (isTextOnly) textAccum.push(blocks);
    else { flushText(); merged.push(...blocks); }
  }
  flushText();
  return merged;
}
```

- [ ] **Step 4: Refactor `flushQueue` to call it**

In `index.js:2632-2661`, replace the inline `merged`/`textAccum`/`flushText` block with:
```js
import { mergeContentBlockGroups } from './lib/message-coalescer.js'; // add near line 24
// inside flushQueue:
function flushQueue(session, queued) {
  const merged = mergeContentBlockGroups(queued);
  if (merged.length > 0) {
    if (!sendToSession(session, merged)) {
      console.log(`[QUEUE] dropped ${queued.length} queued message(s) — session dead or auto-stopped (room ${session.roomId})`);
    }
  }
}
```
(Behavior-preserving: `flushQueue` and its `queued` stay `blocks[][]` — the busy-queue is unchanged by this plan.)

- [ ] **Step 5: Run to verify pass + no regression**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**
```bash
git add lib/message-coalescer.js test/message-coalescer.test.js index.js
git commit -m "refactor(bridge): extract mergeContentBlockGroups into lib/message-coalescer"
```

### T-1.2: Add the download-free window controller to `lib/message-coalescer.js`

**Files:**
- Modify: `lib/message-coalescer.js`
- Test: `test/message-coalescer.test.js`

**Interfaces:**
- Produces: `createCoalesceWindow({ quietMs, hardCapMs, now, setTimer, clearTimer, onFlush })` returning `{ push(entry), size(), startedAt(), flush(), clear() }`. `now`/`setTimer`/`clearTimer` are injected (real: `Date.now`, `setTimeout`, `clearTimeout`; tests: fakes). Holds opaque entries; on quiet-elapsed or hard-cap it calls `onFlush(entries)` exactly once and resets. `push` returns immediately (synchronous). `flush()` force-fires immediately (used by the Send-now button T-2.4 and command flush-then-dispatch T-3.2); `clear()` drops entries + timers WITHOUT calling `onFlush` (discard, used by T-3.2 discard-set + T-3.3 teardown).

- [ ] **Step 1: Write the failing tests (fake clock)**
```js
import { createCoalesceWindow } from '../lib/message-coalescer.js';

function fakeTimers() {
  let t = 0; const timers = new Map(); let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const k = ++id; timers.set(k, { fn, at: t + ms }); return k; },
    clearTimer: (k) => timers.delete(k),
    advance: (ms) => { t += ms; for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn(); } },
  };
}

describe('createCoalesceWindow', () => {
  it('flushes one batch after quiet elapses', () => {
    const clk = fakeTimers(); const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a'); clk.advance(799); expect(flushed).toEqual([]);
    clk.advance(1); expect(flushed).toEqual([['a']]);
  });
  it('resets the quiet timer on each push and flushes once', () => {
    const clk = fakeTimers(); const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a'); clk.advance(700); w.push('b'); clk.advance(700); expect(flushed).toEqual([]);
    clk.advance(100); expect(flushed).toEqual([['a', 'b']]);
  });
  it('hard-cap fires even under a never-quiet stream and clears the quiet timer', () => {
    const clk = fakeTimers(); const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 2000, ...clk, onFlush: (e) => flushed.push(e) });
    for (let i = 0; i < 10; i++) { w.push(i); clk.advance(300); } // 3000ms of 300ms gaps
    expect(flushed.length).toBe(1);              // fired at hard-cap, once
    expect(flushed[0].length).toBeLessThanOrEqual(7); // whatever arrived by 2000ms
  });
  it('flush-then-late-arrival opens a fresh window', () => {
    const clk = fakeTimers(); const flushed = [];
    const w = createCoalesceWindow({ quietMs: 800, hardCapMs: 12000, ...clk, onFlush: (e) => flushed.push(e) });
    w.push('a'); clk.advance(800); w.push('b'); clk.advance(800);
    expect(flushed).toEqual([['a'], ['b']]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: FAIL — `createCoalesceWindow` not exported.

- [ ] **Step 3: Implement**
```js
// lib/message-coalescer.js (append)
export function createCoalesceWindow({ quietMs, hardCapMs, now, setTimer, clearTimer, onFlush }) {
  let entries = [];
  let open = false;              // boolean flag, NOT a startedAt===0 sentinel (a real now() can be 0 under a fake clock — Sonnet round-1 minor)
  let startedAt = 0;
  let quietTimer = null;
  let hardCapTimer = null;
  function fire() {
    if (quietTimer !== null) { clearTimer(quietTimer); quietTimer = null; }
    if (hardCapTimer !== null) { clearTimer(hardCapTimer); hardCapTimer = null; }
    const batch = entries; entries = []; open = false; startedAt = 0;
    return batch.length > 0 ? onFlush(batch) : undefined;   // return onFlush's (possibly-promise) result so flush() is awaitable
  }
  return {
    push(entry) {
      entries.push(entry);
      if (!open) {
        open = true; startedAt = now();
        if (hardCapMs <= 0) { fire(); return; } // boundary: hard-cap already elapsed / disabled
        hardCapTimer = setTimer(fire, hardCapMs);
      }
      if (quietTimer !== null) clearTimer(quietTimer);
      quietTimer = setTimer(fire, quietMs);
    },
    size: () => entries.length,
    startedAt: () => startedAt,
    flush() { return fire(); },   // force-fire; RETURNS the onFlush promise so callers can await (T-3.2 command flush-then-dispatch must await before running the command)
    clear() { if (quietTimer !== null) clearTimer(quietTimer); if (hardCapTimer !== null) clearTimer(hardCapTimer); entries = []; open = false; startedAt = 0; quietTimer = hardCapTimer = null; },
  };
}
```
> `flush()` calls `fire()` which already snapshots+clears+invokes `onFlush`; `clear()` drops without firing (discard). Add a test: `w.push('a'); w.flush(); expect(flushed).toEqual([['a']])` and `w.push('a'); w.clear(); <advance past quiet>; expect(flushed).toEqual([])`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: PASS (all T-1.1 + T-1.2 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/message-coalescer.js test/message-coalescer.test.js
git commit -m "feat(bridge): add download-free coalesce window controller"
```

### T-1.3: Add `downloadAndMerge` (shared flush core) in `index.js`

**Files:**
- Modify: `index.js` (new fn near `buildMediaContentBlocks`, `index.js:3338`)
- Test: `test/message-coalescer.test.js` (via a small injected-builder harness — `downloadAndMerge` takes the builder so it stays testable without full index import)

**Interfaces:**
- Produces: `async downloadAndMerge(entries, session, deps)` — used **only by the idle-coalescer's `_flushCoalesceBuffer`** (the busy-queue is unchanged by this plan). Each entry is `{event, meta}`. `deps = { buildMediaContentBlocks, sendTranscribeNotice?, editNotice?, reportFailure }`. Returns merged `blocks[]`. Per entry: text event → `[{type:'text', text: event.content.body}]`; `m.audio` → notice+build; other media → `buildMediaContentBlocks`. Per-entry `try/catch`: on failure call `reportFailure(meta.name)` and insert `{type:'text', text:'[attachment "<name>" failed to download and was omitted]'}`. Then `mergeContentBlockGroups`.

- [ ] **Step 1: Write the failing test (injected builder — no network)**
```js
import { downloadAndMerge } from '../lib/download-merge.js'; // impl lives here (Step 3) — test imports it directly, no index.js side effects
describe('downloadAndMerge', () => {
  const mkText = (body) => ({ event: { content: { msgtype: 'm.text', body } }, meta: { msgtype: 'm.text' } });
  const mkImg = (name) => ({ event: { content: { msgtype: 'm.image' } }, meta: { msgtype: 'm.image', name } });
  it('builds a text block for a text entry without calling the media builder', async () => {
    const build = async () => { throw new Error('should not be called for text'); };
    const out = await downloadAndMerge([mkText('hello')], {}, { buildMediaContentBlocks: build, reportFailure: () => {} });
    expect(out).toEqual([{ type: 'text', text: 'hello' }]);
  });
  it('inserts a fail-visible marker and continues on a media download failure', async () => {
    const build = async () => { throw new Error('404'); };
    const failures = [];
    const out = await downloadAndMerge([mkText('see this'), mkImg('mock.png')], {},
      { buildMediaContentBlocks: build, reportFailure: (n) => failures.push(n) });
    expect(failures).toEqual(['mock.png']);
    expect(out).toEqual([{ type: 'text', text: 'see this\n\n[attachment "mock.png" failed to download and was omitted]' }]);
  });
  it('merges a text + failed-media burst into one turn', async () => {
    const out = await downloadAndMerge([mkText('review'), mkImg('a.png')], {},
      { buildMediaContentBlocks: async () => { throw new Error('404'); }, reportFailure: () => {} });
    expect(out).toEqual([{ type: 'text', text: 'review\n\n[attachment "a.png" failed to download and was omitted]' }]);
  });
});
```
> Note: `downloadAndMerge` lives in `lib/download-merge.js` (Step 3) and takes `buildMediaContentBlocks` by injection, so the test imports it directly with zero `index.js` side effects (no client construction / `apiServer.listen`). **Acceptance: the test imports `downloadAndMerge` without starting the bridge.**

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: FAIL — module/export missing.

- [ ] **Step 3: Implement** (`lib/download-merge.js`, injection-based)
```js
// lib/download-merge.js
import { mergeContentBlockGroups } from './message-coalescer.js';

export async function downloadAndMerge(entries, session, deps) {
  const { buildMediaContentBlocks, sendTranscribeNotice, editNotice, reportFailure } = deps;
  const groups = [];
  for (const { event, meta } of entries) {
    if (meta.msgtype === 'm.text' || meta.msgtype === 'm.notice') {
      groups.push([{ type: 'text', text: event.content.body || '' }]);
      continue;
    }
    let noticeId = null;
    if (meta.msgtype === 'm.audio' && sendTranscribeNotice) noticeId = await sendTranscribeNotice();
    try {
      const blocks = await buildMediaContentBlocks(event, session);
      // Sonnet round-3 m2: buildMediaContentBlocks can return [] WITHOUT throwing (e.g. missing mxcUrl, index.js:3343) —
      // treat a non-thrown empty as a fail-visible miss, not a silent drop.
      if (!blocks || blocks.length === 0) {
        if (reportFailure) reportFailure(meta.name);
        groups.push([{ type: 'text', text: `[attachment "${meta.name || 'file'}" could not be processed and was omitted]` }]);
        continue;
      }
      if (noticeId && editNotice) editNotice(noticeId, blocks);
      groups.push(blocks);
    } catch (err) {
      if (reportFailure) reportFailure(meta.name, err);
      groups.push([{ type: 'text', text: `[attachment "${meta.name || 'file'}" failed to download and was omitted]` }]);
    }
  }
  return mergeContentBlockGroups(groups);
}
```
Then in `index.js`, import it and **define the deps builder `coalesceFlushDeps(session)`** (module-level) that the coalescer's `_flushCoalesceBuffer` (T-2.3) passes to `downloadAndMerge`:
```js
// index.js — module-level, references index.js internals so it lives here (not lib)
function coalesceFlushDeps(session) {
  return {
    buildMediaContentBlocks,
    sendTranscribeNotice: () => sendToRoom(session.roomId, 'Transcribing voice note…', 'Transcribing voice note…'),
    editNotice: (id, blocks) => { if (!id) return; const t = blocks.find(b => b.type === 'text' && /transcription/i.test(b.text || '')); const preview = t ? t.text.slice(0, 80) : 'Transcribed'; editMessage(session.roomId, id, preview, escapeHtml(preview)); }, // NOT a no-op — resolves the "Transcribing…" notice (Sonnet round-3 m2)
    reportFailure: (name) => { if (session.sendCallback) session.sendCallback(`⚠️ Couldn't download ${name || 'file'} — sending the rest without it`); },
  };
}
```
`downloadAndMerge` logic lives in `lib/download-merge.js` (no circular import — it only imports `message-coalescer.js`); `coalesceFlushDeps` stays in `index.js` because it closes over index internals.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/message-coalescer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/download-merge.js test/message-coalescer.test.js index.js
git commit -m "feat(bridge): add shared downloadAndMerge flush core (injection-testable)"
```

### T-1.4: W2 — caption correctness in `buildMediaContentBlocks`

**Files:**
- Modify: `index.js` (`buildMediaContentBlocks`, `index.js:3338-3402`)
- Test: `test/media-blocks.test.js` (new) — test the caption/filename derivation via a small extracted helper `resolveMediaCaption(content)` so it's unit-testable without downloads.

**Interfaces:**
- Produces: `resolveMediaCaption(content) : { filename, caption }` — `filename` via `resolveUploadMeta` (real name even when captioned); `caption = stripToText(content.formatted_body) || resolveUploadMeta(content).caption`. Used by `buildMediaContentBlocks` for the on-disk filename (all branches) and a msgtype-agnostic caption text block.

- [ ] **Step 1: Write the failing tests**
```js
import { describe, it, expect } from 'vitest';
import { resolveMediaCaption } from '../lib/media-caption.js';
describe('resolveMediaCaption', () => {
  it('captioned image: real filename + caption from body', () => {
    expect(resolveMediaCaption({ msgtype: 'm.image', filename: 'shot.png', body: 'look here' }))
      .toEqual({ filename: 'shot.png', caption: 'look here' });
  });
  it('captioned file: real filename (not caption) + caption', () => {
    expect(resolveMediaCaption({ msgtype: 'm.file', filename: 'doc.pdf', body: 'review' }))
      .toEqual({ filename: 'doc.pdf', caption: 'review' });
  });
  it('no caption: filename from body, caption null', () => {
    expect(resolveMediaCaption({ msgtype: 'm.image', body: 'photo.jpg' }))
      .toEqual({ filename: 'photo.jpg', caption: null });
  });
  it('formatted_body takes precedence, stripped to text', () => {
    expect(resolveMediaCaption({ msgtype: 'm.image', filename: 'x.png', body: 'plain', format: 'org.matrix.custom.html', formatted_body: '<b>rich</b>' }).caption)
      .toBe('rich');
  });
});
```

- [ ] **Step 2: Run to verify fail** — Run: `npx vitest run test/media-blocks.test.js` — Expected: FAIL (missing module).

- [ ] **Step 3: Implement `lib/media-caption.js`**
```js
import { resolveUploadMeta } from './iv-uploads.js';
function stripToText(html) {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() || null;
}
export function resolveMediaCaption(content) {
  const { filename, caption } = resolveUploadMeta(content);
  return { filename, caption: stripToText(content.formatted_body) || caption };
}
```

- [ ] **Step 4: Wire into `buildMediaContentBlocks`** (`index.js:3338-3402`)
  - Replace `const fileName = content.body || 'file';` (`index.js:3346`) with `const { filename: fileName, caption } = resolveMediaCaption(content);` (import `resolveMediaCaption`).
  - Replace the m.file-only caption append (`index.js:3396-3399`) with a msgtype-agnostic append: `if (caption) blocks.push({ type: 'text', text: caption });`
  - Verify the m.image (`:3362`) and generic/m.file (`:3372`) branches now use the corrected `fileName`.

- [ ] **Step 5: Run to verify pass** — Run: `npx vitest run test/media-blocks.test.js` — Expected: PASS (4 tests).

- [ ] **Step 6: Commit**
```bash
git add lib/media-caption.js test/media-blocks.test.js index.js
git commit -m "fix(bridge): deliver media captions + save under real filename (W2)"
```

---

## Phase 2 — W1 idle coalescing core

### T-2.1: Coalesce session state + config constants

**Files:** Modify `index.js` (config near `:116-121`; state init in `createSession` near `:528`)

**Interfaces:**
- Produces: config constants `COALESCE_WINDOW_MS`, `COALESCE_HARDCAP_MS`, `COALESCE_UNIVERSAL`, `COALESCE_NOTICE_MS`; session fields `_coalesceWindow` (controller instance, lazily created; its `startedAt()` supplies window-open time), `_coalesceNoticeEventId`, `_coalesceNoticeTimer`.

- [ ] **Step 1: Add config constants** (near `index.js:121`)
```js
const COALESCE_WINDOW_MS = parseInt(process.env.MATRON_COALESCE_WINDOW_MS ?? '800', 10);   // 0 disables W1
const COALESCE_HARDCAP_MS = parseInt(process.env.MATRON_COALESCE_HARDCAP_MS ?? '12000', 10);
const COALESCE_UNIVERSAL = process.env.MATRON_COALESCE_UNIVERSAL === '1';
const COALESCE_NOTICE_MS = 1500;
```

- [ ] **Step 2: Add session state** (in `createSession`, near the `firstMessageCaptured: false` line `index.js:528`)
```js
    _coalesceWindow: null,        // createCoalesceWindow instance, lazily created on first buffered event (its startedAt() gives the window-open time; no separate _coalesceStartedAt field — Sonnet round-3 m3)
    _coalesceNoticeEventId: null,
    _coalesceNoticeTimer: null,
```

- [ ] **Step 3: Commit** (`git add index.js && git commit -m "feat(bridge): coalesce config + session state (W1)"`) — no test (pure scaffolding; exercised by T-2.2+).

### T-2.2: Media-anchored idle-path buffering

**Files:** Modify `index.js` (the idle-dispatch region `:4978-5057`); Test: `test/coalesce-gate.test.js`

**Interfaces:**
- Consumes: `createCoalesceWindow` (T-1.2), config (T-2.1).
- Produces: `bufferOrDispatchIdle(session, event, { hasMedia, text, msgtype })` — decides per the media-anchored gate whether to buffer (arm the window) or dispatch immediately; extract the *decision* into a pure `shouldBuffer({ hasMedia, holdOpen, universal })` for testing.

- [ ] **Step 1: Failing test for the gate decision**
```js
import { shouldBuffer } from '../lib/message-coalescer.js';
describe('shouldBuffer (media-anchored default)', () => {
  it('media always buffers', () => expect(shouldBuffer({ hasMedia: true, holdOpen: false, universal: false })).toBe(true));
  it('solo text with no open hold dispatches immediately', () => expect(shouldBuffer({ hasMedia: false, holdOpen: false, universal: false })).toBe(false));
  it('text joins an open hold', () => expect(shouldBuffer({ hasMedia: false, holdOpen: true, universal: false })).toBe(true));
  it('universal buffers solo text', () => expect(shouldBuffer({ hasMedia: false, holdOpen: false, universal: true })).toBe(true));
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run test/coalesce-gate.test.js`

- [ ] **Step 3: Implement `shouldBuffer`** in `lib/message-coalescer.js` (pure — the disabled case is handled by the `index.js` caller, which skips coalescing entirely when `COALESCE_WINDOW_MS === 0`)
```js
export function shouldBuffer({ hasMedia, holdOpen, universal }) {
  return hasMedia || holdOpen || universal;
}
```

- [ ] **Step 4: Wire the idle path** (`index.js:4978`, replacing the immediate `hasMedia`/text dispatch): when `COALESCE_WINDOW_MS > 0` and `shouldBuffer({ hasMedia, holdOpen: !!session._coalesceWindow && session._coalesceWindow.size() > 0, universal: COALESCE_UNIVERSAL })`, lazily create `session._coalesceWindow` (with real timers + `onFlush: (entries) => _flushCoalesceBuffer(session, entries)`), extract `meta = { msgtype, name: (content.body||content.filename||'file') }`, and `session._coalesceWindow.push({ event, meta })`; arm the collecting-notice timer (T-2.4). Otherwise fall through to today's immediate `sendToSession`/`sendTextToSession` (unchanged).

- [ ] **Step 5: Run → PASS.** `npx vitest run test/coalesce-gate.test.js`

- [ ] **Step 6: Commit** — `git add index.js lib/message-coalescer.js test/coalesce-gate.test.js && git commit -m "feat(bridge): media-anchored idle buffering (W1)"`

### T-2.3: `_flushCoalesceBuffer` — claim, download, dispatch

**Files:** Modify `index.js` (new fn); Test: `test/coalesce-flush.test.js`

> **Accepted cross-burst ordering (from the spec's Concurrency model — carried forward so it isn't re-flagged as a bug).** Because the flush does NOT set `session.busy` until step 4's `sendToSession`, a later solo-text burst arriving *during* a slow media burst's download can dispatch first (it sees idle) and land its turn before the earlier media burst (which then defers to `queuedMessages` at step 4's busy-check). This is **rare** (needs a second burst inside a multi-second download window), **loses no data** (the media burst is queued, not dropped), and self-heals at turn-end. Accepted per the spec, not a defect.

**Interfaces:**
- Consumes: `downloadAndMerge` (T-1.3), `mergeContentBlockGroups`.
- Produces: `async _flushCoalesceBuffer(session, entries)` — the window controller already snapshotted+cleared its entries (passed in). **The entire body is wrapped in try/catch** (Sonnet round-3 M1): the timer-driven `fire()` path is a floating promise NOT covered by the `room.message` handler's try/catch, so an unguarded throw would silently drop the burst. Steps: (1) start typing indicator (do NOT set busy); (2) `merged = await downloadAndMerge(entries, session, coalesceFlushDeps(session))`; (3) if empty → clear typing, return; (4) **busy check**: no `await` between check and send.
  - **If `session.busy`:** `(session.queuedMessages ||= []).push(merged)` — **must lazily init the queue** (Codex confirmation B1: `createSession` does not initialize `queuedMessages`; the existing busy path inits it before push at 4893-4895, so a bare `.push` on undefined throws). Pushes `merged` (a `blocks[]`) as **one entry** onto the existing **synchronous, unchanged** busy-queue (whose sync `flushQueue` merges entries via `mergeContentBlockGroups`) — exactly like every other queuer.
  - **Else:** `if (!sendToSession(session, merged)) { <fail-visible> }` — **must check the return** (Codex confirmation B2: `sendToSession` returns `false` when `!session.alive || session._autoStopped`, e.g. the session died during the download; existing callers at 5004/2656 branch on it). On `false`, emit the existing "session not available" reply so the burst isn't silently lost.
  
  Then (5) room-naming gated on `!firstMessageCaptured`; (6) chatHistory iff ≥1 text segment. **catch(err):** `console.error('[COALESCE] flush failed', err)`, clear typing, and **preserve the burst fail-visibly** — `(session.queuedMessages ||= []).push(merged)` if `merged` was built, else push a single fail-visible text block `[{ type:'text', text:'⚠️ Couldn't process that burst — resend to retry' }]` (always a `blocks[]` entry — the busy-queue's shape), AND `sendToRoom` the "⚠️ …" notice. Never silently drop.

- [ ] **Step 1: Failing test (spied deps + fake session)**
```js
import { makeFlusher } from '../lib/coalesce-flush-kit.js'; // injection shim exporting the flush logic
describe('_flushCoalesceBuffer', () => {
  it('dispatches one turn when idle', async () => {
    const sends = []; const queued = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({ downloadAndMerge: async () => [{ type: 'text', text: 'x' }],
      sendToSession: (s, m) => { sends.push(m); s.busy = true; return true; },
      queue: (s, m) => queued.push(m) });
    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);
    expect(sends).toEqual([[{ type: 'text', text: 'x' }]]); expect(queued).toEqual([]);
  });
  it('routes to queue when busy at dispatch', async () => {
    const sends = []; const queued = [];
    const session = { busy: true, firstMessageCaptured: true };
    const flush = makeFlusher({ downloadAndMerge: async () => [{ type: 'text', text: 'y' }],
      sendToSession: (s, m) => { sends.push(m); return true; }, queue: (s, m) => queued.push(m) });
    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);
    // Busy-branch pushes the merged blocks[] as one entry onto the (synchronous, unchanged) busy-queue.
    expect(sends).toEqual([]); expect(queued).toEqual([[{ type: 'text', text: 'y' }]]);
  });
  it('no-ops on an all-failed empty merge', async () => {
    const sends = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({ downloadAndMerge: async () => [],
      sendToSession: (s, m) => { sends.push(m); return true; }, queue: () => {} });
    await flush(session, [{ event: {}, meta: { msgtype: 'm.image', name: 'x' } }]);
    expect(sends).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run test/coalesce-flush.test.js`

- [ ] **Step 3: Implement** the flush logic in an injection-testable shim `lib/coalesce-flush-kit.js` (`makeFlusher(deps)` returns the async flush), and wire it in `index.js` using `coalesceFlushDeps(session)` (T-1.3), `sendToSession` (checking its boolean return), and a `queue` that does `(session.queuedMessages ||= []).push(merged)` (lazy-init — see step 4). The busy-branch pushes the merged `blocks[]` as one entry onto the **existing synchronous busy-queue** (unchanged by this plan — same `blocks[]` entry shape every current queuer uses). Room-naming + chatHistory wiring stays in `index.js` (uses `updateRoomName`, `session.chatHistory`).

- [ ] **Step 4: Run → PASS.** `npx vitest run test/coalesce-flush.test.js`

- [ ] **Step 5: Commit** — `git commit -m "feat(bridge): _flushCoalesceBuffer claim/download/dispatch (W1)"`

### T-2.4: Dual-timer wiring + "collecting" affordance

**Files:** Modify `index.js`

- [ ] **Step 1:** Wire `session._coalesceWindow`'s `onFlush` to `_flushCoalesceBuffer`; confirm quiet/hard-cap both route through the controller (T-1.2 already guarantees single-fire + boundary).
- [ ] **Step 2:** On buffering (T-2.2), arm the collecting-notice timer **only if not already armed** (Codex round-5 M1 — dedup): `if (!session._coalesceNoticeTimer && !session._coalesceNoticeEventId) session._coalesceNoticeTimer = setTimeout(postCollectingNotice, COALESCE_NOTICE_MS)` (unref'd). `postCollectingNotice` posts "📎 Collecting attachments…" once with a **Send now** button via `sendButtonMessage` (button value **`'coalesce-flush'`**), stores the id in `_coalesceNoticeEventId`, and nulls `_coalesceNoticeTimer`. Flush and `discardCoalesceHold` both clear timer + notice id (already specified) so a fresh hold re-arms exactly one notice.
- [ ] **Step 2a: Route the button (Codex round-3 B3).** The button-response router (`index.js:4585-4668`) currently handles only `interrupt`/`cancel:*`/`model:*`/`effort:*`/`prompt-opt:*` — add a branch: `if (value === 'coalesce-flush') { if (session._coalesceWindow && session._coalesceWindow.size() > 0) await session._coalesceWindow.flush(); return; }`. Place it alongside the existing `interrupt` branch (the handler scope is already `async`, so `await` is available). Without this branch the tap falls through and is treated as ordinary text.
- [ ] **Step 3:** In `_flushCoalesceBuffer`, if `_coalesceNoticeEventId` set → edit/clear it; clear `_coalesceNoticeTimer`. Skip silently if no notice.
- [ ] **Step 4: Manual check** — send 2 images >1.5s apart via the web app; confirm one "Collecting…" notice with a working "Send now". (Covered by smoke T-4.2; no unit test for the Matrix-side notice.)
- [ ] **Step 5: Commit** — `git commit -m "feat(bridge): collecting-notice + send-now affordance (W1)"`

---

## Phase 3 — W1 command/hold resolution, caption-command gate, teardown

### T-3.1: Caption-is-not-a-command gate

**Files:** Modify `index.js` (bridge-command detection, `:4468-4485`); Test: `test/command-gate.test.js`

**Interfaces:** Produces (all in `lib/message-coalescer.js`): `BRIDGE_COMMAND_NAMES` (Set), `COMMAND_HOLD_DISCARD` (Set), `isBridgeCommandEligible({ msgtype, text })`, `commandHoldAction(cmd)`. **Codex round-1 B2:** the command-name set currently lives as a local `const bridgeCommandNames` inside the handler (`index.js:4469`); the lib helper cannot reference a handler-local. So this task **moves the canonical set into `lib/` as an exported constant and imports it back into `index.js`** — single source, no duplication/drift.

- [ ] **Step 1: Failing test**
```js
import { isBridgeCommandEligible, BRIDGE_COMMAND_NAMES } from '../lib/message-coalescer.js';
describe('isBridgeCommandEligible', () => {
  it('genuine text command qualifies', () => expect(isBridgeCommandEligible({ msgtype: 'm.text', text: '!status' })).toBe(true));
  it('media caption that looks like a command does NOT', () => expect(isBridgeCommandEligible({ msgtype: 'm.image', text: '!status' })).toBe(false));
  it('plain text is not a command', () => expect(isBridgeCommandEligible({ msgtype: 'm.text', text: 'hello' })).toBe(false));
  it('exports the full command-name set', () => expect(BRIDGE_COMMAND_NAMES.has('status')).toBe(true));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3a: Extract the command set to `lib/`.** In `lib/message-coalescer.js` add `export const BRIDGE_COMMAND_NAMES = new Set([ ... ]);` with the **exact 24 names** from the current `index.js:4469-4475` local const (copy verbatim: `start, stop, restart, resume, workdir, status, show, show_working, working, sessions, help, mcp, model, effort, cost, usage, tools, esc, escape, clearall, flush, label, role, who`). In `index.js:4469`, replace the local `const bridgeCommandNames = new Set([...])` with `import { BRIDGE_COMMAND_NAMES as bridgeCommandNames } from './lib/message-coalescer.js'` (add to the existing import). Verify the handler's `bridgeCommandNames.has(...)` call at `:4478` still resolves.
- [ ] **Step 3b: Implement `isBridgeCommandEligible`** — `(msgtype === 'm.text' || msgtype === 'm.notice')` AND leading `!`/`/` AND `BRIDGE_COMMAND_NAMES.has(text.slice(1).split(/\s+/)[0].toLowerCase())`. Wire into the command branch at `index.js:4468` so `hasMedia`/caption events skip command detection.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(bridge): captions not commands + shared BRIDGE_COMMAND_NAMES in lib (round-6/round-1 B2)"`

### T-3.2: P0 command/hold resolution (early best-effort lookup)

**Files:** Modify `index.js` (command branch `:4468-4485`)

- [ ] **Step 1:** At the command branch, add `const held = sessions.get(roomId);` (read-only, no auto-start). If `held?._coalesceWindow?.size() > 0`:
  - **Discard set** = `{esc, escape, stop, restart, clearall, flush}` → `held._coalesceWindow.clear()`, clear the notice (if any) editing it to `✕ discarded (N buffered)` with `N = size before clear`, then run the command.
  - **Else** (all other bridge commands incl. `start`/`resume`/`workdir`) → `await held._coalesceWindow.flush()` (force-flush AND wait for the burst's download+dispatch to complete — `flush()` returns the `onFlush`/`_flushCoalesceBuffer` promise, Codex round-2 M1), **then** run the command. The command branch is already `async`, so `await` is available. Without the await the command would run against the session while the burst is still downloading.
- [ ] **Step 2:** Add `export const COMMAND_HOLD_DISCARD = new Set(['esc','escape','stop','restart','clearall','flush']);` and `export function commandHoldAction(cmd) { return COMMAND_HOLD_DISCARD.has(cmd) ? 'discard' : 'flush'; }` to `lib/message-coalescer.js` (same source as `BRIDGE_COMMAND_NAMES`). Test in `test/command-gate.test.js`:
```js
import { commandHoldAction } from '../lib/message-coalescer.js';
it('discard set', () => ['esc','escape','stop','restart','clearall','flush'].forEach(c => expect(commandHoldAction(c)).toBe('discard')));
it('flush-then-dispatch set', () => ['status','model','effort','start','resume','workdir','help'].forEach(c => expect(commandHoldAction(c)).toBe('flush')));
```
- [ ] **Step 3: Run → PASS.**
- [ ] **Step 4: Commit** — `git commit -m "feat(bridge): command/hold resolution — discard vs flush-then-dispatch (W1)"`

### T-3.3: Teardown fail-visible — all THREE teardown sites

**Files:** Modify `index.js` (`killSession` `:5794`; idle-reaper/`_autoStopped` `:5828`; **and the child-crash close handler `proc.on('close')` `:571-631`** — Sonnet round-1 M1). Verify exact lines at execution.

- [ ] **Step 1: Extract a shared discard helper** with a `notify` param (valid JS — the round-1 sample's bare `...` was a syntax error, Codex round-2 B2):
```js
function discardCoalesceHold(session, reason, { notify = true } = {}) {
  const w = session._coalesceWindow;
  if (!w) return;
  const n = w.size();
  w.clear();                                            // clears entries + BOTH timers (orphan prevention)
  if (session._coalesceNoticeTimer) { clearTimeout(session._coalesceNoticeTimer); session._coalesceNoticeTimer = null; }
  if (session._coalesceNoticeEventId) { /* best-effort edit the collecting notice to discarded */ session._coalesceNoticeEventId = null; }
  if (n > 0) {
    console.log(`[COALESCE] discarded ${n} buffered on ${reason} (room ${session.roomId})`);
    if (notify) {
      const plain = `⚠️ Session ended before dispatch — ${n} buffered message(s) discarded; resend to continue`;
      sendToRoom(session.roomId, plain, escapeHtml(plain));
    }
  }
}
```
  `w.clear()` always runs (even for an empty buffer) so an orphaned window can't leave `_coalesceQuietTimer`/`_coalesceHardCap` firing against a dead session.
- [ ] **Step 2:** Call it at the two `killSession`-family sites: in `killSession` (`:5794`) `discardCoalesceHold(session, 'killSession')` — **placed immediately after the subagentWatcher-stop block and BEFORE the `if (!session.alive) return` early-return** (`index.js:5794` region; Sonnet round-2 minor), so an already-not-alive session still gets its buffer discarded + timers cleared. In the idle-reaper auto-stop branch (`:5828`), call `discardCoalesceHold(session, 'idle-reaper', { notify: false })` — **silent**, because that branch has a documented silent-reap invariant (a Matrix notice would bump the room to the top of the user's list, defeating the reap; the session is resumable via auto-resume). Log-only there; no `sendToRoom` (Sonnet round-2 major M2).
- [ ] **Step 3: Child-crash path (`proc.on('close')`, `:571-631`).** This handler fires on an unexpected child exit (crash/uncaught/non-zero) **independent of `killSession`**, and today carries `queuedMessages`/`queueNotifications` onto the `restarted` session (`:615-ish`). Decision: **discard** the coalesce hold here (don't carry it to the restarted session — the buffered events predate the crash and the timers reference the dead session object). Call `discardCoalesceHold(session, 'child-crash')` in this handler before/at the point it builds `restarted`, and do **not** add `_coalesceWindow` to the `restarted.*` carry-over list. This closes the "mid-hold crash silently loses buffer + orphans timers" gap (Sonnet M1) — distinct from the accepted whole-process Restart limitation.
- [ ] **Step 4: Manual check** — buffer 2 files, `!stop` mid-hold → discard notice fires; separately, force a child crash mid-hold (kill the claude child) → discard notice fires + no orphaned-timer errors after restart (covered by T-4.2).
- [ ] **Step 5: Commit** — `git commit -m "feat(bridge): fail-visible teardown across killSession, reaper, AND child-crash (W1, round-1 M1)"`

---

## Phase 4 — Integration tests, smoke, docs

### T-4.1: Full suite green

- [ ] **Step 1:** Run `npx vitest run` — all new + existing tests pass. Expected: PASS.
- [ ] **Step 2:** Run `npm run lint` (eslint config exists). Expected: clean.
- [ ] **Step 3: Commit** any test-only fixups — `git commit -m "test(bridge): coalescing suite green"`

### T-4.2: Manual smoke on the live bridge

- [ ] **Step 1:** From the **web app** and the **iOS app**, send a text + 3 images in one action; confirm Claude receives **one** turn with all four. Record result.
- [ ] **Step 2:** Send a captioned single image (caption text); confirm the caption reaches Claude and the file is saved under its real name.
- [ ] **Step 3:** Send a captioned image whose caption is `!status`; confirm it's treated as an attachment (not a command).
- [ ] **Step 4:** Buffer files then `!stop` mid-hold; confirm the discard notice fires.
- [ ] **Step 5:** While a turn runs, send a file; confirm it dispatches at turn-end (no stranding).
- [ ] **Step 6:** **Capture the current value first** (`grep MATRON_COALESCE_WINDOW_MS /opt/matron/bridge/.env` or note it's unset → default 800). Set `MATRON_COALESCE_WINDOW_MS=0`, restart, confirm per-event behavior restored.
- [ ] **Step 7: Restore (Codex round-4 B2 — do NOT leave production in kill-switch mode).** Restore the captured value (or remove the override to fall back to the 800 default), restart, and confirm coalescing is active again (send a text+file burst → one turn). The feature must be ON in production when the smoke pass ends.
- [ ] **Step 8:** Document results in the plan's completion notes.

### T-4.3: Config docs

- [ ] **Step 1:** Add `MATRON_COALESCE_WINDOW_MS`, `MATRON_COALESCE_HARDCAP_MS`, `MATRON_COALESCE_UNIVERSAL` to `.env.example` with one-line comments + the kill-switch note.
- [ ] **Step 2:** Note the coalescing behavior + kill-switch in `BRIDGE_CLAUDE.md`.
- [ ] **Step 3: Commit** — `git commit -m "docs(bridge): document coalescing env vars + kill-switch"`

---

## Spec coverage map

| Spec part | Task(s) |
|---|---|
| Goal 1 (one turn per burst, timing/ordering bounds) | T-2.2, T-2.3, T-1.2 |
| Goal 2 (caption delivery + real filename) | T-1.4 |
| Goal 3 (solo text unaffected, kill-switch) | T-2.2, T-2.1, T-4.3 |
| Goal 4 (unit-testable in isolation) | T-1.1, T-1.2, T-1.3, T-3.1 |
| Goal 5 (no command-handling regression) | T-3.1, T-3.2 |
| W1 P1 buffering + media-anchored gate | T-2.2 |
| W1 flush (claim/download/dispatch/naming/history) | T-2.3 |
| W1 dual-timer + collecting UX | T-2.4, T-1.2 |
| W1 P0 command/hold resolution | T-3.2 |
| W1 teardown fail-visible | T-3.3 |
| W1 caption-is-not-a-command | T-3.1 |
| W2 caption/filename fix | T-1.4 |
| W3 mergeContentBlockGroups + window controller + downloadAndMerge | T-1.1, T-1.2, T-1.3 |
| Config summary | T-2.1, T-4.3 |
| Per-task tests + full suite | each T-*.* Step-1 test + T-4.1 (full `vitest run`) |
| Restart limitation (accepted, no code) | — (documented in spec; no task) |

| W4 busy-queue unification | **DESCOPED to follow-up** (async-flush conversion generated disproportionate review collateral; the pre-existing busy-queue media-stranding it targeted remains, documented) |

**Deliberate non-coverage:** (1) restart/crash durability — dropped per spec's Restart limitation (SDK sync-contract concern); (2) busy-queue async unification (W4) — descoped this session, own follow-up spec.

## Appendix: Verified Claims (research pass 2026-07-08)

✓ **Test runner is vitest.** `package.json` declares `vitest@^4.1.8` (devDep, installed at `node_modules/.bin/vitest`) and `"test": "vitest run"`; existing `test/iv-uploads.test.js` uses `import { describe, it, expect } from 'vitest'`. Plan's `npx vitest run <file>` invocation and `describe/it/expect` API are correct. No `vitest.config.*` — defaults discover `test/**/*.test.js`.
✓ **matrix-bot-sdk drops in-flight events on restart** (verified round 7, source-traced): `persistTokenAfterSync=false` default + sync-token committed before `processSync` emits. This is why restart-durability is out of scope (spec Restart limitation) — the plan correctly has no durability task.
✓ **The busy-queue (`flushQueue`/`formatQueueSummary`) is left unchanged** — the async-flush unification (W4) was descoped, so this plan does not migrate any of those call sites. The coalescer only *pushes* a merged `blocks[]` entry onto `session.queuedMessages`, which the existing synchronous consumers already handle.
? **Exact line anchors** (3346, 3396-3399, 4468-4485, 4821, 4897-4907, 4978, 5794, 5828) are as-of this session's read of `index.js`; the executor MUST re-confirm each anchor at edit time (the file mutates via agent ticks) — flagged for adversarial reviewers.
