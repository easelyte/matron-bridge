import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subagentsDirFor } from '../lib/subagent-watcher.js';
import {
  codexRunsDirFor,
  configureCodexSinkEnv,
  launchWithCodexSinkEnv,
} from '../lib/codex-paths.js';

describe('codexRunsDirFor', () => {
  it('uses the same encoded session parent as the subagents directory', () => {
    const workdir = '/root/.openclaw/workspace';
    const sessionId = 'abc-123';
    const dir = codexRunsDirFor(workdir, sessionId);

    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'projects', '-root--openclaw-workspace', sessionId, 'codex-runs',
    ) + path.sep);
    expect(path.dirname(dir)).toBe(path.dirname(subagentsDirFor(workdir, sessionId)));
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
