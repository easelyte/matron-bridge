import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These paths live in index.js and lean on module-scope state, so they are
// pinned by source inspection like the neighbouring *-wiring tests.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function fnBody(header) {
  const start = index.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start) + 2);
}

describe('work that straddles an await stands down once the bridge is shutting down', () => {
  it("a Codex child's exit during shutdown is torn down quietly and keeps the queue", () => {
    const start = index.indexOf("codex.on('turn-exit'");
    expect(start).toBeGreaterThan(-1);
    const handler = index.slice(start, index.indexOf('\n  });\n', start));
    const guard = handler.indexOf('if (shuttingDown || !session.alive) {');
    expect(guard).toBeGreaterThan(-1);
    // The teardown branch comes before the error / queue-flushing paths.
    expect(guard).toBeLessThan(handler.indexOf('finishCodexTurn(session, { error:'));
    const branch = handler.slice(guard, handler.indexOf('return;', guard));
    expect(branch).toContain('discardOutput: true');
    expect(branch).toContain('preserveQueue: shuttingDown');
  });

  it('journalOnCoordinator returns after its journal lookup when shutting down', () => {
    const fn = fnBody('async function journalOnCoordinator(');
    const guard = fn.indexOf('if (shuttingDown) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(fn.indexOf('await memoryLookup.refresh'));
    expect(guard).toBeLessThan(fn.indexOf('findSessionByClaudeSessionId(convoId)'));
  });

  it('runPreReapHandoff re-checks shuttingDown after its mission lookup, before sending the turn', () => {
    const fn = fnBody('async function runPreReapHandoff(');
    const recheck = fn.indexOf('if (shuttingDown || sessions.get(roomId) !== session');
    expect(recheck).toBeGreaterThan(fn.indexOf('await missionsHandlers.resolveMission'));
    expect(recheck).toBeLessThan(fn.indexOf('sendTextToSession('));
  });
});
