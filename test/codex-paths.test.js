import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexRunsDirFor,
  configureCodexSinkEnv,
  launchWithCodexSinkEnv,
} from '../lib/codex-paths.js';

describe('codexRunsDirFor', () => {
  it('anchors the sink to the sessionId, outside the encoded-cwd project tree', () => {
    const sessionId = 'abc-123';
    const dir = codexRunsDirFor('/root/.openclaw/workspace', sessionId);

    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'matron', 'codex-sinks', sessionId, 'codex-runs',
    ) + path.sep);
    // Must NOT live under Claude Code's `projects/` tree, which is re-homed on
    // cwd change (EnterWorktree) and would orphan the frozen sink env (#630).
    expect(dir).not.toContain(`${path.sep}projects${path.sep}`);
  });

  it('yields the SAME sink dir for a worktree cwd as for the main cwd (loop #630)', () => {
    const sessionId = '00000000-1111-2222-3333-444444444444';
    const mainCwd = '/root/workspace';
    const worktreeCwd = '/root/workspace/.claude/worktrees/feature-x';

    // A session that starts in main and later EnterWorktree's must resolve the
    // same sink path on both sides, so producer-write == watcher-watch survives
    // the cwd change. Parity here is what a card actually depends on.
    expect(codexRunsDirFor(worktreeCwd, sessionId))
      .toBe(codexRunsDirFor(mainCwd, sessionId));
  });
});

describe('configureCodexSinkEnv', () => {
  it('injects an existing session-scoped sibling directory', () => {
    const spawnEnv = {};
    const mkdirSync = vi.fn();
    const dir = configureCodexSinkEnv({
      spawnEnv,
      workdir: '/root/.openclaw/workspace',
      sessionId: 'abc-123',
      env: {},
      mkdirSync,
    });

    expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    expect(spawnEnv.MATRON_CODEX_SINK_DIR).toBe(dir);
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
          env: {},
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
