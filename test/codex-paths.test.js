import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  codexRunsDirFor,
  configureCodexSinkEnv,
  detectCodexBinary,
  detectProducer,
  launchWithCodexSinkEnv,
  pruneStaleCodexSinks,
  SHIPPED_SHIM_DIR,
} from '../lib/codex-paths.js';

describe('codexRunsDirFor', () => {
  it('anchors the sink to the sessionId, outside the encoded-cwd project tree', () => {
    const sessionId = 'abc-123';
    const dir = codexRunsDirFor('/home/user/project', sessionId);

    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'matron', 'codex-sinks', sessionId, 'codex-runs',
    ) + path.sep);
    // Must NOT live under Claude Code's `projects/` tree, which is re-homed on
    // cwd change (EnterWorktree) and would orphan the frozen sink env (#630).
    expect(dir).not.toContain(`${path.sep}projects${path.sep}`);
  });

  it('yields the SAME sink dir for a worktree cwd as for the main cwd (loop #630)', () => {
    const sessionId = '00000000-1111-2222-3333-444444444444';
    const mainCwd = '/home/user/project';
    const worktreeCwd = '/home/user/project/.claude/worktrees/feature-x';

    // A session that starts in main and later EnterWorktree's must resolve the
    // same sink path on both sides, so producer-write == watcher-watch survives
    // the cwd change. Parity here is what a card actually depends on.
    expect(codexRunsDirFor(worktreeCwd, sessionId))
      .toBe(codexRunsDirFor(mainCwd, sessionId));
  });

  it('rejects a sessionId that could traverse out of the sinks root', () => {
    for (const bad of ['..', '../evil', 'a/../../etc', 'a/b', 'a\\b', 'x\0y', '', '.']) {
      expect(() => codexRunsDirFor('/home/user/project', bad)).toThrow(/unsafe sessionId/);
    }
    // A normal UUID session id is fine.
    expect(() => codexRunsDirFor('/home/user/project', '00000000-1111-2222-3333-444444444444')).not.toThrow();
  });
});

describe('configureCodexSinkEnv', () => {
  it('injects an existing session-scoped sibling directory (0700) and deploys the shim on PATH', () => {
    const spawnEnv = { PATH: '/usr/bin:/bin' };
    const mkdirSync = vi.fn();
    const chmodSync = vi.fn();
    const dir = configureCodexSinkEnv({
      spawnEnv,
      workdir: '/home/user/.config/agent-workspace',
      sessionId: 'abc-123',
      env: { MATRON_CODEX_VIZ: '1' },
      mkdirSync,
      chmodSync,
    });

    // The sink holds unredacted JSONL: created 0700 and pinned via chmod.
    expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(chmodSync).toHaveBeenCalledWith(dir, 0o700);
    expect(spawnEnv.MATRON_CODEX_SINK_DIR).toBe(dir);
    // Deployment half of the activation guard: the shim dir is prepended so the
    // spawned session's bare `codex` resolves to the producer.
    expect(spawnEnv.PATH.split(path.delimiter)[0]).toBe(SHIPPED_SHIM_DIR);
    expect(spawnEnv.PATH).toContain('/usr/bin:/bin');
  });

  it('does not double-prepend the shim dir when it is already first on PATH', () => {
    const first = `${SHIPPED_SHIM_DIR}${path.delimiter}/usr/bin`;
    const spawnEnv = { PATH: first };
    configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '1' },
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.PATH).toBe(first);
  });

  it('does NOT prepend the shim in wrapper-producer mode (MATRON_CODEX_PRODUCER=wrapper) but still sets the sink dir', () => {
    // The wrapper is the sole producer here; if the shim were also
    // on PATH the wrapper's internal bare `codex exec` would resolve to it and
    // emit a duplicate card for the same run (the dual-producer bug). The guard
    // keys on the distinct MATRON_CODEX_PRODUCER=wrapper signal, NOT on
    // MATRON_CODEX_REAL_BIN (which a shim-only deployment sets too).
    const spawnEnv = { PATH: '/usr/bin:/bin' };
    const dir = configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '1', MATRON_CODEX_PRODUCER: 'wrapper' },
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    // Sink dir still provisioned (the wrapper writes into it)...
    expect(spawnEnv.MATRON_CODEX_SINK_DIR).toBe(dir);
    // ...but the shim is NOT prepended, so bare `codex` reaches the real codex.
    expect(spawnEnv.PATH).toBe('/usr/bin:/bin');
    expect(spawnEnv.PATH.split(path.delimiter)[0]).not.toBe(SHIPPED_SHIM_DIR);
  });

  it('DOES prepend the shim in the documented shim-only deployment (MATRON_CODEX_REAL_BIN resolves, no wrapper signal)', () => {
    // Regression guard for the reported bug: the shim's own error text tells
    // operators to set MATRON_CODEX_REAL_BIN when stock codex isn't resolvable.
    // That is a SHIM-only deployment (the shim forwards to REAL_BIN), so the shim
    // MUST still be deployed. Keying the guard on REAL_BIN suppressed it here and
    // left the session with no producer at all — the silent empty view.
    // process.execPath is a stand-in REAL_BIN that always resolves.
    const spawnEnv = { PATH: '/usr/bin:/bin' };
    const dir = configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '1', MATRON_CODEX_REAL_BIN: process.execPath },
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.MATRON_CODEX_SINK_DIR).toBe(dir);
    expect(spawnEnv.PATH.split(path.delimiter)[0]).toBe(SHIPPED_SHIM_DIR);
  });

  it('DOES prepend the shim when MATRON_CODEX_REAL_BIN is set but does not resolve (still no wrapper signal)', () => {
    // No wrapper declared, so the shim is the producer regardless of REAL_BIN.
    const spawnEnv = { PATH: '/usr/bin:/bin' };
    configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '1', MATRON_CODEX_REAL_BIN: '/opt/real/does-not-exist' },
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.PATH.split(path.delimiter)[0]).toBe(SHIPPED_SHIM_DIR);
  });

  // The shim-only configuration with MATRON_CODEX_REAL_BIN set must never
  // suppress the shim: without a MATRON_CODEX_PRODUCER=wrapper signal the shim
  // is prepended, and the activation guard, evaluated on the session env, sees
  // it. These are the review's three repro values plus a real binary.
  it.each([
    ['a relative path', 'codex'],
    ['the shim itself', path.join(SHIPPED_SHIM_DIR, 'codex')],
    ['a directory', os.tmpdir()],
    ['a real binary', process.execPath],
  ])('with MATRON_CODEX_REAL_BIN set to %s and no wrapper signal, deploys the shim and the guard sees a producer', (_label, realBin) => {
    const env = { MATRON_CODEX_VIZ: '1', MATRON_CODEX_REAL_BIN: realBin, PATH: '/usr/bin:/bin' };
    const spawnEnv = { ...env };
    expect(detectProducer({ env: spawnEnv })).toBe(false);
    const dir = configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env,
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.MATRON_CODEX_SINK_DIR).toBe(dir);
    expect(spawnEnv.PATH.split(path.delimiter)[0]).toBe(SHIPPED_SHIM_DIR);
    expect(detectProducer({ env: spawnEnv })).toBe(true);
  });

  it('with MATRON_CODEX_PRODUCER=wrapper, skips the shim and the guard still sees the wrapper producer', () => {
    const env = { MATRON_CODEX_VIZ: '1', MATRON_CODEX_PRODUCER: 'wrapper', MATRON_CODEX_REAL_BIN: process.execPath, PATH: '/usr/bin:/bin' };
    const spawnEnv = { ...env };
    configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env,
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.PATH).toBe('/usr/bin:/bin');
    expect(detectProducer({ env: spawnEnv })).toBe(true);
  });

  it('does not touch PATH when visualization is disabled', () => {
    const spawnEnv = { PATH: '/usr/bin', MATRON_CODEX_SINK_DIR: '/inherited' };
    configureCodexSinkEnv({
      spawnEnv,
      workdir: '/w',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '0' },
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    });
    expect(spawnEnv.PATH).toBe('/usr/bin');
  });

  it('deletes an inherited sink when visualization is disabled', () => {
    const spawnEnv = { MATRON_CODEX_SINK_DIR: '/inherited/sink' };
    const mkdirSync = vi.fn();

    configureCodexSinkEnv({
      spawnEnv,
      workdir: '/workspace',
      sessionId: 'sid',
      env: { MATRON_CODEX_VIZ: '0', MATRON_CODEX_SINK_DIR: '/inherited/sink' },
      mkdirSync,
    });

    expect(spawnEnv).not.toHaveProperty('MATRON_CODEX_SINK_DIR');
    expect(mkdirSync).not.toHaveBeenCalled();
  });

});

describe('pruneStaleCodexSinks', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Model the real sink layout: <root>/<sessionId>/codex-runs/<file>. Retention
  // must key off the NEWEST activity (the codex-runs subdir / its files), not the
  // <sessionId> dir mtime, which only tracks creation. Each session in `tree`:
  //   { dir: <ms>, runs: <ms>|undefined, files: { name: <ms> }|undefined }
  function fakeFs(tree) {
    const removed = [];
    const impl = {
      readdirSync: (dir, opts) => {
        if (path.basename(dir) === 'codex-runs') {
          const sid = path.basename(path.dirname(dir));
          const files = tree[sid]?.files;
          if (files === undefined) throw new Error('ENOENT'); // no codex-runs yet
          return Object.keys(files);
        }
        // root listing (the withFileTypes call in the sweep loop)
        expect(opts).toEqual({ withFileTypes: true });
        return Object.keys(tree).map(name => ({ name, isDirectory: () => true }));
      },
      statSync: p => {
        const base = path.basename(p);
        if (base === 'codex-runs') {
          const sid = path.basename(path.dirname(p));
          const m = tree[sid]?.runs;
          if (m === undefined) throw new Error('ENOENT');
          return { mtimeMs: m };
        }
        const parent = path.basename(path.dirname(p));
        if (parent === 'codex-runs') {
          const sid = path.basename(path.dirname(path.dirname(p)));
          const m = tree[sid]?.files?.[base];
          if (m === undefined) throw new Error('ENOENT');
          return { mtimeMs: m };
        }
        // session dir
        const m = tree[base]?.dir;
        if (m === undefined) throw new Error('ENOENT');
        return { mtimeMs: m };
      },
      rmSync: dir => { removed.push(path.basename(dir)); },
    };
    return { removed, impl };
  }

  it('removes only session dirs whose newest activity is older than the retention window', () => {
    const now = () => 100 * DAY;
    const { impl, removed } = fakeFs({
      'fresh-sid': { dir: 99 * DAY }, // 1 day old — keep
      'stale-sid': { dir: 80 * DAY }, // 20 days old — prune
    });
    const count = pruneStaleCodexSinks({ now, maxAgeMs: 7 * DAY, root: '/sinks', fsImpl: impl });
    expect(count).toBe(1);
    expect(removed).toEqual(['stale-sid']);
  });

  it('keeps a session whose dir mtime is old but whose codex-runs child is fresh', () => {
    // The exact case the parent-dir-mtime bug got wrong: a long-lived session
    // started >retention ago but still actively writing runs must NOT be pruned.
    const now = () => 100 * DAY;
    const { impl, removed } = fakeFs({
      'active-old-start': {
        dir: 80 * DAY, // session dir created 20 days ago — stale by dir mtime alone
        runs: 99 * DAY, // ...but codex-runs touched 1 day ago
        files: { 'codex-x.jsonl': 99.5 * DAY }, // newest write 12h ago — fresh
      },
    });
    const count = pruneStaleCodexSinks({ now, maxAgeMs: 7 * DAY, root: '/sinks', fsImpl: impl });
    expect(count).toBe(0);
    expect(removed).toEqual([]);
  });

  it('prunes a session that is stale across the dir AND its codex-runs child', () => {
    const now = () => 100 * DAY;
    const { impl, removed } = fakeFs({
      'stale-sid': {
        dir: 80 * DAY,
        runs: 85 * DAY,
        files: { 'codex-x.jsonl': 85 * DAY }, // newest activity still 15 days old
      },
    });
    const count = pruneStaleCodexSinks({ now, maxAgeMs: 7 * DAY, root: '/sinks', fsImpl: impl });
    expect(count).toBe(1);
    expect(removed).toEqual(['stale-sid']);
  });

  it('returns 0 and never throws when the sink root does not exist', () => {
    const impl = { readdirSync: () => { throw new Error('ENOENT'); } };
    expect(pruneStaleCodexSinks({ now: () => 0, root: '/nope', fsImpl: impl })).toBe(0);
  });

  it('falls back to the default window for a negative/invalid retention (never mass-deletes)', () => {
    // MATRON_CODEX_SINK_RETENTION_MS=-1 is truthy; a negative window would push
    // the cutoff into the FUTURE and delete every sink dir. A fresh sink must
    // survive — with the bug, this prunes it (cutoff = now + 1).
    const now = () => 100 * DAY;
    const { impl, removed } = fakeFs({
      'fresh-sid': { dir: 99.5 * DAY }, // 12h old
    });
    const count = pruneStaleCodexSinks({ now, maxAgeMs: -1, root: '/sinks', fsImpl: impl });
    expect(count).toBe(0);
    expect(removed).toEqual([]);
  });
});

describe('Claude spawn-path sink wiring', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('routes both the print and interactive Claude launches through the sink setup', () => {
    expect(indexSource.match(/launchWithCodexSinkEnv\(\{/g)).toHaveLength(2);
    expect(indexSource).toMatch(/launch: configuredEnv => spawn\('claude',[\s\S]*?env: configuredEnv/);
    expect(indexSource).toMatch(/launch: configuredEnv => createInteractiveSession\(\{[\s\S]*?env: configuredEnv/);
  });

  it.each(['print', 'interactive'])(
    '%s spawn still fires without a sink after mkdirSync fails',
    () => {
      const spawnEnv = { MATRON_CODEX_SINK_DIR: '/inherited/sink' };
      const launch = vi.fn(env => ({ env }));
      const warn = vi.fn();

      const result = launchWithCodexSinkEnv({
        spawnEnv,
        workdir: '/workspace',
        sessionId: 'sid',
        launch,
        configureOptions: {
          env: { MATRON_CODEX_VIZ: '1' },
          mkdirSync: () => { throw new Error('EACCES'); },
          warn,
        },
      });

      expect(launch).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledWith(spawnEnv);
      expect(result).toEqual({ env: spawnEnv });
      expect(spawnEnv).not.toHaveProperty('MATRON_CODEX_SINK_DIR');
      expect(warn).toHaveBeenCalledWith(
        '[codex-viz] sink dir setup failed, viz disabled for this session: EACCES',
      );
    },
  );

  it.each(['print', 'interactive'])(
    '%s spawn removes an inherited sink when visualization is disabled',
    () => {
      const spawnEnv = { MATRON_CODEX_SINK_DIR: '/inherited/sink' };
      const launch = vi.fn();

      launchWithCodexSinkEnv({
        spawnEnv,
        workdir: '/workspace',
        sessionId: 'sid',
        launch,
        configureOptions: {
          env: { MATRON_CODEX_VIZ: '0', MATRON_CODEX_SINK_DIR: '/inherited/sink' },
          mkdirSync: vi.fn(),
        },
      });

      expect(launch).toHaveBeenCalledOnce();
      expect(spawnEnv).not.toHaveProperty('MATRON_CODEX_SINK_DIR');
    },
  );
});

// New Chat's Claude/Codex switch is offered only on boxes that can actually
// start Codex. The bridge spawns a bare `codex` from its own PATH, so that is
// what is checked — with the shipped viz shim excluded, because a shim with
// no real codex behind it forwards to nothing.
describe('detectCodexBinary', () => {
  // Real files, not a fake realpath: detectCodexBinary reuses the shim's own
  // resolveRealCodex, which checks for an executable regular file.
  let root;
  const SHIM = path.join(SHIPPED_SHIM_DIR, 'codex');
  const exe = (p) => { writeFileSync(p, '#!/bin/sh\nexit 0\n'); chmodSync(p, 0o755); return p; };
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'detect-codex-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is true when an executable non-shim codex is on PATH', () => {
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    exe(path.join(bin, 'codex'));
    expect(detectCodexBinary({ env: { PATH: bin } })).toBe(true);
  });

  it('is false when the only codex on PATH is the shipped shim', () => {
    expect(detectCodexBinary({ env: { PATH: SHIPPED_SHIM_DIR } })).toBe(false);
  });

  it('is false when the only codex on PATH is a symlink to the shipped shim', () => {
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    symlinkSync(SHIM, path.join(bin, 'codex'));
    expect(detectCodexBinary({ env: { PATH: bin } })).toBe(false);
  });

  it('is true when MATRON_CODEX_REAL_BIN is an absolute executable file, whatever PATH holds', () => {
    const real = exe(path.join(root, 'codex-real'));
    expect(detectCodexBinary({ env: { PATH: '', MATRON_CODEX_REAL_BIN: real } })).toBe(true);
  });

  it.each([
    ['a missing path', (r) => path.join(r, 'nope')],
    ['an existing directory', (r) => r],
    ['a non-executable file', (r) => { const p = path.join(r, 'codex-noexec'); writeFileSync(p, 'x'); chmodSync(p, 0o644); return p; }],
    ['a relative path', () => 'codex'],
    ['the shim itself', () => SHIM],
  ])('ignores MATRON_CODEX_REAL_BIN set to %s', (_label, make) => {
    const realBin = make(root);
    expect(detectCodexBinary({ env: { PATH: '', MATRON_CODEX_REAL_BIN: realBin } })).toBe(false);
  });

  it('does not block on a FIFO named codex on PATH', () => {
    const fifoDir = path.join(root, 'fifo'); mkdirSync(fifoDir);
    const fifo = path.join(fifoDir, 'codex');
    const mk = spawnSync('mkfifo', [fifo]);
    expect(mk.status).toBe(0);
    chmodSync(fifo, 0o755);
    // Run in a child so a regression (a blocking open) fails on the timeout
    // instead of hanging the test worker.
    const script = `
      import { detectCodexBinary } from ${JSON.stringify(path.resolve('lib/codex-paths.js'))};
      process.stdout.write(String(detectCodexBinary({ env: { PATH: ${JSON.stringify(fifoDir)} } })));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('false');
  });

  it('skips a directory or non-executable `codex` on PATH', () => {
    const dirBin = path.join(root, 'a'); mkdirSync(path.join(dirBin, 'codex'), { recursive: true });
    const noexecBin = path.join(root, 'b'); mkdirSync(noexecBin);
    writeFileSync(path.join(noexecBin, 'codex'), 'x'); chmodSync(path.join(noexecBin, 'codex'), 0o644);
    expect(detectCodexBinary({ env: { PATH: [dirBin, noexecBin].join(path.delimiter) } })).toBe(false);
  });
});
