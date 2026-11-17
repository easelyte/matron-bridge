// Disk size of each worktree, for the folder picker and box status. A
// directory walk is not free, and both callers sit on hot paths (every
// picker open, every status frame), so `get` never waits and never walks:
// it answers from the cache (null until the first measurement lands) and,
// when the figure is missing or stale, queues one background measurement.
// Measurements run one at a time.
import { execFile } from 'node:child_process';

export const SIZE_TTL_MS = 30 * 60 * 1000;
const DU_TIMEOUT_MS = 120_000;

// `du -sk`: one subprocess per worktree. No Windows equivalent that is cheap,
// so there the size is simply unknown.
export function duMeasure(dir) {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: DU_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const kb = Number.parseInt(String(stdout ?? '').split(/\s+/)[0], 10);
      resolve(!err && Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null);
    });
  });
}

export function createSizeCache({ ttlMs = SIZE_TTL_MS, measure = duMeasure, now = Date.now } = {}) {
  const cache = new Map(); // path -> { bytes, at }
  const queued = new Set();
  let running = false;

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queued.size) {
        const dir = queued.values().next().value;
        queued.delete(dir);
        let bytes = null;
        try { bytes = await measure(dir); } catch { /* unknown stays unknown */ }
        cache.set(dir, { bytes, at: now() });
      }
    } finally { running = false; }
  };

  return {
    get(dir) {
      const hit = cache.get(dir);
      if (!hit || now() - hit.at >= ttlMs) {
        if (!queued.has(dir)) { queued.add(dir); void pump(); }
      }
      return hit ? hit.bytes : null;
    },
    forget(dir) { cache.delete(dir); queued.delete(dir); },
    // Test hook: resolves once the queue is drained.
    async idle() { while (running || queued.size) await new Promise((r) => setTimeout(r, 5)); },
  };
}
