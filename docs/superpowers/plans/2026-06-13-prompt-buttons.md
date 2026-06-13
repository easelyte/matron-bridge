# Prompt Buttons (unify question handling) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `PromptDetector` the single mechanism for surfacing TUI prompts in iv-mode, rendering them as Matrix buttons (with a text fallback), and remove the now-redundant `ask_user` MCP question tool and its `/ask` machinery.

**Architecture:** A new pure module `lib/prompt-buttons.js` turns a detector-classified prompt into buttons and maps a tap back to a `respondToPrompt` keystroke. `handleInteractivePrompt` uses it (falling back to today's text). A `prompt-opt:<i>` button-response branch drives the answer. The transcript→`sendAllQuestions` path is guarded to print-mode only. The `ask_user` tool + `/ask` endpoints + `pendingMcpQuestions`/`expireMcpQuestion`/`mcp-question-gate` are deleted; secret-handling tools and print-mode question handling stay.

**Tech Stack:** Node.js (ESM), vitest, eslint. Branch `feat/prompt-buttons` (off `fix/effort-command`).

**Ordering note:** Tasks are ordered so every commit is a sane state. Task 3 (guard) removes the duplicate *before* Task 4 adds buttons, so we never make the duplication worse.

**Verify commands (whole plan):**
- Tests: `npx vitest run`
- Lint: `npx eslint <changed files>`
- Syntax: `node --check index.js`

---

### Task 1: `lib/prompt-buttons.js` — pure helpers (TDD)

**Files:**
- Create: `lib/prompt-buttons.js`
- Test: `test/prompt-buttons.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/prompt-buttons.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { promptButtons, promptResponseForButton } from '../lib/prompt-buttons.js';

const numbered = {
  kind: 'numbered',
  question: 'Pick one:',
  options: [{ key: '1', label: 'Alpha' }, { key: '2', label: 'Beta' }],
  freeTextIdx: null,
};
const yesno = {
  kind: 'yes-no',
  question: 'Proceed?',
  options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }],
  freeTextIdx: null,
};
const arrow = {
  kind: 'arrow-menu',
  question: 'Choose:',
  options: [{ label: 'One', selected: true }, { label: 'Two', selected: false }],
  freeTextIdx: null,
};

describe('promptButtons', () => {
  it('builds namespaced buttons for a numbered menu', () => {
    expect(promptButtons(numbered)).toEqual({
      mode: 'pick_one',
      buttons: [
        { id: 'prompt-opt-0', label: 'Alpha', value: 'prompt-opt:0' },
        { id: 'prompt-opt-1', label: 'Beta', value: 'prompt-opt:1' },
      ],
    });
  });

  it('builds buttons for yes-no and arrow menus', () => {
    expect(promptButtons(yesno).buttons.map(b => b.label)).toEqual(['Yes', 'No']);
    expect(promptButtons(arrow).buttons.map(b => b.value)).toEqual(['prompt-opt:0', 'prompt-opt:1']);
  });

  it('returns null (→ text fallback) for a free-text slot', () => {
    expect(promptButtons({ ...numbered, freeTextIdx: 1 })).toBeNull();
  });

  it('returns null for multiSelect, no options, or empty labels', () => {
    expect(promptButtons({ ...numbered, multiSelect: true })).toBeNull();
    expect(promptButtons({ kind: 'numbered', options: [], freeTextIdx: null })).toBeNull();
    expect(promptButtons(null)).toBeNull();
    expect(promptButtons({ ...numbered, options: [{ key: '1', label: '  ' }] })).toBeNull();
  });
});

describe('promptResponseForButton', () => {
  it('maps numbered/lettered to the option key', () => {
    expect(promptResponseForButton(numbered, 1)).toEqual({ kind: 'numbered', key: '2' });
  });
  it('maps yes-no to the option key (y/n)', () => {
    expect(promptResponseForButton(yesno, 0)).toEqual({ kind: 'yes-no', key: 'y' });
    expect(promptResponseForButton(yesno, 1)).toEqual({ kind: 'yes-no', key: 'n' });
  });
  it('maps arrow-menu to the index', () => {
    expect(promptResponseForButton(arrow, 1)).toEqual({ kind: 'arrow-menu', key: '1' });
  });
  it('returns null for out-of-range or bad input', () => {
    expect(promptResponseForButton(numbered, 5)).toBeNull();
    expect(promptResponseForButton(numbered, -1)).toBeNull();
    expect(promptResponseForButton(null, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prompt-buttons.test.js`
Expected: FAIL — `Failed to resolve import '../lib/prompt-buttons.js'`.

- [ ] **Step 3: Write the module**

Create `lib/prompt-buttons.js`:

```js
// Turn a PromptDetector-classified prompt (see lib/prompt-detector.js) into
// Matrix buttons, and map a button tap back to the keystroke response that
// InteractiveSession.respondToPrompt expects. Pure + unit-testable; the bridge
// wires these into handleInteractivePrompt and the button-response handler.
//
// promptButtons returns null when the prompt can't be cleanly turned into a
// single-select button set — the caller then falls back to the text rendering.
// A free-text slot (freeTextIdx set, e.g. plan-mode's "Tell Claude what to
// change") falls back to text so the user can still type a freeform reply.

export function promptButtons(prompt) {
  if (!prompt || !Array.isArray(prompt.options) || prompt.options.length === 0) return null;
  if (prompt.freeTextIdx !== null && prompt.freeTextIdx !== undefined) return null;
  if (prompt.multiSelect) return null;
  const buttons = [];
  for (let i = 0; i < prompt.options.length; i++) {
    const label = ((prompt.options[i] && prompt.options[i].label) || '').trim();
    if (!label) return null; // can't label a button — fall back to text
    buttons.push({ id: `prompt-opt-${i}`, label, value: `prompt-opt:${i}` });
  }
  return { buttons, mode: 'pick_one' };
}

export function promptResponseForButton(prompt, index) {
  if (!prompt || !Array.isArray(prompt.options)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= prompt.options.length) return null;
  if (prompt.kind === 'arrow-menu') return { kind: 'arrow-menu', key: String(index) };
  // yes-no / numbered / lettered: the detector stores the keystroke key on the
  // option (e.g. 'y'/'n', '1'/'2', 'a'/'b').
  const key = prompt.options[index].key;
  if (key === undefined || key === null) return null;
  return { kind: prompt.kind, key: String(key) };
}
```

- [ ] **Step 4: Run tests + lint to verify pass**

Run: `npx vitest run test/prompt-buttons.test.js && npx eslint lib/prompt-buttons.js test/prompt-buttons.test.js`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add lib/prompt-buttons.js test/prompt-buttons.test.js
git commit -m "feat(prompt-buttons): pure helpers to render/answer TUI prompts as buttons"
```

---

### Task 2: Route `prompt-opt:` button taps into the TUI

**Files:**
- Modify: `index.js` (import near line 20; button-response handler near the `effort:` dispatch, ~`index.js:3799`)

- [ ] **Step 1: Add the import**

After the line `import { switchEffortInSession, effortButtons, VALID_EFFORT_HINT } from './lib/effort-command.js';`, add:

```js
import { promptButtons, promptResponseForButton } from './lib/prompt-buttons.js';
```

- [ ] **Step 2: Add the dispatch branch**

Find the effort button dispatch:

```js
    // Effort picker button (no-arg /effort) — value is `effort:<level>`.
    const effortMatch = value.match(/^effort:(.+)$/);
    if (effortMatch) {
      switchEffortInSession(session, effortMatch[1], sendReply);
      return;
    }
```

Immediately after it, add:

```js
    // Detected-prompt button — value is `prompt-opt:<index>`. Drive the open
    // TUI menu via keystrokes (the only correct iv-mode answer channel). The
    // fix/effort-command guard already skips maybeResolveInteractivePrompt for
    // button responses, so this won't be mis-consumed as a typed reply.
    const promptOptMatch = value.match(/^prompt-opt:(\d+)$/);
    if (promptOptMatch) {
      const p = session.pendingInteractivePrompt;
      const resp = p ? promptResponseForButton(p, Number(promptOptMatch[1])) : null;
      if (p && resp && session.iv && session.iv.alive) {
        session.pendingInteractivePrompt = null;
        session.iv.respondToPrompt(resp);
      }
      return;
    }
```

- [ ] **Step 3: Verify syntax + suite**

Run: `node --check index.js && npx vitest run`
Expected: parses OK; full suite still passes (no behavior change yet — dispatch is dormant until Task 4 renders buttons).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(prompt-buttons): dispatch prompt-opt button taps to respondToPrompt"
```

---

### Task 3: Guard the transcript→buttons path to print-mode only

**Files:**
- Modify: `index.js:1525` (the `if (toolName === 'AskUserQuestion')` block)

- [ ] **Step 1: Add the iv-mode guard**

Find:

```js
        if (toolName === 'AskUserQuestion') {
          debug(`AskUserQuestion tool_use block.id=${block.id}, waitingForAnswer=${session.waitingForAnswer}, input keys=${Object.keys(input).join(',')}`);
          if (session.waitingForAnswer) { debug('Skipping AskUserQuestion — already waiting'); continue; }
```

Insert a new line immediately after the `debug(\`AskUserQuestion tool_use...\`)` line:

```js
          // iv-mode: the AskUserQuestion menu renders in the TUI and is surfaced
          // + answered via the PromptDetector path (handleInteractivePrompt +
          // respondToPrompt keystrokes). Surfacing it again here as buttons
          // would duplicate the prompt, and the button answer would route via
          // sendTextToSession (a regular message), which can't drive the open
          // menu. So this transcript→buttons path is print-mode only — matching
          // the sibling tool_result flow (see resolveQuestionAnswer).
          if (session.iv) { debug('iv-mode: AskUserQuestion owned by PTY detector'); continue; }
```

- [ ] **Step 2: Verify syntax + suite**

Run: `node --check index.js && npx vitest run`
Expected: parses OK; suite passes. (Intermediate state: in iv-mode a native AskUserQuestion now surfaces *once*, as the detector's text prompt — no duplicate.)

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "fix(bridge): AskUserQuestion transcript→buttons path is print-mode only"
```

---

### Task 4: Render detected prompts as buttons

**Files:**
- Modify: `index.js` — `handleInteractivePrompt` (`index.js:813`)

- [ ] **Step 1: Add the button-rendering branch**

Find the start of `handleInteractivePrompt`:

```js
function handleInteractivePrompt(session, prompt) {
  if (!session.sendHtml && !session.sendCallback) return;
  const optionLines = prompt.options.map((opt, i) => `${i + 1}. ${opt.label}${opt.selected ? ' (current)' : ''}`);
```

Insert, immediately after the `if (!session.sendHtml && !session.sendCallback) return;` line and BEFORE the `const optionLines` line:

```js
  // Prefer native buttons when the prompt is a clean selection menu and a
  // button channel is wired. promptButtons returns null for free-text /
  // multi-select / unlabelable prompts, which fall through to the text
  // rendering below. pendingInteractivePrompt is set by the caller
  // (iv.on('prompt')) regardless, so a tap routes via the prompt-opt handler.
  if (session.sendButtonMessage) {
    const b = promptButtons(prompt);
    if (b) {
      const header = prompt.question || 'Claude is asking';
      const plain = ['Claude is asking:', prompt.question || '', '',
        ...b.buttons.map((bt, i) => `${i + 1}. ${bt.label}`)].filter(Boolean).join('\n');
      const htmlOpts = b.buttons.map(bt => `<b>${escapeHtml(bt.label)}</b>`).join(' · ');
      const html = `<b>🟡 Claude is asking:</b>` +
        (prompt.question ? `<br/><i>${escapeHtml(prompt.question)}</i>` : '') +
        `<br/><br/>${htmlOpts}`;
      session.sendButtonMessage(header, b.buttons, b.mode, plain, html);
      return;
    }
  }
```

(The existing text rendering after this point is unchanged and serves as the fallback.)

- [ ] **Step 2: Verify syntax + suite**

Run: `node --check index.js && npx vitest run`
Expected: parses OK; suite passes.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(prompt-buttons): render detected TUI prompts as Matrix buttons"
```

---

### Task 5: Remove the `ask_user` MCP tool and its instruction

**Files:**
- Modify: `ask-user.js` (delete the `ask_user` tool, lines 23-84)
- Modify: `BRIDGE_CLAUDE.md:7`
- Modify: `index.js:27` (`FALLBACK_BRIDGE_PROMPT`)

- [ ] **Step 1: Delete the `ask_user` tool from `ask-user.js`**

Delete the entire `server.tool('ask_user', …)` block — from the line `server.tool(` immediately above `'ask_user',` through its closing `);` (the block ending `}` + `);` just before `server.tool(\n  'request_secret',`). Keep `request_secret`, `share_sensitive_data`, `redact_message`, and the server bootstrap.

- [ ] **Step 2: Remove the instruction lines**

In `BRIDGE_CLAUDE.md`, delete the line:

```
When you need to ask the user a question, use `mcp__ask-user__ask_user` instead of `AskUserQuestion`. `AskUserQuestion` is not available in this environment.
```

In `index.js`, replace the `FALLBACK_BRIDGE_PROMPT` constant (line 27) — remove the ask_user sentence. The fallback should retain only still-true guidance. Change:

```js
const FALLBACK_BRIDGE_PROMPT = 'When you need to ask the user a question, use the mcp__ask-user__ask_user tool instead of AskUserQuestion. AskUserQuestion is not available in this environment.';
```

to:

```js
const FALLBACK_BRIDGE_PROMPT = 'You are running inside a Matrix bridge. The user interacts through Matrix, not a terminal.';
```

- [ ] **Step 3: Verify**

Run: `node --check ask-user.js && node --check index.js && npx vitest run`
Expected: parses OK; suite passes. (POST `/ask` is now unreachable from the MCP side — removed next.)

- [ ] **Step 4: Commit**

```bash
git add ask-user.js BRIDGE_CLAUDE.md index.js
git commit -m "feat(bridge): remove ask_user MCP tool; model uses native AskUserQuestion"
```

---

### Task 6: Remove the dead `/ask` machinery

**Files:**
- Modify: `index.js` (multiple blocks — listed below)
- Delete: `lib/mcp-question-gate.js`, `test/mcp-question-gate.test.js`

Delete each of the following from `index.js`. After all deletions, `grep -nE 'pendingMcpQuestions|expireMcpQuestion|ASK_USER_TIMEOUT_MS|isMcpQuestionAbandoned|mcp-question-gate|mcpQuestionCounter' index.js` must return nothing, and `grep -nE "'/ask'|/ask/" index.js` must return nothing.

- [ ] **Step 1: Delete the import (index.js:22)**

```js
import { isMcpQuestionAbandoned } from './lib/mcp-question-gate.js';
```

- [ ] **Step 2: Delete the two session-death cleanup loops**

Both occurrences (createSession ~`:435` and the iv session `exit` handler ~`:662`) of this block (with its preceding comment, which mentions dropping pending MCP questions):

```js
    for (const [qid, entry] of pendingMcpQuestions) {
      if (entry.roomId === session.roomId) pendingMcpQuestions.delete(qid);
    }
```

And the same loop in the idle-reaper path (~`:4870`):

```js
  for (const [qid, entry] of pendingMcpQuestions) {
    if (entry.roomId === session.roomId) pendingMcpQuestions.delete(qid);
  }
```

- [ ] **Step 3: Delete the `mcp:` branch in `resolveQuestionAnswer` (~`:1208`)**

Delete the whole `if (typeof mode === 'string' && mode.startsWith('mcp:')) { … }` block (it ends just before `} else if (mode === 'text-reply') {`), and change the following `} else if (mode === 'text-reply') {` to `if (mode === 'text-reply') {`. The `text-reply` and final `else` (tool_result) branches stay.

- [ ] **Step 4: Delete the liveness guard (~`:3825`)**

Delete the whole block:

```js
  if (typeof session.waitingForAnswer === 'string' && session.waitingForAnswer.startsWith('mcp:')) {
    const qid = session.waitingForAnswer.slice(4);
    if (isMcpQuestionAbandoned(pendingMcpQuestions.get(qid), Date.now())) {
      if (pendingMcpQuestions.has(qid)) {
        // expireMcpQuestion clears the gate, posts the "moved on" notice, and —
        // …(comment)…
        expireMcpQuestion(qid);
      }
    }
  }
```

(Delete the full `if (… startsWith('mcp:')) { … }` block and its leading comment.)

- [ ] **Step 5: Delete the declarations + `expireMcpQuestion` (~`:4264`–`:4318`)**

Delete:

```js
const pendingMcpQuestions = new Map();
let mcpQuestionCounter = 0;
```

(keep `const pendingSecrets = new Map();` if it sits between them — verify and keep any non-MCP declarations.)

Delete the `ASK_USER_TIMEOUT_MS` declaration (~`:4273`) and its comment:

```js
const ASK_USER_TIMEOUT_MS = parseInt(process.env.ASK_USER_TIMEOUT_MS || '1800000', 10);
```

Delete the entire `function expireMcpQuestion(questionId) { … }` (~`:4281`) including its trailing tombstone `setTimeout(() => pendingMcpQuestions.delete(questionId), 60000)` line and any closing braces of that function.

- [ ] **Step 6: Delete the HTTP handlers**

Delete the `GET /ask/:id` handler block (`index.js:4333`–`4355`, the `if (req.method === 'GET' && url.pathname.startsWith('/ask/')) { … }`). Keep the `/secret/`, `/sensitive/` handlers that follow.

Delete the `POST /ask` handler block (`index.js:4421`–`4473`, the `if (url.pathname === '/ask') { … }`). Keep the `/secret` POST handler that follows.

- [ ] **Step 7: Delete the gate module + test**

```bash
git rm lib/mcp-question-gate.js test/mcp-question-gate.test.js
```

- [ ] **Step 8: Verify**

Run:
```bash
node --check index.js && node --check ask-user.js
grep -nE 'pendingMcpQuestions|expireMcpQuestion|ASK_USER_TIMEOUT_MS|isMcpQuestionAbandoned|mcp-question-gate|mcpQuestionCounter' index.js || echo "clean"
grep -nE "'/ask'|/ask/" index.js || echo "clean"
npx vitest run
npx eslint index.js ask-user.js
```
Expected: both `grep`s print `clean`; suite passes; no lint errors. (If eslint flags an unused `sendAllQuestions` or `resolveQuestionAnswer`, that's a real signal — both must still be referenced by the print-mode AskUserQuestion path; investigate rather than blindly delete.)

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "refactor(bridge): remove dead /ask MCP-question machinery"
```

---

### Task 7: Full verification + push

- [ ] **Step 1: Full suite + lint + syntax**

Run:
```bash
npx vitest run
npx eslint index.js ask-user.js lib/prompt-buttons.js test/prompt-buttons.test.js
node --check index.js
```
Expected: all tests pass; no lint errors.

- [ ] **Step 2: Manual verification checklist (post-deploy, documented in PR)**

These require a running bridge (deploy ends the current session), so list them in the PR for the operator to confirm:
- Native `AskUserQuestion` (single-select, short labels) → **one** button message, no text duplicate; tapping a button selects in the TUI and the turn continues.
- A free-text question (no options) → text prompt with "send any text" (no buttons).
- `/effort` confirm ("Change effort level?") → Yes/No buttons; tapping Yes applies.
- A permission/plan prompt → buttons; tap routes correctly.
- `request_secret` / `share_sensitive_data` still work (secret flow unaffected).

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/prompt-buttons
gh pr create --base master --title "feat(bridge): unify question handling as detector-owned buttons" --body "<summary + the Task 7 manual checklist; note it depends on #78 (fix/effort-command) and should merge after it>"
```

(Open non-draft so Bugbot reviews each push.)
