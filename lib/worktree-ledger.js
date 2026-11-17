// Durable record of the git worktrees the bridge created for
// `/start --worktree <name>`. One flat JSON file, keyed by the worktree's
// absolute path:
//
//   { "<path>": { name, branch, root, base, gitDir, createdAt, setup?, removedAt? } }
//
// It answers four questions without a git call: which sessions run in a
// bridge-made worktree (the spawn notice), which folders the picker should
// group under their repo, how many worktrees a repo already has (the
// limit), and whether a session's workdir is a worktree that has since been
// removed (resuming it is refused, never recreated as an empty folder).
// Removed entries stay, flagged, for that last check; the oldest are dropped
// past a cap. All I/O fails open, in the style of lib/recent-folders.js.
import nodeFs from 'fs';

import { atomicWriteFileSync } from './atomic-write.js';

export const WORKTREE_DIR = '.claude/worktrees';
const MAX_REMOVED_KEPT = 200;

// Forward slashes, and a lower-case drive letter, so `C:\r` and `c:/r` are one key.
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}:`);

// `<root>/.claude/worktrees/<name>[/sub]` -> { root, name, path }, else null.
// Pure string work, so it is safe on any hot path.
export function parseWorktreePath(p) {
  if (typeof p !== 'string' || !p) return null;
  const m = /^(.*?)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/.exec(norm(p));
  if (!m || !m[1] || m[2] === '.' || m[2] === '..') return null;
  return { root: m[1], name: m[2], path: `${m[1]}/.claude/worktrees/${m[2]}` };
}

export function createWorktreeLedger({ file, fs = nodeFs, log = console } = {}) {
  let entries = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [p, e] of Object.entries(parsed)) {
        if (e && typeof e === 'object' && typeof e.name === 'string' && typeof e.branch === 'string') entries[norm(p)] = e;
      }
    }
  } catch { /* missing or corrupt: start empty */ }

  const save = () => {
    const removed = Object.entries(entries).filter(([, e]) => e.removedAt).sort((a, b) => a[1].removedAt - b[1].removedAt);
    for (const [p] of removed.slice(0, Math.max(0, removed.length - MAX_REMOVED_KEPT))) delete entries[p];
    try {
      atomicWriteFileSync(file, JSON.stringify(entries, null, 2), { fs, mode: 0o600 });
    } catch (e) {
      log.warn?.(`[worktree-ledger] save failed: ${e?.message || e}`);
    }
  };

  // The entry for the worktree a workdir lives in (the worktree root or any
  // folder below it).
  const lookup = (workdir) => {
    const parsed = parseWorktreePath(workdir);
    if (!parsed) return null;
    const entry = entries[parsed.path];
    return entry ? { path: parsed.path, ...entry } : null;
  };

  return {
    add(wtPath, entry) {
      entries[norm(wtPath)] = { ...entry, createdAt: entry.createdAt ?? Date.now() };
      save();
    },
    update(wtPath, patch) {
      const key = norm(wtPath);
      if (!entries[key]) return false;
      entries[key] = { ...entries[key], ...patch };
      save();
      return true;
    },
    markRemoved(wtPath, now = Date.now()) {
      return this.update(wtPath, { removedAt: now });
    },
    // Live (not removed) record for a workdir, or null.
    get(workdir) {
      const e = lookup(workdir);
      return e && !e.removedAt ? e : null;
    },
    // A workdir inside a worktree this bridge made and that is gone now.
    // `exists` is injectable for tests.
    removedFor(workdir, { exists = (p) => nodeFs.existsSync(p) } = {}) {
      const e = lookup(workdir);
      if (!e) return null;
      return e.removedAt || !exists(e.path) ? e : null;
    },
    // Live worktrees, optionally of one repo root.
    list(root = null) {
      return Object.entries(entries)
        .filter(([, e]) => !e.removedAt && (root === null || norm(e.root) === norm(root)))
        .map(([p, e]) => ({ path: p, ...e }));
    },
  };
}
