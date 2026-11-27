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
//
// `repeat: "daily"` (with `at`, and optionally `tz`) makes a standing
// check-in — the Coordinator's twice-daily sweep, say: the store re-arms the
// same record for the next occurrence after every fire (lib/timer-command.js
// fireRepeating), and `at` is read as a wall-clock time in `tz`, so 08:00
// Europe/London stays 08:00 across BST/GMT (lib/daily-repeat.js). A daily
// reminder cannot hold the box awake: that would pin it up for good, and the
// host wakes the box for each occurrence anyway.
import { parseDuration, parseClockTime, parseClockHourMinute, formatDuration, MIN_TIMER_MS, MAX_TIMER_MS, MAX_HOLD_AWAKE_MS } from './timer-command.js';
import { nextDailyOccurrence, resolveTimeZone, localTimeZone, formatRepeatTime, splitDatedTime, isRealDate, wallTimeToInstant } from './daily-repeat.js';
import { causesForAsk } from './turn-cause.js';

export const REMINDER_TEXT_MAX = 2000;

const bad = (error) => ({ status: 400, body: { error } });

// Tool-facing view of a store record. fire_at is ISO (unambiguous across the
// box/phone timezone gap); in_ms is what the model actually reasons about.
// A daily reminder adds repeat/at/tz; fire_at and in_ms are its NEXT fire.
export function reminderView(record, nowMs) {
  return {
    id: record.id,
    text: record.text,
    fire_at: new Date(record.fireAt).toISOString(),
    in_ms: Math.max(0, record.fireAt - nowMs),
    hold_awake: record.holdAwake === true,
    source: record.source === 'agent' ? 'agent' : 'user',
    ...(record.repeat ? { repeat: 'daily', at: formatRepeatTime(record.repeat), tz: record.repeat.tz } : {}),
  };
}

// One line per reminder for the tool result — a sentence, not JSON, so the
// model reads it rather than re-parsing it.
export function formatReminderLine(view) {
  const who = view.source === 'agent' ? 'set by you' : 'set by the user with /timer';
  const hold = view.hold_awake ? ', holding the box awake' : '';
  // Same phrase as formatRepeat, built from the view's own fields.
  const when = view.repeat ? `daily at ${view.at} ${view.tz}, next in` : 'in';
  return `#${view.id} — ${when} ${formatDuration(view.in_ms)} (${view.fire_at}, ${who}${hold}): "${view.text}"`;
}

export function createReminderHandlers({ sessions, journalConvoIdFor, timerStore, now = Date.now, announce = async () => {}, restartNotes = null }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — send one message first, then set the reminder' } } };
    return { session, convoId, roomId };
  }

  // Exactly one of `in` (duration) / `at` (clock time on this box, or in
  // `tz` when given; or a date and time, "2026-12-24 09:00", for a reminder
  // further off than tomorrow). Bounds are the store's own so a tool reminder can never
  // arm something /timer would have refused. With `repeat: "daily"`, `at` is
  // required and the result also carries the record's repeat.
  function resolveDelay(data) {
    const has = (v) => v !== undefined && v !== null;
    const hasIn = has(data.in);
    const hasAt = has(data.at);
    const daily = has(data.repeat);
    if (daily && data.repeat !== 'daily') return { err: bad(`repeat must be "daily" (got ${JSON.stringify(data.repeat)})`) };
    if (daily && (hasIn || !hasAt)) return { err: bad("repeat: \"daily\" needs 'at' (a clock time such as 08:00), not 'in' — it fires at that time every day") };
    if (hasIn === hasAt) return { err: bad("pass exactly one of 'in' (a duration such as 45m, 2h, 1d2h) or 'at' (a clock time on this box such as 09:00, 14:30, 12:10am, or a date and time such as 2026-12-24 09:00)") };
    if (has(data.tz) && hasIn) return { err: bad("tz only applies to 'at' — 'in' is a duration, the same in every zone") };
    let tz = null;
    if (has(data.tz)) {
      tz = resolveTimeZone(data.tz);
      if (!tz) return { err: bad(`tz must be an IANA time zone such as Europe/London or America/New_York (got ${JSON.stringify(data.tz)})`) };
    } else if (daily) {
      tz = localTimeZone();
    }
    let delayMs;
    let repeat;
    const dated = hasAt ? splitDatedTime(data.at) : null;
    if (dated) {
      if (daily) return { err: bad('repeat: "daily" takes a clock time such as 08:00 in \'at\', not a date — it fires every day') };
      const hm = dated.clock ? parseClockHourMinute(dated.clock) : null;
      if (!hm) return { err: bad(`'at' with a date needs a time too, like 2026-12-24 09:00 or 2026-12-24 9am (got ${JSON.stringify(data.at)})`) };
      if (!isRealDate(dated.year, dated.month, dated.day)) return { err: bad(`${JSON.stringify(data.at)} is not a real date`) };
      const zone = tz || localTimeZone();
      const fireAt = wallTimeToInstant(dated.year, dated.month, dated.day, hm.hour, hm.minute, zone);
      delayMs = fireAt - now();
      if (delayMs < MIN_TIMER_MS) return { err: bad(`${data.at} in ${zone} has already passed (or is under ${formatDuration(MIN_TIMER_MS)} away)`) };
    } else if (hasIn) {
      delayMs = parseDuration(data.in);
      if (delayMs === null) return { err: bad(`'in' must be a duration like 30s, 45m, 2h, 1d or 1h30m (got ${JSON.stringify(data.in)})`) };
    } else if (tz) {
      // A named zone (explicit, or the box's own for a daily one): resolved
      // with Intl rather than the host's local-time setters, so the answer
      // is the same on a UTC dev box and on a laptop in London.
      const hm = parseClockHourMinute(data.at);
      if (!hm) return { err: bad(`'at' must be a clock time like 09:00, 14:30, 9pm or 12:10am, or a date and time like 2026-12-24 09:00 — in ${tz} (got ${JSON.stringify(data.at)})`) };
      const t = now();
      delayMs = nextDailyOccurrence({ ...hm, tz }, t + MIN_TIMER_MS) - t;
      if (daily) repeat = { kind: 'daily', ...hm, tz };
    } else {
      delayMs = parseClockTime(data.at, now());
      if (delayMs === null) return { err: bad(`'at' must be a clock time like 09:00, 14:30, 9pm or 12:10am, or a date and time like 2026-12-24 09:00 — this box's local time (got ${JSON.stringify(data.at)})`) };
    }
    if (delayMs < MIN_TIMER_MS) return { err: bad(`too soon — the minimum is ${formatDuration(MIN_TIMER_MS)}`) };
    if (delayMs > MAX_TIMER_MS) return { err: bad(`too far ahead — the maximum is ${formatDuration(MAX_TIMER_MS)} (a year and a day)`) };
    return { delayMs, repeat };
  }

  // `restart_note: true`: no timer, a note held on disk for the first turn
  // after the next bridge restart (lib/restart-notes.js). Takes only `text`.
  function createRestartNote(data, session, convoId) {
    const has = (v) => v !== undefined && v !== null;
    if (data.restart_note !== true) return bad('restart_note must be true or left out');
    const extra = ['in', 'at', 'repeat', 'tz', 'hold_awake'].filter(k => has(data[k]));
    if (extra.length) return bad(`restart_note cannot be combined with ${extra.join(', ')} — it is delivered after the next bridge restart, not at a time`);
    if (!restartNotes) return bad('restart notes are not available on this bridge');
    // A parked restart_session already carries continue_with into the
    // restarted session. Refused rather than merged: the two are delivered by
    // different restarts, and silently replacing continue_with would drop
    // what the agent asked for. Put the carry-over in continue_with instead.
    if (session._selfRestartPending) return bad('a restart_session is already parked for this session; put what you need to remember in its continue_with instead of a restart note');
    try {
      restartNotes.put(convoId, data.text);
    } catch (e) {
      return { status: 500, body: { error: `the restart note could not be saved, so it was NOT set (${e.message})` } };
    }
    return { status: 201, body: { restart_note: { text: data.text.trim() } } };
  }

  return {
    async create(data) {
      const { err, session, convoId, roomId } = callerSession(data);
      if (err) return err;
      if (data.restart_note !== undefined && data.restart_note !== null && data.restart_note !== false) {
        if (typeof data.text !== 'string' || !data.text.trim()) return bad('text is required');
        if (data.text.length > REMINDER_TEXT_MAX) return bad(`text must be at most ${REMINDER_TEXT_MAX} characters`);
        return createRestartNote(data, session, convoId);
      }
      if (typeof data.text !== 'string' || !data.text.trim()) return bad('text is required');
      if (data.text.length > REMINDER_TEXT_MAX) return bad(`text must be at most ${REMINDER_TEXT_MAX} characters`);
      if (data.hold_awake !== undefined && typeof data.hold_awake !== 'boolean') return bad('hold_awake must be true or false');
      const d = resolveDelay(data);
      if (d.err) return d.err;
      // Refused, not ignored: the hold would never lapse (a daily reminder is
      // always pending), and the host wakes the box for every occurrence.
      if (d.repeat && data.hold_awake === true) return bad('hold_awake cannot be combined with repeat — a daily reminder would keep the box awake for good; the box is woken for each check-in anyway');
      // Holding a box awake for weeks costs the host for nothing: past a
      // week, let it sleep and be woken for the reminder.
      if (data.hold_awake === true && d.delayMs > MAX_HOLD_AWAKE_MS) return bad(`hold_awake is only for reminders up to ${formatDuration(MAX_HOLD_AWAKE_MS)} away — leave it out, and the box sleeps and is woken for this one`);
      // The turn that set it travels with it: the turn it fires is the same
      // work resumed, so an ask made there still names what started it.
      const record = timerStore.add({
        convoId, roomId, text: data.text.trim(), delayMs: d.delayMs,
        holdAwake: data.hold_awake === true, source: 'agent', repeat: d.repeat, requirePersist: true,
        causes: causesForAsk(session),
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
      const which = parseReminderId(data.id);
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

// reminder_cancel's id as a string. Some MCP clients send an integer from an
// anyOf schema as a string ("261"), so the tool accepts "261", "#261" (the
// way reminders are written back) and "all" as well as a bare integer.
export const REMINDER_ID_STRING = /^\s*(?:#?\d+|all)\s*$/;

// The reminder number, 'all', or null when the value is neither.
export function parseReminderId(id) {
  if (id === 'all') return 'all';
  if (Number.isInteger(id)) return id;
  if (typeof id !== 'string' || !REMINDER_ID_STRING.test(id)) return null;
  const s = id.trim();
  return s === 'all' ? 'all' : Number(s.replace(/^#/, ''));
}
