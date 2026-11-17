// Pure parsing/formatting for the /limits command. The bridge shells out to
// `claude -p "/usage" --output-format text` (I/O lives in index.js) and feeds
// the stdout here. Kept side-effect-free so it is unit-testable without
// spawning a claude process. Mirrors lib/model-command.js / lib/session-mode.js.

// Percent thresholds reuse the color idiom from index.js (/cost, /usage):
// green under half, orange approaching the limit, red at/over 80%.
const GREEN = '#3fb950';
const ORANGE = '#f0883e';
const RED = '#f85149';

function percentColor(p) {
  if (p < 50) return GREEN;
  if (p < 80) return ORANGE;
  return RED;
}

// Local copies of index.js's helpers so this module has no import cycle.
// Keep the "-escaping in sync with index.js's escapeHtml: output here only
// lands in element content today (no linkifier or attribute sink in this
// module), but escaping quotes keeps the helper safe if that changes.
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function color(text, hex) {
  return `<font color="${hex}">${text}</font>`;
}

// Matches e.g. "Current session: 39% used · resets Jul 9, 12:59am (UTC)" and
// "Current week (all models): 66% used · resets ...". The separator between
// "used" and "resets" varies (a middot in practice), so match loosely on the
// "resets" keyword rather than the punctuation.
//
// The resets clause is OPTIONAL: Claude prints zero-usage weekly lines as
// "Current week (Fable): 0% used" with no "· resets …" tail. The trailing
// "(?:.*?\bresets\s+(.+?))?" keeps the id/label/percent for such lines and
// leaves capture group 3 undefined; the caller then omits resets/resets_at
// rather than emitting null. The inner ".*?" stays lazy so the with-resets
// case still captures the reset text unchanged.
const LINE_RE = /^Current\s+(.+?):\s*(\d+)%\s+used\b(?:.*?\bresets\s+(.+?))?\s*$/i;

// "Jul 9, 12:59am (UTC)" or "Jul 15 at 12:19am (Europe/London)" -> ISO-8601
// string, or null when the text doesn't match the formats claude prints (the
// separator changed from "," to " at" and the zone from UTC to the machine's
// IANA zone around mid-2026; both are accepted). Minutes are optional:
// on-the-hour resets print as "Aug 20 at 10am", not "10:00am" — weekly lines
// do this routinely, and requiring ":MM" silently dropped resets_at for
// exactly those lines (clients then showed no reset date). The source has no
// year:
// Claude usage limits reset at most weekly, so try each of the years
// [Y-1, Y, Y+1] (Y = `now`'s UTC full year) and accept the first candidate
// that lands within [now - 24h, now + 8d]. The 24h past tolerance absorbs
// clock skew and a just-elapsed reset; the 8-day future horizon covers weekly
// limits with slack. This also fixes Dec->Jan rollover (Y-1 catches "Dec 31"
// read just after midnight on Jan 1). No candidate qualifying means the text
// is stale or malformed, so we fail open and return null. `now` is injected
// for testability.
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const RESETS_AT_RE = /^([A-Za-z]{3})\s+(\d{1,2})(?:,|\s+at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i;

// Only UTC and Area/Location IANA ids — Intl also accepts legacy
// abbreviations like "PST" whose DST semantics are murky; fail open on those
// (the client then shows the raw text, same as any other parse failure).
function isSupportedZone(zone) {
  if (zone !== 'UTC' && !zone.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The zone's UTC offset (ms) at the instant `ms`: format the instant in the
// zone, re-encode that wall-clock reading as UTC, and diff.
function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

// UTC ms for the wall-clock time y/month/day hour:minute in `timeZone`.
// Guess-and-correct: start from the UTC encoding, subtract the offset at the
// guess, re-check once — the second pass settles across a DST boundary.
function zonedTimeToUtcMs(y, month, day, hour, minute, timeZone) {
  const wallMs = Date.UTC(y, month, day, hour, minute);
  let ms = wallMs;
  for (let i = 0; i < 2; i++) ms = wallMs - zoneOffsetMs(ms, timeZone);
  return ms;
}

// Same parse as parseResetsAt but returns the epoch-ms number (or null). This
// is the primitive; parseResetsAt wraps it into an ISO string for any
// text-facing consumer, while the status frame carries the raw number so
// clients can do live countdowns without re-parsing a timezone.
export function resetsAtMs(resetsText, now = new Date()) {
  const m = String(resetsText ?? '').trim().match(RESETS_AT_RE);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2], 10);
  // Group 4 is undefined for on-the-hour text like "10am".
  const minute = m[4] === undefined ? 0 : parseInt(m[4], 10);
  let hour = parseInt(m[3], 10) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  if (day < 1 || day > 31 || minute > 59 || hour > 23) return null;
  const zone = m[6].trim();
  if (!isSupportedZone(zone)) return null;
  const nowMs = now.getTime();
  const minMs = nowMs - 24 * 60 * 60 * 1000;
  const maxMs = nowMs + 8 * 24 * 60 * 60 * 1000;
  const year = now.getUTCFullYear();
  for (const y of [year - 1, year, year + 1]) {
    const candidateMs = zonedTimeToUtcMs(y, month, day, hour, minute, zone);
    if (candidateMs >= minMs && candidateMs <= maxMs) {
      return candidateMs;
    }
  }
  return null;
}

export function parseResetsAt(resetsText, now = new Date()) {
  const ms = resetsAtMs(resetsText, now);
  return ms === null ? null : new Date(ms).toISOString();
}

// Derive a stable machine id from the raw usage label (the text between
// "Current " and ":"). Clients key off this instead of the human label, which
// changes wording across Claude Code versions. Never throws; anything
// unrecognised falls back to a slug or "week_other".
//   "session"            -> "session"
//   "week (all models)"  -> "week_all"
//   "week all models"    -> "week_all"   (same semantic, parens dropped)
//   "week (Fable)"       -> "week_fable"
//   "week (Sonnet 5)"    -> "week_sonnet_5"
//   "week (<anything>)"  -> "week_<slug>" (or "week_other" if empty)
// The session id is plain "session": the parsed text says only "session", never
// "5h", so baking a "5h" window guess into a "stable" id would be an
// unverifiable claim clients might persist against.
//
// WIRE CONTRACT — model-named weekly ids track the LABEL: the descriptor is
// slugged straight from Claude's wording, so a label change renames the id too
// (a relabel "Fable" -> "Fable 5" turns "week_fable" into "week_fable_5").
// Clients MUST NOT persist durable state keyed on "week_<slug>" — treat these
// ids as stable only WITHIN a single /usage response, not across relabels.
//
// The weekly descriptor is taken from the parenthetical when present, else from
// the suffix after "week", then normalized the SAME way regardless of parens so
// wording drift can't fork one semantic into two ids. Known semantic variants
// are canonicalized BEFORE generic slugging: an "all models" descriptor (with or
// without parentheses) always yields "week_all" (previously "week all models"
// slugged to "week_all_models" and contradicted the parenthesized "week_all").
export function deriveLimitId(rawLabel) {
  const label = String(rawLabel ?? '').trim().toLowerCase();
  const slug = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (label.startsWith('session')) return 'session';
  if (label.startsWith('week')) {
    const paren = label.match(/\(([^)]*)\)/);
    const descriptor = (paren ? paren[1] : label.slice('week'.length)).trim();
    // Canonicalize known semantic variants before generic slugging.
    if (descriptor === 'all models') return 'week_all';
    const s = slug(descriptor);
    return s ? `week_${s}` : 'week_other';
  }
  return slug(label) || 'week_other';
}

// Short, stable, order-independent hash of a string -> base36 (FNV-1a, 32-bit).
// Used to disambiguate two rows that derive the same base id: keying the suffix
// on the FULL normalized label (not first-seen order) means the same label
// always maps to the same id, so reordering the rows can't swap their meanings.
// No deps / no crypto import — deterministic pure arithmetic.
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Turn the raw `/usage` text into structured headline lines. Returns
// { ok, lines } where each line is { id, label, percent, resets?, resets_at? }.
// ok is false (and lines empty) when no headline lines are found — the caller
// then falls back to posting the raw text. `id` is a stable machine key (see
// deriveLimitId, deduped within the response); `label` stays the human string.
//
// WIRE CONTRACT — resets/resets_at are OPTIONAL. They were regex-GUARANTEED
// present before, but Claude now prints zero-usage weekly lines with no
// "· resets …" tail ("Current week (Fable): 0% used"), so a line may carry
// only { id, label, percent }. A decoder MUST treat both as optional (both are
// OMITTED, never null, when the reset text is absent or unparseable). resets_at
// is the ISO-8601 STRING form of resets, present only when resets parses. (An
// earlier revision carried a resets_at_ms epoch sibling; it was dropped as
// redundant — resets_at_ms === Date.parse(resets_at) for every emittable line,
// so clients derive the epoch from resets_at when they need a countdown.)
export function parseUsageLimits(rawText, now = new Date()) {
  // First pass: parse every headline line, capturing its base machine id and the
  // full normalized raw label that id was derived from.
  const parsed = [];
  for (const line of String(rawText ?? '').split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const rawLabel = m[1].trim();
    parsed.push({
      baseId: deriveLimitId(rawLabel),
      normLabel: rawLabel.toLowerCase(),
      rawLabel,
      percent: parseInt(m[2], 10),
      // Group 3 is undefined for a line with no resets clause (e.g.
      // "Current week (Fable): 0% used"). Keep resets undefined then and omit
      // the resets/resets_at keys entirely (never emit null).
      resets: m[3] === undefined ? undefined : m[3].trim(),
    });
  }

  // Count base-id occurrences so disambiguation depends only on the SET of rows,
  // never their order. A base id shared by 2+ rows is disambiguated by a stable
  // hash of each row's full normalized label, so the same label always maps to
  // the same id regardless of position (reordering can't swap two rows' ids).
  const baseCounts = new Map();
  for (const p of parsed) baseCounts.set(p.baseId, (baseCounts.get(p.baseId) || 0) + 1);

  const seenIds = new Set();
  const lines = [];
  for (const p of parsed) {
    // Stable machine key: clients render off this rather than the wording, which
    // drifts across Claude Code versions. Bare base id when it is unique in this
    // response; label-hash suffix when it collides.
    let id = p.baseId;
    if (baseCounts.get(p.baseId) > 1) {
      id = `${p.baseId}_${shortHash(p.normLabel)}`;
      // Truly identical labels hash identically and are genuinely
      // indistinguishable; only for those does a positional counter break the
      // remaining tie (uniqueness preserved without reintroducing order-swaps
      // between DISTINCT labels).
      let candidate = id;
      let n = 2;
      while (seenIds.has(candidate)) { candidate = `${id}_${n}`; n += 1; }
      id = candidate;
    }
    seenIds.add(id);
    const entry = {
      id,
      // Strip the "Current " prefix (already dropped by the regex) and uppercase
      // the first character: "session" -> "Session", "week (all models)" ->
      // "Week (all models)". No model name hardcoded.
      label: p.rawLabel.charAt(0).toUpperCase() + p.rawLabel.slice(1),
      percent: p.percent,
    };
    // resets_at is the ISO-8601 string form of resets. Both are present only
    // when a resets clause exists AND parses; otherwise both omitted (never
    // null). Clients derive an epoch from Date.parse(resets_at) for countdowns.
    if (p.resets !== undefined) {
      entry.resets = p.resets;
      const resetMs = resetsAtMs(p.resets, now);
      if (resetMs !== null) {
        entry.resets_at = new Date(resetMs).toISOString();
      }
    }
    lines.push(entry);
  }
  return { ok: lines.length > 0, lines };
}

// Build the chat message. Returns { plain, html }. When parsed.ok is false,
// falls back to the raw text verbatim so the command degrades visibly (e.g.
// API-key accounts, login-required, or a future output-format change) instead
// of silently showing nothing.
export function formatLimits(parsed, rawText) {
  if (!parsed || !parsed.ok) {
    const raw = String(rawText ?? '').trim();
    return {
      plain: raw || 'No usage information available.',
      html: escapeHtml(raw || 'No usage information available.').replace(/\n/g, '<br/>'),
    };
  }

  // A line with no resets clause (e.g. "Current week (Fable): 0% used") has no
  // `resets`; drop the "· resets …" tail for it rather than printing "undefined".
  const plainLines = parsed.lines.map(
    (l) => (l.resets === undefined
      ? `${l.label}: ${l.percent}%`
      : `${l.label}: ${l.percent}% · resets ${l.resets}`),
  );
  const htmlLines = parsed.lines.map(
    (l) => (l.resets === undefined
      ? `${escapeHtml(l.label)}: ${color(`${l.percent}%`, percentColor(l.percent))}`
      : `${escapeHtml(l.label)}: ${color(`${l.percent}%`, percentColor(l.percent))} · resets ${escapeHtml(l.resets)}`),
  );

  return {
    plain: `📊 Subscription Usage\n\n${plainLines.join('\n')}`,
    html: `<b>📊 Subscription Usage</b><br/><br/>${htmlLines.join('<br/>')}`,
  };
}

// One line saying why a `/usage` refresh produced no limits: the error, or
// the first line of what Claude printed (which still names the account
// type, e.g. "You are currently using your subscription…", when the limit
// lines themselves are missing). Never more than one line of 200 chars.
export function usageMissNote({ raw, error } = {}) {
  if (error) return `failed: ${String(error.message || error).split('\n')[0].slice(0, 200)}`;
  const first = String(raw ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return first ? `no limit lines in /usage output (it began: ${first.slice(0, 200)})` : 'empty /usage output';
}

// Logs a refresh that produced no limits once per streak, so an outage is
// visible in the bridge's journal without a line every LIMITS_REFRESH_MS.
// Before this, a box whose `claude -p /usage` printed no limit lines
// (e.g. with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set)
// reported none to the journal and logged nothing unless DEBUG was set.
export function createUsageMissLogger(log) {
  let missing = false;
  return {
    ok() {
      if (missing) log('Usage limits: /usage reports limits again');
      missing = false;
    },
    miss(outcome) {
      if (!missing) log(`Usage limits: ${usageMissNote(outcome)}`);
      missing = true;
    },
  };
}

// How long the `claude -p "/usage"` one-shot may run before it is killed.
// Claude Code's /usage also scans the local session transcripts, so it slows
// as sessions pile up on a box: about 50 s with a few hundred of them. The
// old fixed 30 s killed it there and the account meters silently disappeared.
// USAGE_FETCH_TIMEOUT_MS overrides the default; anything that is not a whole
// number of milliseconds of at least one second falls back to it.
export const DEFAULT_USAGE_FETCH_TIMEOUT_MS = 180_000;
export function usageFetchTimeoutMs(env = process.env) {
  const raw = String(env.USAGE_FETCH_TIMEOUT_MS ?? '').trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1000 ? n : DEFAULT_USAGE_FETCH_TIMEOUT_MS;
}
