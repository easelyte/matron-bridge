// Regression guard for test/setup-isolated-home.js: the suite must never see
// the developer's real home, so nothing derived from os.homedir() can touch
// the real ~/.claude/projects.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { projectDirFor, subagentsDirFor } from '../lib/transcript-dir.js';
import { codexSinksRoot } from '../lib/codex-paths.js';
import { isolatedHomeEnv } from './helpers/home-env.js';

const realHome = process.env.MATRON_TEST_REAL_HOME;
const under = (p, root) => path.resolve(p).startsWith(path.resolve(root) + path.sep);

describe('isolated test home', () => {
  it('os.homedir() is a temp dir, not the real home', () => {
    expect(realHome).toBeTruthy();
    expect(os.homedir()).not.toBe(realHome);
    expect(under(os.homedir(), os.tmpdir())).toBe(true);
    expect(process.env.HOME).toBe(os.homedir());
  });

  it('Claude project + subagent dirs resolve under the fake home', () => {
    const workdir = '/root/.openclaw/workspace';
    expect(under(projectDirFor(workdir), os.homedir())).toBe(true);
    expect(under(subagentsDirFor(workdir, 'sid-1'), os.homedir())).toBe(true);
    expect(under(projectDirFor(workdir), realHome)).toBe(false);
  });

  it('the codex-viz sink root resolves under the fake home', () => {
    expect(under(codexSinksRoot(), os.homedir())).toBe(true);
  });

  const childHome = (env) => spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, encoding: 'utf8' }).stdout;

  it('child processes inherit the fake home', () => {
    expect(childHome(process.env)).toBe(os.homedir());
  });

  it('a from-scratch child env gets the fake home via isolatedHomeEnv()', () => {
    const env = { PATH: process.env.PATH, ...isolatedHomeEnv() };
    expect(childHome(env)).toBe(os.homedir());
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), '.claude'));
  });
});
