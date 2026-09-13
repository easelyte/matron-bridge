// Agent-initiated session restart — the decision half of the `restart_session`
// MCP tool. A session asks the bridge to respawn its own agent process (most
// often to pick up browser tools, which cost ~400M resident and are therefore
// off by default) and hands over a message the bridge feeds back into the
// replacement, so the work carries on with nobody having to retype anything.
//
// Nothing here touches session state or spawns anything: it answers "should
// this restart happen, and with what?" and returns the `!restart` command text
// to park plus the continuation text to queue. The endpoint in index.js stays
// thin around it, and every rule below is unit-testable without a live
// session — the same split lib/command-dispatch.js makes for typed commands.

import { isValidModelArg, normalizeModelArg, VALID_ALIAS_HINT } from './model-aliases.js';

// Self-restarts allowed before the agent must ask the user. The runaway this
// guards is specific: the continuation message lands as the replacement's
// first turn, that turn calls the tool again, and the box ping-pongs burning
// tokens with nobody watching. session.restartCount is no help — it counts
// crashes, and recreateSession starts the replacement at 0.
//
// The budget resets when a real user message arrives (index.js), so this only
// ever bites a session looping on its own; a human turn hands back a fresh 3.
export function parseSelfRestartMax(value, fallback = 3) {
  // A non-numeric or negative setting must not disable the cap: NaN compares
  // false against everything, so `restartCount >= NaN` would never refuse.
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const SELF_RESTART_MAX = parseSelfRestartMax(process.env.MATRON_SELF_RESTART_MAX);

// Same ceiling agent_session_start puts on a seeded task: long enough to hand
// over real context, short enough that it can't become a transcript.
export const CONTINUE_MAX_CHARS = 2000;

// Prefixed onto the queued message so the user reading the journal can tell
// this turn was the session talking to itself, not something they typed.
export const CONTINUATION_PREFIX = '[auto-continue after restart] ';

const CODEX_BROWSER_REFUSAL =
  '--browser is a Claude-only session extra. Codex uses MCP servers from its own config.';
const CODEX_MODEL_REFUSAL =
  'Codex takes its model from its own config — restart_session cannot change it.';

// The /restart-session endpoint body, in the same injected-deps shape as
// lib/agent-spawn.js's handlers so index.js keeps only the wiring:
//
//   getSession(roomId)          -> the live session, or null
//   queueContinuation(s, text)  -> queues the message; returns an undo
//   park(s, command)            -> stash for the turn-end seam (mid-turn)
//   dispatch(s, command)        -> run it now (session already idle)
//   notify(s, text)             -> tell the user what is about to happen
export function createSelfRestartHandler({ getSession, queueContinuation, park, dispatch, notify }) {
  return async function restartSession(data) {
    const { roomId, continue_with: continueWith, browser, model, reason } = data || {};
    const session = getSession(roomId);
    if (!session || !session.alive) {
      return { status: 404, body: { error: 'No active session for this room' } };
    }
    // One restart per swap. The parked command runs at the turn-end seam, so
    // a second call in the same turn (a retry, or parallel tool calls) would
    // queue another continuation, replace the parked command and spend more
    // budget for the same single restart. Refuse it: the first call already
    // has everything it needs. The flag lives on this session object only —
    // recreateSession does not carry it — so the replacement is free again.
    if (session._selfRestartPending) {
      return {
        status: 409,
        body: { error: 'A restart is already pending for this session and will run when this turn ends. Do not call restart_session again.' },
      };
    }

    const plan = planSelfRestart({
      continueWith,
      browser: !!browser,
      model: model ?? null,
      agent: session.agent,
      restartCount: session._agentRestartCount || 0,
    });
    if (plan.error) {
      // Budget exhaustion is the one refusal that is about rate, not shape —
      // the agent can't fix it by rewording, only by asking the user.
      const exhausted = /budget exhausted/.test(plan.error);
      return { status: exhausted ? 429 : 400, body: { error: plan.error } };
    }

    // Queue FIRST: recreateSession carries session.queuedMessages onto the
    // replacement and flushes them when it's ready, so the message has to be
    // on the outgoing session before the restart runs. Queue after, and it
    // lands on a session that is already gone.
    const undoQueue = queueContinuation(session, plan.continuation);
    try {
      // Mid-turn — the overwhelmingly common case, since the tool is called
      // from inside a turn — parks the restart at the turn-end seam, exactly
      // where a user's own mid-turn /restart goes. An idle session (Codex
      // between turns, a tool call that outlived its turn) has no seam left
      // to wait for, so it runs now.
      if (session.busy) park(session, plan.command);
      else dispatch(session, plan.command);
    } catch (e) {
      try { undoQueue?.(); } catch { /* queue already drained — nothing to take back */ }
      return { status: 500, body: { error: `Could not start the restart: ${e?.message || e}` } };
    }
    session._agentRestartCount = plan.restartCount;
    session._selfRestartPending = true;

    const bits = [];
    if (browser) bits.push('browser tools');
    if (normalizeModelArg(model) !== '') bits.push(normalizeModelArg(model));
    const withWhat = bits.length ? ` with ${bits.join(' + ')}` : '';
    const why = typeof reason === 'string' && reason.trim() ? ` — ${reason.trim()}` : '';
    const when = session.busy ? ' once this turn finishes' : ' now';
    try {
      notify(session, `🔄 Restarting this session${withWhat}${when}${why}. `
        + `It will carry on by itself (self-restart ${plan.restartCount}/${SELF_RESTART_MAX}).`);
    } catch { /* a notice that can't be posted must not fail the restart */ }

    return { status: 200, body: { ok: true, parked: !!session.busy, restart_count: plan.restartCount } };
  };
}

export function planSelfRestart({
  continueWith,
  browser = false,
  model = null,
  agent = 'claude',
  restartCount = 0,
} = {}) {
  const spent = Number.isFinite(restartCount) ? restartCount : 0;
  if (spent >= SELF_RESTART_MAX) {
    return {
      error: `Self-restart budget exhausted (${spent}/${SELF_RESTART_MAX} this stretch). `
        + 'Ask the user to restart the session instead — they can run /restart with the flags you need.',
    };
  }

  const text = typeof continueWith === 'string' ? continueWith.trim() : '';
  if (!text) {
    return { error: 'continue_with is required — a restart with nothing to say afterwards leaves the session idle and silent.' };
  }
  if (text.length > CONTINUE_MAX_CHARS) {
    return { error: `continue_with must be at most ${CONTINUE_MAX_CHARS} characters (got ${text.length}).` };
  }

  const wantsModel = normalizeModelArg(model) !== '';
  if (agent === 'codex') {
    if (browser) return { error: CODEX_BROWSER_REFUSAL };
    if (wantsModel) return { error: CODEX_MODEL_REFUSAL };
  }
  // Validate the alias HERE rather than letting the parked command fail at
  // the turn-end replay: by then the session has already been torn down, and
  // the agent that could have fixed the typo is gone with it.
  if (wantsModel && !isValidModelArg(model)) {
    return { error: `Unknown model "${model}". Try: ${VALID_ALIAS_HINT} (or a full claude-* name).` };
  }

  // --force is not optional: the tool is called mid-turn, so the replayed
  // command meets the same busy check that parked it. Without --force it
  // would park itself again, and again.
  const parts = ['!restart', '--force'];
  if (browser) parts.push('--browser');
  if (wantsModel) parts.push('--model', normalizeModelArg(model));

  return {
    command: parts.join(' '),
    continuation: `${CONTINUATION_PREFIX}${text}`,
    restartCount: spent + 1,
  };
}
