// Pure per-room mode/model helpers. No side effects, no I/O — the caller in
// index.js performs the actual session restart. Kept in lib/ so the precedence
// and decision logic is unit-testable without spawning a claude process.

// Precedence: explicit call option -> persisted per-room value -> global default.
export function resolveInteractive({ option, persisted, fallback }) {
  if (typeof option === 'boolean') return option;
  if (typeof persisted === 'boolean') return persisted;
  return !!fallback;
}

// Precedence: explicit option -> persisted -> undefined (CLI default).
export function resolveModel({ option, persisted }) {
  return option ?? persisted ?? undefined;
}

// Session identity for a claude spawn. Fresh sessions mint their id up front
// and pass it via --session-id so claudeSessionId is known synchronously at
// spawn — RPC start needs it to answer convo_id, and journal publishes never
// have to buffer waiting for the init event. Resumes pass --resume only: the
// CLI rejects --session-id + --resume together unless --fork-session is also
// given, and the resume id already identifies the session.
export function planSessionIdentity({ resumeSessionId, mintId }) {
  const sessionId = resumeSessionId || mintId();
  return {
    sessionId,
    cliArgs: resumeSessionId ? ['--resume', resumeSessionId] : ['--session-id', sessionId],
  };
}

const INTERACTIVE_WORDS = new Set(['interactive', 'iv', 'tui', 'on']);
const PRINT_WORDS = new Set(['print', 'noniv', 'non-interactive', 'p', 'off']);

// Parse a /mode argument to a canonical target, or null if unrecognized.
export function normalizeModeArg(arg) {
  const a = String(arg ?? '').trim().toLowerCase();
  if (INTERACTIVE_WORDS.has(a)) return 'interactive';
  if (PRINT_WORDS.has(a)) return 'print';
  return null;
}

export function modeLabel(interactive) {
  return interactive ? 'interactive' : 'non-interactive';
}

// A single button that flips to the opposite of the current mode. Value is
// namespaced `mode:<target>` so the button-response handler can dispatch it.
export function modeButtons(currentInteractive) {
  const target = currentInteractive ? 'print' : 'interactive';
  const label = currentInteractive ? 'Switch to non-interactive' : 'Switch to interactive';
  return [{ id: `mode-${target}`, label, value: `mode:${target}` }];
}

// Decide whether a /mode switch can proceed. `session.iv` truthy means the room
// is currently interactive. Returns a decision the caller acts on.
export function planModeSwitch(session, wantInteractive) {
  const currentInteractive = !!session.iv;
  if (currentInteractive === wantInteractive) {
    return { ok: false, noop: true, message: `Already in ${modeLabel(wantInteractive)} mode.` };
  }
  if (session.busy) {
    return { ok: false, message: 'Finish or interrupt the current turn before switching modes.' };
  }
  if (session._awaitingInputReady) {
    // A just-resumed interactive TUI holds input for a few seconds (busy stays
    // false during that window). Switching now would tear down a still-loading
    // session and drop its held outbox — refuse and let the caller retry.
    return { ok: false, message: 'The session is still resuming — try /mode again in a moment.' };
  }
  if (!session.claudeSessionId) {
    // No session id yet (a fresh print session before its first stream event).
    // Restarting now would spawn without --resume, losing history despite the
    // "history preserved" messaging — refuse until the id exists.
    return { ok: false, message: 'The session is still starting up — try /mode again in a moment.' };
  }
  if (currentInteractive && !wantInteractive && session.pendingInteractivePrompt) {
    return { ok: false, message: 'Answer the pending question before switching to non-interactive mode.' };
  }
  return {
    ok: true,
    message: `Switching to ${modeLabel(wantInteractive)} mode — restarting (history preserved)…`,
  };
}
