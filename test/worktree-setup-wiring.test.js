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

describe('worktree setup wiring in index.js', () => {
  it('a tap on the setup approval card is the bridge\'s, not a turn for the agent', () => {
    const onItem = block('function journalOnItem(', 'itemTurnRouter(session, item, ctx)');
    expect(onItem).toContain('worktreeSetup.isCardReply(item?.payload)');
  });

  it('the consent card is filed after the session exists', () => {
    const start = block("case '!start':", "case '!stop':");
    expect(start.indexOf('fileWorktreeConsentCard(session')).toBeGreaterThan(start.indexOf('createSession('));
  });
});
