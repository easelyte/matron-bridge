import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pathToRepo,
  scoreToolRepo,
  toolRepoSignals,
  commitRepoSignals,
  dominantRepo,
  emptyRepoScores,
  normalizeRepoScores,
  __resetRepoDirCache,
} from '../lib/repo-infer.js';

const ROOT = '/root/.openclaw/workspace';
// Stub the .git probe: goodfellow and snafu-studio are sibling checkouts; the
// workspace's own subtrees (scripts/, memory/, …) are not.
const SIBLINGS = new Set(['goodfellow', 'snafu-studio', 'nipple-pie']);
const isRepoDir = (absDir) => SIBLINGS.has(absDir.slice(ROOT.length + 1));
const opts = { isRepoDir };

describe('pathToRepo', () => {
  it('maps a sibling-repo path to the sibling', () => {
    expect(pathToRepo(`${ROOT}/goodfellow/skills/plan-review/SKILL.md`, ROOT, opts)).toBe('goodfellow');
  });

  it('maps a workspace-internal subtree to son-of-anton', () => {
    expect(pathToRepo(`${ROOT}/scripts/lib/paths.py`, ROOT, opts)).toBe('son-of-anton');
    expect(pathToRepo(`${ROOT}/memory/open-loops.json`, ROOT, opts)).toBe('son-of-anton');
  });

  it('maps the workspace root itself and root files to son-of-anton', () => {
    expect(pathToRepo(ROOT, ROOT, opts)).toBe('son-of-anton');
    expect(pathToRepo(`${ROOT}/CLAUDE.md`, ROOT, opts)).toBe('son-of-anton');
  });

  it('returns null for paths outside the workspace', () => {
    expect(pathToRepo('/etc/passwd', ROOT, opts)).toBe(null);
    expect(pathToRepo('/tmp/scratch.md', ROOT, opts)).toBe(null);
    expect(pathToRepo(`${ROOT}/../other/x.md`, ROOT, opts)).toBe(null);
  });

  it('rejects unusable input', () => {
    expect(pathToRepo('', ROOT, opts)).toBe(null);
    expect(pathToRepo(null, ROOT, opts)).toBe(null);
    expect(pathToRepo(`${ROOT}/x`, null, opts)).toBe(null);
  });
});

describe('scoreToolRepo + dominantRepo', () => {
  it('a write target beats a larger pile of reads (repo you EDIT wins)', () => {
    const s = emptyRepoScores();
    // 5 son-of-anton reads (memory/loops) but the edits land in goodfellow.
    for (let i = 0; i < 5; i++) scoreToolRepo(s, 'Read', { file_path: `${ROOT}/memory/f${i}.json` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    scoreToolRepo(s, 'Write', { file_path: `${ROOT}/goodfellow/b.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('goodfellow');
  });

  it('the dominant write target wins when several repos are edited', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/snafu-studio/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/goodfellow/b.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('goodfellow');
  });

  it('falls back to read-dominant repo when there are no edits', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Read', { file_path: `${ROOT}/snafu-studio/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Grep', { path: `${ROOT}/snafu-studio/y.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Read', { file_path: `${ROOT}/scripts/z.py` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('snafu-studio');
  });

  it('extracts workspace paths from Bash commands (git -C, absolute tokens)', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Bash', { command: `git -C ${ROOT}/goodfellow log --oneline -3` }, ROOT, opts);
    scoreToolRepo(s, 'Bash', { command: `npm --prefix ${ROOT}/snafu-studio run build` }, ROOT, opts);
    scoreToolRepo(s, 'Bash', { command: `git -C ${ROOT}/goodfellow status` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('goodfellow');
  });

  it('ignores non-workspace Bash paths', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Bash', { command: 'cat /etc/hosts && ls /tmp' }, ROOT, opts);
    expect(dominantRepo(s)).toBe(null);
  });

  it('returns null for an untouched session', () => {
    expect(dominantRepo(emptyRepoScores())).toBe(null);
    expect(dominantRepo({})).toBe(null);
    expect(dominantRepo(null)).toBe(null);
  });

  it('is deterministic on ties (lexicographic)', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/snafu-studio/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('goodfellow'); // g < s
  });

  it('scoreToolRepo reports whether it changed the scores', () => {
    const s = emptyRepoScores();
    expect(scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts)).toBe(true);
    expect(scoreToolRepo(s, 'Edit', { file_path: '/etc/passwd' }, ROOT, opts)).toBe(false);
    expect(scoreToolRepo(s, 'ExitPlanMode', {}, ROOT, opts)).toBe(false);
  });

  it('caps an over-long inferred repo label', () => {
    const s = emptyRepoScores();
    const long = 'r'.repeat(40);
    const localOpts = { isRepoDir: (absDir) => absDir.endsWith(long) };
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/${long}/a.md` }, ROOT, localOpts);
    const out = dominantRepo(s);
    expect(Array.from(out)).toHaveLength(25); // 24 chars + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('toolRepoSignals + commitRepoSignals (staged commit, F2)', () => {
  it('computes signals without mutating any score state', () => {
    const sig = toolRepoSignals('Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    expect(sig).toEqual([{ repo: 'goodfellow', write: true }]);
    const readSig = toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts);
    expect(readSig).toEqual([{ repo: 'son-of-anton', write: false }]);
    expect(toolRepoSignals('ExitPlanMode', {}, ROOT, opts)).toEqual([]);
  });

  it('a staged write that never commits does not influence the repo (denied/failed)', () => {
    const s = emptyRepoScores();
    // Simulate: an Edit into goodfellow is staged but its result is an error, so
    // it is never committed; meanwhile son-of-anton reads commit normally.
    const staged = toolRepoSignals('Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts));
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/memory/y.json` }, ROOT, opts));
    void staged; // deliberately not committed
    expect(dominantRepo(s)).toBe('son-of-anton');
  });

  it('a staged write that commits on success wins', () => {
    const s = emptyRepoScores();
    const staged = toolRepoSignals('Edit', { file_path: `${ROOT}/goodfellow/a.md` }, ROOT, opts);
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts));
    commitRepoSignals(s, staged); // result was success
    expect(dominantRepo(s)).toBe('goodfellow');
  });

  it('commitRepoSignals reports change and ignores junk', () => {
    const s = emptyRepoScores();
    expect(commitRepoSignals(s, [{ repo: 'goodfellow', write: true }])).toBe(true);
    expect(commitRepoSignals(s, [])).toBe(false);
    expect(commitRepoSignals(s, [{ nope: 1 }, null])).toBe(false);
    expect(commitRepoSignals(null, [{ repo: 'x' }])).toBe(false);
  });
});

describe('normalizeRepoScores (F5)', () => {
  it('coerces malformed persisted state into clean count maps', () => {
    expect(normalizeRepoScores({ w: 'bad', r: {} })).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores(null)).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores('nope')).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores({ w: { goodfellow: 3 }, r: { 'son-of-anton': 2 } }))
      .toEqual({ w: { goodfellow: 3 }, r: { 'son-of-anton': 2 } });
  });

  it('drops non-finite, negative, and non-string entries; floors floats', () => {
    const out = normalizeRepoScores({
      w: { good: 2.7, bad: -1, worse: NaN, inf: Infinity, '': 5 },
      r: { ok: '4' },
    });
    expect(out).toEqual({ w: { good: 2 }, r: { ok: 4 } });
  });

  it('a normalized malformed score survives a subsequent commit without throwing', () => {
    const s = normalizeRepoScores({ w: 'bad', r: 42 });
    expect(() => commitRepoSignals(s, [{ repo: 'goodfellow', write: true }])).not.toThrow();
    expect(dominantRepo(s)).toBe('goodfellow');
  });
});

describe('defaultIsRepoDir positive-only cache (F4)', () => {
  it('re-probes a directory after .git appears (negative not frozen)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-infer-'));
    try {
      __resetRepoDirCache();
      const newRepo = path.join(tmp, 'freshclone');
      fs.mkdirSync(newRepo);
      // Before .git exists: classified as son-of-anton (root's own subtree).
      expect(pathToRepo(path.join(newRepo, 'a.md'), tmp)).toBe('son-of-anton');
      // Simulate a git clone/init landing.
      fs.mkdirSync(path.join(newRepo, '.git'));
      // A frozen negative cache would still say son-of-anton; positive-only
      // caching re-probes and now sees the checkout.
      expect(pathToRepo(path.join(newRepo, 'a.md'), tmp)).toBe('freshclone');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      __resetRepoDirCache();
    }
  });
});
