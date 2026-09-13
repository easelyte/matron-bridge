// Slow-tool notices: a chat heads-up when a tool call has been in flight
// longer than the user would expect silence.
//
// Motivating incident (2026-08-27): a Roblox Studio MCP tool call wedged in
// the MCP server's long-poll channel and sat for 7+ minutes with no output.
// The user's messages queued behind the busy turn and the session looked
// dead; the only tell was silence. This module makes that state visible: one
// notice when a tool call crosses the threshold (5 min), one reminder if it
// is STILL running at the reminder mark (10 min), and nothing at all for the
// overwhelming majority of calls that finish quickly. The original 60s/5min
// timings nagged on ordinary builds and test runs, and 3 min still caught
// routine long builds; a call has to be genuinely long before anyone wants
// to hear about it.
//
// Scope decisions:
// - Tools that legitimately block on the user are excluded: AskUserQuestion
//   and the plan-mode tools wait for a human answer, and the ask-user MCP
//   server's tools (request_secret et al) poll web forms for minutes by
//   design.
// - Subagents (Task/Agent) are excluded too: the bridge already streams
//   subagent activity into chat, so a long-running subagent is visibly
//   working and a "still running" line on top is just noise.
// - EVERY other tool is covered — built-in and MCP alike: the 2026-09-05
//   chrome-devtools hang (two get_network_request calls, 30 min each,
//   message queued in silence) showed the cost of leaving a tool out.
// - Fire-once per stage per tool call. A hung call produces exactly two
//   lines, never a drumbeat.
// - toolEnded leaves a tombstone rather than deleting: print-mode replays
//   the same assistant content blocks across partial and final events, so a
//   tool_use for an id we've already seen end must not re-arm. reset() (turn
//   end / session teardown) is the memory bound.
//
// Pure with every impure edge injected (timers/now/notify/log), the same
// shape as createPermissionRegistry in lib/permission-prompt.js, so it
// unit-tests without a live bridge.

export const DEFAULT_SLOW_TOOL_NOTICE_MS = 300_000;
export const DEFAULT_SLOW_TOOL_REMINDER_MS = 600_000;
export const MAX_SLOW_TOOL_NOTICE_MS = 3_600_000;

// Env knobs: unset/invalid falls back to the default; 0 or negative disables
// (the whole feature for the notice, just the reminder for the reminder);
// out-of-range high values clamp to the default rather than arming an
// hour-plus timer nobody meant.
function resolveMs(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return fallback;
  if (ms <= 0) return 0;
  return ms <= MAX_SLOW_TOOL_NOTICE_MS ? ms : fallback;
}

// MATRON_SLOW_TOOL_NOTICE_MS — first notice.
export function resolveSlowToolNoticeMs(raw) {
  return resolveMs(raw, DEFAULT_SLOW_TOOL_NOTICE_MS);
}

// MATRON_SLOW_TOOL_REMINDER_MS — the "STILL running" reminder. Measured from
// the tool's start, not from the first notice; a reminder at or before the
// notice is meaningless and is not armed.
export function resolveSlowToolReminderMs(raw) {
  return resolveMs(raw, DEFAULT_SLOW_TOOL_REMINDER_MS);
}

const EXCLUDED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'Task', 'Agent']);
const EXCLUDED_PREFIXES = ['mcp__ask-user__'];

export function isNoticeEligible(toolName) {
  if (typeof toolName !== 'string' || toolName === '') return false;
  if (EXCLUDED_TOOLS.has(toolName)) return false;
  return !EXCLUDED_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function renderSlowToolNotice({ toolName, elapsedMs, reminder }) {
  const elapsed = formatElapsed(elapsedMs);
  return reminder
    ? `⏳ \`${toolName}\` is STILL running (${elapsed}). If it seems stuck, tap Stop (or send "interrupt") to cancel it.`
    : `⏳ Still working — \`${toolName}\` has been running for ${elapsed}. Tap Stop (or send "interrupt") to cancel if it seems stuck.`;
}

// Per-session tracker. notify errors are swallowed through `log` — the same
// fail-open contract as lib/print-interrupt.js: nothing here may throw into
// the event-stream handler that calls it.
export function createSlowToolNotices({
  thresholdMs = DEFAULT_SLOW_TOOL_NOTICE_MS,
  reminderMs = DEFAULT_SLOW_TOOL_REMINDER_MS,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  now = Date.now,
  notify,
  log = () => {},
} = {}) {
  const entries = new Map();

  function fire(id, reminder) {
    const entry = entries.get(id);
    if (!entry || entry.ended) return;
    try {
      notify({ toolUseId: id, toolName: entry.toolName, elapsedMs: now() - entry.startedAt, reminder });
    } catch (e) {
      log(`slow-tool notice notify failed: ${e.message}`);
    }
  }

  function clearTimers(entry) {
    for (const timer of entry.timers) clearTimer(timer);
    entry.timers = [];
  }

  return {
    toolStarted(id, toolName) {
      if (!id || thresholdMs <= 0 || typeof notify !== 'function') return;
      if (!isNoticeEligible(toolName)) return;
      if (entries.has(id)) return; // partial/final event replay of the same block
      const timers = [setTimer(() => fire(id, false), thresholdMs)];
      if (reminderMs > thresholdMs) timers.push(setTimer(() => fire(id, true), reminderMs));
      entries.set(id, { toolName, startedAt: now(), timers, ended: false });
    },

    // Safe to call for every tool_result, tracked or not: an untracked id
    // gets a tombstone so a late replay of its tool_use can't arm timers
    // for a call that already finished.
    toolEnded(id) {
      if (!id) return;
      const entry = entries.get(id);
      if (entry) {
        clearTimers(entry);
        entry.ended = true;
      } else {
        entries.set(id, { toolName: null, startedAt: 0, timers: [], ended: true });
      }
    },

    // Turn end / interrupt / session teardown: nothing in flight, and the
    // tombstone map must not grow across turns.
    reset() {
      for (const entry of entries.values()) clearTimers(entry);
      entries.clear();
    },

    size() { return entries.size; },
  };
}
