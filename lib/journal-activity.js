// Pure helpers for activity-ephemeral wiring (index.js -> journalPublisher.
// publishActivity). No session, no I/O — kept here, in the style of
// lib/session-mode.js and lib/model-aliases.js, so the state-change dedup
// and the detail truncation are unit-testable without a live session or a
// journal connection. index.js owns the per-session last-sent-state field
// (session._journalActivityState) and calls these two functions around it,
// exactly the way journalSessionState owns session._journalState.

// Send only on an actual change from the last state recorded for this
// session — the same decision journalSessionState makes for session_status,
// applied to activity instead. `lastState` is `undefined`/`null` on a
// session's first-ever activity send, which always counts as a change.
export function activityStateChanged(lastState, nextState) {
  return lastState !== nextState;
}

// Display-oriented trim for the 'tool' activity detail (a command string).
// The journal server itself hard-truncates at 200 chars (matron-journal
// src/ws.js ACTIVITY_DETAIL_MAX_CHARS) — this is a tighter, client-side trim
// so a typing indicator never carries a near-200-char command; it also
// keeps the command text short enough to read on a phone.
const ACTIVITY_DETAIL_MAX_CHARS = 100;

export function truncateActivityDetail(command) {
  if (typeof command !== 'string') return undefined;
  return command.length > ACTIVITY_DETAIL_MAX_CHARS
    ? command.slice(0, ACTIVITY_DETAIL_MAX_CHARS) + '…'
    : command;
}

// Decide whether a finished tracked-tool's tool_result should resurrect
// 'thinking' (Bugbot finding #2). Previously gated on session.busy — but iv
// mode's prompt-answer dispatch (iv.respondToPrompt, raw PTY keystrokes)
// never sets busy=true the way sendToSession does, so a turn that resumed by
// answering a prompt kept `busy` false throughout; a tracked Bash tool
// finishing mid-turn then failed the `if (session.busy)` gate and the
// activity indicator stuck on 'tool' (command already done) until the whole
// turn ended.
//
// The real invariant (from the brief): a finished command must never keep
// showing while Claude continues working, and 'thinking' must never fire
// for a session that is idle/waiting. Both are testable from activity state
// alone, without busy:
//   - `lastActivityState === 'tool'` — only resurrect 'thinking' if 'tool'
//     is still the most recently sent activity; if something newer already
//     superseded it (e.g. 'idle' from a turn-end or an awaiting-prompt
//     transition), there's nothing to resurrect FROM.
//   - `!waitingOnPrompt` — belt-and-suspenders against 'thinking' firing for
//     a session currently surfacing a prompt to the user (pendingInteractivePrompt
//     in iv mode, waitingForAnswer in print mode), even if some interleaving
//     left activity state still reading 'tool'.
export function shouldResumeThinkingAfterTool(lastActivityState, waitingOnPrompt) {
  return lastActivityState === 'tool' && !waitingOnPrompt;
}
