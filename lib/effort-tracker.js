// Optimistic tracking of a Claude session's effort level, for the status
// frame's `effort` field (lib/session-status.js).
//
// CONTRACT — the bridge cannot READ the effort level back. No stream-json or
// transcript event carries it, no config file holds it, no spawn flag sets
// it. What is published here is a record of what the bridge itself
// successfully WROTE, never an observation, and it is UNKNOWN until a write
// settles. Unknown publishes as an ABSENT field — never a guess.
//
// The rules, one per test in test/effort-tracker.test.js:
//   - writing `/effort <level>` into the PTY only makes the level PENDING;
//   - a CONFIRMED change commits it. Mid-conversation the TUI raises a
//     "Change effort level?" menu (the prompt detector classifies it; see the
//     fixture in test/prompt-detector.test.js), and the user's accept answer
//     is the commit signal;
//   - when NO confirmation appears before the session goes idle again, the
//     write stands — a fresh/uncached session applies `/effort` silently;
//   - a DECLINED confirmation discards the pending write, leaving the
//     previous value (including unknown) standing;
//   - once a confirmation is armed, ONLY its answer settles the write: the
//     idle path stops applying, so an unanswered menu never commits;
//   - session start, restart, and resume reset to unknown. The replacement
//     session's effort comes from Claude Code's own default, so carrying a
//     value across would publish something false.
//
// ACCEPTED GAP: `/effort` typed straight into the host terminal — not through
// the bridge — is invisible here. Its confirmation has no pending write to
// settle, so the tracked value keeps whatever the bridge last wrote until the
// next restart clears it.
//
// State lives on the session object (`session._effort`), so a fresh session
// object IS the reset; recreateSession's carry-forward whitelist deliberately
// omits it and calls resetEffortTracking on the replacement.

import { isValidEffortArg, normalizeEffortArg } from './effort-command.js';

// The TUI's mid-conversation confirmation. Matched on the question rather
// than the option labels: the labels name the level ("Yes, switch to xhigh"),
// the question is the stable part.
const EFFORT_CONFIRM_RE = /change\s+effort\s+level/i;

// An accepted confirmation. The menu is "Yes, switch to <level>" /
// "No, go back" — anything that is not an affirmative reads as a decline,
// which is the conservative direction (a decline only discards).
const CONFIRM_ACCEPTED_RE = /^\s*yes\b/i;

export function isEffortConfirmationPrompt(prompt) {
  return EFFORT_CONFIRM_RE.test(String(prompt?.question ?? ''));
}

function stateOf(session) {
  if (!session._effort) session._effort = { level: null, pending: null, awaitingConfirm: false };
  return session._effort;
}

// Record that `/effort <level>` reached the PTY. Callers pass the raw arg;
// a level outside EFFORT_LEVELS is refused outright so the frame can never
// publish a value the client's effort_levels list doesn't contain.
export function noteEffortWrite(session, level) {
  if (!session) return;
  if (!isValidEffortArg(level)) return;
  const state = stateOf(session);
  state.pending = normalizeEffortArg(level);
  state.awaitingConfirm = false;
}

// The TUI asked the user to confirm the pending change. Arms the pending
// write so only the answer can settle it — see noteEffortIdle.
export function noteEffortConfirmationPrompt(session, prompt) {
  if (!session) return;
  const state = stateOf(session);
  if (!state.pending) return;
  if (!isEffortConfirmationPrompt(prompt)) return;
  state.awaitingConfirm = true;
}

// The user answered the confirmation. Accept commits the pending write;
// anything else discards it and leaves the previous value standing.
export function noteEffortConfirmationAnswer(session, prompt, optionLabel) {
  if (!session) return;
  const state = stateOf(session);
  if (!state.awaitingConfirm) return;
  if (!isEffortConfirmationPrompt(prompt)) return;
  if (CONFIRM_ACCEPTED_RE.test(String(optionLabel ?? ''))) state.level = state.pending;
  state.pending = null;
  state.awaitingConfirm = false;
}

// The session went idle again with no confirmation in sight: the write stands.
export function noteEffortIdle(session) {
  if (!session) return;
  const state = stateOf(session);
  if (!state.pending || state.awaitingConfirm) return;
  state.level = state.pending;
  state.pending = null;
}

// Session start / restart / resume: back to unknown, dropping any write still
// in flight.
export function resetEffortTracking(session) {
  if (!session) return;
  session._effort = { level: null, pending: null, awaitingConfirm: false };
}

// The current level, or null while it is unknown (the frame then omits the
// field entirely).
export function trackedEffort(session) {
  return session?._effort?.level ?? null;
}
