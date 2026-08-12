# Restart Carry-On Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a bridge restart, publish a one-tap "Carry on" card into every conversation whose turn was genuinely interrupted, and nowhere else.

**Architecture:** A file-backed marker records each in-flight turn at turn start and clears it at turn end, so detection survives a crash or `kill -9`. At boot, markers from a previous bridge process that are within a 6h window become per-chat picker cards. Tapping one auto-resumes the session and injects `carry on`.

**Tech Stack:** Node 22 ESM, vitest, existing bridge modules (`lib/atomic-write.js`, `lib/picker-dispatch.js`, `lib/journal-input-router.js`).

**Spec:** `docs/superpowers/specs/2026-08-11-restart-carry-on-design.md`

## Global Constraints

- Node `>=22.0.0`, ESM (`"type": "module"`). Use `import`, never `require`.
- Every new `lib/*.js` file MUST be appended to the `check` script in `package.json` as `&& node --check lib/<name>.js`.
- New lib modules are pure with injected impure seams (`load`/`save`/`now`/`log`), matching `lib/timer-command.js` `createTimerStore` and `lib/picker-dispatch.js`.
- Tests are vitest, live in `test/<module>.test.js`, and import from `../lib/<module>.js`.
- Lint must pass with zero warnings: `npm run lint` uses `--max-warnings=0`.
- Full gate before any task is considered done: `npm run ci` (lint + check + test + audit).
- Injected resume text is the literal string `carry on` — lowercase, no punctuation. This is a deliberate user decision recorded in the spec; do not "improve" the wording.
- Default window is 6h, overridable via `MATRON_RESTART_CARRY_ON_MAX_AGE_MS`, parsed with `parseInt(..., 10)` following `SESSION_IDLE_TIMEOUT_MS` at `index.js:159`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/inflight-marker.js` (create) | Pure file-backed store of in-flight turns; boot-generation discrimination and the age window |
| `test/inflight-marker.test.js` (create) | Unit tests for the above |
| `lib/picker-dispatch.js` (modify) | Add the `resume:` value namespace and its dispatch seam |
| `test/picker-dispatch.test.js` (modify) | Tests for `resume:` dispatch and rejection |
| `lib/journal-input-router.js` (modify) | Register `resume-` frames as pickers; allow auto-resume for a verified resume tap |
| `test/journal-input-router.test.js` (modify) | Tests for the predicate and the widened gate |
| `index.js` (modify) | Turn-boundary wiring, boot reconciliation, card publishing, tap seam |
| `package.json` (modify) | Register the new lib file in `check` |

---

### Task 1: In-flight marker store

**Files:**
- Create: `lib/inflight-marker.js`
- Create: `test/inflight-marker.test.js`
- Modify: `package.json` (`check` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createInflightMarker({ load, save, now, bootId, touchDebounceMs, log })` returning an object with:
  - `noteTurnStart(convoId, roomId): void`
  - `touch(convoId): void`
  - `noteTurnEnd(convoId): void`
  - `takeStale(maxAgeMs): Array<{ convoId, roomId, startedAt, touchedAt, ageMs }>`

- [ ] **Step 1: Write the failing test**

Create `test/inflight-marker.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createInflightMarker } from '../lib/inflight-marker.js';

function harness({ initial = {}, bootId = 'boot-2', clock = 1_000_000 } = {}) {
  const state = { data: JSON.parse(JSON.stringify(initial)) };
  let t = clock;
  const save = vi.fn((d) => { state.data = JSON.parse(JSON.stringify(d)); });
  const marker = createInflightMarker({
    load: () => state.data,
    save,
    now: () => t,
    bootId,
    touchDebounceMs: 60_000,
  });
  return { marker, state, save, advance: (ms) => { t += ms; }, at: () => t };
}

describe('noteTurnStart / noteTurnEnd', () => {
  it('records a marker stamped with the current bootId and persists it', () => {
    const { marker, state } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    expect(state.data['convo-a']).toEqual({
      roomId: 'room-a', bootId: 'boot-2', startedAt: 1_000_000, touchedAt: 1_000_000,
    });
  });

  it('removes the marker at turn end', () => {
    const { marker, state } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    marker.noteTurnEnd('convo-a');
    expect(state.data['convo-a']).toBeUndefined();
  });

  it('tolerates a turn end for an unknown convo', () => {
    const { marker } = harness();
    expect(() => marker.noteTurnEnd('nope')).not.toThrow();
  });
});

describe('touch', () => {
  it('does not persist again inside the debounce window', () => {
    const { marker, save, advance } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    const callsAfterStart = save.mock.calls.length;
    advance(30_000);
    marker.touch('convo-a');
    expect(save.mock.calls.length).toBe(callsAfterStart);
  });

  it('persists a fresh touchedAt once the debounce window has passed', () => {
    const { marker, state, advance } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    advance(61_000);
    marker.touch('convo-a');
    expect(state.data['convo-a'].touchedAt).toBe(1_061_000);
    expect(state.data['convo-a'].startedAt).toBe(1_000_000);
  });

  it('ignores a touch for an unknown convo', () => {
    const { marker, state, advance } = harness();
    advance(61_000);
    marker.touch('ghost');
    expect(state.data.ghost).toBeUndefined();
  });
});

describe('takeStale', () => {
  const prev = (touchedAt) => ({
    roomId: 'room-x', bootId: 'boot-1', startedAt: touchedAt - 5_000, touchedAt,
  });

  it('returns previous-boot markers inside the window, with age', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(940_000) } });
    const stale = marker.takeStale(6 * 3600 * 1000);
    expect(stale).toEqual([{
      convoId: 'convo-a', roomId: 'room-x', startedAt: 935_000, touchedAt: 940_000, ageMs: 60_000,
    }]);
  });

  it('never returns markers from the current boot', () => {
    const { marker } = harness({
      initial: { 'convo-live': { roomId: 'r', bootId: 'boot-2', startedAt: 999_000, touchedAt: 999_000 } },
    });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('leaves current-boot markers in place after a sweep', () => {
    const live = { roomId: 'r', bootId: 'boot-2', startedAt: 999_000, touchedAt: 999_000 };
    const { marker, state } = harness({ initial: { 'convo-live': live, 'convo-old': prev(940_000) } });
    marker.takeStale(6 * 3600 * 1000);
    expect(state.data['convo-live']).toEqual(live);
  });

  it('excludes markers older than the window', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(1_000_000 - 7 * 3600 * 1000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('includes a marker exactly at the window edge', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(1_000_000 - 6 * 3600 * 1000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toHaveLength(1);
  });

  it('clears every previous-boot marker, including out-of-window ones', () => {
    const { marker, state } = harness({
      initial: { fresh: prev(940_000), ancient: prev(1_000_000 - 7 * 3600 * 1000) },
    });
    marker.takeStale(6 * 3600 * 1000);
    expect(state.data.fresh).toBeUndefined();
    expect(state.data.ancient).toBeUndefined();
  });

  it('is fire-once — a second sweep returns nothing', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(940_000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toHaveLength(1);
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('drops malformed records without throwing', () => {
    const { marker } = harness({
      initial: { a: null, b: 'nonsense', c: { bootId: 'boot-1' }, d: { bootId: 'boot-1', touchedAt: 'soon' } },
    });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });
});

describe('load tolerance', () => {
  it('treats a throwing load as empty and logs', () => {
    const log = vi.fn();
    const marker = createInflightMarker({
      load: () => { throw new Error('corrupt'); },
      save: vi.fn(), now: () => 1, bootId: 'boot-2', log,
    });
    expect(marker.takeStale(1000)).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('treats a non-object load as empty', () => {
    const marker = createInflightMarker({
      load: () => 'garbage', save: vi.fn(), now: () => 1, bootId: 'boot-2',
    });
    expect(marker.takeStale(1000)).toEqual([]);
  });

  it('never propagates a save failure', () => {
    const log = vi.fn();
    const marker = createInflightMarker({
      load: () => ({}), save: () => { throw new Error('disk full'); },
      now: () => 1, bootId: 'boot-2', log,
    });
    expect(() => marker.noteTurnStart('c', 'r')).not.toThrow();
    expect(log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/inflight-marker.test.js`
Expected: FAIL — `Failed to resolve import "../lib/inflight-marker.js"`

- [ ] **Step 3: Write the implementation**

Create `lib/inflight-marker.js`:

```js
// In-flight turn markers — the detection half of restart carry-on prompts
// (docs/superpowers/specs/2026-08-11-restart-carry-on-design.md).
//
// A bridge restart SIGTERMs every live session (index.js signal handlers), so
// a turn that was running is destroyed. Nothing was published into the chat,
// so the interruption is silent. This store is what lets the next boot know
// which conversations were mid-turn.
//
// The marker is written at TURN START and removed at turn end — deliberately
// not snapshotted in the SIGTERM handler. A shutdown snapshot is cheaper (one
// write per restart instead of one per turn boundary) but writes nothing on an
// OOM, a crash, or kill -9, which are exactly the cases where the user has no
// other signal. Writing at turn start means nothing has to run at shutdown for
// the record to survive.
//
// Boot discrimination is by `bootId`: a randomUUID generated once per bridge
// process and stamped into every record. At boot, any record carrying a
// DIFFERENT bootId belongs to a run that no longer exists. That is the whole
// mechanism — no transcript scanning, no inference about what a partial
// transcript means.
//
// Pure with every impure edge injected (load/save/now/bootId/log), the same
// shape as createTimerStore in lib/timer-command.js, so it unit-tests without
// a live bridge.

// Age is measured from `touchedAt`, refreshed as the turn makes progress,
// rather than from `startedAt`. The question being asked is "how long has this
// conversation been dangling", not "how long did the turn run" — a legitimate
// three-hour turn still working one minute before the crash must be carded,
// and measuring from turn start would suppress it as ancient.
const DEFAULT_TOUCH_DEBOUNCE_MS = 60_000;

function isUsableRecord(rec) {
  return !!rec && typeof rec === 'object'
    && typeof rec.bootId === 'string'
    && Number.isFinite(rec.touchedAt);
}

export function createInflightMarker({
  load,
  save,
  now,
  bootId,
  touchDebounceMs = DEFAULT_TOUCH_DEBOUNCE_MS,
  log = () => {},
}) {
  let records = (() => {
    try {
      const raw = load();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    } catch (e) {
      log(`inflight marker load failed: ${e.message}`);
    }
    return {};
  })();

  function persist() {
    try {
      save(records);
    } catch (e) {
      // A lost marker means a missed card, never a broken turn — the caller is
      // on the turn-start path and must not be disturbed by a disk problem.
      log(`inflight marker save failed: ${e.message}`);
    }
  }

  return {
    noteTurnStart(convoId, roomId) {
      if (!convoId) return;
      const at = now();
      records[convoId] = { roomId: roomId ?? null, bootId, startedAt: at, touchedAt: at };
      persist();
    },

    touch(convoId) {
      const rec = records[convoId];
      if (!isUsableRecord(rec)) return;
      const at = now();
      if (at - rec.touchedAt < touchDebounceMs) return;
      rec.touchedAt = at;
      persist();
    },

    noteTurnEnd(convoId) {
      if (!records[convoId]) return;
      delete records[convoId];
      persist();
    },

    // Previous-boot markers within the window, newest information first-hand.
    // ALL previous-boot markers are cleared, including out-of-window ones:
    // this is what makes the feature fire once. Without it the same dangling
    // turn from three restarts ago would resurface on every subsequent boot —
    // the "don't dig up old dead conversations" failure in a different costume.
    takeStale(maxAgeMs) {
      const at = now();
      const stale = [];
      const kept = {};
      for (const [convoId, rec] of Object.entries(records)) {
        if (!isUsableRecord(rec)) continue;           // malformed: drop
        if (rec.bootId === bootId) { kept[convoId] = rec; continue; }  // ours: keep
        const ageMs = at - rec.touchedAt;
        if (ageMs <= maxAgeMs) {
          stale.push({
            convoId,
            roomId: rec.roomId ?? null,
            startedAt: Number.isFinite(rec.startedAt) ? rec.startedAt : rec.touchedAt,
            touchedAt: rec.touchedAt,
            ageMs,
          });
        }
      }
      records = kept;
      persist();
      return stale;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/inflight-marker.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Register the file in the check script**

In `package.json`, append to the end of the `check` script value:

```
 && node --check lib/inflight-marker.js
```

Run: `npm run check`
Expected: exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add lib/inflight-marker.js test/inflight-marker.test.js package.json
git commit -m "feat(inflight): file-backed in-flight turn marker store"
```

---

### Task 2: `resume:` picker value namespace

**Files:**
- Modify: `lib/picker-dispatch.js:38` (`PICKER_VALUE`), `lib/picker-dispatch.js:72` (`handlePickerValue`)
- Modify: `test/picker-dispatch.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `handlePickerValue` accepts a `resume:<convoId>` value and calls the injected seam `carryOnConvo(convoId, session, sendReply)`. `RESUME_CONVO_ID` regex is not exported; validation is internal.

- [ ] **Step 1: Write the failing test**

Append to `test/picker-dispatch.test.js`. Note the existing `seams()` helper at the top of that file must also gain `carryOnConvo: vi.fn()` — add it there.

```js
describe('resume: values', () => {
  it('dispatches resume:<convoId> to carryOnConvo(convoId, session, sendReply)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('resume:abc123def456', 'room-1', session, s)).toBe(true);
    expect(s.carryOnConvo).toHaveBeenCalledWith('abc123def456', session, s.sendReply);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
    expect(s.cancelTimer).not.toHaveBeenCalled();
  });

  it('accepts uuid-shaped convo ids', () => {
    const s = seams();
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(handlePickerValue(`resume:${id}`, 'room-1', {}, s)).toBe(true);
    expect(s.carryOnConvo).toHaveBeenCalledWith(id, {}, s.sendReply);
  });

  it('rejects malformed convo ids without touching any seam', () => {
    for (const bad of ['resume:', 'resume:short', 'resume:has space', 'resume:has/slash', `resume:${'x'.repeat(129)}`]) {
      const s = seams();
      expect(handlePickerValue(bad, 'room-1', {}, s)).toBe(false);
      expect(s.carryOnConvo).not.toHaveBeenCalled();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/picker-dispatch.test.js`
Expected: FAIL — `expected false to be true`, because `PICKER_VALUE` does not match `resume`.

- [ ] **Step 3: Write the implementation**

In `lib/picker-dispatch.js`, replace the `PICKER_VALUE` constant and add the id shape below it:

```js
const PICKER_VALUE = /^(model|effort|mode|timer|resume):(.+)$/;
// Timer values carry a dynamic record id (lib/timer-command.js
// timerCancelButton / timerSendNowButton emit `timer:cancel:<id>` /
// `timer:send:<id>`), so unlike the closed alias sets above they validate
// by shape: the verb must be one of the two the card's buttons emit and
// the id must be all digits.
const TIMER_ARG = /^(cancel|send):(\d+)$/;
// Restart carry-on values carry a convo id (a claude session UUID or a codex
// thread id), so they validate by shape for the same reason. Deliberately
// conservative — the authoritative check is frame provenance in
// lib/journal-input-router.js (the value must be one the frame itself
// offered); this is defence in depth against a malformed or crafted value.
const RESUME_CONVO_ID = /^[A-Za-z0-9_-]{8,128}$/;
```

Replace the `timer` branch region of `parsePickerValue` so it reads:

```js
  if (kind === 'timer') {
    const t = arg.match(TIMER_ARG);
    return t ? { kind, verb: t[1], arg: parseInt(t[2], 10) } : null;
  }
  if (kind === 'resume') {
    return RESUME_CONVO_ID.test(arg) ? { kind, arg } : null;
  }
  return ALLOWED[kind].has(arg) ? { kind, arg } : null;
```

Add `carryOnConvo` to the destructured seams of `handlePickerValue` (after `sendTimerNow`), and add the dispatch branch immediately before the trailing `// kind === 'mode'` comment:

```js
  if (kind === 'resume') {
    carryOnConvo(arg, session, sendReply);
    return true;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/picker-dispatch.test.js`
Expected: PASS, including all pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add lib/picker-dispatch.js test/picker-dispatch.test.js
git commit -m "feat(picker): resume:<convoId> value namespace"
```

---

### Task 3: Router support for resume cards

**Files:**
- Modify: `lib/journal-input-router.js:52` (`PICKER_OPTION_ID`), `lib/journal-input-router.js:446-465` (auto-resume gate)
- Modify: `test/journal-input-router.test.js`

**Interfaces:**
- Consumes: the `resume:` value convention from Task 2.
- Produces: exported pure predicate `isResumePickerTap(offeredValues, choice): boolean`, where `offeredValues` is a `Set<string>` or nullish.

**Why this task exists:** the router deliberately refuses to auto-resume on a `prompt_reply` (comment at `lib/journal-input-router.js:456`: *"A prompt_reply never resumes: its pending prompt died with the process, so there's nothing valid to answer."*). That is correct for ordinary prompts, but a restart carry-on card is published into a convo whose session is dead **by construction** — the rule would make the button inert. This task carves out only the verified resume tap and leaves the general invariant intact.

- [ ] **Step 1: Write the failing test**

Append to `test/journal-input-router.test.js`:

```js
import { isResumePickerTap, isPickerFrame } from '../lib/journal-input-router.js';

describe('isResumePickerTap', () => {
  it('accepts a resume choice the frame actually offered', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 'resume:abc123def456')).toBe(true);
  });

  it('rejects a resume choice the frame did not offer', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 'resume:other9999999')).toBe(false);
  });

  it('rejects non-resume picker values', () => {
    expect(isResumePickerTap(new Set(['model:sonnet']), 'model:sonnet')).toBe(false);
  });

  it('rejects when there is no frame', () => {
    expect(isResumePickerTap(null, 'resume:abc123def456')).toBe(false);
    expect(isResumePickerTap(undefined, 'resume:abc123def456')).toBe(false);
  });

  it('rejects a non-string choice', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), null)).toBe(false);
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 7)).toBe(false);
  });
});

describe('isPickerFrame with resume options', () => {
  it('classifies a resume- option frame as a picker', () => {
    expect(isPickerFrame({ options: [{ id: 'resume-abc123def456', value: 'resume:abc123def456' }] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/journal-input-router.test.js`
Expected: FAIL — `isResumePickerTap is not a function`, and the `isPickerFrame` case returns `false`.

- [ ] **Step 3: Write the implementation**

In `lib/journal-input-router.js`, extend the option-id pattern at line 52 and its comment block (add a line to the non-answerable list above it reading `//                   resume-*                     (restart carry-on cards)`):

```js
const PICKER_OPTION_ID = /^(?:model|effort|mode|timer|resume)-/;
```

Add the exported predicate next to `pickerFrameValues` (after line 89):

```js
// A prompt_reply that is a verified restart carry-on tap: the choice is a
// `resume:` value AND the frame it targets actually offered that value.
// Both halves matter — an AskUserQuestion option can be labelled literally
// `resume:whatever`, so value shape alone must never be trusted (the same
// stance the picker-vs-answer dispatch below takes).
export function isResumePickerTap(offeredValues, choice) {
  return !!offeredValues
    && typeof choice === 'string'
    && choice.startsWith('resume:')
    && offeredValues.has(choice);
}
```

Replace the auto-resume gate (the `let session = ...` block at lines 446-465) with:

```js
      let session = findSessionByConvoId(convoId);
      if (!session && resumeSessionForConvo) {
        // Reaped-but-resumable convo: the idle reaper kills sessions on the
        // assumption that "the next user message auto-resumes" — give the
        // caller the same chance the Matrix room path gets before declaring
        // the convo dead. Text and media both qualify (delivery after the
        // wake is safe: print mode's stdin buffers, iv mode's resume hold
        // parks input until the TUI is ready), but only with something to
        // deliver — a blank message or a blob_ref-less media frame must not
        // respawn a session.
        //
        // A prompt_reply still never resumes IN GENERAL: its pending prompt
        // died with the process, so there's nothing valid to answer. The one
        // exception is a verified restart carry-on tap, whose whole purpose is
        // to act on a session that is dead by construction — the card is only
        // ever published at boot, into convos whose turn the restart killed
        // (docs/superpowers/specs/2026-08-11-restart-carry-on-design.md).
        // Provenance is what makes this safe: the choice must be a `resume:`
        // value the targeted frame itself offered, so a crafted reply or a
        // lookalike answer label cannot wake a session.
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        const resumeTap = type === 'prompt_reply' && payload?.target_seq != null
          && isResumePickerTap(pickerFrames.get(convoId, payload.target_seq), payload?.choice);
        const wakeable = type === 'text' ? !!body : (isMedia ? !!blobRef : resumeTap);
        if (wakeable) {
          try {
            session = resumeSessionForConvo(convoId, ctx) || null;
          } catch (e) {
            warn(`[journal-input] resumeSessionForConvo failed for convo=${convoId}: ${e.message}`);
          }
        }
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/journal-input-router.test.js`
Expected: PASS, including all pre-existing tests in that file.

- [ ] **Step 5: Run the full suite to catch gate regressions**

Run: `npm test`
Expected: PASS. The gate rewrite touches the shared text/media resume path — if any pre-existing router test fails here, the restructure changed behaviour for text or media and must be corrected before proceeding.

- [ ] **Step 6: Commit**

```bash
git add lib/journal-input-router.js test/journal-input-router.test.js
git commit -m "feat(router): allow auto-resume for verified restart carry-on taps"
```

---

### Task 4: Turn-boundary wiring in the bridge

**Files:**
- Modify: `index.js` — config block near line 159; store construction near the `timerStore` construction; turn-start sites `index.js:2946`, `index.js:4074`, `index.js:7676`; turn-end seams `index.js:2203` (`onTurnEnd`), `index.js:3512` (print `result`), `index.js:1798` (`finishCodexTurn`)

**Interfaces:**
- Consumes: `createInflightMarker` from Task 1.
- Produces: module-scoped `inflightMarker` and `RESTART_CARRY_ON_MAX_AGE_MS`, both used by Task 5.

**Note on verification:** `index.js` is a ~9k-line module with no direct unit-test harness; the existing suite tests `lib/` modules. All the logic with branches lives in Tasks 1-3 and is already covered. Verification here is `npm run ci` plus the manual smoke test in Step 6.

- [ ] **Step 1: Add the config and construct the store**

Add near the `SESSION_IDLE_TIMEOUT_MS` block (`index.js:159`):

```js
// Restart carry-on window. A turn interrupted by a bridge restart is offered
// a "Carry on" card at the next boot, but only if the conversation was active
// within this window — measured from the marker's last touch, so a long turn
// that was still working right before the crash still qualifies. Deliberately
// NOT reusing SESSION_IDLE_TIMEOUT_MS: that answers a different question (how
// long to hold memory for an idle session), and 1h would mean restarting the
// bridge before a long meeting silently loses the card.
const RESTART_CARRY_ON_MAX_AGE_MS = parseInt(process.env.MATRON_RESTART_CARRY_ON_MAX_AGE_MS || '21600000', 10);
```

Add the import at the top of `index.js` alongside the other `lib/` imports:

```js
import { createInflightMarker } from './lib/inflight-marker.js';
```

Add the file path constant next to `SESSIONS_FILE` and `TIMERS_FILE`:

```js
const INFLIGHT_FILE = path.join(path.dirname(SESSIONS_FILE), 'inflight.json');
```

Construct the store immediately before `const timerStore = createTimerStore({`:

```js
// One boot identity per bridge process — the whole of restart-carry-on
// detection is "this marker carries a bootId that isn't mine, so the run that
// wrote it is gone" (see lib/inflight-marker.js).
const BRIDGE_BOOT_ID = randomUUID();

const inflightMarker = createInflightMarker({
  load: () => (fs.existsSync(INFLIGHT_FILE) ? JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf-8')) : null),
  // Atomic replace, same rationale as savePersistedSessions: a truncating
  // in-place write that dies mid-rewrite would silently drop every marker.
  save: (data) => atomicWriteFileSync(INFLIGHT_FILE, JSON.stringify(data, null, 2)),
  now: Date.now,
  bootId: BRIDGE_BOOT_ID,
  log: (msg) => console.warn(`[inflight] ${msg}`),
});
```

Confirm `randomUUID` is imported from `node:crypto` at the top of `index.js`; add it to the existing import if absent.

- [ ] **Step 2: Verify it parses**

Run: `npm run check`
Expected: exits 0.

- [ ] **Step 3: Wire the turn-start sites**

At each of the three sites where `session.busy` transitions to true — `index.js:2946` (iv), `index.js:4074` (print), `index.js:7676` (codex) — add immediately after the `session.busy = true;` line:

```js
    inflightMarker.noteTurnStart(journalConvoIdFor(session), session.roomId);
```

Before editing, confirm these three are still the complete set for the current tree:

```bash
grep -n "session\.busy = true" index.js
```

Expected: exactly three hits. If there are more, wire every one — a missed start site means a silently missed card.

- [ ] **Step 4: Wire the turn-end seams**

At each of the three authoritative turn-end seams add, at the point where `busy` is cleared:

- in `session.onTurnEnd` (`index.js:2203`)
- in the print-mode `result` handler (`index.js:3512`)
- in `finishCodexTurn` (`index.js:1798`)

```js
    inflightMarker.noteTurnEnd(journalConvoIdFor(session));
```

Confirm the set is complete:

```bash
grep -n "session\.busy = false" index.js
```

There are more `busy = false` sites than turn-end seams (error paths, prompt surfacing, interrupts). Wire the three named seams; for every other `busy = false` site, decide whether the turn is genuinely over — if it is, add `noteTurnEnd` there too. A missed end site leaves a stale marker that produces a spurious card, which is the failure mode the user explicitly does not want.

- [ ] **Step 5: Wire the progress touch**

In the tool-stream / assistant-event path that already runs per turn event, add a touch. Locate the existing per-event handler that updates `session.lastActivityAt` and add beside it:

```js
    inflightMarker.touch(journalConvoIdFor(session));
```

The store debounces internally to once a minute, so this is safe to call on every event.

Find the site with:

```bash
grep -n "lastActivityAt = Date.now()" index.js
```

- [ ] **Step 6: Verify and smoke test**

```bash
npm run ci
```
Expected: all green.

Then manually:

```bash
./restart.sh
# send a message that starts a long turn in a Matron chat, then mid-turn:
cat ~/.matron/inflight.json   # adjust to the resolved INFLIGHT_FILE path
```
Expected: a record for that convo with the current bootId. Let the turn finish, re-check — the record is gone.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(inflight): record in-flight turns at turn boundaries"
```

---

### Task 5: Boot reconciliation and the carry-on card

**Files:**
- Modify: `index.js` — new helpers near `journalPublishNotice` (`index.js:6513`); reconciliation call in `main()`; `carryOnConvo` seam added to the `handlePickerValue` call site

**Interfaces:**
- Consumes: `inflightMarker`, `RESTART_CARRY_ON_MAX_AGE_MS` (Task 4); the `resume:` dispatch seam name `carryOnConvo` (Task 2); router auto-resume for taps (Task 3).
- Produces: nothing consumed by later tasks.

**Note on the publish path:** `sendButtonMessage` (`index.js:4920`) resolves a live session via `sessions.get(roomId)` and returns `null` when there is none. At boot the session is dead by construction, so it cannot be used. The card must go through `journalPublisher` directly, preceded by an `upsertConvo` — the protocol requires a `convo_upsert` to reach the server before the first publish to a convo, or the publish is hard-rejected server-side (see the comment at `index.js:734`).

- [ ] **Step 1: Add the card publisher**

Add beside `journalPublishNotice` (`index.js:6513`):

```js
// Publish a picker card into a convo that has NO live session — the restart
// carry-on case, where the session is dead by construction. journalPublish /
// sendButtonMessage both key off a live session object, so this goes straight
// to the publisher; the upsert first is the protocol requirement described at
// journalPublish (the server hard-rejects publishes to convos it doesn't know).
// The frame registers itself as a picker on the way back in via the router's
// onJournalEvent observer, so nothing here has to touch pickerFrames.
function journalPublishCardForConvo(convoId, { question, options, mode = 'pick_one' }) {
  if (!JOURNAL_ENABLED || !convoId) return;
  try {
    journalPublisher.upsertConvo(convoId, {});
    journalPublisher.publishPrompt(convoId, { question, options, mode });
  } catch (e) {
    try { console.warn(`[inflight] card publish failed for convo=${convoId}: ${e.message}`); } catch { /* logging must never throw */ }
  }
}

// "about 4 minutes ago" — deliberately coarse. The card is telling the user
// roughly how stale the interrupted work is so they can judge whether carrying
// on still makes sense, not timing it.
function formatInterruptedAgo(ageMs) {
  const mins = Math.round(ageMs / 60_000);
  if (mins < 1) return 'less than a minute ago';
  if (mins === 1) return 'about a minute ago';
  if (mins < 60) return `about ${mins} minutes ago`;
  const hours = Math.round(ageMs / 3_600_000);
  return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
}
```

- [ ] **Step 2: Add the reconciliation pass**

Add above `main()`:

```js
// Boot reconciliation for restart carry-on. Every marker still on disk from a
// previous bridge process is, by construction, a turn that never reached a
// turn-end seam — the restart killed it (index.js SIGTERM handler kills every
// live session). Markers inside the window get a card; the rest are dropped
// silently. takeStale clears ALL previous-boot markers either way, so a given
// interruption is offered exactly once and can never resurface on a later boot.
function publishRestartCarryOnCards() {
  if (!JOURNAL_ENABLED) return;
  let stale;
  try {
    stale = inflightMarker.takeStale(RESTART_CARRY_ON_MAX_AGE_MS);
  } catch (e) {
    console.warn(`[inflight] boot reconciliation failed: ${e.message}`);
    return;
  }
  if (!stale.length) return;
  const persisted = loadPersistedSessions();
  const resumable = new Set(Object.values(persisted)
    .flatMap(rec => [rec?.journalConvoId, rec?.sessionId])
    .filter(Boolean));
  for (const rec of stale) {
    // No persisted session record means there is nothing for a tap to resume,
    // so a card would be a dead button. Drop it.
    if (!resumable.has(rec.convoId)) {
      console.log(`[inflight] skipping carry-on card for convo=${rec.convoId} — no persisted session`);
      continue;
    }
    const question = `⚠️ The bridge restarted while this chat was mid-turn — interrupted ${formatInterruptedAgo(rec.ageMs)}. The work stopped where it was.`;
    journalPublishCardForConvo(rec.convoId, {
      question,
      options: [{ id: `resume-${rec.convoId}`, label: '▶️ Carry on', value: `resume:${rec.convoId}` }],
    });
    console.log(`[inflight] published carry-on card for convo=${rec.convoId} (age ${Math.round(rec.ageMs / 1000)}s)`);
  }
}
```

Call it in `main()` after the journal publisher is connected and after `timerStore.init()`:

```js
  publishRestartCarryOnCards();
```

- [ ] **Step 3: Add the tap seam**

Add beside `journalResumeConvo` (`index.js:7127`):

```js
// A "Carry on" tap. The router has already auto-resumed the session for a
// verified resume tap (lib/journal-input-router.js), so `session` is live by
// the time this runs; the lookup is a fallback for the ordering-independent
// case. The injected text is the literal string `carry on` — a deliberate
// choice recorded in the design spec, along with its trade-off: a turn killed
// mid-tool-call can leave the agent unable to tell whether a side-effecting
// action completed, so a re-run is possible.
async function carryOnConvo(convoId, session, sendReply) {
  let target = session && session.alive ? session : findSessionByClaudeSessionId(convoId);
  if (!target || !target.alive) target = journalResumeConvo(convoId);
  if (!target) {
    if (sendReply) await sendReply('That conversation can no longer be found or resumed.');
    return;
  }
  await journalRouteTextToSession(target, 'carry on');
}
```

Wire it into the existing `handlePickerValue` call site by adding to the seams object:

```js
      carryOnConvo,
```

Locate the call site with:

```bash
grep -n "handlePickerValue(" index.js
```

- [ ] **Step 4: Verify**

```bash
npm run ci
```
Expected: all green.

- [ ] **Step 5: End-to-end smoke test**

```bash
./restart.sh
```
Send a message that starts a long turn in a Matron chat. While it is running:

```bash
./restart.sh
```

Expected: on reconnect, a card appears in that chat reading "⚠️ The bridge restarted while this chat was mid-turn — interrupted less than a minute ago." with a **▶️ Carry on** button. Tapping it resumes the session and delivers `carry on`.

Then verify the scoping — the point of the whole feature:

- A chat that was idle (not mid-turn) at restart gets **no** card.
- A chat idle-reaped days ago gets **no** card.
- A second `./restart.sh` with nothing in flight produces **no** cards at all, including no repeat of the one just carded.

Verify the window by hand:

```bash
MATRON_RESTART_CARRY_ON_MAX_AGE_MS=1000 ./restart.sh
```
Expected: with a 1s window, an interrupted turn produces no card, and `/tmp/matron-bridge.log` shows the marker was swept.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(inflight): publish restart carry-on cards at boot"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 marker, bootId, atomic write | 1, 4 |
| §1 turn-start / turn-end wiring, debounced touch | 4 |
| §2 boot reconciliation, window, fire-once clearing | 1 (`takeStale`), 5 |
| §3 card, `resume:<convoId>`, dispatch, injected `carry on` | 2, 5 |
| §4 error handling (corrupt file, no persisted record, unresumable, double tap, save failure) | 1, 5 |
| §5 testing | 1, 2, 3 |
| §6 cost | no code — debounce implemented in Task 1 |

**Deviation from spec, deliberate:** the spec's §3 assumed a tap would reach `journalResumeConvo` unaided. It would not — `lib/journal-input-router.js:456` refuses to auto-resume on a `prompt_reply`, and the carry-on card is published into a dead convo by construction. Task 3 adds the narrow carve-out. The spec should be amended to record this.

**Double-tap note:** the spec calls a double tap benign. The router additionally consumes the picker frame before dispatch (`pickerFrames.delete`, `journal-input-router.js:596`), so a second tap on the same card finds no frame and is refused as a stale reply rather than re-injecting. This is stricter than the spec described and is the better behaviour.

**Type consistency:** `createInflightMarker` returns `noteTurnStart` / `touch` / `noteTurnEnd` / `takeStale`, used under those exact names in Tasks 4 and 5. `takeStale` returns `{ convoId, roomId, startedAt, touchedAt, ageMs }`; Task 5 reads `convoId` and `ageMs` only. The seam is named `carryOnConvo` in Task 2's dispatch, Task 2's tests, and Task 5's wiring.
