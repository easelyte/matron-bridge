import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDirFor, subagentsDirFor } from '../lib/transcript-dir.js';
import {
  assertRemovableProjectRoot,
  claudeProjectsRoot,
  makeSubagentsDir,
  removeProjectRoots,
} from './helpers/project-root.js';

// Regression: the subagent-watcher tests once registered
// dirname(dirname(dirname(subagentsDirFor(...)))) for teardown. That is
// ~/.claude/projects itself, so afterEach recursively deleted every project
// dir on the machine whenever HOME was not sandboxed.
describe('project-root teardown guard', () => {
  const roots = [];
  afterEach(() => removeProjectRoots(roots));

  const workdir = () => `/tmp/bridge-rmguard-${process.pid}-${Math.random().toString(36).slice(2)}`;

  it('refuses the ~/.claude/projects root the old dirname chain produced', () => {
    const dir = subagentsDirFor(workdir(), 'sid-1');
    const oldRoot = path.dirname(path.dirname(path.dirname(dir)));
    expect(path.resolve(oldRoot)).toBe(claudeProjectsRoot());
    expect(() => assertRemovableProjectRoot(oldRoot)).toThrow(/refusing/);
  });

  it('refuses home, paths outside projects, and paths nested below a project dir', () => {
    const w = workdir();
    expect(() => assertRemovableProjectRoot(os.homedir())).toThrow(/refusing/);
    expect(() => assertRemovableProjectRoot(path.join(os.homedir(), '.claude'))).toThrow(/refusing/);
    expect(() => assertRemovableProjectRoot('/')).toThrow(/refusing/);
    expect(() => assertRemovableProjectRoot(path.join(claudeProjectsRoot(), '..'))).toThrow(/refusing/);
    expect(() => assertRemovableProjectRoot(path.dirname(subagentsDirFor(w, 'sid-1')))).toThrow(/refusing/);
  });

  it('enforces the optional encoded-name prefix', () => {
    const d = projectDirFor(workdir());
    expect(assertRemovableProjectRoot(d, { prefix: '-tmp-bridge-rmguard-' })).toBe(path.resolve(d));
    expect(() => assertRemovableProjectRoot(d, { prefix: '-tmp-other-' })).toThrow(/prefix|refusing/);
  });

  it('makeSubagentsDir registers exactly projectDirFor(workdir), never the projects root', () => {
    const w = workdir();
    const dir = makeSubagentsDir(w, 'sid-2', roots);
    expect(fs.existsSync(dir)).toBe(true);
    expect(roots).toEqual([path.resolve(projectDirFor(w))]);
    expect(roots[0]).not.toBe(claudeProjectsRoot());
  });

  it('removeProjectRoots removes only the registered project dir and leaves siblings intact', () => {
    const keep = projectDirFor(workdir());
    fs.mkdirSync(keep, { recursive: true });
    try {
      const w = workdir();
      makeSubagentsDir(w, 'sid-3', roots);
      removeProjectRoots(roots);
      expect(fs.existsSync(projectDirFor(w))).toBe(false);
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(claudeProjectsRoot())).toBe(true);
    } finally {
      fs.rmSync(assertRemovableProjectRoot(keep), { recursive: true, force: true });
    }
  });

  it('makeSubagentsDir refuses to adopt a project dir that already exists', () => {
    const w = workdir();
    const existing = projectDirFor(w);
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'keep.jsonl'), 'x');
    try {
      expect(() => makeSubagentsDir(w, 'sid-4', roots)).toThrow(/EEXIST/);
      expect(roots).toEqual([]);
      expect(fs.existsSync(path.join(existing, 'keep.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(assertRemovableProjectRoot(existing), { recursive: true, force: true });
    }
  });

  it('removeProjectRoots throws (and removes nothing) for an unsafe root', () => {
    fs.mkdirSync(claudeProjectsRoot(), { recursive: true });
    const bad = [claudeProjectsRoot()];
    expect(() => removeProjectRoots(bad)).toThrow(/refusing/);
    expect(fs.existsSync(claudeProjectsRoot())).toBe(true);
  });
});
