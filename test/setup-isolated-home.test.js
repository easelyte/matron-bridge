import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectsRoot } from './helpers/project-root.js';

describe('test home isolation', () => {
  it('points os.homedir() at a temp dir, not the real home', () => {
    const real = process.env.MATRON_TEST_REAL_HOME;
    expect(real).toBeTruthy();
    expect(path.resolve(os.homedir())).not.toBe(path.resolve(real));
    expect(path.basename(os.homedir())).toMatch(/^bridge-test-home-/);
  });

  it('derives ~/.claude/projects inside the sandbox', () => {
    expect(claudeProjectsRoot().startsWith(os.homedir() + path.sep)).toBe(true);
  });

  it('redirects XDG, codex and claude config dirs too', () => {
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
      expect(process.env[key].startsWith(os.homedir() + path.sep)).toBe(true);
    }
  });
});
