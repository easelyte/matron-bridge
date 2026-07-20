// Shared command-classification for the bridge's !/ command surface. Both
// the Matrix room.message handler (index.js) and the journal session-text
// route (journalRouteTextToSession, also index.js — wired as
// lib/journal-input-router.js's routeTextToSession) run every inbound text
// through these SAME pure classifiers before deciding whether to intercept
// it as a bridge command, an iv-mode PTY rescue keystroke, or let it flow
// through as an ordinary message / TUI-native slash passthrough.
//
// Keeping this decision logic in one shared, dependency-free module is what
// makes it impossible for the two transports to silently fork: change a
// command's name or a passthrough rule here and BOTH transports pick it up
// identically. The actual command IMPLEMENTATIONS (handleCommand's switch,
// in index.js) and PTY calls (session.iv.sendKeystroke) stay put — they're
// deeply coupled to index.js's session/room state and reused AS-IS by both
// transports, not duplicated here. This module only ever answers "what IS
// this text?", never "what should happen because of it".

// The full set of !/ command names the bridge intercepts before they ever
// reach a Claude session. Mirrors handleCommand's switch cases exactly
// (index.js ~3466) MINUS the show_bash family ('!show_bash',
// '!show_bash_output', '!bash_output'): those cases exist in the switch but
// were never added to this gate, so they've never actually been reachable
// from typed chat text in Matrix either. Preserved exactly as-is — closing
// that gap would be a Matrix-visible behavior change, out of scope here.
export const BRIDGE_COMMAND_NAMES = new Set([
  'start', 'stop', 'restart', 'resume', 'workdir', 'status',
  'show', 'show_working', 'working', 'sessions', 'help',
  'agent', 'switch', 'mcp', 'model', 'mode', 'effort', 'cost', 'usage', 'limits', 'tools',
  'login', 'logout',
]);

// text -> the bang-normalized command string handleCommand expects (e.g.
// '!stop'), or null if `text` isn't one of the bridge's intercepted
// commands. Accepts either `!` or `/` prefix, case-insensitive on the
// command word — exactly what the Matrix room.message handler does.
export function classifyBridgeCommand(text) {
  if (typeof text !== 'string') return null;
  if (!(text.startsWith('!') || text.startsWith('/'))) return null;
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  const cmdName = firstWord.slice(1);
  if (!BRIDGE_COMMAND_NAMES.has(cmdName)) return null;
  return '!' + text.slice(1);
}

// iv-mode PTY rescue keystrokes (index.js, the block right after the
// isClaudeSlashCommand check). Recognized regardless of busy state and
// independent of BRIDGE_COMMAND_NAMES — these bypass everything because
// they're pure recovery actions the user can always need. Returns
// 'enter' | 'esc' | null. Case/whitespace-insensitive, like the Matrix
// handler. Callers must additionally gate on session.iv && session.iv.alive
// (kept out of here so this stays a pure string predicate).
export function classifyRescueKeystroke(text) {
  if (typeof text !== 'string') return null;
  const lower = text.trim().toLowerCase();
  if (lower === '!enter') return 'enter';
  if (lower === '!esc' || lower === '!escape' || lower === '!stop') return 'esc';
  return null;
}

// Print-mode rescue: only !esc/!escape map to a turn interrupt. Deliberately
// narrower than classifyRescueKeystroke — in print mode `!stop` must keep
// its documented meaning (stop the session; the command dispatcher handles
// it before this runs on the Matrix path) and `!enter` has no input box to
// nudge, so both fall through as ordinary input.
export function classifyPrintRescue(text) {
  if (typeof text !== 'string') return null;
  const lower = text.trim().toLowerCase();
  if (lower === '!esc' || lower === '!escape') return 'interrupt';
  return null;
}

// Busy-queue "magic words" (PR #101 follow-up). While a session is busy and
// the text is not a TUI slash passthrough, bare `send`/`interrupt`/
// `!interrupt` flush the queued messages immediately and bare `cancel` pops
// the last queued one — exactly the literal comparisons the Matrix busy
// branch made on text.toLowerCase().trim(). Returns 'send' | 'cancel' |
// null. Pure classification only: the busy gating (and everything that
// HAPPENS for a classified word) lives with the shared implementation in
// lib/busy-queue.js, reused verbatim by both transports.
export function classifyBusyMagicWord(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();
  if (lower === 'send' || lower === 'interrupt' || lower === '!interrupt') return 'send';
  if (lower === 'cancel') return 'cancel';
  return null;
}

// Plan-mode `build` approval keyword (PR #101 follow-up) — exactly the
// Matrix comparison: text.toLowerCase().trim() === 'build'. Pure predicate;
// callers additionally gate on the session's pending-plan state
// (pendingPlan || pendingPlanDenialId || ivPendingPlanToolUseId), same
// caller-gates-state convention as classifyRescueKeystroke above.
export function isPlanBuildText(text) {
  return typeof text === 'string' && text.toLowerCase().trim() === 'build';
}

// Classify-and-delegate gate for the `build` keyword, shared by BOTH
// transports (the Matrix room.message handler and journalRouteTextToSession
// call this at the same position in their ordering: after prompt/question
// resolution, before rescue keystrokes and busy-queueing). `approvePlan` is
// the injected implementation (index.js's approvePlanBuild — the iv-mode
// /plan-decision hook resolution or the print-mode tool_result/denial
// dance, reused AS-IS). Returns true when the text was the build keyword
// for a genuinely pending plan and the approval ran; false otherwise, in
// which case NOTHING happened and the caller routes the text as it always
// did (with no pending plan, `build` is just an ordinary message).
export async function dispatchPlanBuild(text, hasPendingPlan, { approvePlan }) {
  if (!hasPendingPlan) return false;
  if (!isPlanBuildText(text)) return false;
  await approvePlan();
  return true;
}

// Whether `text` should bypass busy-queueing and go straight into the PTY
// as a claude-native slash command (index.js's isClaudeSlashCommand). `//`
// escapes this — a message starting with a literal double slash is queued
// like ordinary text instead of typed straight into the TUI. Only
// meaningful for interactive (iv-mode) sessions; callers must AND this with
// their own session.iv check (kept out of here so this stays a pure string
// predicate, easy to unit test without a session fixture).
export function isIvSlashPassthrough(text) {
  return typeof text === 'string' && text.startsWith('/') && !text.startsWith('//');
}

// Bridge commands whose Matrix implementation depends on context the
// journal transport has no equivalent for (a live Matrix event to react to
// or redact, an attachment already uploaded to Matrix, etc). Mapping
// handleCommand's actual switch (index.js, every BRIDGE_COMMAND_NAMES-gated
// case) turned up NONE today: handleCommand's own signature — (roomId,
// text, sendReply, sendHtml, sender) — never receives a Matrix event or
// attachment at all, so nothing in its switch CAN depend on one; every case
// reads/mutates session or bridge-global state and replies through the
// injected sendReply/sendHtml sink, which is exactly as meaningful over the
// journal as over Matrix. (The genuinely Matrix-only surfaces — media
// messages, button-tap responses, the ask-user MCP server's /secret,
// /share-sensitive, /redact-message HTTP endpoints — are none of them !/
// bridge commands; they're separate message types/routes entirely, outside
// classifyBridgeCommand's domain.) Kept as an explicit, tested denylist
// rather than an implicit "we checked once" comment, so a FUTURE command
// that genuinely needs Matrix event/attachment context fails safely (a
// one-line reply, see dispatchJournalBridgeCommand's `notAvailable`) the
// moment it's added to BRIDGE_COMMAND_NAMES, rather than silently
// misbehaving or crashing.
export const JOURNAL_UNAVAILABLE_COMMANDS = new Set([]);

// Journal-side command-dispatch decision + delegation (Deliverable 1/2).
// Mirrors where the Matrix room.message handler checks bridge commands —
// FIRST, before any prompt/menu/AskUserQuestion resolution (see
// journalRouteTextToSession in index.js) — so e.g. /stop always stops the
// session even while a TUI menu is open. Returns true if `text` was a
// bridge command and has been fully handled — either dispatched or answered
// with a "not available" reply (caller must not do anything else with it);
// false otherwise, in which case NONE of `flushCursor`/`runBridgeCommand`/
// `notAvailable` were called.
//
// `flushCursor`, `runBridgeCommand`, and `notAvailable` are injected so this
// stays testable with fakes, without a real journal publisher or a real
// handleCommand/session — same injection style lib/journal-input-router.js
// already uses. `unavailableCommands` defaults to the real
// JOURNAL_UNAVAILABLE_COMMANDS set (currently empty) but is overridable so
// the denylist branch itself is exercised in tests without mutating shared
// module state. Order matters: for a dispatched command, flushCursor runs
// synchronously BEFORE runBridgeCommand, exactly like the existing
// control-command and prompt_reply replay guards — a crash inside
// runBridgeCommand must never leave the cursor pointing at an undispatched
// (and therefore replayable) destructive command. A denied command never
// flushes at all: nothing destructive happened, so there's nothing to guard
// against replaying.
export async function dispatchJournalBridgeCommand(text, {
  flushCursor, runBridgeCommand, notAvailable, unavailableCommands = JOURNAL_UNAVAILABLE_COMMANDS,
} = {}) {
  const normalizedCommand = classifyBridgeCommand(text);
  if (!normalizedCommand) return false;
  const cmdName = normalizedCommand.slice(1).split(/\s+/)[0].toLowerCase();
  if (unavailableCommands.has(cmdName)) {
    if (notAvailable) await notAvailable(cmdName);
    return true;
  }
  flushCursor();
  await runBridgeCommand(normalizedCommand);
  return true;
}

// Journal-side iv-mode PTY rescue-keystroke decision + delegation. Checked
// AFTER prompt/menu/AskUserQuestion resolution, matching Matrix's own
// ordering (see journalRouteTextToSession). Returns true if `text` was a
// rescue keystroke and has been handled; false otherwise. Only active when
// `ivActive` (session.iv && session.iv.alive), matching Matrix's guard —
// when `ivActive` is false this returns false without even classifying the
// text, so a print-mode session's chat text can never accidentally trip a
// rescue keystroke it has no PTY to receive. Print-mode sessions route
// !esc/!escape to printModeInterrupt via the printActive branch instead.
export async function dispatchJournalRescueKeystroke(text, ivActive, { flushCursor, sendRescueKeystroke, printActive = false, sendPrintInterrupt = null }) {
  if (ivActive) {
    const rescue = classifyRescueKeystroke(text);
    if (!rescue) return false;
    flushCursor();
    await sendRescueKeystroke(rescue);
    return true;
  }
  // Print-mode counterpart: same position in the routing order, narrower
  // word set (classifyPrintRescue), interrupt via control_request instead
  // of a PTY keystroke. Both callbacks optional so iv-only callers are
  // unaffected.
  if (printActive && sendPrintInterrupt && classifyPrintRescue(text)) {
    flushCursor();
    await sendPrintInterrupt();
    return true;
  }
  return false;
}

// --- Journal control-convo command parsing (Deliverable 3) ---
//
// The journal's single control convo (JOURNAL_CONTROL_CONVO_ID in index.js)
// has no Matrix room of its own — /start, /sessions, /resume etc. are
// dispatched through the SAME handleCommand the Matrix control room uses,
// via a synthetic room ID (see journalHandleControlCommand). This section
// only owns parsing the convo's command word into that dispatcher's
// canonical form; index.js owns everything else (which reply sink to use,
// invoking handleCommand, and BRIDGE_COMMAND_NAMES-membership gating).

// Aliases the journal control convo accepts in addition to each bridge
// command's canonical spelling. Historically this convo only understood
// bare "new"/"list"/"help" — these keep working unchanged now that /start,
// /sessions, and /help are the canonical, Matrix-shared spellings.
export const JOURNAL_CONTROL_ALIASES = { new: 'start', list: 'sessions' };

// body -> { cmd, rest }. `cmd` is the bridge's canonical (unprefixed,
// lowercased) command name, e.g. 'start' for "/start", "!start", "new", or
// bare "start" — Matrix's own bridgeCommandNames gate treats ! and /
// interchangeably too (see classifyBridgeCommand), so this does the same
// plus the two legacy bare-word aliases. `cmd` is '' for empty input; `rest`
// is the remaining whitespace-split tokens (e.g. a /start directory arg).
export function normalizeJournalControlCommand(body) {
  const parts = (body || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const stripped = (first.startsWith('/') || first.startsWith('!')) ? first.slice(1) : first;
  const lower = stripped.toLowerCase();
  return { cmd: JOURNAL_CONTROL_ALIASES[lower] || lower, rest: parts.slice(1) };
}

// Full routing decision for a control-convo body — normalize, gate on
// BRIDGE_COMMAND_NAMES, and apply the SAME JOURNAL_UNAVAILABLE_COMMANDS
// denylist the session-command path enforces (review fast-follow: before
// this, only dispatchJournalBridgeCommand checked it, so a future
// Matrix-only command would have stayed reachable from the control convo).
// Returns one of:
//   { kind: 'help' }                          — empty/unrecognized: show help
//   { kind: 'unavailable', cmd }              — denylisted: one-line refusal
//   { kind: 'dispatch', cmd, normalizedText } — run via handleCommand
// `unavailableCommands` is injectable for tests, same as
// dispatchJournalBridgeCommand's.
export function classifyJournalControlCommand(body, { unavailableCommands = JOURNAL_UNAVAILABLE_COMMANDS } = {}) {
  const { cmd, rest } = normalizeJournalControlCommand(body);
  if (!cmd || !BRIDGE_COMMAND_NAMES.has(cmd)) return { kind: 'help' };
  if (unavailableCommands.has(cmd)) return { kind: 'unavailable', cmd };
  return { kind: 'dispatch', cmd, normalizedText: '!' + [cmd, ...rest].join(' ') };
}

// Short nudge shown for empty/unrecognized control-convo input — kept
// intentionally brief (the full command list is one "/help" away) so a typo
// doesn't dump the whole command reference.
export const JOURNAL_CONTROL_HELP =
  'Commands: "/start [--claude|--codex] [dir]" (alias "new") — start a session; "/sessions [--claude|--codex]" (alias "list") — list sessions; "/help" — full command list.';

// Matron-specific addendum appended to the REAL control-room /help text
// (Deliverable 3) — handleCommand's '!help' case is reused verbatim for the
// command reference itself; this just notes the aliases and which listed
// commands don't apply with no session tied to this convo.
export const JOURNAL_CONTROL_HELP_NOTE =
  '\n\nMatron control convo notes:\n' +
  '- Aliases: "new" = /start, "list" = /sessions.\n' +
  '- /start, /resume, and /workdir create a new session + convo here. Add --codex or --claude to choose the agent.\n' +
  '- Session-scoped commands (/status, /stop, /restart, /show, /working, /agent, /switch, /mcp, /model, /mode, /effort, /cost, /usage, /tools, /login, /logout) ' +
  'have no session in this convo — use them from inside a session\'s own Matron convo instead.\n' +
  '- /limits works here too — it isn\'t session-scoped.';
