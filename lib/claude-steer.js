// Mid-turn steering for print-mode Claude sessions.
//
// A print-mode claude process reads stream-json from a long-lived stdin. A
// user message written while a turn is running is NOT an interrupt: the CLI
// keeps it until the next tool-result boundary and the model sees it in the
// same turn. If the turn ends before another boundary, the CLI emits the
// turn's `result`, then opens a fresh turn (system/init ... result) for the
// steered message on its own.
//
// When the stdin line carries a top-level `uuid`, the CLI reports progress on
// it as `command_lifecycle` events (state queued -> started -> completed).
// That is what lets the bridge tell the two cases apart at `result` time:
//   - entry already `started`: the message was folded into this turn, so the
//     turn really is over;
//   - entry still `written`/`queued`: the CLI is about to run another turn for
//     it, so the bridge must keep the session busy instead of flushing its
//     queue on top of that turn.
//
// This module holds the pure decision and the per-session bookkeeping; the
// index.js glue (the stdin write, the result-handler hold, the turn-end path
// a backstop falls back to) stays thin and injects what it needs.

import { classifyBusyMagicWord } from './command-dispatch.js';

// How long a held session waits after `result` for the CLI to start the
// steered message's own turn. Live probes show `started` within milliseconds
// of the previous result; this only bounds a CLI that never runs it, so a
// session can never stay busy on a message nothing will answer.
export const STEER_HOLD_BACKSTOP_MS = 20_000;

// Posted in place of the "Queued" card when a message went straight into the
// running turn.
export const STEER_NOTICE = '↪ Sent into the running turn (claude sees it once the current step finishes).';

const OFF_VALUES = new Set(['0', 'false', 'off']);

// Default ON. Only an explicit 0/false/off disables it.
export function claudeSteerEnabled(env = {}) {
  const raw = env.MATRON_CLAUDE_STEER;
  if (raw === undefined || raw === null) return true;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

function stdinWritable(proc) {
  const stdin = proc?.stdin;
  if (!stdin || typeof stdin.write !== 'function') return false;
  if (stdin.destroyed || stdin.writableEnded || stdin.writable === false) return false;
  return true;
}

function hasParkedControls(session) {
  const slots = session._deferredControls;
  return !!slots && typeof slots === 'object' && Object.keys(slots).length > 0;
}

// Decide whether a message can be written into the running turn right now.
// Returns { ok: true } or { ok: false, reason }. Every "no" means the caller
// queues the message exactly as it did before steering existed.
//
// ctx:
//   enabled   - the MATRON_CLAUDE_STEER switch (claudeSteerEnabled)
//   origin    - 'user' only for plain text the session's own user typed; any
//               other source (reminder, timer, carry-on, wake, media, room,
//               item reply) is rejected
//   text      - the trimmed message
//   inputHeld - another flow holds input like a running turn (e.g. an
//               /effort switch returning to print mode)
//   isMagicWord - busy-queue magic-word classifier (send/cancel/interrupt);
//               defaults to the shared one in lib/command-dispatch.js
export function canSteerClaude(session, ctx = {}) {
  const { enabled = true, origin = null, text = '', inputHeld = false, isMagicWord = classifyBusyMagicWord } = ctx;
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (!session) return { ok: false, reason: 'no-session' };
  if (origin !== 'user') return { ok: false, reason: 'not-user-text' };
  if (session.agent === 'codex' || session.codex) return { ok: false, reason: 'codex' };
  if (session.iv) return { ok: false, reason: 'interactive' };
  if (!session.busy) return { ok: false, reason: 'idle' };
  if (!session.alive || session._autoStopped || !stdinWritable(session.proc)) {
    return { ok: false, reason: 'no-process' };
  }
  if (inputHeld) return { ok: false, reason: 'input-held' };
  // The CLI has not opened this turn yet (init trails the prompt write). A
  // second line written now would land before the first turn even starts.
  if (session._cliInitGeneration !== session.turnGeneration) return { ok: false, reason: 'pre-init' };
  if (session.pendingInterrupt) return { ok: false, reason: 'interrupt-pending' };
  if (session._operatorCompactPending) return { ok: false, reason: 'compact-running' };
  if (session._deferredCommandText) return { ok: false, reason: 'deferred-command' };
  if (hasParkedControls(session)) return { ok: false, reason: 'deferred-control' };
  if (session._selfRestartPending) return { ok: false, reason: 'restart-pending' };
  // A turn another person started: the owner's words must not be mixed into it.
  if (session.foreignTurn) return { ok: false, reason: 'foreign-turn' };
  if (session.waitingForAnswer || session.pendingQuestions?.length
    || session.pendingPlan || session.pendingPlanDenialId) {
    return { ok: false, reason: 'awaiting-answer' };
  }
  // Anything already waiting goes first: steering past it would reorder.
  if (session.queuedMessages?.length) return { ok: false, reason: 'queue-not-empty' };
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return { ok: false, reason: 'command' };
  if (typeof isMagicWord === 'function' && isMagicWord(trimmed)) return { ok: false, reason: 'magic-word' };
  return { ok: true };
}

// The stdin line for a steered message: the same user message a normal turn
// writes, plus the fields that make the CLI report command_lifecycle for it.
export function buildSteerLine(contentBlocks, uuid) {
  return JSON.stringify({
    type: 'user',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: contentBlocks },
  }) + '\n';
}

export function noteSteerWritten(session, uuid, now = Date.now()) {
  if (!(session._steered instanceof Map)) session._steered = new Map();
  session._steered.set(uuid, { state: 'written', at: now });
}

// Ends a hold: the CLI has opened the steered message's turn.
export function endSteerHold(session, { clearTimer = clearTimeout } = {}) {
  const hold = session?._steerHold;
  if (!hold) return;
  if (hold.timer) clearTimer(hold.timer);
  session._steerHold = null;
}

// handleClaudeEvent's command_lifecycle case. Returns true when the event was
// a lifecycle event (handled or deliberately ignored); it is never output.
export function applySteerLifecycle(session, event, { clearTimer = clearTimeout } = {}) {
  if (!event || event.type !== 'command_lifecycle') return false;
  const steered = session?._steered;
  const uuid = event.command_uuid;
  if (!(steered instanceof Map) || !steered.has(uuid)) return true;
  const state = event.state;
  if (state === 'completed') {
    steered.delete(uuid);
  } else if (state === 'queued' || state === 'started') {
    const entry = steered.get(uuid);
    // Never move backwards (a late `queued` after `started`).
    if (!(entry.state === 'started' && state === 'queued')) entry.state = state;
  }
  if (state === 'started' || state === 'completed') endSteerHold(session, { clearTimer });
  return true;
}

// True when a steered message has not started yet, so the CLI will run
// another turn for it after this `result`.
export function steerPendingTurn(session) {
  const steered = session?._steered;
  if (!(steered instanceof Map)) return false;
  for (const entry of steered.values()) {
    if (entry.state === 'written' || entry.state === 'queued') return true;
  }
  return false;
}

export function dropUnstartedSteers(session) {
  const steered = session?._steered;
  if (!(steered instanceof Map)) return;
  for (const [uuid, entry] of steered) {
    if (entry.state === 'written' || entry.state === 'queued') steered.delete(uuid);
  }
}

// Arms the hold. onBackstop runs only if nothing started within backstopMs;
// the stale entries are dropped first so the caller's normal turn-end path
// does not see them and hold again.
export function beginSteerHold(session, {
  onBackstop, backstopMs = STEER_HOLD_BACKSTOP_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  endSteerHold(session, { clearTimer });
  const hold = { timer: null };
  hold.timer = setTimer(() => {
    if (session._steerHold !== hold) return;
    session._steerHold = null;
    dropUnstartedSteers(session);
    onBackstop?.();
  }, backstopMs);
  hold.timer?.unref?.();
  session._steerHold = hold;
  return hold;
}

// Clears every trace of steering on a session: process exit/kill/respawn,
// /stop, and any path that force-clears busy.
export function resetClaudeSteer(session, { clearTimer = clearTimeout } = {}) {
  if (!session) return;
  endSteerHold(session, { clearTimer });
  session._steered = null;
}
