// Loopback handlers behind the reminder_* MCP tools: an agent-callable face
// on the same file-backed timer store that /timer uses (lib/timer-command.js),
// scoped to the calling session's convo. Same {status, body} contract as
// lib/items-tools.js; index.js mounts them with respondAgentChatRoute.
//
// Why this exists: an agent's in-process reminders (CronCreate,
// ScheduleWakeup) live only in the claude process and die with it — at the
// bridge's idle reap, on a restart, and when the dev VM idle-stops. A store
// reminder is persisted, re-armed by the bridge at boot, and known to the
// host's vm-idle-stop, which lets the box sleep and starts it again ahead of
// the fire time. `hold_awake` is the opt-in for the rare reminder whose
// intervening work must not be interrupted: it adds the record to the
// guest-side keep-awake marker the host probe honours (keepAwakeMarker) and
// exempts the session from the idle reaper until it fires.
import { parseDuration, parseClockTime, formatDuration, MIN_TIMER_MS, MAX_TIMER_MS } from './timer-command.js';

export const REMINDER_TEXT_MAX = 2000;

const bad = (error) => ({ status: 400, body: { error } });

// Tool-facing view of a store record. fire_at is ISO (unambiguous across the
// box/phone timezone gap); in_ms is what the model actually reasons about.
export function reminderView(record, nowMs) {
  return {
    id: record.id,
    text: record.text,
    fire_at: new Date(record.fireAt).toISOString(),
    in_ms: Math.max(0, record.fireAt - nowMs),
    hold_awake: record.holdAwake === true,
    source: record.source === 'agent' ? 'agent' : 'user',
  };
}

// One line per reminder for the tool result — a sentence, not JSON, so the
// model reads it rather than re-parsing it.
export function formatReminderLine(view) {
  const who = view.source === 'agent' ? 'set by you' : 'set by the user with /timer';
  const hold = view.hold_awake ? ', holding the box awake' : '';
  return `#${view.id} — in ${formatDuration(view.in_ms)} (${view.fire_at}, ${who}${hold}): "${view.text}"`;
}

export function createReminderHandlers({ sessions, journalConvoIdFor, timerStore, now = Date.now, announce = async () => {} }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — send one message first, then set the reminder' } } };
    return { session, convoId, roomId };
  }

  // Exactly one of `in` (duration) / `at` (clock time on this box). Bounds
  // are the store's own so a tool reminder can never arm something /timer
  // would have refused.
  function resolveDelay(data) {
    const hasIn = data.in !== undefined && data.in !== null;
    const hasAt = data.at !== undefined && data.at !== null;
    if (hasIn === hasAt) return { err: bad("pass exactly one of 'in' (a duration such as 45m, 2h, 1d2h) or 'at' (a clock time on this box such as 09:00, 14:30, 12:10am)") };
    let delayMs;
    if (hasIn) {
      delayMs = parseDuration(data.in);
      if (delayMs === null) return { err: bad(`'in' must be a duration like 30s, 45m, 2h, 1d or 1h30m (got ${JSON.stringify(data.in)})`) };
    } else {
      delayMs = parseClockTime(data.at, now());
      if (delayMs === null) return { err: bad(`'at' must be a clock time like 09:00, 14:30, 9pm or 12:10am — this box's local time (got ${JSON.stringify(data.at)})`) };
    }
    if (delayMs < MIN_TIMER_MS) return { err: bad(`too soon — the minimum is ${formatDuration(MIN_TIMER_MS)}`) };
    if (delayMs > MAX_TIMER_MS) return { err: bad(`too far ahead — the maximum is ${formatDuration(MAX_TIMER_MS)}`) };
    return { delayMs };
  }

  return {
    async create(data) {
      const { err, session, convoId, roomId } = callerSession(data);
      if (err) return err;
      if (typeof data.text !== 'string' || !data.text.trim()) return bad('text is required');
      if (data.text.length > REMINDER_TEXT_MAX) return bad(`text must be at most ${REMINDER_TEXT_MAX} characters`);
      if (data.hold_awake !== undefined && typeof data.hold_awake !== 'boolean') return bad('hold_awake must be true or false');
      const d = resolveDelay(data);
      if (d.err) return d.err;
      const record = timerStore.add({
        convoId, roomId, text: data.text.trim(), delayMs: d.delayMs,
        holdAwake: data.hold_awake === true, source: 'agent', requirePersist: true,
      });
      // The store rolled the record back: nothing is armed, so say so rather
      // than promise a durable reminder that a restart would silently lose.
      if (!record) return { status: 500, body: { error: 'the reminder could not be saved to disk, so it was NOT set — check free space in the home directory, then try again' } };
      // The chat's visible record (a card with the same Send-now / Cancel
      // buttons a /timer set gets) — the user must be able to see and undo
      // what their agent scheduled. Never lets a chat failure fail the tool:
      // the reminder is already armed and persisted.
      try { await announce(session, record); } catch { /* announced best-effort */ }
      return { status: 201, body: { reminder: reminderView(record, now()) } };
    },

    async list(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const t = now();
      return { status: 200, body: { reminders: timerStore.listForConvo(convoId).map(r => reminderView(r, t)) } };
    },

    async cancel(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const which = data.id === 'all' ? 'all' : Number.isInteger(data.id) ? data.id : null;
      if (which === null) return bad("id must be a reminder number or 'all'");
      const cancelled = timerStore.cancel(convoId, which);
      if (!cancelled.length) {
        return { status: 404, body: { error: which === 'all' ? 'no reminders pending in this conversation' : `no reminder #${which} in this conversation — it may have fired or been cancelled already` } };
      }
      const t = now();
      return { status: 200, body: { cancelled: cancelled.map(r => reminderView(r, t)) } };
    },
  };
}
