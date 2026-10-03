// Fable-limit fallback for fresh starts (mission: spawns default to Opus on
// a box that is out of Fable). A spawn with no `model` runs the box default
// — Fable on the fleet — and on a box whose Fable weekly meter is spent the
// new session stalls on its very first turn. When the caller named no model,
// the box default is Fable, the box's latest /usage reading shows the Fable
// weekly meter at FABLE_MAXED_PERCENT or more, and the all-models weekly
// meter still has room, the session starts on Opus instead.
//
// Pure: the reading comes from index.js's usageLimitsCache (lines shaped by
// lib/usage-limits.js parseUsageLimits). matron-journal src/spawn-model.js
// mirrors fableMaxed() to predict the same answer on the consent card from
// the box's last box_status report — keep the two in step.

export const FALLBACK_MODEL = 'opus';
export const FALLBACK_REASON_FABLE_LIMIT = 'fable_limit';
// "≥ ~99%": /usage rounds, and a meter showing 99% is out within minutes of
// a session's first turn.
export const FABLE_MAXED_PERCENT = 99;

// A meter whose reset time has already passed is not a reading of now: the
// cache may be hours old on a box that slept through the reset.
function liveLine(line, nowMs) {
  if (!line || !Number.isFinite(line.percent)) return false;
  if (typeof line.resets_at === 'string') {
    const at = Date.parse(line.resets_at);
    if (Number.isFinite(at) && at <= nowMs) return false;
  }
  return true;
}

// 'week_fable' today; deriveLimitId slugs the label, so a relabel to
// "Fable 5" arrives as 'week_fable_5'.
const isFableWeek = (id) => typeof id === 'string' && (id === 'week_fable' || id.startsWith('week_fable_'));

// True when the Fable weekly meter is spent and a live all-models reading
// shows room. No all-models reading (absent, or past its reset) is no
// evidence of room, so no fallback; an absent Fable line reads as not
// maxed.
export function fableMaxed(lines, nowMs = Date.now()) {
  if (!Array.isArray(lines)) return false;
  const fable = lines.find((l) => l && isFableWeek(l.id) && liveLine(l, nowMs));
  if (!fable || fable.percent < FABLE_MAXED_PERCENT) return false;
  const all = lines.find((l) => l && l.id === 'week_all' && liveLine(l, nowMs));
  return !!all && all.percent < 100;
}

// The box default, normalised by index.js (alias or full claude-* name).
export function isFableModel(model) {
  if (typeof model !== 'string') return false;
  const m = model.toLowerCase();
  return m === 'fable' || m.startsWith('fable[') || m.startsWith('claude-fable');
}

// {model, reason} to start on instead of the box default, or null. Only
// for a start that named no model — an explicit pick always wins, and the
// caller does not ask otherwise.
export function spawnModelFallback({ defaultModel, lines, nowMs = Date.now() }) {
  if (!isFableModel(defaultModel)) return null;
  if (!fableMaxed(lines, nowMs)) return null;
  return { model: FALLBACK_MODEL, reason: FALLBACK_REASON_FABLE_LIMIT };
}

// Stalled-session fallback (Dan, on the mission's open question: "bridge
// switches automatically"). A session that stalls on its Fable limit with
// the weekly reset far off moves to Opus and carries on, instead of
// sitting until the reset or waiting for the Coordinator. Not for a reset
// that is near — a few hours' wait keeps the session on the model it was
// on — and not when the 5-hour session meter is the one that is full: it
// covers every model, so Opus would stall the same.
export const STALL_SWITCH_MIN_RESET_MS = 12 * 60 * 60 * 1000;

const findLive = (lines, pred, nowMs) => (Array.isArray(lines) ? lines.find((l) => l && pred(l.id) && liveLine(l, nowMs)) : undefined);

// {model, reason, resetsAt} to switch the stalled session to, or null.
// `model` is the model the session stalled on (the stall's, else the
// session's current one). The reading must postdate the stall — the caller
// decides on the forced refresh the stall triggers.
export function stallModelFallback({ stall, model, lines, nowMs = Date.now(), minResetMs = STALL_SWITCH_MIN_RESET_MS }) {
  if (!stall || stall.kind !== 'usage_limit') return null;
  if (!isFableModel(stall.model || model)) return null;
  if (!fableMaxed(lines, nowMs)) return null;
  const session = findLive(lines, (id) => id === 'session', nowMs);
  if (session && session.percent >= 100) return null;
  const fable = findLive(lines, isFableWeek, nowMs);
  const resetMs = typeof fable?.resets_at === 'string' ? Date.parse(fable.resets_at) : NaN;
  // No reset time: a spent weekly meter with no date to wait for.
  if (Number.isFinite(resetMs) && resetMs - nowMs < minResetMs) return null;
  return {
    model: FALLBACK_MODEL,
    reason: FALLBACK_REASON_FABLE_LIMIT,
    ...(Number.isFinite(resetMs) ? { resetsAt: new Date(resetMs).toISOString() } : {}),
  };
}
