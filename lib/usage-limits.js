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
const LINE_RE = /^Current\s+(.+?):\s*(\d+)%\s+used\b.*?\bresets\s+(.+?)\s*$/i;

// "Jul 9, 12:59am (UTC)" or "Jul 15 at 12:19am (Europe/London)" -> ISO-8601
// string, or null when the text doesn't match the formats claude prints (the
// separator changed from "," to " at" and the zone from UTC to the machine's
// IANA zone around mid-2026; both are accepted). The source has no year:
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
const RESETS_AT_RE = /^([A-Za-z]{3})\s+(\d{1,2})(?:,|\s+at)\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)$/i;

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
  const minute = parseInt(m[4], 10);
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
//   "session"            -> "session_5h"
//   "week (all models)"  -> "week_all"
//   "week (Fable)"       -> "week_fable"
//   "week (Sonnet 5)"    -> "week_sonnet_5"
//   "week (<anything>)"  -> "week_<slug>" (or "week_other" if empty)
export function deriveLimitId(rawLabel) {
  const label = String(rawLabel ?? '').trim().toLowerCase();
  const slug = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (label.startsWith('session')) return 'session_5h';
  if (label.startsWith('week')) {
    const paren = label.match(/\(([^)]*)\)/);
    const inner = paren ? paren[1].trim() : '';
    if (inner === 'all models') return 'week_all';
    const s = slug(inner);
    return s ? `week_${s}` : 'week_other';
  }
  return slug(label) || 'week_other';
}

// Turn the raw `/usage` text into structured headline lines. Returns
// { ok, lines } where each line is { id, label, percent, resets, resets_at }.
// ok is false (and lines empty) when no headline lines are found — the caller
// then falls back to posting the raw text. `id` is a stable machine key (see
// deriveLimitId); `label` stays the human string; `resets_at` is epoch ms (a
// number, omitted when the reset text doesn't parse).
export function parseUsageLimits(rawText, now = new Date()) {
  const lines = [];
  for (const line of String(rawText ?? '').split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const rawLabel = m[1].trim();
    const resets = m[3].trim();
    const entry = {
      // Stable machine key derived from the raw label; clients render off this
      // rather than the wording, which drifts across Claude Code versions.
      id: deriveLimitId(rawLabel),
      // Strip the "Current " prefix (already dropped by the regex) and
      // uppercase the first character: "session" -> "Session",
      // "week (all models)" -> "Week (all models)". No model name hardcoded.
      label: rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1),
      percent: parseInt(m[2], 10),
      resets,
    };
    // Epoch ms (number), not ISO — clients drive live countdowns off it. Omit
    // (never null) when the reset text is unparseable.
    const resetMs = resetsAtMs(resets, now);
    if (resetMs !== null) entry.resets_at = resetMs;
    lines.push(entry);
  }
  return { ok: lines.length > 0, lines };
}

// Build the Matrix message. Returns { plain, html }. When parsed.ok is false,
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

  const plainLines = parsed.lines.map(
    (l) => `${l.label}: ${l.percent}% · resets ${l.resets}`,
  );
  const htmlLines = parsed.lines.map(
    (l) => `${escapeHtml(l.label)}: ${color(`${l.percent}%`, percentColor(l.percent))} · resets ${escapeHtml(l.resets)}`,
  );

  return {
    plain: `📊 Subscription Usage\n\n${plainLines.join('\n')}`,
    html: `<b>📊 Subscription Usage</b><br/><br/>${htmlLines.join('<br/>')}`,
  };
}
