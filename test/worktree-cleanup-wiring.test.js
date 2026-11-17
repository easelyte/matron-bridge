import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (see start-model-flag-wiring.test.js),
// so the wiring of worktree sessions is pinned by source inspection. The
// behaviour itself is tested in worktree*.test.js.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function block(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

describe('worktree clean-up wiring in index.js', () => {
  it('the picker, box status and the clean-up RPC are wired to the cleanup service', () => {
    expect(indexSource).toContain('describeWorktrees: () => worktreeCleanup.describe()');
    expect(indexSource).toContain('worktreeCleanup: (args) => worktreeCleanup.cleanup(args)');
    expect(indexSource).toContain('worktreeCleanup.summary()');
  });

  it('a discard asks through a step-up question and verifies a signed tap', () => {
    const wiring = block('const worktreeCleanup = createCleanupService(', 'function persistSession(');
    expect(wiring).toContain('discardQuestion(args)');
    expect(wiring).toContain('verifyDiscardTap(');
    expect(wiring).toContain('step_up_ignored');
  });
});
