import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { subagentsDirFor } from '../lib/subagent-watcher.js';
import { codexRunsDirFor, configureCodexSinkEnv } from '../lib/codex-paths.js';

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

  it('fails open when directory creation throws and allows spawn to proceed', () => {
    const spawnEnv = { MATRON_CODEX_SINK_DIR: '/inherited/sink' };
    const warn = vi.fn();
    const spawn = vi.fn();

    expect(() => {
      configureCodexSinkEnv({
        spawnEnv,
        workdir: '/workspace',
        sessionId: 'sid',
        env: {},
        mkdirSync: () => { throw new Error('EACCES'); },
        warn,
      });
      spawn('claude', { env: spawnEnv });
    }).not.toThrow();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawnEnv).not.toHaveProperty('MATRON_CODEX_SINK_DIR');
    expect(warn).toHaveBeenCalledWith(
      '[codex-viz] sink dir setup failed, viz disabled for this session: EACCES',
    );
  });
});
