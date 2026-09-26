// Pure pieces of the `box_status` report added for the Ops page (loop #542
// phase B, wire contract §1): the Codex rate-limit cache that feeds extra
// `limits.lines`, the `vitals` block, the wire-line validator, and the
// re-publish cadence. index.js owns the live state and the timer; everything
// here is injectable so it unit-tests without a bridge.

// matron-journal sanitizeSpawnLimits: at most 12 lines survive, and ONE bad
// line rejects the whole limits block — so the bridge validates the Codex
// lines it appends and drops (never truncates) any the journal would refuse.
export const BOX_LIMIT_LINES_MAX = 12;
const LIMIT_STR_CAP = 100;
const RESETS_AT_CAP = 40;
// sanitizeBoxVitals upper bound for sampled_at_ms.
const SAMPLED_AT_MAX_MS = 8.64e15;

// Re-publish box_status this often while connected, so the journal's
// persisted copy (and the vitals in it) is never more than ~5 min stale.
export const BOX_STATUS_REPUBLISH_MS = 5 * 60 * 1000;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const capStr = (v, cap) => typeof v === 'string' && v.length > 0 && v.length <= cap;

// Would matron-journal accept this limits line? Mirrors sanitizeSpawnLimits
// (id/label non-empty ≤100, integer percent, optional resets ≤100 /
// resets_at ≤40), narrowed to 0..100 which is all codexLimitLines emits.
export function isWireLimitLine(l) {
  if (!isPlainObject(l)) return false;
  if (!capStr(l.id, LIMIT_STR_CAP) || !capStr(l.label, LIMIT_STR_CAP)) return false;
  if (!Number.isInteger(l.percent) || l.percent < 0 || l.percent > 100) return false;
  if (l.resets !== undefined && !capStr(l.resets, LIMIT_STR_CAP)) return false;
  if (l.resets_at !== undefined && !capStr(l.resets_at, RESETS_AT_CAP)) return false;
  return true;
}

const round1 = (n) => Math.round(n * 10) / 10;
const isPct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

// hostVitals() sample -> the box_status `vitals` block, or null (omit it).
// All-or-nothing like the journal's sanitizeBoxVitals: before the CPU
// sampler's first reading hostVitals() reports cpu_pct:null, and a block the
// journal rejects is worse than an absent one.
export function buildBoxVitals(sample) {
  if (!isPlainObject(sample)) return null;
  const { cpu_pct: cpu, ram_pct: ram, sampled_at_ms: at } = sample;
  if (!isPct(cpu) || !isPct(ram)) return null;
  if (!Number.isInteger(at) || at <= 0 || at > SAMPLED_AT_MAX_MS) return null;
  return { cpu_pct: round1(cpu), ram_pct: round1(ram), sampled_at_ms: at };
}

// Account-scoped Codex rate-limit lines for box_status. `read` is
// () => codexAccountReader.read(DEFAULT_WORKDIR) (lib/codex-account.js, which
// runs `account/rateLimits/read` through withCodexAppServer and maps it with
// codexLimitLines); `available` is detectCodexBinary. Same shape and throttle
// discipline as index.js's usageLimitsCache: at most one read per refreshMs, a
// failure stamps fetchedAt too (no spawn storm during an outage) and KEEPS the
// previous lines, concurrent callers share one in-flight read. onFresh fires
// only when new lines landed (index.js re-publishes box_status there).
export function createCodexLimitsRefresher({ read, available, refreshMs, now = Date.now, onFresh = () => {} }) {
  const cache = { lines: null, fetchedAt: 0, inflight: null };
  function refresh() {
    if (cache.inflight) return cache.inflight;
    let can;
    try { can = available() === true; } catch { can = false; }
    if (!can) {
      cache.lines = null;
      return null;
    }
    if (now() - cache.fetchedAt < refreshMs) return null;
    cache.inflight = Promise.resolve()
      .then(() => read())
      .then((value) => {
        cache.fetchedAt = now();
        if (!isPlainObject(value) || value.limitsError || !Array.isArray(value.limits)) return false;
        cache.lines = value.limits;
        try { onFresh(); } catch { /* a publish failure must not poison the cache */ }
        return true;
      }, () => {
        cache.fetchedAt = now();
        return false;
      })
      .finally(() => { cache.inflight = null; });
    return cache.inflight;
  }
  return { cache, refresh };
}
