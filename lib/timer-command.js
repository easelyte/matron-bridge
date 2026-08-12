// /timer command handling — schedule a message to be (re)sent into a
// session's convo after a delay: `/timer 2h hey what's up` routes
// "hey what's up" through the normal input path two hours later, exactly as
// if the user had typed it then; `/timer 2h /compact` types /compact into
// the TUI at fire time the same way.
//
// Two halves, both pure/injected so they're unit-testable without a bridge:
//  - parsing (parseDuration / parseTimerCommand / formatDuration), mirroring
//    the lib/effort-command.js style of "validate here, act in index.js";
//  - createTimerStore, a file-backed scheduler with every impure edge
//    injected (load/save/now/setTimeout/clearTimeout/onFire). Timers are
//    persisted on every mutation and re-armed via init() on bridge startup,
//    so they survive BOTH the idle reaper (which only kills the claude
//    process — the bridge, and thus the armed setTimeout, stays up; the
//    fire path auto-resumes the reaped session like any other inbound
//    message would) AND full bridge restarts (where init() re-arms from
//    disk, firing anything that came due while the bridge was down).

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
//   { kind: 'set', delayMs, message }      — /timer <duration> <message>
//   { kind: 'error', message }             — anything else, with a hint
// `rest` keeps the user's original spacing so the scheduled message is sent
// verbatim (parts-splitting would collapse internal whitespace).
export function parseTimerCommand(rest) {
  const trimmed = String(rest ?? '').trim();
  if (!trimmed) return { kind: 'list' };

  const [first] = trimmed.split(/\s+/);
  if (first.toLowerCase() === 'cancel') {
    const arg = trimmed.slice(first.length).trim().toLowerCase();
    if (!arg || arg === 'all') return { kind: 'cancel', which: 'all' };
    if (/^#?\d+$/.test(arg)) return { kind: 'cancel', which: parseInt(arg.replace('#', ''), 10) };
    return { kind: 'error', message: 'Usage: /timer cancel [<id>|all]' };
  }

  const delayMs = parseDuration(first);
  if (delayMs === null) {
    return { kind: 'error', message: `"${first}" isn't a duration. Use e.g. 30s, 10m, 2h, 1d, 1h30m: /timer 2h <message>` };
  }
  if (delayMs < MIN_TIMER_MS) {
    return { kind: 'error', message: `Timer too short — minimum is ${formatDuration(MIN_TIMER_MS)}.` };
  }
  if (delayMs > MAX_TIMER_MS) {
    return { kind: 'error', message: `Timer too long — maximum is ${formatDuration(MAX_TIMER_MS)}.` };
  }
  const message = trimmed.slice(first.length).trim();
  if (!message) {
    return { kind: 'error', message: 'Nothing to send. Usage: /timer <duration> <message>' };
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
// createdAt }] }. IDs are bridge-global and monotonic so "/timer cancel 3"
// never races a renumbering.
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
  const handles = new Map(); // id -> setTimer handle

  function persist() {
    try {
      save({ nextId, timers });
    } catch (e) {
      log(`timer store save failed: ${e.message}`);
    }
  }

  function fire(record) {
    handles.delete(record.id);
    timers = timers.filter(t => t.id !== record.id);
    persist();
    try {
      onFire(record);
    } catch (e) {
      log(`timer #${record.id} onFire failed: ${e.message}`);
    }
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

    add({ convoId, roomId, text, delayMs }) {
      const record = {
        id: nextId++,
        convoId,
        roomId: roomId || null,
        fireAt: now() + delayMs,
        text,
        createdAt: now(),
      };
      timers.push(record);
      persist();
      arm(record);
      return record;
    },

    listForConvo(convoId) {
      return timers.filter(t => t.convoId === convoId).sort((a, b) => a.fireAt - b.fireAt);
    },

    // Deliver a timer's message NOW instead of waiting out the delay (the
    // Send-now button). Convo-scoped like cancel(), so one conversation's
    // tap can never fire another's timer. Routes through the same fire()
    // as a natural expiry — the record is removed and persisted BEFORE
    // onFire runs, so a crash mid-delivery can't double-fire on restart.
    // Returns the fired record, or null when nothing matched (already
    // fired/cancelled).
    fireNow(convoId, id) {
      const record = timers.find(t => t.convoId === convoId && t.id === id);
      if (!record) return null;
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
