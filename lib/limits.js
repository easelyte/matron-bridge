export const DEFAULT_THRESHOLDS = [50, 85, 95];

export function parseThresholds(raw, log) {
  // Return a fresh copy of the defaults on fallback so a caller mutating the result can't
  // corrupt the shared DEFAULT_THRESHOLDS constant (T-1.1 quality review).
  if (!raw || !String(raw).trim()) return [...DEFAULT_THRESHOLDS];
  const parts = String(raw).split(',').map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0 || n > 100)) {
    log.warn(`[limits] BRIDGE_LIMITS_THRESHOLDS invalid (${raw}); using defaults ${DEFAULT_THRESHOLDS.join(',')}`);
    return [...DEFAULT_THRESHOLDS];
  }
  return [...new Set(parts)].sort((a, b) => a - b);
}

export function parseIntEnv(raw, { name, def, min, allowDisableSentinel = false }, log) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (raw !== undefined && String(raw).trim() !== '') {
      log.warn(`[limits] ${name} not a number (${raw}); using default ${def}`);
    }
    return def;
  }
  if (allowDisableSentinel && n <= 0) return 0;
  if (n < min) {
    log.warn(`[limits] ${name} below min ${min} (${n}); using default ${def}`);
    return def;
  }
  return n;
}

function highestAtOrBelow(util, thresholds) {
  let t = 0;
  for (const th of thresholds) if (util >= th && th > t) t = th;
  return t;
}

export function evaluateWindow({ utilization, prev, thresholds }) {
  // First poll after (re)start: seed silently to whatever tier util already sits at.
  if (prev.isFirstPoll) {
    return { nextState: { tier: highestAtOrBelow(utilization, thresholds), isFirstPoll: false }, crossedTier: null };
  }

  // Rising edge: highest threshold strictly above the stored tier that util now meets.
  let crossed = null;
  for (const th of thresholds) if (th > prev.tier && utilization >= th && (crossed === null || th > crossed)) crossed = th;
  if (crossed !== null) {
    return { nextState: { tier: crossed, isFirstPoll: false }, crossedTier: crossed };
  }

  // Drop-below re-arm (no emit) or steady.
  const rearmed = highestAtOrBelow(utilization, thresholds);
  const tier = rearmed < prev.tier ? rearmed : prev.tier;
  return { nextState: { tier, isFirstPoll: false }, crossedTier: null };
}
