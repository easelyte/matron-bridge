// Safe teardown for tests that create real Claude Code project dirs.
//
// subagentsDirFor(workdir, sid) is ~/.claude/projects/<enc>/<sid>/subagents.
// Walking up from it with a dirname chain is an easy off-by-one: three
// dirnames reach ~/.claude/projects ITSELF, and a recursive rm of that wipes
// every session transcript and project memory on the machine. Tests register
// projectDirFor(workdir) instead, and every removal goes through
// assertRemovableProjectRoot, which refuses anything that is not exactly one
// encoded project dir directly under ~/.claude/projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDirFor, subagentsDirFor } from '../../lib/transcript-dir.js';

export function claudeProjectsRoot() {
  return path.resolve(os.homedir(), '.claude', 'projects');
}

// Throws unless `d` is a single encoded project dir directly under
// ~/.claude/projects (never the projects root, home, or anything outside).
// `prefix`, when given, must match the start of the encoded dir name.
export function assertRemovableProjectRoot(d, { prefix } = {}) {
  const root = claudeProjectsRoot();
  const r = path.resolve(d);
  const name = path.basename(r);
  if (path.dirname(r) !== root || !name || name === '.' || name === '..') {
    throw new Error(`refusing to remove ${r}: not a single project dir directly under ${root}`);
  }
  if (prefix && !name.startsWith(prefix)) {
    throw new Error(`refusing to remove ${r}: project dir name does not start with ${prefix}`);
  }
  return r;
}

// Create the real subagents dir for (workdir, sessionId) and register its
// encoded project dir (…/projects/<enc>) in `roots` for teardown. The project
// dir is created EXCLUSIVELY (non-recursive mkdir, EEXIST throws), so teardown
// only ever removes a dir this test created — never a pre-existing project.
export function makeSubagentsDir(workdir, sessionId, roots, opts) {
  const dir = subagentsDirFor(workdir, sessionId);
  const projectRoot = assertRemovableProjectRoot(projectDirFor(workdir), opts);
  fs.mkdirSync(claudeProjectsRoot(), { recursive: true });
  fs.mkdirSync(projectRoot); // throws EEXIST for a dir we did not create
  roots.push(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Remove every registered project root. The guard runs OUTSIDE any try/catch:
// a bad root must fail the test loudly, never be silently skipped or removed.
export function removeProjectRoots(roots, opts) {
  for (const d of roots.splice(0)) {
    const safe = assertRemovableProjectRoot(d, opts);
    fs.rmSync(safe, { recursive: true, force: true });
  }
}
