import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  workspaceRootLabel,
  __resetRepoDirCache,
} from '../lib/repo-infer.js';

const ROOT = '/home/user/workspace';
// Stub the .git probe: api-server, my-app and other-app are sibling checkouts; the
// workspace's own subtrees (scripts/, memory/, …) are not.
const SIBLINGS = new Set(['api-server', 'my-app', 'other-app']);
const isRepoDir = (absDir) => SIBLINGS.has(absDir.slice(ROOT.length + 1));
const opts = { isRepoDir };

// Keep the ambient environment out of the default-label assertions.
beforeEach(() => { vi.stubEnv('MATRON_WORKSPACE_ROOT_LABEL', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('pathToRepo', () => {
  it('maps a sibling-repo path to the sibling', () => {
    expect(pathToRepo(`${ROOT}/api-server/docs/README.md`, ROOT, opts)).toBe('api-server');
  });

  it('maps a workspace-internal subtree to the workspace root label', () => {
    expect(pathToRepo(`${ROOT}/scripts/lib/paths.py`, ROOT, opts)).toBe('workspace');
    expect(pathToRepo(`${ROOT}/memory/open-loops.json`, ROOT, opts)).toBe('workspace');
  });

  it('maps the workspace root itself and root files to the workspace root label', () => {
    expect(pathToRepo(ROOT, ROOT, opts)).toBe('workspace');
    expect(pathToRepo(`${ROOT}/CLAUDE.md`, ROOT, opts)).toBe('workspace');
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
    // 5 workspace-root reads but the edits land in api-server.
    for (let i = 0; i < 5; i++) scoreToolRepo(s, 'Read', { file_path: `${ROOT}/memory/f${i}.json` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    scoreToolRepo(s, 'Write', { file_path: `${ROOT}/api-server/b.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('api-server');
  });

  it('the dominant write target wins when several repos are edited', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/my-app/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/api-server/b.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('api-server');
  });

  it('falls back to read-dominant repo when there are no edits', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Read', { file_path: `${ROOT}/my-app/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Grep', { path: `${ROOT}/my-app/y.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Read', { file_path: `${ROOT}/scripts/z.py` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('my-app');
  });

  it('extracts workspace paths from Bash commands (git -C, absolute tokens)', () => {
    const s = emptyRepoScores();
    scoreToolRepo(s, 'Bash', { command: `git -C ${ROOT}/api-server log --oneline -3` }, ROOT, opts);
    scoreToolRepo(s, 'Bash', { command: `npm --prefix ${ROOT}/my-app run build` }, ROOT, opts);
    scoreToolRepo(s, 'Bash', { command: `git -C ${ROOT}/api-server status` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('api-server');
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
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/my-app/x.ts` }, ROOT, opts);
    scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    expect(dominantRepo(s)).toBe('api-server'); // a < m
  });

  it('scoreToolRepo reports whether it changed the scores', () => {
    const s = emptyRepoScores();
    expect(scoreToolRepo(s, 'Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts)).toBe(true);
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

describe('toolRepoSignals + commitRepoSignals (staged commit)', () => {
  it('computes signals without mutating any score state', () => {
    const sig = toolRepoSignals('Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    expect(sig).toEqual([{ repo: 'api-server', write: true }]);
    const readSig = toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts);
    expect(readSig).toEqual([{ repo: 'workspace', write: false }]);
    expect(toolRepoSignals('ExitPlanMode', {}, ROOT, opts)).toEqual([]);
  });

  it('a staged write that never commits does not influence the repo (denied/failed)', () => {
    const s = emptyRepoScores();
    // Simulate: an Edit into api-server is staged but its result is an error, so
    // it is never committed; meanwhile workspace-root reads commit normally.
    const staged = toolRepoSignals('Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts));
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/memory/y.json` }, ROOT, opts));
    void staged; // deliberately not committed
    expect(dominantRepo(s)).toBe('workspace');
  });

  it('a staged write that commits on success wins', () => {
    const s = emptyRepoScores();
    const staged = toolRepoSignals('Edit', { file_path: `${ROOT}/api-server/a.md` }, ROOT, opts);
    commitRepoSignals(s, toolRepoSignals('Read', { file_path: `${ROOT}/scripts/x.py` }, ROOT, opts));
    commitRepoSignals(s, staged); // result was success
    expect(dominantRepo(s)).toBe('api-server');
  });

  it('commitRepoSignals reports change and ignores junk', () => {
    const s = emptyRepoScores();
    expect(commitRepoSignals(s, [{ repo: 'api-server', write: true }])).toBe(true);
    expect(commitRepoSignals(s, [])).toBe(false);
    expect(commitRepoSignals(s, [{ nope: 1 }, null])).toBe(false);
    expect(commitRepoSignals(null, [{ repo: 'x' }])).toBe(false);
  });
});

describe('normalizeRepoScores', () => {
  it('coerces malformed persisted state into clean count maps', () => {
    expect(normalizeRepoScores({ w: 'bad', r: {} })).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores(null)).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores('nope')).toEqual({ w: {}, r: {} });
    expect(normalizeRepoScores({ w: { 'api-server': 3 }, r: { 'workspace': 2 } }))
      .toEqual({ w: { 'api-server': 3 }, r: { 'workspace': 2 } });
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
    expect(() => commitRepoSignals(s, [{ repo: 'api-server', write: true }])).not.toThrow();
    expect(dominantRepo(s)).toBe('api-server');
  });
});

describe('defaultIsRepoDir positive-only cache', () => {
  it('re-probes a directory after .git appears (negative not frozen)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-infer-'));
    try {
      __resetRepoDirCache();
      const newRepo = path.join(tmp, 'freshclone');
      fs.mkdirSync(newRepo);
      // Before .git exists: classified as the workspace root (root's own subtree).
      expect(pathToRepo(path.join(newRepo, 'a.md'), tmp)).toBe(path.basename(tmp));
      // Simulate a git clone/init landing.
      fs.mkdirSync(path.join(newRepo, '.git'));
      // A frozen negative cache would still say the root label; positive-only
      // caching re-probes and now sees the checkout.
      expect(pathToRepo(path.join(newRepo, 'a.md'), tmp)).toBe('freshclone');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      __resetRepoDirCache();
    }
  });
});

describe('workspace root label', () => {
  it('defaults to the basename of the workspace root', () => {
    expect(workspaceRootLabel('/srv/projects/monorepo')).toBe('monorepo');
    expect(workspaceRootLabel('/srv/projects/monorepo/')).toBe('monorepo');
    expect(pathToRepo('/srv/projects/monorepo/scripts/x.py', '/srv/projects/monorepo', opts)).toBe('monorepo');
  });

  it('falls back to "workspace" when the root has no usable basename', () => {
    expect(workspaceRootLabel('/')).toBe('workspace');
    expect(workspaceRootLabel(null)).toBe('workspace');
  });

  it('MATRON_WORKSPACE_ROOT_LABEL overrides the default (trimmed)', () => {
    vi.stubEnv('MATRON_WORKSPACE_ROOT_LABEL', '  main-repo  ');
    expect(workspaceRootLabel(ROOT)).toBe('main-repo');
    expect(pathToRepo(`${ROOT}/scripts/x.py`, ROOT, opts)).toBe('main-repo');
    expect(pathToRepo(ROOT, ROOT, opts)).toBe('main-repo');
    // Sibling checkouts keep their own directory name.
    expect(pathToRepo(`${ROOT}/my-app/x.ts`, ROOT, opts)).toBe('my-app');
  });

  it('a blank override is ignored', () => {
    vi.stubEnv('MATRON_WORKSPACE_ROOT_LABEL', '   ');
    expect(workspaceRootLabel(ROOT)).toBe('workspace');
  });

  it('an explicit rootLabel option wins over env and default', () => {
    vi.stubEnv('MATRON_WORKSPACE_ROOT_LABEL', 'from-env');
    expect(pathToRepo(`${ROOT}/scripts/x.py`, ROOT, { ...opts, rootLabel: 'explicit' })).toBe('explicit');
  });

  it('accepts an injected env map', () => {
    expect(workspaceRootLabel(ROOT, { MATRON_WORKSPACE_ROOT_LABEL: 'injected' })).toBe('injected');
    expect(workspaceRootLabel(ROOT, {})).toBe('workspace');
  });
});
