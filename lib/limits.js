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
