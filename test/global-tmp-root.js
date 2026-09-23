// Vitest globalSetup: give the whole run one private temp root.
//
// Tests (and the per-file sandbox HOME from test/setup-isolated-home.js) create
// their scratch dirs under os.tmpdir(). A test that forgets to clean up, is
// killed mid-run, or is skipped wholesale (vitest does not run afterAll hooks
// for a file whose tests are all skipped) would otherwise leave the directory
// in the machine's /tmp forever. Pointing TMPDIR at a run-scoped directory
// before any worker spawns means os.tmpdir() in every worker and child process
// resolves inside it, and teardown removes the lot. Per-test cleanup is still
// expected; this is the backstop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup() {
  const previous = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vitest-run-'));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
