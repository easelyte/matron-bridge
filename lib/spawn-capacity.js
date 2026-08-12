// Pure builders for the capacity blocks attached to the recent_folders RPC
// reply (spec: 2026-08-10 agent-spawn bridge + capacity design). Kept free
// of index.js state so they unit-test without a bridge: index.js passes the
// live `sessions` Map, the persisted-session record map, and the
// usageLimitsCache. Never blocks and never throws — a capacity report is a
// convenience, not worth failing the reply over.

const HOUR_MS = 60 * 60 * 1000;
const LAST_HOUR_CAP = 20;
// Mirrors the journal's own sanitizeSpawnActivity path cap
// (matron-journal src/spawns.js) — the journal rejects the WHOLE activity
// block, not just the offending entry, if any path exceeds this. Skipping
// (not truncating: a truncated path is a misleading one, since it may look
// like a valid shorter directory) an over-long entry here keeps every OTHER
// path in last_hour instead of losing the whole block over one outlier.
const PATH_MAX_CHARS = 1024;

// live_sessions = sessions running right now; last_hour = workdirs with a
// session used in the trailing hour, session-counted (not path-deduped like
// recent-folders). Live and persisted views of the same session share the
// roomId key, so a live session with a fresh persisted record counts once —
// and a live session counts toward its workdir even when its persisted
// record has gone stale (it is, by definition, in use).
export function buildActivity({ sessions, persisted, now = Date.now() }) {
  const byPath = new Map(); // path -> { keys: Set, recency: number }
  const add = (path, key, at) => {
    if (typeof path !== 'string' || !path || path.length > PATH_MAX_CHARS) return;
    let entry = byPath.get(path);
    if (!entry) byPath.set(path, entry = { keys: new Set(), recency: 0 });
    entry.keys.add(key);
    if (at > entry.recency) entry.recency = at;
  };
  let live = 0;
  for (const [key, s] of sessions instanceof Map ? sessions : new Map()) {
    if (!s || !s.alive || s._autoStopped) continue;
    live += 1;
    add(s.workdir, key, typeof s.lastActivityAt === 'number' ? s.lastActivityAt : now);
  }
  for (const [key, rec] of Object.entries(persisted && typeof persisted === 'object' ? persisted : {})) {
    if (!rec || typeof rec.workdir !== 'string' || typeof rec.lastUsed !== 'number') continue;
    if (now - rec.lastUsed > HOUR_MS) continue;
    add(rec.workdir, key, rec.lastUsed);
  }
  const last_hour = [...byPath.entries()]
    .sort((a, b) => b[1].recency - a[1].recency)
    .slice(0, LAST_HOUR_CAP)
    .map(([path, e]) => ({ path, sessions: e.keys.size }));
  return { live_sessions: live, last_hour };
}

// The account-limits cache verbatim (index.js's usageLimitsCache shape:
// {lines, fetchedAt}). Null when cold — the reply then omits `limits`
// entirely rather than blocking on a `claude -p "/usage"` boot.
export function buildLimits(cache) {
  if (!cache || !Array.isArray(cache.lines) || cache.lines.length === 0) return null;
  if (!Number.isInteger(cache.fetchedAt) || cache.fetchedAt <= 0) return null;
  return { as_of: cache.fetchedAt, lines: cache.lines };
}
