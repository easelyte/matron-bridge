import fs from 'node:fs';
import path from 'node:path';

// Deterministic, activity-based repo inference for journal titles.
//
// The session cwd is a useless repo signal for our normal pattern: work is
// rooted in son-of-anton and reaches sibling repos (goodfellow, snafu-studio,
// …) BY PATH, so `workdir` is always the workspace root. The codex summary
// pass asks the model to infer a REPO: line, but that is prose over an
// untrusted transcript and is absent whenever the pass fails or has not run.
//
// This module derives the repo from what the session actually TOUCHED. A
// first-level directory under the workspace root that owns its own `.git` is a
// sibling repo; the workspace root and its own subtrees (scripts/, docs/,
// memory/, …) are son-of-anton. Edits are the strong signal for "the repo being
// worked on"; reads and Bash paths are a weak tiebreak used only when the
// session made no edits at all (a read-only browse).

const REPO_LABEL_MAX = 24;

// A path may point into a sibling checkout only if that first-level directory
// has its own .git. Memoized: repos do not appear/vanish mid-process, and this
// runs in the per-event tool_use loop. Cache is keyed by absolute dir so two
// workspaces in one process cannot collide.
const repoDirCache = new Map();

function defaultIsRepoDir(absDir) {
  // Positive-only cache: once a directory HAS a .git it is permanently a repo,
  // so caching true is safe. A negative result is NOT permanent — a later
  // `git clone`/`git init` can create the checkout mid-session — so misses
  // re-probe every time (existsSync is microseconds, and this is cosmetic).
  // Caching negatives would freeze a freshly-cloned repo as son-of-anton
  // forever (F4).
  if (repoDirCache.get(absDir)) return true;
  let isRepo = false;
  try {
    isRepo = fs.existsSync(path.join(absDir, '.git'));
  } catch {
    isRepo = false;
  }
  if (isRepo) repoDirCache.set(absDir, true);
  return isRepo;
}

// Test seam: drop the memoized fs results.
export function __resetRepoDirCache() {
  repoDirCache.clear();
}

// Map an absolute-or-relative filesystem path to a repo label, or null when the
// path is outside the workspace (or unusable). Paths inside the workspace root
// but not inside a sibling checkout resolve to 'son-of-anton'.
export function pathToRepo(p, defaultWorkdir, { isRepoDir = defaultIsRepoDir } = {}) {
  if (typeof p !== 'string' || !p.trim() || typeof defaultWorkdir !== 'string') return null;
  let resolved;
  try {
    // Resolve against the workspace root so a relative tool path (rare, but
    // Bash can emit them) lands inside the workspace rather than the bridge cwd.
    resolved = path.resolve(defaultWorkdir, p);
  } catch {
    return null;
  }
  const root = path.resolve(defaultWorkdir);
  if (resolved === root) return 'son-of-anton';
  const rel = path.relative(root, resolved);
  // '..' prefix or an absolute remainder means the path escaped the workspace.
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const seg = rel.split(path.sep)[0];
  if (!seg || seg === '.') return 'son-of-anton';
  return isRepoDir(path.join(root, seg)) ? seg : 'son-of-anton';
}

// Absolute workspace paths embedded in a Bash command line. Deliberately narrow:
// only tokens that begin with the workspace root count, so unrelated absolute
// paths (/etc, /tmp) and prose never register. `-C <dir>` / `--prefix <dir>` /
// `--workdir <dir>` forms are covered because the directory token itself starts
// with the root.
function bashPaths(command, root) {
  if (typeof command !== 'string' || !command) return [];
  const out = [];
  // Split on shell-ish whitespace and common delimiters; strip surrounding
  // quotes. Good enough for a cosmetic signal — no shell parsing needed.
  for (const rawTok of command.split(/[\s'"=]+/)) {
    const tok = rawTok.trim();
    if (tok.startsWith(root)) out.push(tok);
  }
  return out;
}

// Tool blocks whose file_path is a WRITE to the repo — the strong signal.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tool blocks that only READ — weak signal, tiebreak only.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

// Extract candidate {repo, write} signals from one tool_use block. Pure: no
// side effects, so it can be computed at tool_use time and COMMITTED later once
// the tool's result is known (see commitRepoSignals) — a denied or failed write
// must not count as activity (F2).
export function toolRepoSignals(toolName, input, defaultWorkdir, opts = {}) {
  const root = path.resolve(defaultWorkdir);
  const signals = [];
  const add = (p, write) => {
    const repo = pathToRepo(p, defaultWorkdir, opts);
    if (repo) signals.push({ repo, write });
  };
  if (WRITE_TOOLS.has(toolName)) {
    add(input?.file_path ?? input?.notebook_path, true);
  } else if (READ_TOOLS.has(toolName)) {
    add(input?.file_path ?? input?.path, false);
  } else if (toolName === 'Bash') {
    for (const p of bashPaths(input?.command, root)) add(p, false);
  }
  return signals;
}

// Empty score accumulator. `w` = write-repo counts, `r` = read/other counts.
export function emptyRepoScores() {
  return { w: {}, r: {} };
}

// Coerce persisted/untrusted score state into a clean accumulator: two count
// maps of finite, nonnegative integers. Persisted JSON is version-skewable and
// reaches the event path (F5) — `{w:"bad"}` would otherwise throw a TypeError
// on the next write and, with no containment around handleClaudeEvent, could
// terminate event processing. Anything malformed degrades to empty.
export function normalizeRepoScores(raw) {
  const clean = emptyRepoScores();
  if (!raw || typeof raw !== 'object') return clean;
  for (const bucket of ['w', 'r']) {
    const src = raw[bucket];
    if (!src || typeof src !== 'object') continue;
    for (const [label, n] of Object.entries(src)) {
      if (typeof label !== 'string' || !label) continue;
      const count = Number(n);
      if (Number.isFinite(count) && count > 0) clean[bucket][label] = Math.floor(count);
    }
  }
  return clean;
}

// Fold already-computed signals into a session's scores. Returns true when the
// scores changed. Callers stage toolRepoSignals() at tool_use and call this
// only once the tool_result confirms success.
export function commitRepoSignals(scores, signals) {
  if (!scores || typeof scores !== 'object' || !Array.isArray(signals)) return false;
  if (!scores.w) scores.w = {};
  if (!scores.r) scores.r = {};
  let changed = false;
  for (const sig of signals) {
    if (!sig || typeof sig.repo !== 'string') continue;
    const bucket = sig.write ? scores.w : scores.r;
    bucket[sig.repo] = (bucket[sig.repo] || 0) + 1;
    changed = true;
  }
  return changed;
}

// Convenience compute-and-commit in one step (no result gating). Retained for
// tests and any caller that scores synchronously; the production event path
// stages + commits separately so failed writes never count.
export function scoreToolRepo(scores, toolName, input, defaultWorkdir, opts = {}) {
  return commitRepoSignals(scores, toolRepoSignals(toolName, input, defaultWorkdir, opts));
}

// Deterministic argmax over a {label: count} map. Ties break lexicographically
// so the same activity always yields the same label (test-stable, no flicker).
function argmax(counts) {
  let best = null;
  let bestN = 0;
  for (const [label, n] of Object.entries(counts || {})) {
    if (n > bestN || (n === bestN && best !== null && label < best)) {
      best = label;
      bestN = n;
    }
  }
  return best;
}

// The repo this session is working on, inferred from activity. Write targets win
// (the repo you EDIT is the repo you are working on); reads decide only when the
// session made no edits at all. Returns null when nothing usable was touched —
// callers then fall back to the workdir basename. The label is capped like every
// other repo segment.
export function dominantRepo(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const label = argmax(scores.w) ?? (Object.keys(scores.w || {}).length ? null : argmax(scores.r));
  if (!label) return null;
  const chars = Array.from(label);
  return chars.length > REPO_LABEL_MAX ? `${chars.slice(0, REPO_LABEL_MAX).join('')}…` : label;
}
