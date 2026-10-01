// /timer command handling — schedule a message to be (re)sent into a
// session's convo after a delay: `/timer 2h hey what's up` routes
// "hey what's up" through the normal input path two hours later, exactly as
// if the user had typed it then; `/timer 2h /compact` types /compact into
// the TUI at fire time the same way. The delay can be a duration ("2h",
// "1h30m") or a wall-clock time in the HOST's timezone ("09:00", "12:10am"),
// which resolves to the next occurrence of that time.
//
// Two halves, both pure/injected so they're unit-testable without a bridge:
//  - parsing (parseDuration / parseClockTime / parseTimerCommand /
//    formatDuration), mirroring
//    the lib/effort-command.js style of "validate here, act in index.js";
//  - createTimerStore, a file-backed scheduler with every impure edge
//    injected (load/save/now/setTimeout/clearTimeout/onFire). Timers are
//    persisted on every mutation and re-armed via init() on bridge startup,
//    so they survive BOTH the idle reaper (which only kills the claude
//    process — the bridge, and thus the armed setTimeout, stays up; the
//    fire path auto-resumes the reaped session like any other inbound
//    message would) AND full bridge restarts (where init() re-arms from
//    disk, firing anything that came due while the bridge was down).
//
// A record may also repeat daily (reminder_create `repeat: "daily"`, see
// lib/daily-repeat.js): it is never removed on fire, only moved on to its
// next occurrence — see fire() for the crash ordering that implies.
import { nextDailyOccurrence, normalizeRepeat } from './daily-repeat.js';

// Duration bounds. Min stops accidental instant-fire loops ("/timer 0s
// /timer 0s …" gets refused, not queued); max keeps every armed delay far
// inside Node's ~24.8-day setTimeout ceiling so arm() never needs to chain.
export const MIN_TIMER_MS = 5 * 1000;
export const MAX_TIMER_MS = 7 * 24 * 3600 * 1000;

// Overdue timers found at init() (bridge was down when they came due) fire
// after this grace instead of synchronously — gives the journal socket a
// moment to connect so the fire notice isn't emitted into a dead publisher.
export const OVERDUE_GRACE_MS = 5 * 1000;

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

// "2h" | "90s" | "1h30m" | "1d2h" -> total ms, or null if the string isn't a
// pure duration. Bare numbers are rejected (ambiguous — is "5" seconds or
// minutes?); each unit may appear at most once and must descend (d>h>m>s),
// so typo'd doubles like "2h2h" don't silently sum.
export function parseDuration(str) {
  const s = String(str ?? '').trim().toLowerCase();
  if (!/^(\d+[smhd])+$/.test(s)) return null;
  let total = 0;
  const seen = [];
  for (const [, num, unit] of s.matchAll(/(\d+)([smhd])/g)) {
    if (seen.length && 'dhms'.indexOf(unit) <= 'dhms'.indexOf(seen[seen.length - 1])) return null;
    seen.push(unit);
    total += parseInt(num, 10) * UNIT_MS[unit];
  }
  return total;
}

// A single token that could be a wall-clock time: "14:30", "9:05", "9pm",
// "12:10am". Used only to tell "you meant a time but got it wrong" ("25:70")
// apart from "you meant something else entirely" ("soon"), so the error can
// name the right grammar. Deliberately looser than CLOCK_RE below.
const CLOCK_SHAPED = /^(\d{1,2}:\d{1,2}(am|pm)?|\d{1,2}(am|pm))$/i;

// The grammar actually accepted. No internal spaces anywhere: parseTimerCommand
// splits on the FIRST whitespace, so "12:10 am hi" would schedule 12:10 and
// send "am hi" — the spaced meridiem is intentionally not a form.
const CLOCK_RE = /^(\d{1,2})(?::([0-5]\d))?(am|pm)?$/i;

// "14:30" | "9:05" | "9pm" | "12:10am" -> { hour: 0-23, minute: 0-59 }, or
// null if the token isn't a clock time (including clock-shaped-but-out-of-
// range: "25:00", "13pm"). The zone-free half of parseClockTime, shared with
// reminder_create's `tz` / `repeat: "daily"` path, which resolves the time
// in a named zone instead of the host's (lib/daily-repeat.js).
export function parseClockHourMinute(str) {
  const s = String(str ?? '').trim().toLowerCase();
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  const [, rawHour, rawMinute, meridiem] = m;
  // A bare number ("9") is neither: it's the ambiguous case parseDuration
  // already refuses, and reading it as an hour would be a guess.
  if (rawMinute === undefined && !meridiem) return null;

  let hour = parseInt(rawHour, 10);
  const minute = rawMinute === undefined ? 0 : parseInt(rawMinute, 10);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    // 12am = 00:xx, 12pm = 12:xx; every other pm hour shifts by 12.
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

// "14:30" | "9:05" | "9pm" | "12:10am" -> ms until the NEXT occurrence of that
// wall-clock time in the HOST's local timezone, or null if the token isn't a
// clock time (see parseClockHourMinute).
//
// `now` is injected (epoch ms) so this stays pure and testable; production
// call sites pass Date.now(). If the time has already gone by today — or is
// closer than MIN_TIMER_MS, where "in 3 seconds" is never what someone
// naming a clock time meant — it resolves to tomorrow.
//
// Arithmetic is deliberately local-time (new Date + setHours/setDate) rather
// than epoch addition, so a DST shift in the window resolves the way a wall
// clock does: "/timer 09:00" is 09:00 as the host reads it, whether that's
// 23, 24, or 25 hours away.
export function parseClockTime(str, now) {
  const hm = parseClockHourMinute(str);
  if (!hm) return null;
  const { hour, minute } = hm;

  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() - now < MIN_TIMER_MS) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

// ms -> compact human string ("2h", "1h 30m", "45s"). Sub-minute remainders
// are dropped once the total reaches a minute — timer feedback, not a
// stopwatch.
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

// Raw text after the "/timer" word -> a discriminated action for
// handleCommand's switch:
//   { kind: 'list' }                       — bare /timer
//   { kind: 'cancel', which: n | 'all' }   — /timer cancel [n|all]
//   { kind: 'set', delayMs, message }      — /timer <duration|time> <message>
//   { kind: 'error', message }             — anything else, with a hint
// `rest` keeps the user's original spacing so the scheduled message is sent
// verbatim (parts-splitting would collapse internal whitespace).
// `now` is injected (epoch ms) so clock-time resolution stays testable; only
// that path reads it, so duration parsing is unchanged and time-independent.
export function parseTimerCommand(rest, now = Date.now()) {
  const trimmed = String(rest ?? '').trim();
  if (!trimmed) return { kind: 'list' };

  const [first] = trimmed.split(/\s+/);
  if (first.toLowerCase() === 'cancel') {
    const arg = trimmed.slice(first.length).trim().toLowerCase();
    if (!arg || arg === 'all') return { kind: 'cancel', which: 'all' };
    if (/^#?\d+$/.test(arg)) return { kind: 'cancel', which: parseInt(arg.replace('#', ''), 10) };
    return { kind: 'error', message: 'Usage: /timer cancel [<id>|all]' };
  }

  // Duration first, then clock time. The two grammars can't collide: no
  // duration form contains ":" or a meridiem, and no clock form is a bare
  // "<digits><smhd>" run — so the order is for cost, not for tie-breaking.
  const delayMs = parseDuration(first) ?? parseClockTime(first, now);
  if (delayMs === null) {
    // Clock-shaped but unparseable ("25:70", "13pm") is a wrong TIME, not a
    // wrong duration — say so instead of pointing at the duration grammar.
    return CLOCK_SHAPED.test(first)
      ? { kind: 'error', message: `"${first}" isn't a clock time. Use 0-23:00-59 or 1-12 with am/pm — e.g. 00:10, 14:30, 12:10am: /timer 09:00 <message>` }
      : { kind: 'error', message: `"${first}" isn't a duration (30s, 10m, 2h, 1d, 1h30m) or a clock time (00:10, 14:30, 12:10am): /timer 2h <message>` };
  }
  if (delayMs < MIN_TIMER_MS) {
    return { kind: 'error', message: `Timer too short — minimum is ${formatDuration(MIN_TIMER_MS)}.` };
  }
  if (delayMs > MAX_TIMER_MS) {
    return { kind: 'error', message: `Timer too long — maximum is ${formatDuration(MAX_TIMER_MS)}.` };
  }
  const message = trimmed.slice(first.length).trim();
  if (!message) {
    return { kind: 'error', message: 'Nothing to send. Usage: /timer <duration|time> <message>' };
  }
  return { kind: 'set', delayMs, message };
}

// The Cancel button attached to a set-confirmation card, following the
// picker-button convention (lib/effort-command.js effortButtons): the id's
// `timer-` prefix classifies the frame as non-answerable in
// lib/journal-input-router.js (so it never advances the reply staleness
// guard, and taps are seq-proven against this exact frame), and a tap sends
// the VALUE back as the prompt_reply choice — Matron taps send values, not
// ids — which lib/picker-dispatch.js dispatches to the bridge's cancel seam.
export function timerCancelButton(id) {
  return { id: `timer-cancel-${id}`, label: '🚫 Cancel timer', value: `timer:cancel:${id}` };
}

// The Send-now button that rides beside Cancel on the same card: a tap
// delivers the scheduled message immediately instead of waiting out the
// delay (Dan, 2026-08-05). Same `timer-` id prefix (non-answerable frame)
// and `timer:` value namespace, dispatched to the bridge's fireNow seam.
export function timerSendNowButton(id) {
  return { id: `timer-send-${id}`, label: '📤 Send now', value: `timer:send:${id}` };
}

// File-backed timer scheduler. Every impure edge is injected: `load()` ->
// persisted shape (or anything falsy/corrupt — normalized away), `save(data)`
// persists it, `now()` is the clock, `setTimer`/`clearTimer` are
// setTimeout/clearTimeout, `onFire(record)` is the bridge's delivery
// callback (invoked AFTER the record is already removed and persisted, so a
// crash mid-delivery can't double-fire on restart — a lost fire is the safer
// failure than a replayed one, matching the flush-cursor-before-dispatch
// convention in lib/command-dispatch.js).
//
// Persisted shape: { nextId, timers: [{ id, convoId, roomId, fireAt, text,
// createdAt, holdAwake?, source?, repeat? }] }. IDs are bridge-global and monotonic
// so "/timer cancel 3" never races a renumbering. `holdAwake: true` marks a
// reminder whose box must NOT idle-stop before it fires (see
// keepAwakeMarker below); `source: 'agent'` marks one set by the agent
// through the reminder_* tools rather than typed as /timer — the fire path
// words the delivered turn differently so the model knows it is hearing
// its own reminder, not the user. `repeat: {kind: 'daily', hour, minute,
// tz}` marks a daily reminder (lib/daily-repeat.js): `fireAt` is always its
// NEXT occurrence, so the host's wake probe — a grep for `"fireAt"` over the
// file — sees a repeating record exactly as it sees a new one, and learns
// each re-arm from the same save.
export function createTimerStore({ load, save, now, setTimer, clearTimer, onFire, log = () => {} }) {
  const loaded = (() => {
    try {
      const raw = load();
      if (raw && Array.isArray(raw.timers)) {
        return { nextId: Number.isInteger(raw.nextId) ? raw.nextId : 1, timers: raw.timers };
      }
    } catch (e) {
      log(`timer store load failed: ${e.message}`);
    }
    return { nextId: 1, timers: [] };
  })();

  let nextId = loaded.nextId;
  let timers = loaded.timers.filter(t => t && Number.isFinite(t.fireAt) && t.convoId && typeof t.text === 'string');
  // A repeat that no longer parses degrades the record to a one-shot (see
  // normalizeRepeat) instead of dropping it or re-arming garbage.
  for (const t of timers) {
    if (t.repeat === undefined) continue;
    const repeat = normalizeRepeat(t.repeat);
    if (repeat) {
      t.repeat = repeat;
    } else {
      log(`timer #${t.id}: unreadable repeat ${JSON.stringify(t.repeat)} — it fires once and is not re-armed`);
      delete t.repeat;
    }
  }
  const handles = new Map(); // id -> setTimer handle

  // Returns whether the write landed. Most callers carry on regardless (an
  // armed-but-unpersisted /timer still fires unless the bridge restarts);
  // add({ requirePersist }) is the one that must know.
  function persist() {
    try {
      save({ nextId, timers });
      return true;
    } catch (e) {
      log(`timer store save failed: ${e.message}`);
      return false;
    }
  }

  function fire(record) {
    handles.delete(record.id);
    if (record.repeat) {
      fireRepeating(record);
      return;
    }
    timers = timers.filter(t => t.id !== record.id);
    persist();
    try {
      onFire(record);
    } catch (e) {
      log(`timer #${record.id} onFire failed: ${e.message}`);
    }
  }

  // A daily reminder coming due: deliver, THEN move the same record (same
  // id, same createdAt) on to its next occurrence, persist and re-arm it.
  // The order is the inverse of a one-shot's on purpose: a one-shot must
  // never replay, but losing a repeating record would silently end the
  // user's standing check-ins for good. Here the record never leaves the
  // file — a crash between delivery and the save leaves it on disk still due
  // at the occurrence just delivered, so the next boot's init() fires it once
  // more (after the overdue grace) and re-arms from there: a duplicate,
  // never a lost schedule.
  //
  // The next occurrence is computed from NOW, not from the fireAt just
  // served, so a record found overdue at boot (the box slept through three
  // days of 08:00s) fires once and then arms the next future 08:00 rather
  // than bursting through the backlog. Send-now does NOT come through here
  // (see fireNow): it never touches a repeating record's schedule.
  function fireRepeating(record) {
    try {
      // A snapshot: delivery is async (index.js fireTimer) and must see the
      // occurrence it is delivering, not the fireAt the re-arm writes below.
      onFire({ ...record });
    } catch (e) {
      log(`timer #${record.id} onFire failed: ${e.message}`);
    }
    // Cancelled from inside onFire: nothing to re-arm.
    if (!timers.includes(record)) return;
    const next = nextDailyOccurrence(record.repeat, now() + MIN_TIMER_MS);
    // Unreachable for a real zone (every day has the time or its gap's end),
    // but an unarmable record must not be re-armed at NaN: keep it on disk,
    // unchanged, for the next boot to try again.
    if (next === null) {
      log(`timer #${record.id}: no next occurrence for ${JSON.stringify(record.repeat)} — left as it was on disk`);
      return;
    }
    record.fireAt = next;
    // A failed save still re-arms in memory: the disk keeps the previous
    // fireAt, which a restart fires once more and re-arms (see above).
    persist();
    arm(record);
  }

  function arm(record, { minDelay = 0 } = {}) {
    const delay = Math.max(record.fireAt - now(), minDelay);
    handles.set(record.id, setTimer(() => fire(record), delay));
  }

  return {
    // Re-arm everything persisted from a previous bridge run. Only records
    // that are ALREADY overdue (came due while the bridge was down) get the
    // startup grace instead of firing synchronously — see OVERDUE_GRACE_MS.
    // Still-future records arm with their exact remaining delay, even when
    // that's shorter than the grace (Bugbot, PR #171: blanket grace made a
    // timer due 2s after restart fire 3s late).
    init() {
      for (const record of timers) {
        arm(record, { minDelay: record.fireAt <= now() ? OVERDUE_GRACE_MS : 0 });
      }
      return timers.length;
    },

    // requirePersist: the reminder_* tools sell durability ("survives a
    // restart and a VM stop"), so for them a failed save is a failed add —
    // the record is rolled back, nothing is armed, and null comes back
    // instead of a record that exists only in memory (CodeRabbit, PR #283).
    // repeat: a daily reminder's {kind, hour, minute, tz} (lib/daily-repeat.js);
    // delayMs is still the caller's, to its FIRST occurrence.
    add({ convoId, roomId, text, delayMs, holdAwake = false, source = undefined, repeat = undefined, requirePersist = false }) {
      const record = {
        id: nextId++,
        convoId,
        roomId: roomId || null,
        fireAt: now() + delayMs,
        text,
        createdAt: now(),
        // Only present when set, so records written before these fields
        // existed and plain /timer records keep the same shape on disk.
        ...(holdAwake ? { holdAwake: true } : {}),
        ...(source ? { source } : {}),
        ...(repeat ? { repeat } : {}),
      };
      timers.push(record);
      if (!persist() && requirePersist) {
        timers = timers.filter(t => t !== record);
        return null;
      }
      arm(record);
      return record;
    },

    listForConvo(convoId) {
      return timers.filter(t => t.convoId === convoId).sort((a, b) => a.fireAt - b.fireAt);
    },

    // Latest fireAt among this convo's holdAwake reminders (all convos when
    // convoId is omitted), or null when none is pending. The idle reaper
    // consults this so a session that asked to stay up for a reminder is not
    // SIGTERMed at the one-hour mark — the whole point of the hold is that
    // the work in between must not be interrupted.
    holdAwakeUntil(convoId) {
      const scope = convoId === undefined ? timers : timers.filter(t => t.convoId === convoId);
      return keepAwakeMarker(scope)?.until ?? null;
    },

    // The guest-side keep-awake marker derived from every pending reminder
    // ({until, reminders} or null) — what the save path writes, exposed so
    // index.js can rewrite the marker between saves (the idle reaper leases
    // it for work in flight, lib/work-hold.js) without forgetting the
    // reminders' own hold, including the ones init() re-armed from disk
    // that no save has seen yet.
    holdAwakeMarker() {
      return keepAwakeMarker(timers);
    },

    // Deliver a timer's message NOW instead of waiting out the delay (the
    // Send-now button). Convo-scoped like cancel(), so one conversation's
    // tap can never fire another's timer. Routes through the same fire()
    // as a natural expiry — the record is removed and persisted BEFORE
    // onFire runs, so a crash mid-delivery can't double-fire on restart.
    // A daily reminder is a pure extra delivery: the record, its armed
    // handle and the file are left exactly as they were, so the next
    // occurrence never moves — not even for a tap seconds before it, which
    // then delivers twice, seconds apart. The alternative (routing through
    // fireRepeating) re-arms from now + MIN_TIMER_MS, and a tap within that
    // window of the occurrence would silently push it to tomorrow. Returns
    // the fired record, or null when nothing matched (already
    // fired/cancelled).
    fireNow(convoId, id) {
      const record = timers.find(t => t.convoId === convoId && t.id === id);
      if (!record) return null;
      if (record.repeat) {
        try {
          onFire({ ...record });
        } catch (e) {
          log(`timer #${record.id} onFire failed: ${e.message}`);
        }
        return record;
      }
      const handle = handles.get(record.id);
      if (handle !== undefined) clearTimer(handle);
      fire(record);
      return record;
    },

    // which: numeric id or 'all' (scoped to the convo either way, so one
    // conversation's cancel can never reach into another's timers). Returns
    // the cancelled records ([] when nothing matched).
    cancel(convoId, which) {
      const match = t => t.convoId === convoId && (which === 'all' || t.id === which);
      const cancelled = timers.filter(match);
      if (!cancelled.length) return [];
      timers = timers.filter(t => !match(t));
      for (const record of cancelled) {
        const handle = handles.get(record.id);
        if (handle !== undefined) clearTimer(handle);
        handles.delete(record.id);
      }
      persist();
      return cancelled;
    },
  };
}

// The guest-side keep-awake marker derived from the persisted timers: the
// host's vm-idle-stop probe reads ~/.matron-bridge-keepawake.json
// ({until: epoch-ms}) alongside ~/.matron-bridge-timers.json and treats an
// unexpired `until` as activity, so the box is not wound down while a
// hold-awake reminder is pending. Returns null when no such reminder exists
// (the caller removes the file), otherwise the latest fireAt plus the count.
// Pure and grep-friendly by design: the probe runs as root inside the guest
// with nothing but sh, so the field must be a bare integer.
// A repeating record never counts: its fireAt is always in the future, so a
// hold would keep the box up for good. reminder_create refuses the pair;
// this is the store-side backstop for a record that carries it anyway.
export function keepAwakeMarker(timers) {
  const holds = (timers || []).filter(t => t && t.holdAwake && !t.repeat && Number.isFinite(t.fireAt));
  if (!holds.length) return null;
  return { until: Math.max(...holds.map(t => t.fireAt)), reminders: holds.length };
}
