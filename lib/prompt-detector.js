import { EventEmitter } from 'node:events';

// Strip ANSI escape sequences, converting cursor-positioning escapes to
// equivalent whitespace via a single left-to-right column-aware tokenising
// pass. The pass tracks the current visible column (1-indexed) so it can
// convert Cursor Horizontal Absolute (CHA, `\x1b[<n>G`) into the correct
// number of padding spaces — something a stateless regex chain cannot do.
//
// Tokeniser priority (matches in order):
//   1. OSC sequence  \x1b]…\x07      (drop)
//   2. CSI sequence  \x1b[…          (interpret or drop per type)
//   3. Other escape  \x1b + one byte  (drop)
//   4. CR  \r                         (reset col to 1, emit nothing)
//   5. LF  \n                         (emit \n, reset col to 1)
//   6. Literal-text run /[^\x1b\r\n]+/ (emit, advance col)
//
// The literal-text token MUST stop on \x1b, \r, AND \n so that CR/LF are
// always seen as their own tokens and never silently swallowed (plan-review
// R1 B3 — a \x1b-only stop set breaks CR/A1 repositioning).
//
// CSI sequences handled:
//   CHA  \x1b[<n>G  — move to absolute column n:
//     target = clamp(n, 1, COL_CAP)
//     target > col  → append (target-col) spaces, col = target
//     target <= col → col = target (no rewrite — accepted limitation A1)
//   Cursor-forward  \x1b[<n>C  → append min(n, MAX_FWD_SPACES) spaces
//   Cursor-down / next-line  \x1b[<n>[BE]  → append min(n, ROW_CAP) newlines, col = 1
//   All other CSI / OSC / escape  → drop, col unchanged
//
// Constants (MUST stay distinct — CHA and cursor-forward have different semantics):
//   COL_CAP = 120        CHA clamps to real terminal width (PTY spawned at cols=120)
//   MAX_FWD_SPACES = 80  cursor-forward per-escape byte-budget cap (unchanged from old code)
//   ROW_CAP = 50         cursor-down newline cap (unchanged from old code)

const COL_CAP = 120;
const MAX_FWD_SPACES = 80;
const ROW_CAP = 50;

// Master tokeniser — matches one token at a time from position `pos`.
// Returns { type, raw, n? } or null when the input is exhausted.
//   type 'osc'     — OSC sequence (drop)
//   type 'csi'     — parsed CSI with final byte and .n (first numeric arg, 0 if absent)
//   type 'esc'     — bare escape (drop)
//   type 'cr'      — carriage return
//   type 'lf'      — line feed
//   type 'text'    — literal-text run
// eslint-disable-next-line no-control-regex
const TOKEN_RE = /\x1b\][^\x07]*\x07|\x1b\[([0-9;?<>=!]*)([ -/]*)([@-~])|\x1b[@-_a-z]|\r|\n|[^\x1b\r\n]+/g;

export function stripAnsi(s) {
  let col = 1;
  const out = [];

  for (const m of s.matchAll(TOKEN_RE)) {
    const raw = m[0];

    if (raw[0] !== '\x1b' && raw !== '\r' && raw !== '\n') {
      // Literal-text run
      out.push(raw);
      col += raw.length;
      continue;
    }

    if (raw === '\r') {
      // CR: reposition col, emit nothing (accepted limitation A1)
      col = 1;
      continue;
    }

    if (raw === '\n') {
      out.push('\n');
      col = 1;
      continue;
    }

    // Escape sequence — raw[0] === '\x1b'
    if (raw[1] === ']') {
      // OSC: drop
      continue;
    }

    if (raw[1] === '[') {
      // CSI: raw[1]='[', m[1]=params, m[2]=intermediates, m[3]=final byte
      const params = m[1] ?? '';
      const final = m[3];
      const firstParam = params.split(';')[0];
      const n = firstParam === '' ? 1 : (parseInt(firstParam, 10) || 1);

      if (final === 'G') {
        // CHA — Cursor Horizontal Absolute
        const target = Math.max(1, Math.min(n, COL_CAP));
        if (target > col) {
          out.push(' '.repeat(target - col));
        }
        col = target;
        continue;
      }

      if (final === 'C') {
        // Cursor Forward
        const spaces = Math.min(n, MAX_FWD_SPACES);
        out.push(' '.repeat(spaces));
        col += spaces;
        continue;
      }

      if (final === 'B' || final === 'E') {
        // Cursor Down / Next-Line
        const newlines = Math.min(n, ROW_CAP);
        out.push('\n'.repeat(newlines));
        col = 1;
        continue;
      }

      // All other CSI (color, screen-clear, cursor up/back, mouse modes): drop
      continue;
    }

    // All other escapes (\x1b + one byte): drop
  }

  return out.join('');
}

// Claude's TUI renders its input field with a full-line background fill:
// each (possibly wrapped) line looks like `\x1b[48;5;<n>m\x1b[38;5;<n>m❯ <text>`.
// Nothing else in the stream opens a line with a background-colour SGR —
// response prose and the status bar use foreground colours + cursor moves
// only. These lines MUST be removed before stripAnsi, otherwise the user's
// own wrapped message becomes a phantom `❯`-cursor menu and the arrow-menu
// detector surfaces it as "Claude is asking". Matched theme-independently
// via the SGR structure (any 256/truecolour background), not specific colours.
// eslint-disable-next-line no-control-regex
const INPUT_BOX_OPEN_RE = /^[\r\s]*\x1b\[48[;0-9:]*m/;

// Footer that closes Claude Code's queued-message ("type-ahead") widget. Hoisted
// above stripInputBox so the box stripper can spare it (see below); stripQueuedWidget
// reuses it. Matched whitespace-tolerantly since stripAnsi can vary inter-word spacing.
const QUEUED_FOOTER_RE = /press\s+up\s+to\s+edit\s+queued\s+messages/i;

export function stripInputBox(raw) {
  if (!raw || raw.indexOf('\x1b[48') === -1) return raw;
  return raw.split('\n').filter(line => {
    if (!INPUT_BOX_OPEN_RE.test(line)) return true;
    // Keep genuine highlighted menu options (a number/letter follows the
    // marker, e.g. `❯ 1. Yes`) so we never strip a real selection; only
    // the free-text input field (`❯ <prose>`) gets dropped.
    const vis = stripAnsi(line).trim();
    if (/^[❯>▶►]?\s*\d+[.)]/.test(vis)) return true;
    if (/^[❯>▶►]?\s*\(?[a-zA-Z]\)?[.)]\s/.test(vis)) return true;
    // Keep the queued-widget footer even when it renders as its own
    // background-filled row, so stripQueuedWidget (which runs later, after
    // stripAnsi) can still anchor on it and blank the queued type-ahead lines.
    // Without this, a footer dropped here leaves a numbered queued line
    // (`❯ 1. …`, kept by the numbered exception above) to trip a phantom menu.
    if (QUEUED_FOOTER_RE.test(vis)) return true;
    return false;
  }).join('\n');
}

const YN_RE = /[[(]\s*[yY]\s*\/\s*[Nn]\s*[\])]|[[(]\s*[Yy]\s*\/\s*[nN]\s*[\])]/;
// The TUI uses cursor-positioning escapes between menu marker, number, and
// label rather than literal spaces — after ANSI strip the line looks like
// `❯1.Yes,andbypasspermissions`. Allow zero spaces after every separator.
// Also accept an optional menu marker (❯ etc.) before the number/letter so
// the "current selection" line still parses as a numbered/lettered item.
const NUMBERED_LINE_RE = /^[\s❯>▶►]*(\d+)[.)]\s*(.+)$/;
const LETTERED_LINE_RE = /^[\s❯>▶►]*\(?([a-zA-Z])\)?[.)]\s*(.+)$/;
const ARROW_MARKER_RE = /^(\s*)([❯>▶►])\s*(.+)$/;
// Marker set for DETECTING an arrow menu — deliberately excludes ASCII `>`:
// claude's TUI renders past USER messages in the transcript as `> hi`, so a
// resume's full-screen repaint is full of `>`-prefixed lines that are chat
// history, not menus. Real selection menus always use ❯/▶/►. ASCII `>` stays
// in ARROW_MARKER_RE (stripping/question-cleanup) and the numbered/lettered
// prefix classes, where a number/letter must also match.
const ARROW_MENU_MARKER_RE = /^(\s*)([❯▶►])\s*(.+)$/;

// Lines that look like UI chrome rather than real menu options. The TUI
// renders separators (box drawing), status bars (⏵⏵, ◉), and so on around
// the input area; misreading these as menu items produces false positives
// the moment claude paints its welcome screen.
const SEPARATOR_RE = /^[-=_─-╿▀-▟‐-―]+$/;
// CHROME_RE rejects lines that contain TUI decoration we treat as a hard
// "this isn't a menu item" signal. Beyond the existing button/marker
// glyphs, include the tree-drawing brackets used in claude's tool-call
// status output (`⎿ Read foo.md`, `⎿ Referenced file ...`) and the
// sparkle/spinner glyphs in status lines (`✻ Baked for 2m33s`). Without
// these, the arrow-menu detector happily reads a `❯ /compact` slash-
// command suggestion plus its trailing `⎿ ...` status lines as a real
// menu and asks the user to pick an option.
const CHROME_RE = /[⏴-⏺◀-◿⬅-⬍⎰-⎿✢-✿]|⏵⏴|◉|◯|·\s+\//;

function looksLikeRealMenuItem(text) {
  if (!text) return false;
  if (SEPARATOR_RE.test(text)) return false;
  if (CHROME_RE.test(text)) return false;
  // Reject lines that are mostly non-alphanumeric (status bars, art).
  const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum < 2 || alnum / text.length < 0.3) return false;
  return true;
}

// Real menu options are concise — the longest claude ships (`/login`
// options) is ~68 chars. A label far longer than that is wrapped prose,
// not a menu item: the classic signature of a wrapped line of response
// text or the input field bleeding into the detector. Reject options
// above this bound (terminal width is 120, so a wrapped line lands ~110+).
const MENU_OPTION_MAX_LEN = 90;

function looksLikeMenuOption(text) {
  return looksLikeRealMenuItem(text) && text.length <= MENU_OPTION_MAX_LEN;
}

// Keyboard-shortcut hints that the TUI shows alongside a menu (e.g. "shift+tab
// to approve with this feedback", "ctrl-g to edit in VS Code"). These look
// like real menu items by length/alnum but shouldn't be presented to the
// user as choices.
const KEYBOARD_HINT_RE = /\b(shift\+?tab|ctrl[+-]?[a-z]|alt[+-]?[a-z]|esc(?:ape)?|enter|return)\b\s+to\s+\w/i;

function isKeyboardHintLine(text) {
  return KEYBOARD_HINT_RE.test(text);
}

// Claude Code folds a large pasted message in the input box into a placeholder
// widget that renders as `❯ [Pasted text #1 +9 lines]` with a `paste again to
// expand` hint beneath it. The arrow-marker (❯) matches, so without this guard
// the folded paste is misread as a selection menu — surfacing a phantom prompt
// to the operator and triggering a spurious busy-clear on any multi-line paste.
// Anchored so a real menu option that merely contains the words "paste again
// to expand" isn't mistaken for chrome. The `[Pasted text …]` alternative
// keeps a leading anchor only (the widget can be followed by the dim hint on
// the same line), while the bare hint must be the whole line.
const PASTE_FOLD_RE = /^\[Pasted text\s+#\d+\s+\+\d+\s+lines?\]|^paste again to expand$/i;

function isPasteFoldLine(text) {
  return PASTE_FOLD_RE.test(text);
}

// Claude Code renders messages the user types while a turn is running ("type-
// ahead") in a queued-message widget: one or more `❯ <text>` lines closed by a
// `❯ Press up to edit queued messages` footer. Those `❯ <text>` lines are USER
// INPUT, not menu options — but a queued message that happens to start with a
// number ("❯ 1. also to be clear …") is structurally identical to a numbered
// menu item, so both classifyScreen and the looksLikeUnclassifiedMenu safety
// net misread the widget as a prompt and surface a phantom menu while claude is
// mid-turn. Blank the widget lines (the footer plus the marker lines above it)
// so neither detector sees them. A real menu that happens to sit BELOW the
// widget is untouched. Operates on the ANSI-stripped screen; idempotent (once
// the footer is blanked a second pass matches nothing). QUEUED_FOOTER_RE is
// defined above stripInputBox (which also needs it).
// Spinner repaints can leave a blank spacer or two between the queued messages
// and the footer; tolerate a small run of them, but stop at the first real
// (non-marker, non-blank) line so we never blank unrelated content above.
const QUEUED_WIDGET_MAX_WALK = 24;
const QUEUED_WIDGET_MAX_BLANKS = 2;

export function stripQueuedWidget(screen) {
  if (!screen || !QUEUED_FOOTER_RE.test(screen)) return screen;
  const lines = String(screen).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!QUEUED_FOOTER_RE.test(lines[i])) continue;
    lines[i] = '';
    let blanks = 0;
    for (let j = i - 1; j >= 0 && i - j <= QUEUED_WIDGET_MAX_WALK; j--) {
      const t = (lines[j] || '').trim();
      if (!t) { if (++blanks > QUEUED_WIDGET_MAX_BLANKS) break; continue; }
      if (!/^[❯>▶►]/.test(t)) break; // first real line above the widget — stop
      blanks = 0;
      lines[j] = '';
    }
  }
  return lines.join('\n');
}

// Safety-net heuristic: does the settled screen look like a selection menu the
// classifier COULDN'T parse? Used only when classifyScreen returned null and
// there's no known input cue — to surface an otherwise-invisible prompt rather
// than leave the Matrix user blind while the TUI waits. Deliberately tight to
// avoid false positives on normal output: requires a TUI selection cursor
// (❯/▶/►) AND a numbered/lettered option on the same line, with a real label
// (not a paste-fold, keyboard hint, or chrome). The user's own input cursor is
// stripped (stripInputBox) before this runs, so a surviving ❯ is a real menu
// marker; a bare prose numbered list (no cursor) or a single "❯ /command"
// suggestion (no number/letter) is correctly ignored.
export function looksLikeUnclassifiedMenu(screen) {
  if (!screen) return false;
  screen = stripQueuedWidget(screen);
  for (const raw of String(screen).split('\n')) {
    if (!/[❯▶►]/.test(raw)) continue;
    const numbered = raw.match(NUMBERED_LINE_RE);
    const lettered = numbered ? null : raw.match(LETTERED_LINE_RE);
    const label = numbered ? numbered[2] : lettered ? lettered[2] : null;
    if (!label) continue;
    if (isPasteFoldLine(label)) continue;
    if (isKeyboardHintLine(label)) continue;
    if (!looksLikeRealMenuItem(label)) continue;
    return true;
  }
  return false;
}

// Claude's interactive prompts almost always include a final "free-text"
// option ("Tell Claude what to change", "Refine with Ultraplan", "Edit in
// VS Code"). When the user replies to a Matrix-surfaced prompt with text
// that doesn't parse as a number/letter, we route them to this option and
// pipe their reply into the TUI's text input. The heuristic: the LAST
// option's label starts with one of a handful of well-known verbs.
const FREE_TEXT_LABEL_RE = /^(tell|refine|describe|enter|specify|edit|type|other)\b/i;

function detectFreeTextIdx(options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const last = options[options.length - 1];
  const label = (last && last.label || '').trim();
  return FREE_TEXT_LABEL_RE.test(label) ? options.length - 1 : null;
}

// How many trailing lines of the stripped screen to consider when looking
// for a prompt. The PTY buffer accumulates many overlapping redraws — when
// claude's TUI repaints a status line every spinner tick the older content
// piles up in the byte stream. Only the bottom of that stream reflects what
// the user can currently see, so restrict classification to roughly one
// screen-worth of trailing lines.
const SCREEN_TAIL_LINES = 50;

// How many lines above the menu we'll walk back to assemble the question.
// claude's modals (e.g. the bypass-permissions warning) include a multi-
// line WARNING + explanation paragraph + URL above the options. The old
// 2-line slice cropped this to just the URL, leaving Matrix users staring
// at a question consisting solely of `https://code.claude.com/docs/en/security`.
const QUESTION_LINES_ABOVE_MENU = 12;

// Walk lines[0..startIdx-1] backwards collecting non-blank, non-chrome
// lines until we hit a separator line (e.g. ────) or QUESTION_LINES_ABOVE_MENU
// non-blank lines, whichever comes first. Returns lines in original (top-to-
// bottom) order so the caller can `join(' ')` them into a question string.
function collectQuestionLinesAbove(lines, startIdx) {
  const collected = [];
  for (let i = startIdx - 1; i >= 0 && collected.length < QUESTION_LINES_ABOVE_MENU; i--) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // A row of separator chars (────) marks the top of the modal — anything
    // above it is a different screen region (status bar, prior prompt) so
    // stop walking back.
    if (SEPARATOR_RE.test(trimmed)) break;
    collected.push(trimmed);
  }
  return collected.reverse();
}

// --- Explanatory-prose (preamble) capture ---------------------------------
// In iv-mode claude writes the assistant message (including the prose it wrote
// before an AskUserQuestion) to the transcript only AFTER the tool resolves —
// i.e. after the user answers. But that prose IS on the live PTY screen when
// the menu renders, just separated from it by chrome and pushed up by the
// spinner animation (which the column-aware stripAnsi turns into long runs of
// blank lines). extractPreamble recovers it: collapse blank runs, find the
// assistant-message marker (●) above the menu, and collect the prose between
// it and the question, dropping chrome.

function collapseBlankRuns(lines) {
  const out = [];
  let prevBlank = false;
  for (const l of lines) {
    const blank = !l.trim();
    if (blank && prevBlank) continue;
    out.push(l);
    prevBlank = blank;
  }
  return out;
}

// Prose lines carry real words; spinner-frame fragments ("✢ g", "* n2") do not.
function looksLikeProse(text) {
  if (!text) return false;
  const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum >= 8 && alnum / text.length > 0.5;
}

// The AskUserQuestion header renders with a checkbox glyph (☐/☑/▢/▣).
const QUESTION_HEADER_RE = /^\s*[☐☑▢▣]/;

// TodoWrite widget chrome the spinner repaints between the prose and the menu.
// A summary line opens the widget ("7 tasks (2 done, 1 in progress, 4 open)")
// and a collapsed footer closes it ("… +2 completed"). The item rows in between
// carry ◼/◻ glyphs (already CHROME_RE), but a mid-paint redraw can shift the
// glyph off a row, leaving garbled prose ("P opose 2-3 integrat o approaches")
// that slips past looksLikeProse — so once we see the summary we skip the whole
// block through to its footer/blank line.
const TODO_SUMMARY_RE = /^\s*\d+\s+tasks?\s+\(\d+\s+(?:done|in progress|open|completed|pending)\b/i;
const TODO_FOOTER_RE = /^\s*(?:…|\.\.\.)\s*\+\d+\s+\w+/;

// Spinner status line ("✻ Asking clarifying questions… (8m 38s · ↓ 39.6k
// tokens · thought for 26s)"). The leading spinner glyph is usually CHROME_RE,
// but plain '*'/'·' animation frames are not — match the token-count /
// "thought for" telemetry that always rides along instead.
const SPINNER_STATUS_RE = /[↑↓]\s*[\d.]+k?\s+tokens|\bthought for\s+\d+\s*s/i;

// Recover claude's pre-question prose from the recent raw PTY output. `prompt`
// is the detector's classified result (used to locate the question boundary).
// Returns { preamble, complete }; `complete` is true only when the assistant-
// message marker was found AND prose was captured — the caller relies on that
// to decide whether the post-answer transcript copy is a safe duplicate to drop.
export function extractPreamble(raw, prompt) {
  if (!raw || !prompt) return { preamble: '', complete: false };
  const lines = collapseBlankRuns(stripAnsi(stripInputBox(String(raw))).split('\n'));
  const qNorm = (prompt.question || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
  const isOption = (l) => NUMBERED_LINE_RE.test(l) || LETTERED_LINE_RE.test(l);
  const matchesQuestion = (l) => qNorm.length >= 12 && l.toLowerCase().replace(/\s+/g, ' ').includes(qNorm);
  const isWidget = (l) => isOption(l) || QUESTION_HEADER_RE.test(l) || matchesQuestion(l);
  // Bottom-most widget line = the detected menu/question.
  let menuRef = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (isWidget(lines[i])) { menuRef = i; break; } }
  if (menuRef < 0) return { preamble: '', complete: false };
  // Nearest assistant-message marker (●) above it bounds this turn's prose.
  let start = -1;
  for (let i = menuRef - 1; i >= 0 && menuRef - i < 400; i--) {
    if (/^\s*●/.test(lines[i])) { start = i; break; }
  }
  const from = start >= 0 ? start : Math.max(0, menuRef - 80);

  // Queued/echoed USER input renders with the input cursor (❯) in the region
  // BETWEEN the prose and the menu, and a plain scrollback twin can sit there
  // too — so scan the prose window itself, not below the menu. Collect each
  // cursor line's text so we can drop its plain twin (a queued "should we bring
  // the editor out of vite btw?" leaked into the preamble otherwise). The
  // cursor line itself is dropped by the `^[❯>▶►]` chrome filter below; this
  // only removes the bare duplicate. Require a substantial length so a short
  // echo can't accidentally suppress a short line of real prose.
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const inputEchoes = new Set();
  for (let i = from; i < menuRef; i++) {
    const m = (lines[i] || '').trim().match(/^[❯>▶►]\s+(\S.*)$/);
    if (m) { const echo = norm(m[1]); if (echo.length >= 12) inputEchoes.add(echo); }
  }

  const prose = [];
  let inTodo = false; // inside a TodoWrite widget block (summary → footer)
  for (let i = from; i < menuRef; i++) {
    const line = lines[i] || '';
    if (isWidget(line)) break; // reached the question/menu widget
    const t = line.replace(/^\s*●\s*/, '').trim();
    if (!t) { inTodo = false; continue; } // blank line closes any todo block
    if (inTodo) {
      if (TODO_FOOTER_RE.test(t)) inTodo = false; // consume the footer, then exit
      continue;
    }
    if (TODO_SUMMARY_RE.test(t)) { inTodo = true; continue; }
    if (TODO_FOOTER_RE.test(t)) continue;    // stray footer (block opened off-window)
    if (SPINNER_STATUS_RE.test(t)) continue; // spinner telemetry line
    if (SEPARATOR_RE.test(t) || CHROME_RE.test(t) || KEYBOARD_HINT_RE.test(t) || /^[❯>▶►]/.test(t)) continue;
    if (inputEchoes.has(norm(t))) continue;  // queued / echoed user input
    if (!looksLikeProse(t)) continue;
    prose.push(t);
  }
  const preamble = prose.join(' ').replace(/\s+/g, ' ').trim();
  return { preamble, complete: start >= 0 && preamble.length > 0 };
}

// Whether a transcript text flush is (substantially) the same prose we already
// surfaced as a preamble — used to suppress the post-answer duplicate. The
// screen capture can have minor glyph glitches, so compare word-overlap rather
// than requiring equality.
export function preambleMatchesText(preamble, text) {
  if (!preamble || !text) return false;
  const words = (s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
  const a = words(preamble), b = words(text);
  if (a.size < 6 || b.size < 6) return false;
  let common = 0;
  for (const w of b) if (a.has(w)) common++;
  // max() denominator (not min()) so a short preamble that merely appears
  // inside a longer, genuinely-different message doesn't score as a match —
  // both sides must be substantially the same set of words.
  return common / Math.max(a.size, b.size) >= 0.5;
}

// Classify a screen (already ANSI-stripped) as one of the prompt kinds we
// know how to respond to. Returns `null` if the screen does not look like a
// prompt — false negatives are preferred over false positives, since false
// positives spam Matrix with "claude is asking" messages mid-response.
export function classifyScreen(screen) {
  if (!screen) return null;
  screen = stripQueuedWidget(screen);
  const allLines = screen.split('\n').map(l => l.trimEnd());
  // Restrict to the bottom of the buffer so older redraws don't contaminate
  // the match (e.g. an old ❯ from a prior screen above the actual prompt).
  const lines = allLines.slice(-SCREEN_TAIL_LINES);

  // Yes/No — search only the sliced `lines` (last SCREEN_TAIL_LINES) so a
  // stale [y/N] in older scrollback can't preempt a real menu at the
  // bottom of the screen.
  {
    const matchLineIdx = lines.findIndex(l => YN_RE.test(l));
    if (matchLineIdx >= 0) {
      const question = lines.slice(Math.max(0, matchLineIdx - 1), matchLineIdx + 1).join(' ').trim();
      return {
        kind: 'yes-no',
        question: question.replace(YN_RE, '').trim() || question,
        options: [
          { key: 'y', label: 'Yes' },
          { key: 'n', label: 'No' },
        ],
        freeTextIdx: null,
      };
    }
  }

  // Numbered selection. The buffer can contain multiple numbered runs (e.g.
  // a numbered list inside plan prose AND the bypass-permissions confirmation
  // menu); look at every run and pick the one that passes the menu guard,
  // preferring runs closer to the bottom of the screen.
  {
    const runs = collectAllRuns(lines, NUMBERED_LINE_RE);
    for (const run of runs.reverse()) {
      if (run.length < 2) continue;
      const opts = run.matches.map(m => ({ key: m[1], label: m[2].trim() }));
      // Reject the run if any option looks like TUI chrome (tool-call
      // status lines, separators) or is wrapped prose rather than a real
      // menu item.
      if (!opts.every(o => looksLikeMenuOption(o.label))) continue;
      // claude's TUI sometimes glues the FIRST numbered option onto the line
      // above the run — e.g. the theme picker renders as
      //   "To change this later, run /theme  1. Auto (match terminal)"
      //   "2. Dark mode ✔ (current)"
      // Without recovering option 1 the user picks "1" expecting Auto and
      // gets Dark mode (Matrix index 1 → opt[0] which is screen "2.").
      const firstNum = parseInt(run.matches[0][1], 10);
      let questionLines = collectQuestionLinesAbove(lines, run.startIdx);
      let recoveredFirstOption = false;
      if (Number.isFinite(firstNum) && firstNum === 2 && questionLines.length > 0) {
        const lastQ = questionLines[questionLines.length - 1];
        // Greedy `(.*)` so we anchor on the LAST "1." on the line — the
        // heading text itself can legitimately contain "1." earlier.
        const tail = lastQ.match(/(.*)\b1[.)]\s+(.+?)\s*$/);
        if (tail) {
          const headBeforeOption = tail[1].trim();
          const recoveredLabel = tail[2].trim();
          if (recoveredLabel && headBeforeOption) {
            opts.unshift({ key: '1', label: recoveredLabel });
            questionLines[questionLines.length - 1] = headBeforeOption;
            recoveredFirstOption = true;
          }
        }
      }
      const question = questionLines.join(' ').trim();
      // Reject when the question text contains TUI chrome glyphs — this
      // means the "question" is actually garbled status/response output,
      // not a real interactive prompt.
      if (CHROME_RE.test(question)) continue;
      const aboveLooksInterrogative = /[?:]\s*$/.test(question);
      // The `❯` glyph specifically marks claude's TUI selection cursor.
      // It can land on ANY option (the runtime `/theme` picker, for
      // example, opens with the cursor on the current theme — option 2
      // in a fresh install), so checking only the first line of the run
      // misses pickers whose heading isn't interrogative.
      const anyItemMarked = runHasSelectionMarker(lines, run);
      if (aboveLooksInterrogative || anyItemMarked || recoveredFirstOption) {
        return { kind: 'numbered', question, options: opts, freeTextIdx: detectFreeTextIdx(opts) };
      }
    }
    // Fallback: sparse numbered runs (AskUserQuestion-style menus where
    // each numbered option header is followed by 1+ indented description
    // lines). Iterate bottom-first so a menu near the bottom of the screen
    // wins over an unrelated numbered list higher up.
    const sparseRuns = collectSparseNumberedRuns(lines);
    for (const run of sparseRuns.reverse()) {
      const opts = run.matches.map((m, j) => {
        const opt = { key: m[1], label: m[2].trim() };
        // Capture the indented description line(s) between this option header
        // and the next — AskUserQuestion renders a per-option explanation the
        // user needs before choosing. Stop at a separator, the next option, or
        // a chrome line.
        const from = run.indices[j] + 1;
        const to = j + 1 < run.indices.length ? run.indices[j + 1] : from + 4;
        const desc = [];
        for (let k = from; k < to && k < lines.length; k++) {
          const t = (lines[k] || '').trim();
          if (!t) continue;
          if (SEPARATOR_RE.test(t) || NUMBERED_LINE_RE.test(lines[k])) break;
          if (!looksLikeRealMenuItem(t)) continue;
          desc.push(t);
        }
        if (desc.length) opt.description = desc.join(' ');
        return opt;
      });
      if (!opts.every(o => looksLikeMenuOption(o.label))) continue;
      const question = collectQuestionLinesAbove(lines, run.startIdx).join(' ').trim();
      if (CHROME_RE.test(question)) continue;
      const aboveLooksInterrogative = /[?:]\s*$/.test(question);
      const anyItemMarked = run.indices.some(idx => /^[\s]*[❯>▶►]/.test(lines[idx] || ''));
      if (aboveLooksInterrogative || anyItemMarked) {
        return { kind: 'numbered', question, options: opts, freeTextIdx: detectFreeTextIdx(opts) };
      }
    }
  }

  // Lettered selection — same guard, same all-runs handling.
  {
    const runs = collectAllRuns(lines, LETTERED_LINE_RE);
    for (const run of runs.reverse()) {
      if (run.length < 2) continue;
      const opts = run.matches.map(m => ({ key: m[1].toLowerCase(), label: m[2].trim() }));
      if (!opts.every(o => looksLikeMenuOption(o.label))) continue;
      const above = collectQuestionLinesAbove(lines, run.startIdx);
      const question = above.join(' ').trim();
      if (CHROME_RE.test(question)) continue;
      const aboveLooksInterrogative = /[?:]\s*$/.test(question);
      const anyItemMarked = runHasSelectionMarker(lines, run);
      if (aboveLooksInterrogative || anyItemMarked) {
        return { kind: 'lettered', question, options: opts, freeTextIdx: detectFreeTextIdx(opts) };
      }
    }
  }

  // Arrow menu — a line whose first non-blank is a marker (❯/>/▶), followed
  // by sibling lines at the same indent that look like real menu items.
  // Sibling lines that look like keyboard-shortcut hints (e.g. "shift+tab
  // to approve with this feedback", "ctrl-g to edit in VS Code") get
  // filtered so they don't pollute the menu.
  {
    // Find the first arrow marker that isn't a folded-paste widget. Skipping
    // (rather than rejecting outright at the first marker) means a real menu
    // appearing alongside a folded paste in the same buffer is still detected,
    // regardless of which renders first.
    const markerIdx = lines.findIndex(l => {
      const mm = l.match(ARROW_MENU_MARKER_RE);
      return mm && !isPasteFoldLine(mm[3].trim());
    });
    if (markerIdx >= 0) {
      const m = lines[markerIdx].match(ARROW_MENU_MARKER_RE);
      const indent = m[1].length;
      const firstLabel = m[3].trim();
      // Reject when the marker line itself doesn't look like a menu item —
      // catches the false positive where claude's TUI uses ❯ as the input-
      // box prompt indicator surrounded by separators and status chrome.
      // The length bound additionally rejects the input field's wrapped
      // first line (~110+ chars), which stripInputBox normally removes but
      // we guard here too in case colour stripping ever misses it.
      if (looksLikeMenuOption(firstLabel) && !isPasteFoldLine(firstLabel)) {
        const items = [{ label: firstLabel, selected: true }];
        for (let i = markerIdx + 1; i < lines.length; i++) {
          const line = lines[i];
          const sm = line.match(/^(\s*)(.*)$/);
          if (!sm) break;
          if (sm[1].length < indent) break;
          const rest = sm[2].replace(/^[❯>▶►]\s*/, '').trim();
          if (!rest) break;
          if (!looksLikeMenuOption(rest)) break;
          if (isKeyboardHintLine(rest)) break;
          if (isPasteFoldLine(rest)) break;
          items.push({ label: rest, selected: false });
          if (items.length >= 20) break; // sanity
        }
        if (items.length >= 2) {
          // Require a non-empty plausible question line above the marker.
          // Real menus have a question; the TUI welcome screen doesn't. Strip
          // any arrow marker before testing, and drop folded-paste widget lines
          // so a paste sitting above a real menu doesn't leak "[Pasted text …]
          // paste again to expand" into the surfaced question.
          const aboveLines = lines.slice(0, markerIdx)
            .map(l => { const mm = l.match(ARROW_MARKER_RE); return (mm ? mm[3] : l).trim(); })
            .filter(l => l && !isPasteFoldLine(l));
          const question = aboveLines.slice(-2).join(' ').trim();
          if (question && looksLikeRealMenuItem(question)) {
            return { kind: 'arrow-menu', question, options: items, freeTextIdx: detectFreeTextIdx(items) };
          }
        }
      }
    }
  }

  return null;
}

// True if any of the lines covered by `run` starts with a TUI selection
// marker (❯, >, ▶, ►). Used by the numbered/lettered detectors to accept
// a run on the strength of the cursor glyph alone — without this, pickers
// whose heading isn't interrogative (e.g. `/theme`, `/model`) are missed
// whenever the cursor isn't sitting on option 1.
function runHasSelectionMarker(lines, run) {
  for (let i = 0; i < run.length; i++) {
    const line = lines[run.startIdx + i] || '';
    if (/^[\s]*[❯>▶►]/.test(line)) return true;
  }
  return false;
}

// Reconstruct numbered menus whose options are split by description lines.
// Claude's AskUserQuestion-style prompts often render each option on its
// own line followed by 1+ indented description lines (and sometimes blank
// lines between options) — every numbered line ends up in its own length-1
// run, so `collectAllRuns` followed by `run.length < 2` skips them all,
// and the arrow-menu fallback slurps the descriptions as siblings.
//
// Reconstruct by walking every line and collecting NUMBERED_LINE_RE hits
// whose keys form a strict 1..N sequence (1, then 2, then 3, …) with no
// separator line in between. Each maximal in-sequence stretch becomes a
// sparse "run" with `length >= 2` so the consumer can apply the usual
// menu-context guards.
function collectSparseNumberedRuns(lines) {
  const runs = [];
  let cur = []; // { idx, m, key }
  function flush() {
    if (cur.length >= 2) {
      runs.push({
        length: cur.length,
        matches: cur.map(h => h.m),
        indices: cur.map(h => h.idx),
        startIdx: cur[0].idx,
      });
    }
    cur = [];
  }
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i].trim())) { flush(); continue; }
    const m = lines[i].match(NUMBERED_LINE_RE);
    if (!m) continue;
    const key = parseInt(m[1], 10);
    if (!Number.isFinite(key)) continue;
    if (cur.length === 0) {
      if (key === 1) cur.push({ idx: i, m, key });
    } else if (key === cur.length + 1) {
      cur.push({ idx: i, m, key });
    } else {
      flush();
      if (key === 1) cur.push({ idx: i, m, key });
    }
  }
  flush();
  return runs;
}

// Find every maximal run of consecutive lines matching `re`. Returns an
// array of { length, matches, startIdx } in document order. Used by the
// numbered and lettered detectors so we can pick the run that actually has
// menu context (question/marker) rather than always taking the longest.
function collectAllRuns(lines, re) {
  const runs = [];
  let cur = [];
  let curStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      if (cur.length === 0) curStart = i;
      cur.push(m);
    } else if (cur.length > 0) {
      runs.push({ length: cur.length, matches: cur, startIdx: curStart });
      cur = [];
      curStart = -1;
    }
  }
  if (cur.length > 0) runs.push({ length: cur.length, matches: cur, startIdx: curStart });
  return runs;
}

// Detect URLs the user might need to act on (OAuth, "open in browser", etc).
// `[\s,)]|$` end-anchor stops the match at trailing punctuation/whitespace
// without requiring a word boundary, since URLs end in characters that don't
// always satisfy \b cleanly.
const URL_RE = /https?:\/\/[^\s<>"')\]}]+/g;

// How much of each URL participates in the screen-update dedup signature.
// Long enough to distinguish any two genuinely different destinations
// (origin + path + the head of the query), short enough that a repaint
// truncating the tail of a long OAuth URL still hashes to the same sig.
const URL_SIG_PREFIX_LEN = 80;

// Compact form of screen text: lowercased, all whitespace and apostrophes
// removed. Claude's TUI renders some lines with per-character escape
// sequences (e.g. the shimmer animation on the post-login "Press Enter to
// continue…" line), which the column-aware stripAnsi necessarily turns into
// letter-spaced text ("P r e s s   E n t e r …") — a `\s+`-between-WORDS
// regex never matches those. All cue/readiness matching therefore runs on
// this compact form (the same trick isIdleReadyScreen has always used for
// "esctointerrupt").
export function compactScreenText(s) {
  return String(s || '').toLowerCase().replace(/[\s']+/g, '');
}

// Phrases claude prints when it wants the user to type/paste something
// outside of a structured menu. Used to distinguish a screen the user must
// act on (e.g. paste an OAuth code) from idle status chrome. Compact-form
// tokens (see compactScreenText), grouped under a canonical name that feeds
// the screen-update dedup signature. Grouping matters: the /login wizard's
// screen carries several of these phrases at once and repaints as the user
// acts (pasting the code can scroll "Paste code here" away while "use the
// URL below" stays) — with per-phrase tokens the signature flapped between
// them and the SAME sign-in screen was re-sent as a duplicate card. The
// 'oauth' group is one screen in every state; 'pressenter' is a genuinely
// different screen (post-login acknowledgment) and must stay distinct.
// 'pressenter' is checked first: the post-login acknowledgment screen can
// still carry OAuth phrases in scrollback, and classifying it as 'oauth'
// would suppress the press-enter transition the auto-Enter path needs.
const INPUT_CUE_GROUPS = [
  ['pressenter', ['pressenter', 'entertocontinue']],
  ['oauth', ['pastecode', 'copytheurl', 'usetheurl', 'browserdidntopen']],
];

// Returns the canonical cue group present on the screen, or '' when none is.
export function findInputCue(screen) {
  const compact = compactScreenText(screen);
  const hit = INPUT_CUE_GROUPS.find(([, tokens]) => tokens.some(t => compact.includes(t)));
  return hit ? hit[0] : '';
}

// Cues for which the bridge auto-sends Enter on the user's behalf. Kept
// narrow on purpose — only matches phrasing where claude is explicitly
// waiting for an acknowledgment keystroke ("press enter to continue" /
// "press enter to dismiss"), NOT "paste code here" or other prompts that
// need real input. Compact-form (see compactScreenText): the post-login
// line is shimmer-animated and arrives letter-spaced after ANSI strip, so
// a word-spaced regex never fires on exactly the screen this exists for.
export const AUTO_ENTER_COMPACT_RE = /pressenterto(continue|dismiss|acknowledge|proceed)/;

// Compact-form signals that a press-Enter acknowledgment is a LOGIN SUCCESS
// screen — used to finish the /login-from-print flow (auto-return to
// non-interactive mode, see _accountFlowReturnToPrint in index.js).
export const LOGIN_SUCCESS_COMPACT_RE = /loginsuccessful|loggedinas/;

// True only when a login-success token sits within the few lines just above
// (or on) the press-Enter cue line. A whole-screen match is not enough
// (Bugbot, PR #162): a resumed session repaints its old transcript into the
// tail, and stale "Login successful" text in that scrollback would let a
// LATER unrelated acknowledgment cue trigger a spurious switch back to
// print mode. Same cue-window rule the ✅ result-line formatter uses.
const LOGIN_SUCCESS_CUE_WINDOW = 4;
export function loginSuccessNearAutoEnterCue(screen) {
  const lines = String(screen || '').split('\n').map(l => l.trim()).filter(Boolean);
  let cueIdx = lines.findIndex(l => AUTO_ENTER_COMPACT_RE.test(compactScreenText(l)));
  if (cueIdx < 0) {
    // The auto-Enter decision matches the WHOLE compacted screen, so a cue
    // wrapped across two lines (narrow terminal, shimmer letter-spacing)
    // still auto-Enters — this locator must find it too, or the flow would
    // acknowledge the success screen and then never return to print mode
    // (Bugbot, PR #162). One join of adjacent lines covers a single wrap;
    // the phrase is too short to span three.
    cueIdx = lines.findIndex((l, i) =>
      i + 1 < lines.length && AUTO_ENTER_COMPACT_RE.test(compactScreenText(l + lines[i + 1])));
  }
  if (cueIdx < 0) return false;
  const nearby = lines.slice(Math.max(0, cueIdx - LOGIN_SUCCESS_CUE_WINDOW), cueIdx + 1).join('\n');
  return LOGIN_SUCCESS_COMPACT_RE.test(compactScreenText(nearby));
}

export function extractUrls(text) {
  return [...new Set(text.match(URL_RE) || [])];
}

// "Idle and ready for input" detection for a freshly-resumed iv session.
//
// After `claude --resume` (and any auto-compaction) finishes, the TUI sits
// at an empty input box with an idle status line — and crucially, NO "esc to
// interrupt" hint (that hint is only shown while a turn or a compaction is
// actively running). The bridge gates the first post-resume message on this
// state so the message isn't typed into a still-loading TUI and dropped.
//
// We match against a whitespace-stripped, lowercased copy of the screen tail.
// claude's TUI renders inter-word gaps with cursor-forward escapes that
// stripAnsi turns into a variable number of spaces (and sometimes none), so
// "esc to interrupt" can arrive as "esctointerrupt"; collapsing whitespace
// makes the match robust to that.
const READY_WORKING_TOKEN = 'esctointerrupt';
const READY_IDLE_TOKENS = [
  'shift+tabtocycle',
  'shifttabtocycle',
  'forshortcuts',
  'bypasspermissionson',
];

// Logged-out TUI status footer ("Not logged in · Please run /login" /
// "Not logged in · Run /login"): idle in every way that matters — it accepts
// typed slash commands. A resumed-while-logged-out session never shows the
// normal idle footer, so without this a parked /login only ran at the 120s
// hardcap while the user's retries all bounced off "the session is still
// resuming". Matched deliberately tightly (Bugbot, PR #162): the exact
// status-line form including the `·` separator and the /login command — NOT
// a bare "not logged in", which appears in ordinary conversation text (a
// resumed session repaints its old transcript into the tail, and transcripts
// legitimately discuss login states) — and only within the bottom few
// non-blank lines, where a status footer can actually live.
const READY_LOGGED_OUT_RE = /notloggedin·(?:pleaserun|run)\/login/;
const LOGGED_OUT_FOOTER_LINES = 5;

export function isIdleReadyScreen(rawBuffer) {
  if (!rawBuffer) return false;
  const screen = stripAnsi(stripInputBox(rawBuffer));
  const tail = screen.split('\n').slice(-SCREEN_TAIL_LINES).join('\n');
  const compact = compactScreenText(tail);
  // A turn or compaction is in progress — not ready, regardless of any idle
  // status text that may still be on screen (the working state shows both).
  if (compact.includes(READY_WORKING_TOKEN)) return false;
  // Require a positive idle-status signal so the blank pre-render screen right
  // after spawn (no status line yet) doesn't read as "ready".
  if (READY_IDLE_TOKENS.some(t => compact.includes(t))) return true;
  const bottom = compactScreenText(
    tail.split('\n').filter(l => l.trim()).slice(-LOGGED_OUT_FOOTER_LINES).join('\n')
  );
  return READY_LOGGED_OUT_RE.test(bottom);
}

// Watches a stream of PTY bytes, accumulates the screen, and emits `prompt`
// events when classifyScreen detects one after a brief idle period. The idle
// gate prevents the detector from firing mid-render (when the screen is
// transiently in an ambiguous state). Also emits `screen-update` events for
// free-text TUI screens that don't classify as a structured menu but contain
// URLs or input cues the user needs to see (e.g. /login OAuth URL screen).
export class PromptDetector extends EventEmitter {
  constructor({ idleMs = 300, bufferLimit = 16384 } = {}) {
    super();
    this.idleMs = idleMs;
    this.bufferLimit = bufferLimit;
    this.buf = '';
    this.timer = null;
    this.lastEmitted = null;
    this.lastScreenUpdateSig = null;
    this.lastUnclassifiedSig = null;
  }

  feed(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.bufferLimit) {
      this.buf = this.buf.slice(-this.bufferLimit);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._check(), this.idleMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _check() {
    // Remove claude's input field (background-filled `❯ <user text>` lines)
    // BEFORE stripping ANSI, so the user's own wrapped/multi-line message
    // can't be misread as a `❯`-cursor menu. Then drop the queued-message
    // widget (type-ahead the user sent while claude was busy) so its
    // `❯ <text>` lines don't read as a menu in any classification path.
    const screen = stripQueuedWidget(stripAnsi(stripInputBox(this.buf)));
    const r = classifyScreen(screen);
    if (r) {
      const sig = `${r.kind}::${r.question}::${r.options.map(o => o.label).join('|')}`;
      if (sig === this.lastEmitted) return;
      this.lastEmitted = sig;
      // Clear the accumulated buffer so a subsequent identical re-render of
      // the same prompt classifies to the same signature (and is suppressed).
      // If we kept appending, the question/options text would shift inside a
      // growing screen and the sig would diverge.
      this.buf = '';
      this.emit('prompt', r);
      return;
    }
    // No structured prompt — check for free-text TUI states the user
    // must see. We ONLY emit when claude is showing an input cue
    // ("paste code here", "press enter to continue", "browser didn't
    // open", etc) — i.e. claude is stuck waiting for a specific user
    // action outside the normal conversation. URLs alone are not enough
    // because regular assistant turns often contain URLs (and those
    // come through the transcript JSONL, so surfacing the raw PTY
    // screen on top duplicates and adds noisy status chrome).
    const cueText = findInputCue(screen);
    if (!cueText) {
      // No structured prompt and no known input cue. Last resort: if the
      // settled screen still looks like a selection menu the classifier
      // couldn't parse (e.g. option labels too long), surface it so the Matrix
      // user isn't left blind while the TUI waits for an answer.
      if (looksLikeUnclassifiedMenu(screen)) {
        const sig = screen.trim().slice(0, 300);
        if (sig !== this.lastUnclassifiedSig) {
          this.lastUnclassifiedSig = sig;
          this.buf = '';
          this.emit('unclassified-prompt', { screen });
        }
      }
      return;
    }
    const urls = extractUrls(screen);
    // Dedupe on the sorted URL set + the cue token. The token identity
    // (not just cue presence) is critical because "Paste code here" and
    // "Press Enter to continue" are both input cues — without
    // distinguishing them, claude's post-login "Logged in / Press Enter
    // to continue" screen is silently suppressed while the OAuth URL is
    // still in the scrollback.
    // URLs enter the sig prefix-truncated: a mid-repaint capture can cut a
    // long URL short (the /login OAuth URL lost its query tail after the
    // user pasted their code), and the full-vs-truncated pair would
    // otherwise read as different URLs — re-sending the same sign-in
    // screen as a duplicate card.
    const sig = `${urls.map(u => u.slice(0, URL_SIG_PREFIX_LEN)).sort().join(',')}::cue=${cueText}`;
    if (sig === this.lastScreenUpdateSig) return;
    this.lastScreenUpdateSig = sig;
    // Clear the accumulated buffer for the same reason the structured-prompt
    // path does (line 313 above): the buffer grows monotonically and
    // findInputCue returns the first token found anywhere in it. Without
    // this, a "Paste code here" cue persists in the buffer and overshadows
    // the later "Press Enter to continue" cue — the next `_check` recomputes
    // the same sig and silently suppresses the post-login screen.
    this.buf = '';
    this.emit('screen-update', { screen, urls, hasInputCue: true });
  }

  // Call after responding to a prompt so the SAME prompt text can fire again
  // later (otherwise repeated identical prompts would be silently dropped).
  // Also clears the screen-update dedup so the post-response screen (e.g.
  // /login OAuth URL after picking option 1) fires even if the previous
  // session surfaced the same URL.
  reset() {
    this.buf = '';
    this.lastEmitted = null;
    this.lastScreenUpdateSig = null;
    this.lastUnclassifiedSig = null;
  }
}
