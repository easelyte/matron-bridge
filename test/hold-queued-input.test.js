import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORK_HOLD_MAX_MS, workHold } from '../lib/work-hold.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const T0 = 1_700_000_000_000;

function source(name) {
  const start = index.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = index.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return index.slice(start, end + 2);
}

function restartHolds(session, unreadable) {
  const table = unreadable ? Object.assign([], { unreadable: true }) : [];
  // Compile the real adapter too, so the readable-table path must forward
  // the signal all the way to workHold.
  const sessionWorkHold = new Function('workHold', 'liveWorkChildren', 'sessionChildPid', 'MCP_SERVER_SIGNATURES',
    `${source('sessionWorkHold')}; return sessionWorkHold;`)(workHold, () => [], () => 200, []);
  return new Function('sessions', 'readProcessTable', 'handoffIdleSince', 'sessionWorkHold', 'workHold', 'debug', 'Date',
    `${source('sessionsHoldingRestart')}; return sessionsHoldingRestart();`)(
    new Map([[session.roomId, session]]), () => table, s => s.lastActivity,
    sessionWorkHold, workHold, () => {}, { now: () => T0 },
  );
}

describe.each([false, true])('queued input holds a restart (unreadable process table: %s)', unreadable => {
  const pending = [
    ['queuedMessages', ['message']],
    ['_resumeOutbox', ['message']],
    ['_awaitingInputReady', true],
  ];

  it.each(pending)('holds an idle live session with %s', (field, value) => {
    const session = { roomId: 'room', alive: true, busy: false, lastActivity: T0, [field]: value };
    expect(restartHolds(session, unreadable)).toEqual({
      holders: [{ session, reason: 'input queued for delivery' }], unreadable,
    });
  });

  it.each([
    ['queuedMessages', []],
    ['_resumeOutbox', []],
    ['_awaitingInputReady', false],
    ['queuedMessages', undefined],
  ])('does not hold an idle session with empty or absent %s', (field, value) => {
    const session = { roomId: 'room', alive: true, busy: false, lastActivity: T0, [field]: value };
    expect(restartHolds(session, unreadable)).toEqual({ holders: [], unreadable });
  });

  it.each(pending)('releases %s at the age cap', (field, value) => {
    const session = { roomId: 'room', alive: true, busy: false, lastActivity: T0 - WORK_HOLD_MAX_MS, [field]: value };
    expect(restartHolds(session, unreadable)).toEqual({ holders: [], unreadable });
  });
});

it('does not pass queuedInput from the idle reaper', () => {
  expect(source('startIdleReaper')).not.toContain('queuedInput');
});
