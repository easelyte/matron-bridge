import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js for the shutdown and listen-time guards.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = index.indexOf(from);
  expect(start, `${from} is missing from index.js`).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf(to, start + 1));
};

describe('input guards across awaits', () => {
  it('journalOnCoordinator re-checks shutdown after its awaits', () => {
    const fn = between('async function journalOnCoordinator(', '\nasync function deliverCoordinatorTurn(');
    const lookup = fn.indexOf('findSessionByClaudeSessionId(convoId)');
    const guard = fn.indexOf('if (shuttingDown) return;');
    expect(guard).toBeGreaterThan(fn.lastIndexOf('await ', lookup));
    expect(guard).toBeLessThan(fn.indexOf('decideCoordinatorEvent({'));
  });

  it('runPreReapHandoff re-checks shutdown with the session guard after its awaits', () => {
    const fn = between('async function runPreReapHandoff(', '\nfunction drainPreReapCompact(');
    expect(fn).toMatch(/if \(shuttingDown \|\| sessions\.get\(roomId\) !== session \|\| !session\.alive \|\| session\._autoStopped \|\| !session\._preReapHandoff\) return;/);
  });
});

describe('listen-time restart token failure', () => {
  it('keeps the carry-on cards and logs loudly instead of silently dropping them', () => {
    const listen = between('apiServer.listen(API_PORT,', 'Local API listening');
    const tokenCatch = listen.slice(listen.indexOf("catch {\n      plannedRestartAvailable = false;"), listen.indexOf('if (plannedRestartAvailable) {\n    try { restartBoot'));
    expect(tokenCatch).toContain('restartBoot = null;');
    expect(tokenCatch).toContain('publishRestartCarryOnCards();');
    expect(tokenCatch).toContain("console.error('[restart] token initialization failed; planned restart unavailable');");
  });
});

describe('/wake availability', () => {
  it('is unavailable while shutting down or a restart is latched', () => {
    const handler = between('const handleWake = createWakeHandler({', '\nconst handleSendAttachment');
    expect(handler).toContain('unavailable: () => shuttingDown || plannedRestartRuntime.stamped === true,');
  });
});
