// Pure builders for the capacity blocks attached to the recent_folders RPC
// reply (spec: 2026-08-10 agent-spawn bridge + capacity design). Kept free
// of index.js state so they unit-test without a bridge: index.js passes the
// live `sessions` Map, the persisted-session record map, and the
// usageLimitsCache. Never blocks and never throws — a capacity report is a
// convenience, not worth failing the reply over.

import fs from 'fs';
import { isWireLimitLine, BOX_LIMIT_LINES_MAX } from './box-status.js';

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

// Free/total bytes for the filesystem holding `path` (the default workdir —
// one figure per box; per-folder figures would almost always restate the
// same filesystem). A box that is nearly full is a bad spawn target however
// idle it looks, so this rides the same reply as activity/limits. statfsSync
// is one syscall, no subprocess — safe to answer inline. Any failure or
// nonsense figure -> null, and the reply omits the block, same contract as
// the other capacity builders.
export function buildDisk({ path, statfs = fs.statfsSync }) {
  try {
    const s = statfs(path);
    // bavail (blocks free to unprivileged users), not bfree — bfree counts
    // the root reserve, which a spawned session cannot actually write to.
    //
    // Known limitation: POSIX defines these counts in f_frsize units, but
    // Node's StatFs exposes only bsize, so bsize is what we multiply by.
    // On the common case (ext4/xfs/btrfs, where the two are equal) the
    // figures match df exactly; on filesystems that split them (some
    // FUSE/ZFS/VirtioFS setups) they can be inflated. Fixing that needs
    // frsize, which means a subprocess (df) or a native addon — both worse
    // than an occasionally-optimistic advisory figure on exotic mounts.
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    if (!Number.isSafeInteger(free) || !Number.isSafeInteger(total)) return null;
    if (free < 0 || total <= 0 || free > total) return null;
    return { free_bytes: free, total_bytes: total };
  } catch {
    return null;
  }
}

// The account-limits caches -> the `limits` block. Claude lines (index.js's
// usageLimitsCache shape: {lines, fetchedAt}) come first and verbatim; Codex
// lines (lib/box-status.js createCodexLimitsRefresher cache, same shape) are
// appended after them, validated line by line and dropped past the journal's
// 12-line cap, so a Codex hiccup can never invalidate the Claude quotas
// (wire contract 2026-09-26 §1). as_of is the oldest sample time among the
// providers whose lines are included. Null when both are cold — the
// reply then omits `limits` entirely rather than blocking on a
// `claude -p "/usage"` boot.
const warm = (cache) => !!cache && Array.isArray(cache.lines) && cache.lines.length > 0
  && Number.isInteger(cache.fetchedAt) && cache.fetchedAt > 0;

export function buildLimits(cache, codexCache = null) {
  const claudeLines = warm(cache) ? cache.lines : [];
  const codexLines = warm(codexCache)
    ? codexCache.lines.filter(isWireLimitLine).slice(0, Math.max(0, BOX_LIMIT_LINES_MAX - claudeLines.length))
    : [];
  if (claudeLines.length === 0 && codexLines.length === 0) return null;
  // One as_of for the merged block: the OLDEST sample in it, so a stale
  // Codex reading kept across a failed read never borrows a fresh Claude time.
  const times = [];
  if (claudeLines.length > 0) times.push(cache.fetchedAt);
  if (codexLines.length > 0) times.push(codexCache.fetchedAt);
  const as_of = Math.min(...times);
  return { as_of, lines: codexLines.length > 0 ? [...claudeLines, ...codexLines] : claudeLines };
}
