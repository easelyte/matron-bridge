// Vitest setupFiles entry: every test file runs with a throwaway HOME.
//
// Several bridge modules derive real, destructive paths from the user's home
// (~/.claude/projects/<encoded workdir> via lib/transcript-dir.js, the codex-viz
// sink root via lib/codex-paths.js, ~/.claude-matrix-uploads, ~/matron-files).
// A test that exercises cleanup on one of those, or a module that mkdirs/rms at
// import time, must never reach the developer's real home: on 2026-09-19,
// 2026-09-20 and 2026-09-23 a suite run on a dev box removed the real
// ~/.claude/projects/<workspace> directory (session transcripts + project
// memory). This file points HOME and friends at a fresh temp dir before the test
// file (and anything it imports) loads, so os.homedir() and every path derived
// from it land in the sandbox. Children inherit it through process.env; a test
// that builds a child env from scratch must spread isolatedHomeEnv() from
// test/helpers/home-env.js into it.
//
// On POSIX os.homedir() follows $HOME; USERPROFILE is the Windows equivalent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const realHome = os.homedir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-home-'));

process.env.MATRON_TEST_REAL_HOME = realHome;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');
process.env.XDG_DATA_HOME = path.join(fakeHome, '.local', 'share');
process.env.XDG_CACHE_HOME = path.join(fakeHome, '.cache');
process.env.XDG_STATE_HOME = path.join(fakeHome, '.local', 'state');
// Explicit, so a child handed these (test/helpers/home-env.js) cannot fall back
// to anything outside the sandbox.
process.env.CODEX_HOME = path.join(fakeHome, '.codex');
process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude');

if (path.resolve(os.homedir()) === path.resolve(realHome) && realHome !== fakeHome) {
  throw new Error(`setup-isolated-home: os.homedir() still resolves to the real home (${realHome})`);
}

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});
