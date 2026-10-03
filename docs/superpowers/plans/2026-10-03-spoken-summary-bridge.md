# Spoken summary (bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The turn-end summary pass also writes a short spoken version of the agent's last reply (`SPOKEN`) and a longer one (`SPOKEN_MORE`), and publishes them on the `summary` event as `spoken`, `spoken_more` and `spoken_ref`, so the voice-mode apps have something to say the moment a turn ends.

**Architecture:** Four small changes. `lib/summary-pass.js` gains the two prompt lines in both prompt variants, and three pure helpers: `splitSpoken` (reads the two lines out of the model's answer and hands back the rest), `spokenRefFor` and `spokenPayload`. `lib/journal-stream.js` gains `armReplyRef` / `settleReplyRef`, which `flushResponse` in `index.js` uses so that every flushed reply's text event carries a `message_ref` and the session remembers it (`session._lastReplyRef`). `maybeUpdatePinnedSummary` in `index.js` reads that ref with the window, cuts the spoken lines out before the existing parser runs, and spreads the new keys into the one `publishSummary` call. `parseTitlePassResponse` (`lib/journal-title-seed.js`) and `lib/summary-model.js` are not changed.

**Tech Stack:** Node ≥22 ESM, vitest 5 (`npx vitest run test/<file>.test.js`), eslint 10 (`npm run lint`), `npm run check` (`node --check` over the listed files). No new dependencies.

**Spec:** `/Users/danbarker/Dev/matron-apple-voice-design/docs/superpowers/specs/2026-10-03-voice-mode-carplay-design.md`, section 1 "The spoken version (matron-bridge)" and the bridge line of section 14 "Testing". Read section 1 before starting. Sections 2 to 13 are other plans.

> **Superseded wording (3 Oct 2026):** the `SPOKEN` and `SPOKEN_MORE` prompt strings quoted in Tasks 1 and 2 below are the first draft. After running the real summary model they were reworded (first person, name what blocks the agent, `NONE` when there is nothing to add). The strings in `lib/summary-pass.js` and `test/summary-pass.test.js` are the current ones; do not restore the text quoted here. `settleReplyRef` also gained a `summarised` option after review (a code-only reply is not remembered).

## Global Constraints

- **Names, exactly:** output lines `SPOKEN:` and `SPOKEN_MORE:`; payload keys `spoken`, `spoken_more`, `spoken_ref`. The `summary` event payload becomes `{toc, detail, model, spoken, spoken_more, spoken_ref}`.
- **Prompt wording is the spec's, word for word** (section 1, "What is written"). The spec wraps the two lines for the page; the prompt carries each on one line. Do not reword them. Both prompt variants get them: the `NEW` variant and the first-pass `SUMMARY` variant.
- **`ROSTER` stays the last format line** in both variants (see the comment at `lib/summary-pass.js:33-35`). The two new lines go directly before it.
- **Caps:** `spoken` at most 400 characters, `spoken_more` at most 1,200 (JS `String.length`). `spoken_more` is left out when the model wrote `NONE` (any case) or nothing.
- **Old shape still works:** when the model's answer has no `SPOKEN` line, none of the three keys is sent and the summary event is published exactly as today.
- **Small.** A prompt change, a parser, a payload change and tests. No new dependencies. No refactors. Do not change `parseTitlePassResponse`, `summaryWindow`, `lib/summary-model.js`, the title logic, the roster upsert or the pinned-summary logic.
- **Where to work:** only `/Users/danbarker/Dev/matron-bridge-voice-read` (branch `feat/spoken-summary`). Never edit, `cd` into or run anything in `/Users/danbarker/Dev/matron-bridge`: this box's live bridge runs from that checkout. Task 6 reads its `.env` and nothing else.
- **Commits:** every commit is made with `git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit …`. Never run `git config`. Every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit only the files each task lists (this plan file is untracked; leave it out).
- **Tests on this box:** the full suite has failures on untouched master that only happen on this Mac (Linux `/proc`, node-pty and file-mode assumptions; the count varies from run to run). So: run the test files each task names, and in Task 5 compare the full suite's failing files against the list you save in "Before you start". A file that fails after your change and was not in that list must be run on untouched master (the command is in Task 5) before you call it a regression or dismiss it.
- **Stop after Task 6.** No push, no pull request, no deploy, no bridge restart. Report as Task 6 says.

## What the other repos can rely on (the contract, as built)

- Every `summary` event still has `toc`, `detail` and `model`.
- `spoken` and `spoken_ref` are sent together or not at all. `spoken_more` is only ever sent with them.
- `spoken` and `spoken_more` are each one line: runs of whitespace are folded to single spaces, so there are no newlines.
- `spoken_ref` equals the `payload.message_ref` of a `text` event published earlier in the same conversation: the first chunk of the agent's last reply in the messages this summary covers. After this change every flushed agent reply has one (a uuid when the reply was not streamed). Bridge notices and the tool-call list sent with `!show_working` have none.
- A summary can land after a newer reply has already been published (the model call takes a few seconds). The app tells by comparing `spoken_ref` with the newest reply's `message_ref`.

## Where the contract and the spec did not fit the code (decisions this plan makes)

1. **Most text events had no `message_ref`.** `sendToRoom` (`index.js:6171-6193`) only attaches a ref that `flushResponse` armed, and `flushResponse` armed one only while a streaming overlay was open (`index.js:5346-5348`). That is print-mode Claude and the Codex app-server. Interactive-mode replies are read whole from the transcript and never stream (`index.js:4494-4506`), and Codex exec has no deltas, so their text events carried no ref at all and `spoken_ref` would have had nothing to name. **Decision:** `flushResponse` now arms a ref for every reply: the overlay's when there is one, otherwise a fresh uuid (Task 3). To a client, a ref with no overlay open is a no-op (checked in matron-apple `JournalTimelineService.reconcile`, which removes an overlay that is not there). The alternative, leaving `spoken_ref` out for unstreamed replies, would mean voice mode never gets a spoken line in interactive mode.
2. **Only the first chunk of a reply carries the ref.** A reply longer than `MAX_MSG_LENGTH` (32,768 characters, `index.js:321`) is split by `splitMessage` (`index.js:5946`) and published as several text events; the ref is consumed by the first (`index.js:6181-6184`). `spoken_ref` therefore names the first chunk. Not changed.
3. **"The turn's last assistant text event" cannot be found by position.** Bridge notices are published as `from: 'assistant'` text events through the same `sendToRoom` (`index.js:6171`); in interactive mode the tool-call list is sent after the reply (`index.js:3385-3389`); a Codex error line is sent after the turn ends (`index.js:2965-2969`). **Decision:** the ref is recorded where the reply is flushed (`flushResponse`), not looked up afterwards.
4. **A turn with no reply must not borrow the previous reply's ref.** The pass runs whenever there is at least one new message (`SUMMARY_MIN_NEW = 1`), including a lone user message from an interrupted turn. **Decision:** the spoken keys are sent only when the messages being summarised include an assistant message and the last reply's text event carried a ref; otherwise none of the three is sent (`spokenRefFor`, `spokenPayload`). The contract's rule for a missing `SPOKEN` line is extended to a missing ref, so the app never receives a `spoken` it cannot attach.
5. **The ref is read before the model call, not at publish time.** `maybeUpdatePinnedSummary` awaits the model for seconds between computing the window (`index.js:6417`) and publishing (`index.js:6452`); a reply flushed by the next turn in that gap would otherwise lend its ref to the older window's lines.
6. **The existing parser would misread spoken prose.** `parseTitlePassResponse` (`lib/journal-title-seed.js:144-151`) matches `TITLE:`, `SUMMARY:` and `NEW:` anywhere in a line and ignoring case. With 190 more words of prose in the answer, "what is new: …" in `SPOKEN` becomes the `NEW` field on a first pass and is published as `toc` (Task 4's last test shows it). **Decision:** a new function, `splitSpoken`, takes the two spoken blocks out of the answer first and `parseTitlePassResponse` is given the rest. That parser and its 45 tests stay as they are. A spoken field runs from its label at the start of a line to the next of `TITLE|SUMMARY|NEW|SPOKEN_MORE|SPOKEN|ROSTER` at the start of a line, or the end of the text. The labels are case-sensitive, like `ROSTER`.
7. **`SPOKEN: NONE`** (or an empty `SPOKEN`) is treated as no `SPOKEN` line. The spec defines `NONE` only for `SPOKEN_MORE`; saying the word "none" aloud would be wrong.
8. **How the caps cut.** The model may wrap a line; a voice does not care, so whitespace runs are folded to single spaces before measuring. Text over the cap is cut back to the last whole word (a single unbroken run longer than the cap is cut hard), so no half word is read out.
9. **One sentence of prompt wording is this plan's, not the spec's.** Both prompt variants start with a numbered list of what to provide (three items today) before the `Format:` block. Left alone, the model would be told "three things" and shown five keys. The list gains item 3, "Two spoken versions of the agent's latest reply, for someone listening instead of reading", and the roster item becomes 4. The two format lines themselves are verbatim.
10. **No summary event, no spoken line.** The event is only published when the model gave a `NEW` or `SUMMARY` line (`index.js:6450-6451`). That is unchanged, so an answer with `SPOKEN` but no `NEW`/`SUMMARY` publishes nothing.

Known limits, not fixed here:

- **Interactive mode can miss the final reply.** The Stop hook races the transcript flush (`index.js:4508-4515`), so `onTurnEnd` (`index.js:3375-3397`) can run the pass before the turn's last message has been flushed. That message is then summarised at the next turn's end, and this turn's spoken line describes an earlier message or is absent. The app's four-second fallback to its own cleaner covers it.
- **`session._lastReplyRef` is in memory only.** It is not persisted and not carried when a session object is recreated (restart, `/model`, agent switch: `index.js:2462`, `3304`, `11057`, `12497` carry `lastSummaryMsgCount` but not this). The first pass after a recreation publishes no spoken keys unless a reply has been flushed since.
- **The model does not see fenced code.** `flushResponse` strips fenced blocks before a reply enters `chatHistory` (`index.js:5332`), so a reply that is mostly a diff or code reaches the model as its prose only; a reply that is only a fenced block is not in the window at all and gets no spoken line.

## Journal: no code change; one paragraph for the journal plan

Checked in `/Users/danbarker/Dev/matron-journal-voice-read`:

- `src/ws.js:1782` accepts an agent `publish` when the type is in `AGENT_PUBLISH_TYPES` (`src/ws.js:55-58`, which includes `summary`) and the payload is a non-null object. There is no per-key validation and no size cap on a `summary` payload; the only bound is the 1 MiB WebSocket frame (`src/ws.js:199`). The new keys add at most about 1,700 characters. **No journal code change is needed for phase 1.**
- `docs/protocol.md:756-762` describes `summary` events as "carrying `{toc, detail, model}`". **Task for the journal plan (not done here):** extend that paragraph to `{toc, detail, model, spoken?, spoken_more?, spoken_ref?}` and say what the three are: `spoken` (at most 400 characters) and `spoken_more` (at most 1,200, optional) are the bridge's spoken version of the agent's last reply; `spoken_ref` is the `payload.message_ref` of that reply's `text` event; all three are bridge-capped and still opaque to the server.
- For the journal's phase 3 only: `src/push.js:67` makes `summary` events never push, which is the rule the spoken notification will have to change.

## Review Focus

1. **A user message with no reply** (an interrupted turn) while an older reply's ref is still remembered: no spoken keys. Pinned in Task 2 (`spokenRefFor`) and Task 4 ("a turn in which the agent said nothing").
2. **A reply flushed while the model is answering:** the older window keeps its own ref. Pinned in Task 4 ("a reply flushed while the model was answering").
3. **Spoken prose that looks like a key** ("what is new: …", "In summary: …", a line starting `API:`): never becomes `toc`, never ends the field early. Pinned in Task 2 and Task 4.
4. **A send callback that does not publish through `sendToRoom`:** the fresh ref is disarmed and cannot ride a later notice. Pinned in Task 3.
5. **An answer in the old shape** (no `SPOKEN` line): the payload is exactly `{toc, detail, model}`. Pinned in Task 4.

## Before you start

- [ ] **Step 0a: Install dependencies (the worktree has no `node_modules`)**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npm ci --no-audit --no-fund`
Expected: exits 0.

- [ ] **Step 0b: Confirm the baseline of the files this plan touches**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js test/journal-stream.test.js test/journal-title-seed.test.js test/codex-progress.test.js test/summary-model.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  5 passed (5)` and `Tests  65 passed (65)` (7 + 5 + 45 + 3 + 5).

- [ ] **Step 0c: Save the full suite's failing files on the untouched branch**

Run:

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
npx vitest run 2>&1 | grep -E '^ FAIL ' | awk '{print $2}' | sort -u > /tmp/spoken-summary-baseline-fails.txt
cat /tmp/spoken-summary-baseline-fails.txt
```

Expected: a short list of test files (on 3 Oct 2026 a copy of this commit failed in `codex-completion`, `codex-liveness`, `file-link-guard`, `interactive-session`, `local-memories`, `pre-trust`, `setup-pair` and `setup-wizard`; your list may differ slightly). None of the five files from Step 0b may be in it. This file is what Task 5 compares against.

## File map

| File | Change |
|---|---|
| `lib/summary-pass.js` | The two prompt lines in both variants (`buildSummaryPrompt`, lines 26-41); new exports `splitSpoken`, `spokenRefFor`, `spokenPayload`, `SPOKEN_MAX`, `SPOKEN_MORE_MAX` |
| `lib/journal-stream.js` | New exports `armReplyRef`, `settleReplyRef` (appended after `streamRefFor`) |
| `index.js` | Imports (lines 177, 179); `flushResponse` (5313-5360) arms and settles the reply ref; `maybeUpdatePinnedSummary` (6380-6509) reads the ref, splits the answer, publishes the keys |
| `test/summary-pass.test.js` | Prompt tests; `splitSpoken`, `spokenPayload`, `spokenRefFor` tests |
| `test/journal-stream.test.js` | `armReplyRef` / `settleReplyRef` tests |
| `test/spoken-summary-wiring.test.js` | New. Runs the real `flushResponse` and `maybeUpdatePinnedSummary` from `index.js` in a vm |
| `test/codex-progress.test.js` | Its vm harness runs `flushResponse`, so it needs the two new helpers in its context (lines 6, 40) |
| `test/journal-title-seed.test.js` | One source assertion follows the renamed call (lines 474-476) |
| `scripts/spoken-sample.mjs`, `test/fixtures/spoken-sample.json` | New. The manual listening check (Task 6) |

Line numbers are for the untouched branch (commit `7f0e73f`). Task 3 adds three lines to `flushResponse`, so in Task 4 every `index.js` line after it is three lower in this plan than in your file; each edit also quotes the text to find.

---

### Task 1: The prompt asks for `SPOKEN` and `SPOKEN_MORE`

**Files:**
- Modify: `lib/summary-pass.js:26-41` (`buildSummaryPrompt`, plus two constants above it)
- Test: `test/summary-pass.test.js` (constants after line 2; a new test at the end of `describe('buildSummaryPrompt', …)`, after line 47)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildSummaryPrompt({ messages, priorRoster, hasCumulative })` — same signature. Its `Format:` block is now `TITLE`, `NEW` (or `SUMMARY`), `SPOKEN`, `SPOKEN_MORE`, `ROSTER`.

- [ ] **Step 1: Write the failing test**

In `test/summary-pass.test.js`, add these constants after the import on line 2 (before `const msgs = …`):

```js
// Voice mode spec 2026-10-03 §1, "What is written": the two lines, word for
// word (the spec wraps them for the page; the prompt carries each on one line).
const SPOKEN_LINE = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most. First, anything the agent is asking or needs decided, naming the options. Then the outcome in one sentence. Then what it will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff or a long list, say it is in the chat instead of reading it.>';
const SPOKEN_MORE_LINE = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat the agent raised. Same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything.>';
```

Then, inside `describe('buildSummaryPrompt', …)`, after the test `'omits the preamble when there is no prior roster'` (which ends on line 47) and before the describe's closing `});`, add:

```js
  it.each([
    ['the NEW variant', true, 'NEW'],
    ['the first-pass SUMMARY variant', false, 'SUMMARY'],
  ])('%s asks for SPOKEN then SPOKEN_MORE, in the spec\'s words, with ROSTER still last', (_name, hasCumulative, second) => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative });
    const format = p.slice(p.indexOf('Format:'), p.indexOf('\n\nMessages:'));
    const keys = format.split('\n').filter((l) => /^[A-Z_]+: </.test(l)).map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['TITLE', second, 'SPOKEN', 'SPOKEN_MORE', 'ROSTER']);
    expect(format.split('\n')).toContain(SPOKEN_LINE);
    expect(format.split('\n')).toContain(SPOKEN_MORE_LINE);
    // The numbered list above the format block names the spoken versions too,
    // so the model is not told "three things" and shown five keys.
    expect(p.slice(0, p.indexOf('Format:'))).toContain('3. Two spoken versions of the agent\'s latest reply, for someone listening instead of reading');
    expect(p.slice(0, p.indexOf('Format:'))).toContain('4. A 2-3 sentence rolling summary');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js 2>&1 | grep -E 'Tests |AssertionError'`
Expected: `Tests  2 failed | 7 passed (9)`, both failures reading `expected [ 'TITLE', 'NEW', 'ROSTER' ] to deeply equal [ 'TITLE', 'NEW', 'SPOKEN', …(2) ]` (and the same with `SUMMARY`).

- [ ] **Step 3: Add the lines to both prompt variants**

In `lib/summary-pass.js`, replace the whole of `buildSummaryPrompt` (line 26 to the end of the file, line 41) with:

```js
// The two spoken lines for voice mode (matron-apple spec
// 2026-10-03-voice-mode-carplay-design.md §1). The wording is the spec's, word
// for word — it was approved as written, so change it there first. The apps
// say SPOKEN aloud when a turn ends and SPOKEN_MORE when the listener asks
// for more.
const SPOKEN_FORMAT = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most. First, anything the agent is asking or needs decided, naming the options. Then the outcome in one sentence. Then what it will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff or a long list, say it is in the chat instead of reading it.>';
const SPOKEN_MORE_FORMAT = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat the agent raised. Same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything.>';

export function buildSummaryPrompt({ messages, priorRoster, hasCumulative }) {
  const rendered = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  // Triple-quote fencing: the roster is model output and could contain lines
  // like "TITLE:" — fencing keeps it visually distinct from the format block.
  const preamble = priorRoster
    ? `Context — previous rolling summary of this conversation:\n"""\n${priorRoster}\n"""\n\nThe messages below are what happened AFTER that summary.\n\n`
    : '';
  // ROSTER must stay the LAST format line in both variants:
  // parseTitlePassResponse's multi-line capture stops at the next KEY: line
  // or end-of-text, so a field placed after it would be swallowed. The two
  // spoken lines therefore sit just before it.
  const shared = 'a 3-5 word title (max 34 chars) describing the overall topic/feature being worked on';
  const spokenItem = 'Two spoken versions of the agent\'s latest reply, for someone listening instead of reading';
  const spokenLines = `${SPOKEN_FORMAT}\n${SPOKEN_MORE_FORMAT}`;
  const format = hasCumulative
    ? `Based on these recent messages, provide:\n1. ${shared}, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what just happened\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific and concise.`
    : `Based on these messages, provide:\n1. ${shared}, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific.`;
  return `${preamble}${format}\n\nMessages:\n${rendered}`;
}
```

What changed, so you can check your edit: two constants above the function; the comment about `ROSTER` gains its last sentence; two new locals, `spokenItem` and `spokenLines`; in both template strings the numbered list has a new item 3 and the roster item is now 4, and `${spokenLines}\n` sits between the `NEW:` / `SUMMARY:` line and the `ROSTER:` line. Nothing else in the two strings is altered.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js test/journal-title-seed.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  2 passed (2)` and `Tests  54 passed (54)` (9 + 45).

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
git add lib/summary-pass.js test/summary-pass.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
Summary prompt: ask for SPOKEN and SPOKEN_MORE

Both prompt variants gain the two spoken lines from the voice-mode spec,
word for word, directly before ROSTER (which must stay last). The numbered
list above the format block names them too, so the model is not told
"three things" and shown five keys.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: Read the spoken lines out of the model's answer

**Files:**
- Modify: `lib/summary-pass.js` (append after `buildSummaryPrompt`)
- Test: `test/summary-pass.test.js` (imports at the top; three new describes at the end)

**Interfaces:**
- Consumes: `parseTitlePassResponse(text)` from `lib/journal-title-seed.js` (tests only; unchanged).
- Produces:
  - `SPOKEN_MAX = 400`, `SPOKEN_MORE_MAX = 1200`.
  - `splitSpoken(text)` → `{ spoken: string | null, spokenMore: string | null, rest: string }`. `spoken` and `spokenMore` are single-line and already capped; `NONE` or empty is `null`. `rest` is the answer with both spoken blocks removed, for `parseTitlePassResponse`.
  - `spokenRefFor(messages, lastReplyRef)` → `string | null`: `lastReplyRef` when `messages` has an assistant message and the ref is a non-empty string.
  - `spokenPayload({ spoken, spokenMore }, replyRef)` → `{}` or `{ spoken, spoken_more?, spoken_ref }`.

- [ ] **Step 1: Write the failing tests**

In `test/summary-pass.test.js`, replace the import on line 2,

```js
import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, SUMMARY_WINDOW_CAP } from '../lib/summary-pass.js';
```

with:

```js
import {
  summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, SUMMARY_WINDOW_CAP,
  splitSpoken, spokenPayload, spokenRefFor, SPOKEN_MAX, SPOKEN_MORE_MAX,
} from '../lib/summary-pass.js';
import { parseTitlePassResponse } from '../lib/journal-title-seed.js';
```

Then append to the end of the file:

```js
describe('splitSpoken', () => {
  const full = [
    'TITLE: deploy script fix',
    'NEW: Fixed the deploy script.',
    'SPOKEN: The agent asks whether to deploy now or wait for review. The fix is ready.',
    'SPOKEN_MORE: Deploying now puts the fix live tonight,',
    'but nobody else has read it.',
    '',
    'Waiting costs a day.',
    'ROSTER: Working on the deploy script.',
  ].join('\n');

  it('reads SPOKEN, and SPOKEN_MORE across wrapped lines up to the next label, as one line each', () => {
    const r = splitSpoken(full);
    expect(r.spoken).toBe('The agent asks whether to deploy now or wait for review. The fix is ready.');
    expect(r.spokenMore).toBe('Deploying now puts the fix live tonight, but nobody else has read it. Waiting costs a day.');
  });

  it('hands back the rest with both blocks cut out, which parseTitlePassResponse reads as before', () => {
    const r = splitSpoken(full);
    expect(r.rest).toBe('TITLE: deploy script fix\nNEW: Fixed the deploy script.\nROSTER: Working on the deploy script.');
    expect(parseTitlePassResponse(r.rest)).toEqual({
      title: 'deploy script fix', summary: null, added: 'Fixed the deploy script.', roster: 'Working on the deploy script.',
    });
  });

  it('output with no SPOKEN line (an old prompt, a model that skipped it): nulls, text untouched', () => {
    const old = 'TITLE: plan mode fix\nNEW: Added a test.\nROSTER: Working on plan mode.';
    expect(splitSpoken(old)).toEqual({ spoken: null, spokenMore: null, rest: old });
  });

  it('SPOKEN_MORE of NONE, in any case and with or without a full stop, or left empty, is null', () => {
    for (const more of ['NONE', 'none', 'None.', ' NONE ', '']) {
      const r = splitSpoken(`TITLE: t\nNEW: n\nSPOKEN: All done.\nSPOKEN_MORE: ${more}\nROSTER: r`);
      expect(r.spoken, JSON.stringify(more)).toBe('All done.');
      expect(r.spokenMore, JSON.stringify(more)).toBeNull();
      expect(r.rest, JSON.stringify(more)).toBe('TITLE: t\nNEW: n\nROSTER: r');
    }
    // NONE only as the whole field: a sentence that starts with it is kept.
    expect(splitSpoken('SPOKEN: Done.\nSPOKEN_MORE: None of the tests ran.').spokenMore).toBe('None of the tests ran.');
  });

  it('SPOKEN of NONE or left empty is no spoken line at all', () => {
    expect(splitSpoken('TITLE: t\nSPOKEN: NONE\nSPOKEN_MORE: Some detail.\nROSTER: r').spoken).toBeNull();
    expect(splitSpoken('TITLE: t\nSPOKEN:\nROSTER: r').spoken).toBeNull();
  });

  it('a label counts only at the start of a line, and only the pass\'s own labels end a field', () => {
    const r = splitSpoken([
      'NEW: The agent wrote SPOKEN: into the prompt.',
      'SPOKEN: It asks which API to use.',
      'SPOKEN_MORE: There are two.',
      'API: the first is older.',
      'TODO: it has not tried the second.',
      'ROSTER: Choosing an API.',
    ].join('\n'));
    expect(r.spoken).toBe('It asks which API to use.');
    expect(r.spokenMore).toBe('There are two. API: the first is older. TODO: it has not tried the second.');
    expect(r.rest).toBe('NEW: The agent wrote SPOKEN: into the prompt.\nROSTER: Choosing an API.');
  });

  it('spoken prose that looks like TITLE, SUMMARY or NEW never reaches the single-line parser', () => {
    // parseTitlePassResponse matches those three anywhere in a line, ignoring
    // case. Left in, "In summary: …" would become the first pass's SUMMARY and
    // "what is new: …" its NEW.
    const r = splitSpoken([
      'TITLE: billing export',
      'SPOKEN: Here is what is new: the export works.',
      'SPOKEN_MORE: In summary: nothing else changed.',
      'ROSTER: Working on the billing export.',
    ].join('\n'));
    expect(parseTitlePassResponse(r.rest)).toEqual({
      title: 'billing export', summary: null, added: null, roster: 'Working on the billing export.',
    });
  });

  it('a model that puts the spoken lines after ROSTER does not have them swallowed into the roster', () => {
    const r = splitSpoken('TITLE: t\nNEW: n\nROSTER: Working on it.\nStill going.\nSPOKEN: Done.\nSPOKEN_MORE: More.');
    expect(r.spoken).toBe('Done.');
    expect(r.spokenMore).toBe('More.');
    expect(parseTitlePassResponse(r.rest).roster).toBe('Working on it.\nStill going.');
  });

  it('caps SPOKEN at 400 and SPOKEN_MORE at 1,200 characters, cutting back to a whole word', () => {
    expect(SPOKEN_MAX).toBe(400);
    expect(SPOKEN_MORE_MAX).toBe(1200);
    const words = (n) => Array.from({ length: n }, () => 'seven77').join(' '); // 8 chars a word with its space
    const r = splitSpoken(`SPOKEN: ${words(60)}\nSPOKEN_MORE: ${words(200)}`);
    expect(r.spoken).toBe(words(50)); // 399 chars: the 51st word would end at 407
    expect(r.spoken.length).toBeLessThanOrEqual(400);
    expect(r.spokenMore).toBe(words(150)); // 1,199 chars
    // Exactly at the cap is kept whole; a single unbroken run is cut hard.
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(400)}`).spoken).toBe('x'.repeat(400));
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(401)}`).spoken).toBe('x'.repeat(400));
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(396)} and more`).spoken).toBe(`${'x'.repeat(396)} and`);
  });

  it('tolerates non-string input', () => {
    expect(splitSpoken(undefined)).toEqual({ spoken: null, spokenMore: null, rest: '' });
  });
});

describe('spokenPayload', () => {
  it('gives the three summary-event keys, in the order the spec lists them', () => {
    const p = spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, 'msg_1');
    expect(p).toEqual({ spoken: 'Short.', spoken_more: 'Longer.', spoken_ref: 'msg_1' });
    expect(Object.keys(p)).toEqual(['spoken', 'spoken_more', 'spoken_ref']);
  });
  it('leaves spoken_more out when there is none', () => {
    expect(spokenPayload({ spoken: 'Short.', spokenMore: null }, 'msg_1')).toEqual({ spoken: 'Short.', spoken_ref: 'msg_1' });
  });
  it('gives nothing without a spoken line, or without a reply to hang it on', () => {
    expect(spokenPayload({ spoken: null, spokenMore: 'Longer.' }, 'msg_1')).toEqual({});
    expect(spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, null)).toEqual({});
    expect(spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, '')).toEqual({});
  });
});

describe('spokenRefFor', () => {
  const user = { role: 'user', text: 'go' };
  const reply = { role: 'assistant', text: 'done' };
  it('is the last reply\'s ref when the window holds an assistant message', () => {
    expect(spokenRefFor([user, reply], 'msg_9')).toBe('msg_9');
  });
  it('is null when the window holds no assistant message, so an old reply never lends its ref', () => {
    expect(spokenRefFor([user], 'msg_9')).toBeNull();
    expect(spokenRefFor([], 'msg_9')).toBeNull();
  });
  it('is null when the last reply\'s text event carried no ref', () => {
    expect(spokenRefFor([user, reply], null)).toBeNull();
    expect(spokenRefFor([user, reply], undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js 2>&1 | grep -E 'Tests |TypeError|AssertionError' | sort | uniq -c`
Expected: `Tests  16 failed | 9 passed (25)`. The failures are `TypeError: splitSpoken is not a function` (9), `spokenPayload is not a function` (3) and `spokenRefFor is not a function` (3), and one `AssertionError: expected undefined to be 400` for the caps test.

- [ ] **Step 3: Implement**

Append to the end of `lib/summary-pass.js`:

```js
// --- Reading the spoken lines back out of the model's answer ---

export const SPOKEN_MAX = 400;
export const SPOKEN_MORE_MAX = 1200;

// Every format key of the pass. A spoken field runs from its own label at the
// start of a line to the next of THESE at the start of a line, or to the end
// of the text — so SPOKEN_MORE may wrap over several lines, and ordinary
// prose such as `API:` or `TODO:` at the start of a line does not end it.
// SPOKEN_MORE sits before SPOKEN only for the reader: `SPOKEN:` cannot match
// the longer label, because `_` is not `:`.
const PASS_KEYS = 'TITLE|SUMMARY|NEW|SPOKEN_MORE|SPOKEN|ROSTER';
const FIELD_END = `(?=\\n(?:${PASS_KEYS}):|$)`;
const SPOKEN_RE = new RegExp(`(?:^|\\n)SPOKEN:([\\s\\S]*?)${FIELD_END}`);
const SPOKEN_MORE_RE = new RegExp(`(?:^|\\n)SPOKEN_MORE:([\\s\\S]*?)${FIELD_END}`);
const SPOKEN_BLOCKS_RE = new RegExp(`(?:^|\\n)SPOKEN(?:_MORE)?:[\\s\\S]*?${FIELD_END}`, 'g');

// One line of speech. The model's line wraps mean nothing to a voice, so every
// run of whitespace becomes one space. NONE (the prompt's word for "nothing to
// add"), in any case, is no line. Over the cap, cut back to the last whole
// word rather than leave half a word to be read out.
function speakable(raw, max) {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s || /^none\.?$/i.test(s)) return null;
  if (s.length <= max) return s;
  const at = s.slice(0, max + 1).lastIndexOf(' ');
  return at > 0 ? s.slice(0, at) : s.slice(0, max);
}

// Splits the model's answer into the two spoken lines and everything else.
// `rest` is the answer with both spoken blocks cut out, and is what
// parseTitlePassResponse must be given: its TITLE/SUMMARY/NEW patterns match
// anywhere in a line and ignore case, so spoken prose such as "In summary: …"
// would otherwise be read as the SUMMARY field. Cutting the blocks out also
// means a model that writes them AFTER ROSTER does not get them swallowed
// into the roster. An answer with no spoken lines comes back unchanged.
export function splitSpoken(text) {
  const t = typeof text === 'string' ? text : '';
  return {
    spoken: speakable(t.match(SPOKEN_RE)?.[1], SPOKEN_MAX),
    spokenMore: speakable(t.match(SPOKEN_MORE_RE)?.[1], SPOKEN_MORE_MAX),
    rest: t.replace(SPOKEN_BLOCKS_RE, ''),
  };
}

// The ref the spoken lines belong to: the message_ref on the text event of
// the agent's last reply (session._lastReplyRef, set by flushResponse). Only
// when this window holds an assistant message — a pass over a turn in which
// the agent said nothing must not hang its lines on the reply before it.
export function spokenRefFor(messages, lastReplyRef) {
  const hasReply = Array.isArray(messages) && messages.some((m) => m?.role === 'assistant');
  return hasReply && typeof lastReplyRef === 'string' && lastReplyRef ? lastReplyRef : null;
}

// The keys the `summary` event gains: {spoken, spoken_more?, spoken_ref}.
// All or nothing — with no spoken line, or no reply to hang it on, the event
// is published exactly as before and the apps fall back to their own cleaner.
export function spokenPayload({ spoken, spokenMore } = {}, replyRef) {
  if (!spoken || !replyRef) return {};
  return {
    spoken,
    ...(spokenMore ? { spoken_more: spokenMore } : {}),
    spoken_ref: replyRef,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  1 passed (1)` and `Tests  25 passed (25)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
git add lib/summary-pass.js test/summary-pass.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
Summary pass: parse SPOKEN and SPOKEN_MORE out of the model's answer

splitSpoken reads the two lines (a field runs to the next of the pass's
own labels at a line start, so SPOKEN_MORE may wrap), folds each to one
line, drops NONE, caps them at 400 and 1,200 characters on a word
boundary, and hands back the rest of the answer for the existing
title/summary parser, which matches its keys anywhere in a line and must
not see spoken prose. spokenRefFor and spokenPayload decide the keys the
summary event will carry: all three, or none.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Every flushed reply carries a `message_ref`, and the session remembers the last one

**Files:**
- Modify: `lib/journal-stream.js` (append after `streamRefFor`, line 23)
- Modify: `index.js:179` (import), `index.js:5340-5355` (inside `flushResponse`)
- Test: `test/journal-stream.test.js` (import on line 2; new describe at the end)
- Test: `test/spoken-summary-wiring.test.js` (new file)
- Test: `test/codex-progress.test.js:6` and `:40` (its vm harness)

**Interfaces:**
- Consumes: `sendToRoom` (`index.js:6164-6197`), unchanged: it moves `session._journalDurableRef` onto the first text event it publishes for the session and nulls it, synchronously.
- Produces:
  - `armReplyRef(session, mkId = randomUUID)` → `{ ref, minted } | null`. Sets `session._journalDurableRef = ref`. `null` (and nothing armed) when the session has no `sendCallback`.
  - `settleReplyRef(session, armed)` → the ref, or `null`. Sets `session._lastReplyRef` to the ref when the text event took it, else `null`; disarms a minted ref nobody took.
  - `session._lastReplyRef`: the `message_ref` of the newest flushed reply's text event, or `null`/`undefined`. Task 4 reads it.

- [ ] **Step 1: Write the failing tests**

(a) In `test/journal-stream.test.js`, replace line 2,

```js
import { streamRefFor } from '../lib/journal-stream.js';
```

with:

```js
import { streamRefFor, armReplyRef, settleReplyRef } from '../lib/journal-stream.js';
```

and append to the end of the file:

```js
describe('armReplyRef / settleReplyRef (the ref a flushed reply is published under)', () => {
  // Stand-in for index.js's sendToRoom, which puts the armed ref on the text
  // event it publishes and nulls it in the same synchronous step.
  const publishTextEvent = (session) => {
    const ref = session._journalDurableRef;
    session._journalDurableRef = null;
    return ref;
  };
  const mk = () => 'uuid-1';

  it('a streamed reply is published under its overlay ref, and that ref is remembered', () => {
    const session = { sendCallback() {}, _journalStreamRef: 'msg_A', _journalDurableRef: null };
    const armed = armReplyRef(session, mk);
    expect(armed).toEqual({ ref: 'msg_A', minted: false });
    expect(session._journalDurableRef).toBe('msg_A');
    expect(publishTextEvent(session)).toBe('msg_A');
    expect(settleReplyRef(session, armed)).toBe('msg_A');
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('a reply that was never streamed (iv-mode, Codex exec) gets a fresh ref, so it can be pointed at too', () => {
    const session = { sendCallback() {}, _journalStreamRef: null, _journalDurableRef: null };
    const armed = armReplyRef(session, mk);
    expect(armed).toEqual({ ref: 'uuid-1', minted: true });
    expect(session._journalDurableRef).toBe('uuid-1');
    expect(publishTextEvent(session)).toBe('uuid-1');
    expect(settleReplyRef(session, armed)).toBe('uuid-1');
    expect(session._lastReplyRef).toBe('uuid-1');
  });

  it('mints with randomUUID by default', () => {
    const armed = armReplyRef({ sendCallback() {}, _journalStreamRef: null });
    expect(armed.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('with no sendCallback nothing is armed, and the remembered ref is cleared: this reply was not published', () => {
    const session = { sendCallback: null, _journalStreamRef: 'msg_A', _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    expect(armed).toBeNull();
    expect(session._journalDurableRef).toBeNull();
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });

  it('a minted ref that no text event took is disarmed and not remembered, so it cannot ride a later notice', () => {
    const session = { sendCallback() {}, _journalStreamRef: null, _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    // the callback did not publish through sendToRoom for this session
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._journalDurableRef).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });

  it('an overlay ref that no text event took stays armed, as before, but is not remembered', () => {
    const session = { sendCallback() {}, _journalStreamRef: 'msg_A', _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._journalDurableRef).toBe('msg_A');
    expect(session._lastReplyRef).toBeNull();
  });
});
```

(b) Create `test/spoken-summary-wiring.test.js`:

```js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { armReplyRef, settleReplyRef } from '../lib/journal-stream.js';

// The spoken summary (voice mode, matron-apple spec 2026-10-03 §1) as index.js
// wires it. Importing index.js would start the bridge, so the two functions
// under test are lifted out of its source and run in a vm with their
// collaborators stubbed — the idiom of test/codex-progress.test.js. The
// pieces themselves are tested in test/journal-stream.test.js and
// test/summary-pass.test.js; a break here is silent in production (voice mode
// just loses its spoken line and falls back to the apps' own cleaner).
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// Runs the real flushResponse once.
function flushWith(session, { splitMessage = (text) => [text] } = {}) {
  const start = src.indexOf('function flushResponse(');
  const end = src.indexOf('\n}\n', start) + 2;
  expect(start, 'could not find flushResponse in index.js — this test needs updating').toBeGreaterThan(-1);
  const context = vm.createContext({
    briefContextReport: () => null,
    recordConversationMessage: (s, role, text) => s.chatHistory.push({ role, text }),
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge', updateRoomName: () => {},
    splitMessage, armReplyRef, settleReplyRef,
  });
  vm.runInContext(src.slice(start, end), context);
  context.flushResponse(session);
}

// A session whose sendCallback stands in for sendToRoom: it puts the armed
// ref on the text event it "publishes" and nulls it, in the same synchronous
// step. `events` is what was published.
function sessionWith(extra = {}) {
  const events = [];
  const session = {
    responseBuffer: 'The fix is ready.', chatHistory: [], _journalStreamRef: null, _journalDurableRef: null,
    sendCallback: (body) => {
      const ref = session._journalDurableRef;
      session._journalDurableRef = null;
      events.push(ref ? { body, message_ref: ref } : { body });
    },
    ...extra,
  };
  return { session, events };
}

describe('reply ref wiring (flushResponse)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('a reply that was never streamed is published under a fresh ref, and the session remembers it', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('The fix is ready.');
    expect(events[0].message_ref).toMatch(UUID);
    expect(session._lastReplyRef).toBe(events[0].message_ref);
    expect(session._journalDurableRef).toBeNull();
  });

  it('a streamed reply keeps its overlay ref, and the session remembers that one', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A' });
    flushWith(session);
    expect(events).toEqual([{ body: 'The fix is ready.', message_ref: 'msg_A' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('a reply split into chunks carries the ref on its first chunk only', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A', responseBuffer: 'one two' });
    flushWith(session, { splitMessage: (text) => text.split(' ') });
    expect(events).toEqual([{ body: 'one', message_ref: 'msg_A' }, { body: 'two' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('each flush replaces the remembered ref: the last reply of the turn wins', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    session.responseBuffer = 'Shall I deploy it?';
    flushWith(session);
    expect(events).toHaveLength(2);
    expect(events[1].message_ref).not.toBe(events[0].message_ref);
    expect(session._lastReplyRef).toBe(events[1].message_ref);
  });

  it('a callback that does not publish through sendToRoom leaves nothing armed and nothing remembered', () => {
    const received = [];
    const { session } = sessionWith({ _lastReplyRef: 'msg_OLD' });
    session.sendCallback = (body) => received.push(body);
    flushWith(session);
    expect(received).toEqual(['The fix is ready.']);
    expect(session._journalDurableRef).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });
});
```

(c) In `test/codex-progress.test.js`, whose harness runs the real `flushResponse` in a vm (lines 32-42), add an import after line 6:

```js
import { armReplyRef, settleReplyRef } from '../lib/journal-stream.js';
```

and add one line to the `vm.createContext({ … })` object, after `splitMessage: text => [text],` (line 40):

```js
    armReplyRef, settleReplyRef,
```

This file does not fail yet. Without the edit, two of its three tests fail after Step 4 with `ReferenceError: armReplyRef is not defined`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/journal-stream.test.js test/spoken-summary-wiring.test.js test/codex-progress.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  2 failed | 1 passed (3)` and `Tests  11 failed | 8 passed (19)`: six `TypeError: armReplyRef is not a function` in `journal-stream`, and all five tests of the new file (for example `expected undefined to be 'msg_A'`, because nothing sets `_lastReplyRef`, and `.toMatch() expects to receive a string, but got undefined`, because an unstreamed reply has no ref).

- [ ] **Step 3: Add the helpers**

Append to the end of `lib/journal-stream.js`:

```js
// --- The ref a flushed reply is published under ---
//
// Unlike streamRefFor these two touch the session's fields directly, because
// the question they answer ("did the text event actually take the ref?") can
// only be read off the session after the send. index.js's flushResponse calls
// armReplyRef, sends the reply's chunks, then calls settleReplyRef.
//
// Why every reply gets a ref: the turn-end summary pass publishes a spoken
// version of the agent's last reply (voice mode), and names that reply by the
// message_ref on its text event (`spoken_ref`). A streamed reply already
// carries its overlay's ref. A reply that was never streamed (iv-mode reads
// whole messages from the transcript; Codex exec has no deltas) carried none,
// so there was nothing to point at. Those now get a fresh uuid. To a client a
// ref with no overlay open is a no-op: it retires an overlay that isn't there.

// Arm the ref for the reply about to be sent. index.js's sendToRoom moves
// session._journalDurableRef onto the first text event it publishes for the
// session and nulls it, in the same synchronous step as the send. Only armed
// when a sendCallback will drive that send; returns null otherwise.
export function armReplyRef(session, mkId = randomUUID) {
  if (!session.sendCallback) return null;
  const minted = !session._journalStreamRef;
  const ref = session._journalStreamRef || mkId();
  session._journalDurableRef = ref;
  return { ref, minted };
}

// After the send: record whether the reply's text event took the ref.
// session._lastReplyRef is the ref of the newest flushed reply, or null when
// that reply went out without one (no callback, or a callback that did not
// publish through sendToRoom for this session) — never an older reply's ref.
// A minted ref nobody took is disarmed here so it cannot ride a later,
// unrelated publish. An overlay ref nobody took is left armed, exactly as
// before this helper existed; journalStreamClear retires it at turn end.
export function settleReplyRef(session, armed) {
  const carried = Boolean(armed) && session._journalDurableRef !== armed.ref;
  if (armed && !carried && armed.minted) session._journalDurableRef = null;
  session._lastReplyRef = carried ? armed.ref : null;
  return session._lastReplyRef;
}
```

- [ ] **Step 4: Use them in `flushResponse`**

In `index.js`, change the import on line 179 from

```js
import { streamRefFor } from './lib/journal-stream.js';
```

to

```js
import { streamRefFor, armReplyRef, settleReplyRef } from './lib/journal-stream.js';
```

Then, in `flushResponse` (starts at line 5313), replace this block (lines 5340-5355):

```js
  // Arm the durable ref for the very next journal mirror (the first chunk's
  // sendToRoom) so the streamed overlay retires by ref. Only when an overlay is
  // actually open for this session (print-mode streamed this message) AND a
  // callback will drive sendToRoom synchronously — otherwise the arm would leak
  // onto a later, unrelated publish. journalStreamClear (at turn-end) clears
  // any overlay this flush didn't retire.
  if (session._journalStreamRef && session.sendCallback) {
    session._journalDurableRef = session._journalStreamRef;
  }

  if (session.sendCallback) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      session.sendCallback(chunk);
    }
  }
```

with:

```js
  // Arm the durable ref for the very next journal mirror (the first chunk's
  // sendToRoom): the streamed overlay's ref when one is open, so the overlay
  // retires by ref, otherwise a fresh one, so every reply's text event can be
  // pointed at (the summary pass's spoken_ref — see lib/journal-stream.js).
  // Only when a callback will drive sendToRoom synchronously; settleReplyRef
  // below disarms a fresh ref that no text event took, so it cannot leak onto
  // a later, unrelated publish. journalStreamClear (at turn-end) clears any
  // overlay this flush didn't retire.
  const armedReply = armReplyRef(session);

  if (session.sendCallback) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      session.sendCallback(chunk);
    }
  }
  // Remember which ref this reply's text event carried (session._lastReplyRef)
  // for the turn-end summary pass.
  settleReplyRef(session, armedReply);
```

Leave the rest of `flushResponse` as it is (the `session.lastActivityAt = Date.now();` lines that follow stay).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/journal-stream.test.js test/spoken-summary-wiring.test.js test/codex-progress.test.js test/context-command.test.js test/codex-session.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  5 passed (5)` and `Tests  53 passed (53)`. (`context-command` and `codex-session` read `flushResponse`'s source text; they are here to show the edit did not disturb what they pin.)

Then: `node --check index.js && npm run lint`
Expected: both exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
git add lib/journal-stream.js index.js test/journal-stream.test.js test/spoken-summary-wiring.test.js test/codex-progress.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
Every flushed reply carries a message_ref, and the session remembers it

Only a streamed reply's text event carried a message_ref (the overlay's),
so interactive-mode and Codex exec replies had nothing the summary pass
could point at. flushResponse now arms a ref for every reply — the
overlay's when one is open, a fresh uuid otherwise — and records in
session._lastReplyRef the ref the text event actually took. A fresh ref
no text event took is disarmed so it cannot ride a later notice.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: Publish `spoken`, `spoken_more` and `spoken_ref` on the summary event

**Files:**
- Modify: `index.js:177` (import); in `maybeUpdatePinnedSummary`: after the window (lines 6417-6418), the parse (6425-6426) and the TOC publish (6449-6457). After Task 3 these are three lines lower in your file.
- Test: `test/spoken-summary-wiring.test.js` (two imports; new section at the end)
- Test: `test/journal-title-seed.test.js:474-476`

**Interfaces:**
- Consumes: `splitSpoken`, `spokenRefFor`, `spokenPayload` (Task 2); `session._lastReplyRef` (Task 3).
- Produces: the `summary` event payload `{toc, detail, model, spoken, spoken_more, spoken_ref}`, the last three as "What the other repos can rely on" describes.

- [ ] **Step 1: Write the failing tests**

(a) In `test/spoken-summary-wiring.test.js`, add two imports after the `../lib/journal-stream.js` import (line 4):

```js
import { summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor } from '../lib/summary-pass.js';
import { parseTitlePassResponse, withSessionShort, titleMarkerFor } from '../lib/journal-title-seed.js';
```

and append to the end of the file:

```js
// maybeUpdatePinnedSummary is run for real too, with the model and the journal
// stubbed: `answer` is what the model returns, and the result is every journal
// publish the pass made. `during` runs while the model call is in flight.
async function runPass(session, answer, { during } = {}) {
  const start = src.indexOf('async function maybeUpdatePinnedSummary(');
  const end = src.indexOf('\n}\n', start) + 2;
  expect(start, 'could not find maybeUpdatePinnedSummary in index.js — this test needs updating').toBeGreaterThan(-1);
  const published = [];
  const context = vm.createContext({
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge', updateRoomName: () => {},
    summaryModel: { model: 'test-model', generate: async () => { during?.(); return answer; } },
    summaryModelNag: { maybeFile: () => {} },
    journalConvoIdFor: () => 'convo', debug: () => {}, console,
    summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor,
    parseTitlePassResponse, withSessionShort, titleMarkerFor,
    journalUpsertConvo: () => {}, persistSession: () => {},
    // JSON round trip: the payload is built inside the vm, in another realm.
    journalPublish: (_session, method, payload) => published.push({ method, payload: JSON.parse(JSON.stringify(payload)) }),
  });
  vm.runInContext(src.slice(start, end), context);
  await context.maybeUpdatePinnedSummary(session);
  return published;
}

// A session whose turn has just ended: one user message, one reply, and the
// ref that reply's text event was published under.
function turnEnded(extra = {}) {
  return {
    roomId: 'room', claudeSessionId: 'ab12', workdir: '/tmp/w',
    chatHistory: [{ role: 'user', text: 'Fix the export.' }, { role: 'assistant', text: 'Fixed. Shall I deploy it?' }],
    pinnedSummaryText: '• Looked at the export.', lastSummaryMsgCount: 0, lastRosterText: '',
    _lastReplyRef: 'msg_A',
    ...extra,
  };
}

const ANSWER = [
  'TITLE: export fix',
  'NEW: Fixed the export.',
  'SPOKEN: The agent asks whether to deploy now. The export is fixed.',
  'SPOKEN_MORE: Deploying now puts it live tonight,',
  'before anyone has reviewed it.',
  'ROSTER: Fixing the nightly export.',
].join('\n');

describe('spoken summary wiring (maybeUpdatePinnedSummary)', () => {
  it('publishes one summary event carrying {toc, detail, model, spoken, spoken_more, spoken_ref}', async () => {
    const published = await runPass(turnEnded(), ANSWER);
    expect(published).toEqual([{
      method: 'publishSummary',
      payload: {
        toc: 'Fixed the export.',
        detail: 'Fixing the nightly export.',
        model: 'test-model',
        spoken: 'The agent asks whether to deploy now. The export is fixed.',
        spoken_more: 'Deploying now puts it live tonight, before anyone has reviewed it.',
        spoken_ref: 'msg_A',
      },
    }]);
    expect(Object.keys(published[0].payload)).toEqual(['toc', 'detail', 'model', 'spoken', 'spoken_more', 'spoken_ref']);
  });

  it('leaves spoken_more out when the model wrote NONE', async () => {
    const [{ payload }] = await runPass(turnEnded(), ANSWER.replace(/SPOKEN_MORE:[\s\S]*?\nROSTER/, 'SPOKEN_MORE: none\nROSTER'));
    expect(payload.spoken).toBe('The agent asks whether to deploy now. The export is fixed.');
    expect(payload.spoken_ref).toBe('msg_A');
    expect('spoken_more' in payload).toBe(false);
  });

  it('with no SPOKEN line the event is published exactly as before', async () => {
    const [{ payload }] = await runPass(turnEnded(), 'TITLE: export fix\nNEW: Fixed the export.\nROSTER: Fixing the nightly export.');
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a turn in which the agent said nothing gets no spoken keys, whatever the model wrote', async () => {
    // Only a user message is new: _lastReplyRef still names the reply of an
    // EARLIER turn, and these lines must not be hung on it.
    const session = turnEnded({ lastSummaryMsgCount: 2 });
    session.chatHistory.push({ role: 'user', text: 'Actually, stop.' });
    const [{ payload }] = await runPass(session, ANSWER);
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a reply whose text event carried no ref gets no spoken keys', async () => {
    const [{ payload }] = await runPass(turnEnded({ _lastReplyRef: null }), ANSWER);
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a reply flushed while the model was answering does not lend its ref to this pass', async () => {
    const session = turnEnded();
    const [{ payload }] = await runPass(session, ANSWER, { during: () => { session._lastReplyRef = 'msg_LATER'; } });
    expect(payload.spoken_ref).toBe('msg_A');
  });

  it('cuts over-long lines to 400 and 1,200 characters', async () => {
    const long = (n) => Array.from({ length: n }, () => 'word').join(' ');
    const [{ payload }] = await runPass(turnEnded(), `NEW: n\nSPOKEN: ${long(200)}\nSPOKEN_MORE: ${long(400)}\nROSTER: r`);
    expect(payload.spoken.length).toBe(399); // 80 whole words
    expect(payload.spoken_more.length).toBe(1199); // 240 whole words
  });

  it('spoken prose never becomes the table-of-contents line (first pass, SUMMARY variant)', async () => {
    const answer = 'TITLE: export fix\nSUMMARY: Fixed the export.\nSPOKEN: Here is what is new: the export works.\nROSTER: Fixing the nightly export.';
    const [{ payload }] = await runPass(turnEnded({ pinnedSummaryText: '' }), answer);
    expect(payload.toc).toBe('Fixed the export.');
    expect(payload.spoken).toBe('Here is what is new: the export works.');
  });
});
```

(b) In `test/journal-title-seed.test.js`, replace lines 474-476,

```js
  it('routes the Gemini response through parseTitlePassResponse', () => {
    expect(indexSrc).toMatch(/const parsed = parseTitlePassResponse\(text\);/);
  });
```

with:

```js
  it('routes the Gemini response through parseTitlePassResponse, with the spoken lines already cut out', () => {
    // The spoken lines (voice mode) are taken out by splitSpoken first; the
    // parser must be given what is left. See test/spoken-summary-wiring.test.js.
    expect(indexSrc).toMatch(/const parsed = parseTitlePassResponse\(voiced\.rest\);/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/spoken-summary-wiring.test.js test/journal-title-seed.test.js 2>&1 | grep -E 'Test Files|Tests |×'`
Expected: `Test Files  2 failed (2)` and `Tests  6 failed | 52 passed (58)`. The six: the renamed test in `journal-title-seed`, and in the wiring file "publishes one summary event…", "leaves spoken_more out…", "a reply flushed while the model was answering…", "cuts over-long lines…" and "spoken prose never becomes the table-of-contents line…" (that last one fails with `expected 'the export works.' to be 'Fixed the export.'`, which is decision 6 happening). The three "no spoken keys" tests pass already: today's code never sends them.

- [ ] **Step 3: Wire the pass**

All four edits are in `index.js`.

Edit 1, the import on line 177. Change

```js
import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW } from './lib/summary-pass.js';
```

to

```js
import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, splitSpoken, spokenPayload, spokenRefFor } from './lib/summary-pass.js';
```

Edit 2, in `maybeUpdatePinnedSummary`. Replace

```js
    const { messages, nextCount } = summaryWindow(session.chatHistory, session.lastSummaryMsgCount);
    if (!messages.length) return;
```

with

```js
    const { messages, nextCount } = summaryWindow(session.chatHistory, session.lastSummaryMsgCount);
    if (!messages.length) return;
    // Which reply the spoken lines will belong to. Read here, in the same
    // step as the window and BEFORE the model call below: that call takes
    // seconds, and a reply flushed by the next turn meanwhile must not lend
    // its ref to this window's lines.
    const replyRef = spokenRefFor(messages, session._lastReplyRef);
```

Edit 3, a few lines further down. Replace

```js
    const text = await summaryModel.generate(prompt);
    const parsed = parseTitlePassResponse(text);
```

with

```js
    const text = await summaryModel.generate(prompt);
    // The spoken lines come out first; the title/summary parser gets the rest
    // (see splitSpoken for why it must not see spoken prose).
    const voiced = splitSpoken(text);
    const parsed = parseTitlePassResponse(voiced.rest);
```

Edit 4, the TOC publish. Replace

```js
    // TOC event: one per successful pass, anchored by its own journal seq.
    const toc = (parsed.added || parsed.summary || '').trim();
    if (toc) {
      journalPublish(session, 'publishSummary', {
        toc: toc.slice(0, 300),
        detail: (parsed.roster || '').slice(0, 1000),
        model: summaryModel.model,
      });
    }
```

with

```js
    // TOC event: one per successful pass, anchored by its own journal seq.
    // It also carries the spoken version of the agent's last reply for voice
    // mode — {spoken, spoken_more?, spoken_ref}, all or none (spokenPayload).
    // Old apps ignore the extra keys; the journal passes the payload through.
    const toc = (parsed.added || parsed.summary || '').trim();
    if (toc) {
      journalPublish(session, 'publishSummary', {
        toc: toc.slice(0, 300),
        detail: (parsed.roster || '').slice(0, 1000),
        model: summaryModel.model,
        ...spokenPayload(voiced, replyRef),
      });
    }
```

Nothing else in `maybeUpdatePinnedSummary` changes: the title rename, the roster upsert, the cursor advance and the pinned-summary block all keep reading `parsed`. `maybeSummarizeAtTurnEnd` is not touched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/spoken-summary-wiring.test.js test/journal-title-seed.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  2 passed (2)` and `Tests  58 passed (58)` (13 + 45).

Then: `node --check index.js && npm run lint`
Expected: both exit 0, no warnings.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
git add index.js test/spoken-summary-wiring.test.js test/journal-title-seed.test.js
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
Summary event carries spoken, spoken_more and spoken_ref

The turn-end pass takes the two spoken lines out of the model's answer
before the title/summary parser runs, and publishes them on the summary
event with the message_ref of the reply they describe. The ref is read
with the window, before the model call, so a reply flushed meanwhile
cannot lend its ref to an older window. With no SPOKEN line, or no reply
in the window, the event is published exactly as before.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Full verification

**Files:** none changed.

**Interfaces:**
- Consumes: Tasks 1 to 4, and `/tmp/spoken-summary-baseline-fails.txt` from Step 0c.
- Produces: a branch whose touched tests, lint and syntax check pass, and whose full suite fails in no file that master does not.

- [ ] **Step 1: Lint and syntax check**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npm run lint && npm run check`
Expected: both exit 0. (`lib/summary-pass.js` and `lib/journal-stream.js` are already in the `check` list.)

- [ ] **Step 2: The touched test files**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && npx vitest run test/summary-pass.test.js test/journal-stream.test.js test/spoken-summary-wiring.test.js test/journal-title-seed.test.js test/codex-progress.test.js test/summary-model.test.js 2>&1 | grep -E 'Test Files|Tests '`
Expected: `Test Files  6 passed (6)` and `Tests  102 passed (102)` (25 + 11 + 13 + 45 + 3 + 5).

- [ ] **Step 3: The full suite, against the baseline**

Run:

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
npx vitest run 2>&1 | grep -E '^ FAIL ' | awk '{print $2}' | sort -u > /tmp/spoken-summary-after-fails.txt
comm -13 /tmp/spoken-summary-baseline-fails.txt /tmp/spoken-summary-after-fails.txt
```

Expected: no output — no file fails now that did not fail before the change. (For reference, a copy of this plan's finished code passed 32 more tests than the untouched commit and failed in the same eight files.)

If a file is printed, run it alone (`npx vitest run test/<file>.test.js`). If it still fails, run the same file on untouched master without disturbing this tree:

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
rm -rf /tmp/bridge-master-check && mkdir /tmp/bridge-master-check
git archive origin/master | tar -x -C /tmp/bridge-master-check
ln -s "$PWD/node_modules" /tmp/bridge-master-check/node_modules
(cd /tmp/bridge-master-check && npx vitest run test/<file>.test.js 2>&1 | grep -E 'Test Files|Tests ')
```

Fails on master too: it is one of this Mac's known failures; note the file name in your report and go on. Passes on master: it is a regression from this branch; fix it before Task 6.

- [ ] **Step 4: Confirm the commits' author**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && git log origin/master..HEAD --format='%an <%ae> | %s'`
Expected: four lines, each starting `Dan Barker <dan@yearbookmachine.com> |`.

---

### Task 6: Manual listening check with the real summary model

The tests prove the plumbing. Whether the two lines sound right can only be judged from what the real model writes, so this task asks it once, about a saved conversation, and prints the result.

**Files:**
- Create: `test/fixtures/spoken-sample.json`
- Create: `scripts/spoken-sample.mjs`

**Interfaces:**
- Consumes: `createSummaryModel` (`lib/summary-model.js`), `buildSummaryPrompt`, `splitSpoken`, `spokenPayload`, `spokenRefFor` (`lib/summary-pass.js`), `parseTitlePassResponse` (`lib/journal-title-seed.js`); `OPENAI_API_KEY`, `GEMINI_API_KEY`, `SUMMARY_MODEL` from the environment, chosen exactly as `index.js:499-507` chooses them.
- Produces: printed output only. One model call per run.

- [ ] **Step 1: Save the sample conversation**

Create `test/fixtures/spoken-sample.json`. It is the shape of `session.chatHistory`. The last reply has two questions with options, a table, a file path, a URL, a PR number and a caveat, which is everything the `SPOKEN` instructions have rules about:

```json
[
  {
    "role": "user",
    "text": "The nightly export to the accounts system failed again last night. Can you find out why and fix it?"
  },
  {
    "role": "assistant",
    "text": "I'll read last night's run log first, then the export code."
  },
  {
    "role": "assistant",
    "text": "Found it. The export failed because the accounts API now rejects any batch over 500 rows, and last night's batch had 1,240. I've changed `lib/export/batch.js` to split batches at 500 and added a test; all 212 tests pass. The change is in PR #418 (https://github.com/example/app/pull/418).\n\n| Night | Rows | Result |\n|---|---|---|\n| Mon | 310 | ok |\n| Tue | 480 | ok |\n| Wed | 1,240 | failed |\n\nTwo things need deciding:\n\n1. **Re-run last night's export now, or wait for tonight's run?** Re-running now sends Wednesday's 1,240 rows today, but the accounts team is in month-end close and asked not to receive data between 9 and 5. Waiting means Wednesday's rows arrive with Thursday's, about 14 hours late.\n2. **Merge the PR myself, or wait for a review?** It is a six-line change with a test.\n\nOne caveat: I could not find the API's limit documented anywhere, so 500 comes from the error message. If the real limit is lower the export will fail again tonight; I added a log line so we would see why."
  }
]
```

- [ ] **Step 2: Write the script**

Create `scripts/spoken-sample.mjs`:

```js
// Operator listening check for the spoken summary lines (voice mode,
// matron-apple spec 2026-10-03 §1). Asks the REAL summary model, once, about a
// saved conversation and prints what a listener would hear, so the wording
// can be judged by ear before the apps exist. Kept out of npm test: it needs
// a key and costs a model call. Prints no key and no config value.
//
//   node scripts/spoken-sample.mjs [conversation.json]
//
// The conversation is a JSON array of {role: 'user'|'assistant', text}, the
// shape of session.chatHistory. Default: test/fixtures/spoken-sample.json.
// The model is picked exactly as index.js picks it: OPENAI_API_KEY wins, then
// GEMINI_API_KEY; SUMMARY_MODEL overrides the model name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createSummaryModel } from '../lib/summary-model.js';
import { buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor } from '../lib/summary-pass.js';
import { parseTitlePassResponse } from '../lib/journal-title-seed.js';

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplePath = process.argv[2] || path.join(bridgeDir, 'test', 'fixtures', 'spoken-sample.json');
const messages = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

const geminiKey = process.env.GEMINI_API_KEY || '';
const summaryModel = createSummaryModel({
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  geminiClient: geminiKey ? new GoogleGenerativeAI(geminiKey) : null,
  modelOverride: process.env.SUMMARY_MODEL || '',
});

if (!summaryModel) {
  console.log('SKIPPED: neither OPENAI_API_KEY nor GEMINI_API_KEY is set, so there is no summary model to ask.');
  process.exit(0);
}

const count = (s) => (s ? `${s.split(' ').length} words, ${s.length} characters` : 'none');

// The NEW variant: the one every pass after a conversation's first uses.
const prompt = buildSummaryPrompt({ messages, priorRoster: null, hasCumulative: true });
const text = await summaryModel.generate(prompt);
const voiced = splitSpoken(text);
const parsed = parseTitlePassResponse(voiced.rest);

console.log(`model: ${summaryModel.model}`);
console.log(`conversation: ${path.relative(bridgeDir, samplePath)} (${messages.length} messages)`);
console.log('\n--- the model\'s answer, as it came ---');
console.log(text);
console.log('\n--- SPOKEN (said when the turn ends; 40 words asked for, cut at 400 characters) ---');
console.log(voiced.spoken ?? '(missing: the summary event would carry no spoken keys)');
console.log(`[${count(voiced.spoken)}]`);
console.log('\n--- SPOKEN_MORE (said on "more"; 150 words asked for, cut at 1,200 characters) ---');
console.log(voiced.spokenMore ?? '(none: the model wrote NONE or left it out)');
console.log(`[${count(voiced.spokenMore)}]`);
console.log('\n--- the rest still parses ---');
console.log(JSON.stringify(parsed, null, 2));
console.log('\n--- keys the summary event would gain ---');
console.log(JSON.stringify(spokenPayload(voiced, spokenRefFor(messages, 'sample-reply-ref')), null, 2));
```

- [ ] **Step 3: Check it without a key**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && node --check scripts/spoken-sample.mjs && npx eslint scripts/spoken-sample.mjs --max-warnings=0 && env -u OPENAI_API_KEY -u GEMINI_API_KEY node scripts/spoken-sample.mjs; echo "exit=$?"`
Expected: `SKIPPED: neither OPENAI_API_KEY nor GEMINI_API_KEY is set, so there is no summary model to ask.` and `exit=0`. No model call is made.

- [ ] **Step 4: Commit**

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
git add scripts/spoken-sample.mjs test/fixtures/spoken-sample.json
git -c user.name="Dan Barker" -c user.email=dan@yearbookmachine.com commit -F - <<'EOF'
scripts/spoken-sample.mjs: hear what the summary model writes for voice mode

An operator check, outside npm test: asks the configured summary model
once about a saved conversation and prints SPOKEN and SPOKEN_MORE with
their word and character counts, so the wording can be judged before the
apps exist.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: Run it for real, once**

Run: `cd /Users/danbarker/Dev/matron-bridge-voice-read && node scripts/spoken-sample.mjs`

If it prints `SKIPPED`, your shell has no key. On this Mac the bridge's own key is in `/Users/danbarker/Dev/matron-bridge/.env` (on 3 Oct 2026 it had `OPENAI_API_KEY` and no `GEMINI_API_KEY`; checked by name, not by value). Read it, and only read it:

```bash
cd /Users/danbarker/Dev/matron-bridge-voice-read
env -u OPENAI_API_KEY -u GEMINI_API_KEY -u SUMMARY_MODEL node --env-file=/Users/danbarker/Dev/matron-bridge/.env scripts/spoken-sample.mjs
```

If that file is missing, or the script still prints `SKIPPED`, there is no key on this box: skip the rest of this task and say so in your report, in these words: "Manual listening check skipped: no summary model key is configured on this box." Do not ask for a key and do not copy one anywhere.

Expected with a key: the model name, the model's raw answer, then the `SPOKEN` and `SPOKEN_MORE` sections with counts, the parsed rest, and the three payload keys. Never print or paste the key.

- [ ] **Step 6: Read the output against this list**

1. The raw answer has five lines starting `TITLE:`, `NEW:`, `SPOKEN:`, `SPOKEN_MORE:`, `ROSTER:`, in that order, with no markdown around the labels (no `**SPOKEN:**`, no numbering).
2. `SPOKEN` opens with the two things to decide and names the options (re-run now or wait for tonight; merge or wait for a review), then the outcome. About 40 words; under 400 characters.
3. `SPOKEN` has no file path, URL, PR number, backticks or list markers, and says the table is in the chat instead of reading it out.
4. `SPOKEN_MORE` does not repeat `SPOKEN`; it gives the reasons (the month-end close, about fourteen hours late, the undocumented limit). At most about 150 words; under 1,200 characters.
5. "the rest still parses" shows `title`, `added` and `roster` filled in and `summary` null.
6. "keys the summary event would gain" shows `spoken`, `spoken_more` and `spoken_ref`.

Do not change the prompt wording or the parser to make a point pass: the wording is the spec's. If point 1 fails (the model decorates or drops a label), that is a finding for Dan, because the parser only accepts a bare label at the start of a line.

- [ ] **Step 7: Report**

Finish with a report that contains: the commits (`git log origin/master..HEAD --oneline`); the Task 5 results; the model name and the `SPOKEN` and `SPOKEN_MORE` text exactly as printed, with their counts; which of the six points passed and which did not; and any full-suite file you had to check against master. Dan can hear the lines on this Mac with `say "<the SPOKEN text>"`. Do not push, open a pull request, deploy or restart anything.
