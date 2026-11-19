import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORK_HOLD_MAX_MS, liveWorkChildren, workHold } from '../lib/work-hold.js';
import { handoffIdleSince } from '../lib/pre-reap-handoff.js';

// Execute the restart holder decision without booting the bridge.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const now = 1_700_000_000_000;

function functionSource(name) {
  const start = index.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start) + 3);
}

const sessionWorkHold = new Function('workHold', 'liveWorkChildren', 'sessionChildPid', 'MCP_SERVER_SIGNATURES', `
  ${functionSource('sessionWorkHold')}
  return sessionWorkHold;
`)(workHold, liveWorkChildren, () => null, []);

function holders(session, unreadable) {
  const table = unreadable ? Object.assign([], { unreadable: true }) : [];
  const make = new Function('sessions', 'readProcessTable', 'handoffIdleSince', 'sessionWorkHold', 'workHold', 'debug', 'Date', `
    ${functionSource('sessionsHoldingRestart')}
    return sessionsHoldingRestart();
  `);
  return make(new Map([['room', session]]), () => table, handoffIdleSince, sessionWorkHold, workHold, () => {}, { now: () => now }).holders;
}

describe('a pending answer holds a bridge update or requested restart', () => {
  for (const unreadable of [false, true]) {
    describe(`process table ${unreadable ? 'unreadable' : 'readable'}`, () => {
      for (const prompt of [
        { pendingInteractivePrompt: { type: 'permission' } },
        { pendingUnclassifiedPrompt: true },
        { waitingForAnswer: 'text' },
      ]) {
        it(`holds for ${Object.keys(prompt)[0]} under the age cap`, () => {
          const session = { alive: true, busy: false, lastActivityAt: now - WORK_HOLD_MAX_MS + 1, ...prompt };
          expect(holders(session, unreadable)).toEqual([{ session, reason: 'waiting for an answer' }]);
        });

        it(`releases ${Object.keys(prompt)[0]} at the age cap`, () => {
          for (const age of [WORK_HOLD_MAX_MS, WORK_HOLD_MAX_MS + 1]) {
            const session = { alive: true, busy: false, lastActivityAt: now, ...prompt, _preReapHandoff: { idleSince: now - age } };
            expect(holders(session, unreadable)).toEqual([]);
          }
        });
      }

      it('does not hold a session with no pending prompt', () => {
        expect(holders({ alive: true, busy: false, lastActivityAt: now }, unreadable)).toEqual([]);
      });
    });
  }

  it('does not opt the idle reaper into awaiting-answer holds', () => {
    expect(functionSource('startIdleReaper')).not.toContain('awaitingAnswer');
  });
});
