// Pre-reap handoff (after obie/auto-handoff).
//
// The idle reaper kills a session after SESSION_IDLE_TIMEOUT_MS (an hour)
// without user input or assistant text. The model's prompt cache lasts
// about as long, so a session that is reaped at the hour mark is resumed
// later onto a cold cache and reloads its whole transcript. Shortly BEFORE
// the reap, while the cache is still warm, the bridge does two things:
//
//   1. It sends the session one turn asking it to bring its mission status
//      up to date and post a progress milestone if anything changed since
//      the last one. The mission IS the handoff — there is no separate
//      handoff file. Skipped when the mission's status is already newer
//      than the session's last activity, when the session has no mission,
//      and for the Coordinator (it has no mission of its own).
//   2. It compacts the session when its context gauge is at or above a
//      threshold (default 20% of the window), so the later resume reloads
//      a summary, not the transcript. Skipped for Codex sessions.
//
// Rules the wiring in index.js enforces with these helpers:
//   * once per idle period — the session is marked when the handoff fires
//     (`session._preReapHandoff`), and any other turn clears the mark: a
//     user message at the journal seams, and every turn the bridge starts
//     on the session (noteTurnStart) other than the handoff's own;
//   * never mid-turn or while a prompt waits — the caller's `occupied`
//     test (lib/session-control.js occupied) gates it;
//   * it must not postpone the reap — the mark freezes the idle anchor at
//     the moment of the handoff (handoffIdleSince), so the handoff turn's
//     own output does not count as activity;
//   * one line in the chat, nothing when both parts are skipped.
//
// Pure: the clock, the session fields, the mission lookups and the gauge
// are all passed in. index.js owns the timers and the delivery.
import { AGENT_CODEX } from './agent-backend.js';
import { isCompactCommand } from './compact-priority.js';

export const DEFAULT_HANDOFF_IDLE_MS = 50 * 60_000;
export const DEFAULT_COMPACT_PCT = 20;
// A mission status set in the closing minutes of the last turn is current:
// agents typically set the status and then write their closing message,
// which bumps lastActivityAt a little after status_updated_at.
export const STATUS_FRESH_GRACE_MS = 5 * 60_000;
export const HANDOFF_TURN_PREFIX = '[pre-reap handoff from the bridge]';

const OFF_RE = /^(0|false|off|no)$/i;

function parsePositiveMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// MATRON_PRE_REAP_COMPACT_PCT: 1–100 is the threshold, 0/off means never
// compact (the status turn still runs), anything else is the default.
function parsePct(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  if (OFF_RE.test(String(value).trim())) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n >= 0 && n <= 100 ? n : fallback;
}

// { enabled, idleMs, compactPct, reason } from the environment. `reason`
// names why it is off (for the boot log); null when on. The handoff only
// makes sense strictly before the reap, so an idle delay at or past the
// reap timeout — or a reaper that is off — switches it off.
export function handoffConfig(env = {}, { reapTimeoutMs } = {}) {
  const idleMs = parsePositiveMs(env.MATRON_PRE_REAP_HANDOFF_IDLE_MS, DEFAULT_HANDOFF_IDLE_MS);
  const compactPct = parsePct(env.MATRON_PRE_REAP_COMPACT_PCT, DEFAULT_COMPACT_PCT);
  const flag = env.MATRON_PRE_REAP_HANDOFF;
  let reason = null;
  if (flag != null && OFF_RE.test(String(flag).trim())) reason = 'MATRON_PRE_REAP_HANDOFF';
  else if (!Number.isFinite(reapTimeoutMs) || reapTimeoutMs <= 0) reason = 'the idle reaper is off (SESSION_IDLE_TIMEOUT_MS=0)';
  else if (idleMs >= reapTimeoutMs) reason = 'MATRON_PRE_REAP_HANDOFF_IDLE_MS is not shorter than SESSION_IDLE_TIMEOUT_MS';
  return { enabled: reason === null, idleMs, compactPct, reason };
}

// The reaper's idle anchor for a session: its last activity, until a
// handoff fires — then the anchor the handoff froze, so the turn and the
// compaction the bridge itself started cannot postpone the reap. A real
// user turn clears the mark (index.js) and the clock is lastActivityAt again.
export function handoffIdleSince(session) {
  const frozen = session?._preReapHandoff?.idleSince;
  if (Number.isFinite(frozen)) return frozen;
  return session?.lastActivityAt || session?.startedAt || 0;
}

// Every turn started on the session ends the idle period — a user message,
// a room message, a reminder firing, a Coordinator carry-on — EXCEPT the
// handoff's own: its status turn (recognised by the bridge frame it opens
// with) and a compaction (a /compact is never activity worth keeping a
// session up for; the user's own /compact re-armed at the journal seam
// before it got here). Called from sendToSession with the turn's text, so
// the frozen anchor only ever hides the handoff's own work from the reaper.
export function noteTurnStart(session, text) {
  const mark = session?._preReapHandoff;
  if (!mark) return;
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.startsWith(HANDOFF_TURN_PREFIX) || isCompactCommand(t)) return;
  session._preReapHandoff = null;
}

// Whether the handoff fires on this reaper tick: on, a live session that
// has been idle for the delay, free (the caller's occupied test), and not
// yet handed off in this idle period.
export function handoffDue({ session, now, config, occupied }) {
  if (!config?.enabled || !session || !session.alive || session._autoStopped) return false;
  if (session._preReapHandoff) return false;
  if (now - handoffIdleSince(session) < config.idleMs) return false;
  if (typeof occupied === 'function' && occupied(session)) return false;
  return true;
}

// What to do. `missionStatusAt` is the mission's status_updated_at (ISO) or
// null; the gauge is the session's last context tokens over its window.
//   -> { statusTurn, compact, pct, skipped: { status, compact } }
// `skipped` names the reason each part was left out (null = it runs), for
// the debug log.
export function planHandoff({ session, hasMission, missionStatusAt, coordinator, contextTokens, contextWindow, config }) {
  let statusSkip = null;
  if (coordinator) statusSkip = 'coordinator';
  else if (!hasMission) statusSkip = 'no mission';
  else if (typeof missionStatusAt === 'string') {
    const at = Date.parse(missionStatusAt);
    const lastActivity = session?.lastActivityAt || session?.startedAt || 0;
    if (Number.isFinite(at) && at >= lastActivity - STATUS_FRESH_GRACE_MS) statusSkip = 'status is current';
  }

  // The exact gauge decides; `pct` is the rounded figure for the notice.
  let exact = null;
  if (Number.isFinite(contextTokens) && Number.isFinite(contextWindow) && contextWindow > 0) {
    exact = (contextTokens / contextWindow) * 100;
  }
  const pct = exact === null ? null : Math.round(exact);
  let compactSkip = null;
  if (!config || !(config.compactPct > 0)) compactSkip = 'off';
  else if (session?.agent === AGENT_CODEX) compactSkip = 'codex';
  else if (exact === null) compactSkip = 'no gauge';
  else if (exact < config.compactPct) compactSkip = 'below threshold';

  return { statusTurn: statusSkip === null, compact: compactSkip === null, pct, skipped: { status: statusSkip, compact: compactSkip } };
}

// Keep the working state needed to resume after the session sleeps.
export function preReapCompactCommand() {
  return '/compact Preserve the session goal and the user\'s latest asks; current mission, PR, worktree and branch names and paths; open tracker items and unanswered questions; pending background jobs, reminders and waits; promises made; and the exact next step.';
}

// The turn the session gets. Framed by the bridge, like a Coordinator
// carry-on, so the agent can tell it from the user. One line.
export function handoffTurnText({ idleMinutes }) {
  const mins = Number.isFinite(idleMinutes) ? idleMinutes : 50;
  return `${HANDOFF_TURN_PREFIX} This session has been idle for about ${mins} minutes and the bridge will put it to sleep shortly (it resumes on the next message). `
    + 'While your context is still warm: if anything has changed since the mission\'s last milestone or status, bring the mission status up to date with mission_status and post a progress milestone with milestone_post. '
    + 'If nothing has changed, do nothing about status or milestones. If this session\'s work is finished (its mission is done or it has completed the task it was given) and /close has not been run since its last real work, run /close now (that is not new work); otherwise do nothing. Do not start new work. Answer in one line.';
}

// The one line the chat gets; null when the handoff did nothing.
export function handoffNotice(plan, { idleMinutes }) {
  if (!plan || (!plan.statusTurn && !plan.compact)) return null;
  const idle = `💤 Idle ${idleMinutes} min — `;
  const gauge = `(${plan.pct}%)`;
  if (plan.statusTurn && plan.compact) return `${idle}asked this session to refresh its mission status; compacting its context ${gauge} once it answers.`;
  if (plan.statusTurn) return `${idle}asked this session to refresh its mission status before it sleeps.`;
  return `${idle}compacting this session's context ${gauge} before it sleeps.`;
}
