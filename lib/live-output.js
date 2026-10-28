import { writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';

export function createLiveOutputStore({ ttlSeconds = 86400, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const entries = new Map();

  function register(toolUseId, { logPath, roomId }) {
    entries.set(toolUseId, {
      logPath,
      doneSentinelPath: `${logPath}.done`,
      roomId,
      expiresAt: now() + ttlSeconds,
      complete: false,
    });
  }

  function get(toolUseId) {
    return entries.get(toolUseId);
  }

  function markComplete(toolUseId, { exitCode = null, denied = false, truncated = false } = {}) {
    const entry = entries.get(toolUseId);
    if (!entry) return;
    // Exclusive create ('wx' = O_CREAT|O_EXCL, which also refuses to follow
    // a symlink) and owner-only, since the name sits in shared /tmp. Never
    // throw: this runs inside the CLI's stdout listener, where an exception
    // would take the bridge down.
    try {
      writeFileSync(entry.doneSentinelPath, JSON.stringify({ exitCode, denied, truncated }), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      console.warn(`[live-output] could not write ${entry.doneSentinelPath}: ${e.code || e.message}`);
    }
    entry.complete = true;
  }

  function gcExpired() {
    let removed = 0;
    for (const [id, entry] of entries) {
      if (now() >= entry.expiresAt) {
        try { unlinkSync(entry.logPath); } catch {}
        try { unlinkSync(entry.doneSentinelPath); } catch {}
        entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  return { register, get, markComplete, gcExpired };
}

export function sweepOrphanedLogs(dir, ttlSeconds) {
  const cutoff = Date.now() - ttlSeconds * 1000;
  let removed = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith('matron-cmd-')) continue;
    const full = `${dir}/${name}`;
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}
