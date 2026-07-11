import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export const DEFAULT_THRESHOLDS = [50, 85, 95];

export class LimitsFetchError extends Error {
  constructor(message, { status = null, malformedBody = false } = {}) {
    super(message);
    this.name = 'LimitsFetchError';
    this.status = status;
    this.malformedBody = malformedBody;
  }
}

export function readOAuthToken({ credsPath } = {}) {
  let p = credsPath || path.join(os.homedir(), '.claude', '.credentials.json');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1).replace(/^[/\\]/, ''));
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : null;
  } catch {
    return null;
  }
}

function normWindow(obj) {
  const u = obj && typeof obj.utilization === 'number' ? obj.utilization : null;
  const r = obj && typeof obj.resets_at === 'string' ? obj.resets_at : null;
  return { utilization: u, resetsAt: r };
}

export function usableWindowCount({ fiveHour, sevenDay }) {
  return (fiveHour.utilization !== null ? 1 : 0) + (sevenDay.utilization !== null ? 1 : 0);
}

export async function fetchUsage({ token, fetchImpl = fetch, timeoutMs = 10000 }) {
  // Bound hung requests so the poller can classify the rejection and retry later.
  const res = await fetchImpl(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) throw new LimitsFetchError(`usage endpoint returned ${res.status}`, { status: res.status });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new LimitsFetchError('usage endpoint returned non-JSON body', { status: 200, malformedBody: true });
  }
  return { fiveHour: normWindow(body?.five_hour), sevenDay: normWindow(body?.seven_day), raw: body };
}

export function classifyFailure(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  if (err && err.malformedBody) return { class: 'permanent', reason: 'malformed' };
  if (status === 401 || status === 403) return { class: 'permanent', reason: 'stale-token' };
  if (status === 429 || (status >= 500 && status <= 599)) return { class: 'transient' };
  if (status !== null && status >= 400 && status < 500) return { class: 'permanent', reason: 'malformed' };
  return { class: 'transient' };
}

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
