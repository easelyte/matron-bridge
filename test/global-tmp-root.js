// Vitest globalSetup: give the whole run one private temp root.
//
// Tests (and the per-file sandbox HOME from test/setup-isolated-home.js) create
// their scratch dirs under os.tmpdir(). A test that forgets to clean up, or a
// file that is skipped wholesale (vitest does not run afterAll hooks for a file
// whose tests are all skipped), would otherwise leave the directory in the
// machine's /tmp forever. Pointing TMPDIR at a run-scoped directory before any
// worker spawns means os.tmpdir() in every worker and child process resolves
// inside it, and teardown removes the lot. Per-test cleanup is still expected;
// this is the backstop.
//
// A run that is killed outright (SIGKILL, CI timeout) never reaches teardown
// and leaves its root behind, so each run also sweeps roots from earlier runs
// that are older than a day. The age guard keeps it clear of a concurrent run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'bridge-vitest-run-';
const STALE_MS = 24 * 60 * 60 * 1000;

function sweepStaleRoots(base) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(base, name);
    try {
      const st = fs.lstatSync(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Raced with another run's teardown; nothing to do.
    }
  }
}

export default function setup() {
  const previous = process.env.TMPDIR;
  const base = os.tmpdir();
  sweepStaleRoots(base);
  const root = fs.mkdtempSync(path.join(base, PREFIX));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
