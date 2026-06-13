# Unify question handling: detector-owned prompts as Matrix buttons — design

**Date:** 2026-06-13
**Status:** Draft (pending spec review)
**Branch:** `feat/prompt-buttons` (off `fix/effort-command` — depends on its button-tap guard)

## Problem

In interactive (iv) mode a question to the user can be surfaced **twice**:

1. **Native `AskUserQuestion`** renders an interactive menu in the TUI. That menu
   is caught by the `PromptDetector`, which surfaces it as the
   *"🟡 Claude is asking… reply with a number"* **text** prompt
   (`handleInteractivePrompt`, index.js:813), AND the same `AskUserQuestion`
   tool_use in the transcript triggers the `sendAllQuestions` **buttons** path
   (index.js:1525) — so the user sees the question rendered two different ways at
   once and doesn't know which to answer.
2. The separate `mcp__ask-user__ask_user` MCP tool (ask-user.js) was added to
   avoid that by giving clean buttons via `POST /ask`, and the bridge instructs
   the model to use it *instead of* `AskUserQuestion`. But the model frequently
   ignores that instruction and calls native `AskUserQuestion` anyway, so the
   duplicate keeps happening.

Verified from logs (2026-06-13): a single `AskUserQuestion` produced an
`iv-prompt` (detector text) at 10:40:30 **and** a `sendAllQuestions` button
message at 10:42:09 for the same question.

Root cause: **two uncoordinated surfacing mechanisms** for the same prompt, and
the iv-mode menu's only correct answer channel (keystrokes via the detector)
differs from the button channel's answer channel (`sendTextToSession`, which
does not drive an open TUI menu, index.js:1248).

## Goal

One question mechanism in iv-mode:

1. The `PromptDetector` is the single authority for every TUI prompt (permission
   dialogs, resume/plan pickers, the `/effort` confirm, **and** native
   `AskUserQuestion`).
2. Detected prompts are surfaced as **native Matrix buttons** when possible;
   tapping a button drives the TUI via keystrokes (`respondToPrompt`).
3. Prompts that can't be cleanly turned into buttons (free-text, multi-select,
   overlong labels, or no button channel) fall back to **today's text prompt** —
   never dropped.
4. The old `ask_user` MCP question tool and its `/ask` machinery are **removed**.
5. No duplication is possible, because there is only one surfacing path.

Print mode (legacy; not this deployment, which runs `MATRON_INTERACTIVE_MODE=1`)
keeps its self-contained `AskUserQuestion` → `sendAllQuestions` →
`text-reply` handling unchanged.

## Key facts (verified)

- This deployment runs **iv-mode only** (`MATRON_INTERACTIVE_MODE=1` in the
  systemd unit). `MATRON_DUMP_PTY=1` is also set.
- The detector already reliably classifies TUI menus as `yes-no` / `numbered` /
  `lettered` / `arrow-menu` with a `question`, `options[]` (each `{label, key,
  selected}`), and `freeTextIdx` (test/prompt-detector.test.js).
- `InteractiveSession.respondToPrompt({kind, key})` already answers all those
  kinds via keystrokes (interactive-session.js:96) — this is the *correct* iv
  answer channel for an open menu.
- The detector **rejects** option labels longer than ~68 chars (treats them as
  wrapped prose, not a menu). So overlong-label menus aren't classified as menus
  at all — they simply won't surface as buttons.
- The `/ask` + `/ask/:id` endpoints, `pendingMcpQuestions`, `expireMcpQuestion`,
  `mcp-question-gate.js`, `ASK_USER_TIMEOUT_MS`, and the `waitingForAnswer =
  'mcp:<id>'` branch exist **only** to serve `mcp__ask-user__ask_user`. Removing
  the tool makes all of them dead.
- The `/secret`, `/share-sensitive`, `/redact-message` endpoints and the
  `request_secret` / `share_sensitive_data` / `redact_message` MCP tools are
  **independent** of `/ask` and are security-critical — they stay.
- Depends on the `fix/effort-command` change that skips
  `maybeResolveInteractivePrompt` for button responses, so a button tap is never
  mis-consumed as a typed prompt answer.

## Approach

### New module: `lib/prompt-buttons.js` (pure, unit-testable)

- `promptButtons(prompt)` → `{ buttons, mode: 'pick_one' }` or `null`.
  - Returns `null` (→ text fallback) when: no options; **`prompt.freeTextIdx` is
    set** (the menu offers a "type anything" slot, e.g. plan-mode's "Tell Claude
    what to change" — text rendering preserves both the numbered pick *and* the
    free-text reply); `prompt.multiSelect` (detector never sets this today, but
    guard anyway); or any option label is empty.
  - Each button: `{ id: 'prompt-opt-<i>', label: <option label>, value:
    'prompt-opt:<i>' }`. The `(current)` marker is dropped from button labels.
- `promptResponseForButton(prompt, index)` → `{ kind, key }` for
  `respondToPrompt`, or `null` if the index is out of range. Mirrors the
  response-construction in `maybeResolveInteractivePrompt`:
  - `yes-no` → `{kind:'yes-no', key: options[index].key}` (the detector sets the
    option's key to `'y'`/`'n'`)
  - `arrow-menu` → `{kind:'arrow-menu', key: String(index)}`
  - `numbered`/`lettered` → `{kind, key: options[index].key}`

### Surface as buttons: `handleInteractivePrompt` (index.js:813)

- Compute `const b = (session.sendButtonMessage) ? promptButtons(prompt) : null;`
- If `b` → `session.sendButtonMessage(prompt.question || 'Claude is asking', b.buttons, b.mode, <plain fallback>, <html fallback>)`.
- Else → existing text rendering, unchanged.
- `session.pendingInteractivePrompt = prompt` continues to be set (in the
  `iv.on('prompt')` handler) regardless of rendering, so the answer routes the
  same way whether the user taps a button or types a number.

### Route a tap: button-response handler (next to the `effort:`/`model:` dispatch, index.js:~3799)

```
const optMatch = value.match(/^prompt-opt:(\d+)$/);
if (optMatch) {
  const p = session.pendingInteractivePrompt;
  const resp = p ? promptResponseForButton(p, Number(optMatch[1])) : null;
  if (p && resp && session.iv) {
    session.pendingInteractivePrompt = null;
    session.iv.respondToPrompt(resp);
  }
  return;
}
```

(Typed numeric/`y`/`n` replies still work via `maybeResolveInteractivePrompt`,
unchanged — buttons are additive.)

### Kill the duplicate transcript path in iv-mode: `AskUserQuestion` handler (index.js:1525)

Add at the top of the `if (toolName === 'AskUserQuestion')` block:
```
if (session.iv) { debug('iv-mode: AskUserQuestion owned by PTY detector'); continue; }
```
Matches the existing convention that the sibling `tool_result` flow is
"print-mode only, unreachable in iv-mode" (index.js:1252).

### Remove the old MCP question path

- **ask-user.js:** delete the `ask_user` tool (lines 23-84). Keep the other three
  tools and the server.
- **Instruction:** remove the "use `mcp__ask-user__ask_user` instead of
  AskUserQuestion" sentence from `BRIDGE_CLAUDE.md:7` and `FALLBACK_BRIDGE_PROMPT`
  (index.js:27). Keep the sensitive-data instructions.
- **index.js dead code:** remove `POST /ask`, `GET /ask/:id`, `pendingMcpQuestions`,
  `expireMcpQuestion`, `ASK_USER_TIMEOUT_MS`, the `import … mcp-question-gate`,
  and the `waitingForAnswer.startsWith('mcp:')` branches (resolveQuestionAnswer
  index.js:1225, and the liveness guard index.js:~3815).
- **lib/mcp-question-gate.js** and **test/mcp-question-gate.test.js:** delete.
- `resolveQuestionAnswer`'s `text-reply` and `tool_result` branches stay (print
  mode). `sendAllQuestions` stays (print-mode `AskUserQuestion`).

## Data flow (iv-mode, after change)

```
model calls AskUserQuestion
  → TUI renders menu (PTY)
  → PromptDetector classifies → iv.on('prompt') sets pendingInteractivePrompt
  → handleInteractivePrompt: promptButtons() → buttons (or text fallback)
user taps "Option 2"  (value prompt-opt:1)
  → button-response handler: skip maybeResolve (button), match prompt-opt
  → promptResponseForButton(prompt,1) → respondToPrompt keystrokes into the menu
  → TUI applies selection; pendingInteractivePrompt cleared
```

## Edge cases

- **Free-text question** (no options): text fallback ("send any text"), as today.
- **Overlong labels** (>~68 chars): not classified as a menu → text fallback /
  not surfaced as buttons. `AskUserQuestion` labels are meant to be 1-5 words.
- **Multi-select:** detector has no multi-select kind; such menus fall back to
  text. Documented limitation (rare).
- **Multiple questions per call:** the TUI advances one menu at a time; the
  detector catches each in turn → user answers, next surfaces. Works naturally.
- **No button channel** (`sendButtonMessage` unset, e.g. some auto-started
  sessions): text fallback.

## Testing

- Unit: `test/prompt-buttons.test.js` for `promptButtons` (button shape, null
  fallbacks) and `promptResponseForButton` (per-kind response mapping, bounds).
- Existing `test/prompt-detector.test.js` covers classification (unchanged).
- Delete `test/mcp-question-gate.test.js` with its module.
- Regression: full vitest suite green; eslint clean.
- Manual (post-deploy): native `AskUserQuestion` shows buttons once; tap selects;
  free-text falls back to text; `/effort` confirm shows as Yes/No buttons.

## Risks

- **Detector reliance:** questions now depend entirely on screen classification.
  Mitigated: the detector is already the authority for all other iv prompts, is
  well-tested, and the text fallback prevents a dropped prompt.
- **Removal blast radius:** the `/ask` machinery is intertwined with session
  state. Mitigated: it is reachable *only* via the removed tool; removal is
  guarded by the full test suite, and `/secret`-family endpoints are untouched.
- **Ordering:** a button tap must not be eaten by `maybeResolveInteractivePrompt`
  — covered by the `fix/effort-command` guard this branch builds on.
