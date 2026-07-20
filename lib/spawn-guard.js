// Spawn safety for claude child processes. Two failure modes both surface as
// `Error: spawn claude ENOENT` and, unhandled, take down the whole bridge:
// a persisted workdir that stopped existing (repo renamed, worktree pruned —
// Node blames the binary when it's actually the missing cwd), and a genuinely
// missing binary. resolveSpawnCwd degrades the first to a fallback dir before
// spawn; attachSpawnErrorHandler absorbs the second so one bad session can
// never crash-loop the service (as it did on 2026-07-16).
import fs from 'node:fs';

// Pick the spawn cwd: the requested workdir if it still exists, otherwise the
// first existing fallback. The last fallback is returned unconditionally as a
// last resort (callers pass a dir that always exists, e.g. os.homedir()).
export function resolveSpawnCwd(requested, fallbacks, { exists = fs.existsSync } = {}) {
  if (requested && exists(requested)) {
    return { cwd: requested, fellBack: false, missing: null };
  }
  const fallback = fallbacks.find((p) => exists(p)) ?? fallbacks[fallbacks.length - 1];
  return { cwd: fallback, fellBack: true, missing: requested || null };
}

// An EventEmitter with no 'error' listener throws on emit — fatal to the
// process. Cleanup and the restart cap stay in the existing 'close' handler
// ('close' still fires after a spawn 'error'); this listener only reports.
export function attachSpawnErrorHandler(proc, { notify, log }) {
  proc.on('error', (err) => {
    const detail = err?.message || String(err);
    try { log(`claude process error: ${detail}`); } catch { /* logging must never throw */ }
    try { notify(`⚠️ Claude process error: ${detail}`); } catch { /* notify must never throw */ }
  });
}
