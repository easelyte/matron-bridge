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
//
// presetId is the pre-init-crash restart path (#136 / PR #151): a fresh
// print session mints an id and passes --session-id, but Claude only writes
// a *resumable* transcript once a real turn runs. If the process dies before
// then (SIGKILL/OOM/spawn failure), the auto-restart must NOT --resume that
// id — Claude never wrote it, so --resume fails and the conversation
// terminates. Instead it respawns with the SAME id via --session-id
// (presetId), preserving the convo_id/journal identity without claiming a
// resume that can't happen. resumeSessionId always wins over presetId.
//
// transcriptExists (optional, (sessionId) => boolean) is the on-disk ground
// truth for the same rule (/logout-crash-loop bug): rooms can persist a
// session id whose transcript was never written (a zero-turn chat), and
// every --resume of it exits 1 ("No conversation found") — the iv
// auto-restart and journal auto-resume paths then retried it forever. A
// resume whose transcript is missing is demoted to a fresh --session-id
// spawn on the SAME id, so the room self-heals instead of crash-looping.
// `resumed` in the result reports which branch was taken (callers seed
// _sessionConfirmed from it — a demoted resume is NOT confirmed).
export function planSessionIdentity({ resumeSessionId, presetId, mintId, transcriptExists }) {
  if (resumeSessionId && (!transcriptExists || transcriptExists(resumeSessionId))) {
    return { sessionId: resumeSessionId, cliArgs: ['--resume', resumeSessionId], resumed: true };
  }
  const sessionId = resumeSessionId || presetId || mintId();
  return { sessionId, cliArgs: ['--session-id', sessionId], resumed: false };
}

// #136 / PR #151 follow-up (/logout-crash-loop bug): does this stream event
// prove the session's transcript exists on disk? `system` events do NOT —
// init and hook_started/hook_response fire at spawn, before Claude has
// written anything, yet they carry a session_id. Marking a session
// resumable off one of those let a zero-turn chat pass the mode-switch
// gate and --resume a transcript that was never written. Turn-bearing
// events (assistant/user/result/stream_event) only exist once the turn's
// user message reached the transcript.
export function eventConfirmsSession(event) {
  return !!(event && event.session_id && event.type && event.type !== 'system');
}

// Guard for the delayed /login auto-return-to-print timer. The timer must
// honor whatever session holds the room WHEN IT FIRES, not only the object
// that scheduled it: the iv auto-restart path deliberately copies
// _accountFlowReturnToPrint onto its replacement session, so requiring
// object identity would silently strand a just-restarted session in
// interactive mode (Bugbot, PR #162). The flag check also turns a timer
// whose flow was consumed or abandoned elsewhere into a no-op.
export function shouldRunAccountFlowReturn(current) {
  return !!(current && current.alive && current.iv && current._accountFlowReturnToPrint);
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
  // An unconfirmed print session used to be refused here: the switch recreates
  // it with --resume, and a provisional id Claude never persisted isn't
  // resumable (#136 / PR #151). recreateSession's preInitPrint branch now
  // demotes exactly that case to a fresh --session-id spawn on the SAME id, so
  // the switch is safe — and refusing it was the reason /login could not be the
  // first thing you say to a new chat. Unconfirmed means no turn-bearing event
  // has arrived (see eventConfirmsSession), i.e. zero turns, so the respawn
  // discards nothing; say so rather than promising preserved history.
  const provisional = !currentInteractive && !session._sessionConfirmed;
  return {
    ok: true,
    provisional,
    message: provisional
      ? `Switching to ${modeLabel(wantInteractive)} mode — restarting…`
      : `Switching to ${modeLabel(wantInteractive)} mode — restarting (history preserved)…`,
  };
}
