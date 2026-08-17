import { describe, it, expect } from 'vitest';
import {
  pathToRepo,
  scoreToolRepo,
  dominantRepo,
  emptyRepoScores,
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
