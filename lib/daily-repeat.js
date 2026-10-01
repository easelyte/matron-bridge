// Daily repeating reminders: the wall-clock maths behind reminder_create's
// `repeat: "daily"` + `tz` (lib/reminder-tools.js) and the store's re-arm
// after each fire (lib/timer-command.js createTimerStore).
//
// A daily reminder is a wall-clock time in a named IANA zone — "08:00
// Europe/London" — not a 24-hour interval: across a clock change the gap
// between two fires is 23 or 25 hours, and 08:00 stays 08:00 on the user's
// clock in both BST and GMT. The box's own zone is irrelevant once `tz` is
// resolved (dev boxes run UTC; the user usually does not), so everything
// here is computed from Intl in the named zone, never from Date's local-time
// setters the way parseClockTime does for a one-shot `at`.
//
// Pure: every function takes the instant it reasons about; no clock reads.

const DAY_MS = 24 * 3600 * 1000;

// One formatter per zone — constructing Intl.DateTimeFormat is the expensive
// part, and a store only ever sees a handful of zones.
const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

// The wall clock in `tz` at instant `t`, as numbers (month 1-12).
function wallAt(t, tz) {
  const out = {};
  for (const { type, value } of formatterFor(tz).formatToParts(t)) {
    if (type !== 'literal') out[type] = parseInt(value, 10);
  }
  return out;
}

// `tz`'s UTC offset at instant `t`, in ms (BST = +3600000). Whole seconds:
// the wall clock has no finer grain.
function offsetAt(t, tz) {
  const w = wallAt(t, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

function sameWallMinute(t, tz, y, mo, d, h, mi) {
  const w = wallAt(t, tz);
  return w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi;
}

// The instant the wall clock in `tz` reads y-mo-d h:mi. `d` may overflow the
// month (Date.UTC normalises it), which is how the caller steps a day.
//
// The two offsets in force either side of that day are the only candidates
// (zones change at most once in a 48-hour window):
//   - one reads back as the wanted wall time — the ordinary case;
//   - both do — the fall-back hour, which happens twice. The FIRST (earlier)
//     instant wins, and the caller's `notBefore` then moves on to the next
//     day, so a time inside the repeated hour fires once, not twice;
//   - neither does — the spring-forward gap, where that wall time never
//     happens. It resolves to the next valid instant: the moment the clocks
//     jump, found by bisecting between the two candidates. 01:30 London on
//     29 March 2026 fires at 02:00 BST (01:00Z). This is deliberately not
//     Temporal's "compatible" choice (02:30, shifted by the gap length): a
//     check-in due "at 01:30" should come as soon as the day allows, not an
//     hour past it.
function wallTimeToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const n = new Date(guess);
  const [ny, nmo, nd] = [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()];
  const before = offsetAt(guess - DAY_MS, tz);
  const after = offsetAt(guess + DAY_MS, tz);
  const candidates = [...new Set([guess - before, guess - after])]
    .filter(t => sameWallMinute(t, tz, ny, nmo, nd, h, mi));
  if (candidates.length) return Math.min(...candidates);
  // The gap: `guess - after` is still on the old offset, `guess - before`
  // already on the new one. Bisect to the first instant on the new offset.
  let lo = guess - after;
  let hi = guess - before;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, tz) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

// The first occurrence of `hour:minute` in `tz` at or after `notBefore`
// (epoch ms). The store passes now + MIN_TIMER_MS, the same "closer than
// the minimum rolls to tomorrow" rule parseClockTime applies to a one-shot —
// which is also what makes a fire land on TOMORROW'S occurrence even if the
// timer ran a millisecond early. Starts from the zone's own calendar day of
// `notBefore` (not UTC's), and never needs more than the next day; the third
// iteration is headroom for a zone whose gap swallows local midnight.
export function nextDailyOccurrence({ hour, minute, tz }, notBefore) {
  const w = wallAt(notBefore, tz);
  for (let i = 0; i < 3; i++) {
    const t = wallTimeToInstant(w.year, w.month, w.day + i, hour, minute, tz);
    if (t >= notBefore) return t;
  }
  return null;
}

// A tool-supplied zone name -> its canonical IANA spelling ("europe/london"
// -> "Europe/London"), or null when Intl does not know it. Fixed offsets
// ("+01:00", which Node's Intl accepts) are refused: they never change with
// the seasons, which is the one thing `tz` is for.
export function resolveTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone;
    return /^[+-]/.test(name) ? null : name;
  } catch {
    return null;
  }
}

// The box's own zone — the default when reminder_create gets no `tz`.
// Resolved once at create time and stored by name, so the reminder does not
// drift if the box's zone is changed later, and the list can say which zone
// "08:00" is in.
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// A persisted repeat -> itself when well-formed, else null. The store runs
// every loaded record through this; a record whose repeat no longer parses
// (hand-edited, or a zone a later ICU dropped) is kept as a one-shot rather
// than dropped — it still fires once, it just does not come back.
export function normalizeRepeat(raw) {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'daily') return null;
  const { hour, minute, tz } = raw;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (resolveTimeZone(tz) !== tz) return null;
  return { kind: 'daily', hour, minute, tz };
}

const pad2 = (n) => String(n).padStart(2, '0');

// "HH:MM" — the 24-hour form the tool result and the list both use.
export function formatRepeatTime({ hour, minute }) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

// "daily at 08:00 Europe/London" — the phrase every surface (the tool
// result, reminder_list, /timer, the chat card) uses for a repeating record.
export function formatRepeat(repeat) {
  return `daily at ${formatRepeatTime(repeat)} ${repeat.tz}`;
}
