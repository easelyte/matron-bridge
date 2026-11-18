import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  workHold,
  liveWorkChildren,
  WORK_HOLD_MAX_MS,
} from '../lib/work-hold.js';
import { createCodeUpdateWatcher } from '../lib/code-update-restart.js';

// Verification table for the restart quiet rule (one test per difference
// between a stricter "quiet" rule and what this tree holds a restart for).
// Each test asserts what upstream actually does today: whether the session
// holds the restart or not. A test name starts with `gap:` and the row it
// pins; the result, not the expectation, classifies the row.
//
// sessionsHoldingRestart lives in index.js, which cannot be imported, so its
// own text is sliced out and compiled with the few collaborators it reads
// injected. The production body runs; only its inputs are fakes.

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function sliceFunction(name) {
  const start = index.indexOf(`function ${name}(`);
  expect(start, `function ${name} is missing from index.js`).toBeGreaterThan(-1);
  const end = index.indexOf('\n}\n', start);
  return index.slice(start, end + 3);
}

const NOW = Date.parse('2026-11-18T12:00:00Z');
const H = 3600 * 1000;

// Build sessionsHoldingRestart over fake sessions. `table` is the process
// table ps would give ({pid, ppid, args} rows, or an unreadable marker).
function holdersFor(sessionList, { table = [], unreadable = false, now = NOW } = {}) {
  const sessions = new Map(sessionList.map((s, i) => [`room${i}`, s]));
  const processTable = Object.assign([...table], unreadable ? { unreadable: true } : {});
  const factory = new Function(
    'sessions', 'readProcessTable', 'handoffIdleSince', 'sessionWorkHold', 'workHold', 'debug', 'Date',
    `${sliceFunction('sessionsHoldingRestart')}\nreturn sessionsHoldingRestart;`,
  );
  const fakeDate = { now: () => now };
  const sessionWorkHold = (session, last, at, t) => workHold({
    busy: !!session.busy,
    children: liveWorkChildren(session.pid, t, []),
    idleSince: last,
    now: at,
    subagentCount: session.subagentConvos?.runningCount() ?? 0,
  });
  const fn = factory(
    sessions,
    () => processTable,
    (s) => s.idleSince ?? now,
    sessionWorkHold,
    workHold,
    () => {},
    fakeDate,
  );
  return fn();
}

const live = (extra = {}) => ({ alive: true, busy: false, roomId: '!r', pid: 100, ...extra });

describe('restart hold gaps: what upstream holds a restart for', () => {
  it('control: a running turn holds', () => {
    const { holders } = holdersFor([live({ busy: true })]);
    expect(holders.map((h) => h.reason)).toEqual(['turn in progress']);
  });

  it('gap: pending interactive prompt (busy is cleared when the prompt arrives)', () => {
    // iv.on('prompt') sets busy=false on purpose; the turn resumes on the answer.
    const handler = index.slice(index.indexOf("iv.on('prompt'"), index.indexOf("iv.on('parseError'"));
    expect(handler).toMatch(/session\.busy = false;/);
    const { holders } = holdersFor([live({ pendingInteractivePrompt: { kind: 'permission', question: 'Allow?' } })]);
    expect(holders).toHaveLength(0);
  });

  it('gap: pending unclassified prompt', () => {
    const { holders } = holdersFor([live({ pendingUnclassifiedPrompt: true })]);
    expect(holders).toHaveLength(0);
  });

  it('gap: awaited answer (waitingForAnswer)', () => {
    const { holders } = holdersFor([live({ waitingForAnswer: true })]);
    expect(holders).toHaveLength(0);
  });

  it('gap: queued input (queuedMessages, resume outbox, awaiting input ready)', () => {
    const { holders } = holdersFor([
      live({ queuedMessages: [[{ type: 'text', text: 'next' }]] }),
      live({ _resumeOutbox: [{ text: 'x' }] }),
      live({ _awaitingInputReady: true }),
    ]);
    expect(holders).toHaveLength(0);
  });

  it('gap: in-flight input (a message or media still being delivered, busy not yet set)', () => {
    // Upstream keeps no in-flight input counter; a session between receipt and
    // the first turn event has busy=false and no child.
    expect(index).not.toMatch(/createInputCounter|inFlightInputs|inputCounter/);
    const { holders } = holdersFor([live()]);
    expect(holders).toHaveLength(0);
  });

  it('gap: Codex exec detached process group (reparented away from the session tree)', () => {
    // A detached group (setsid) is reparented to init: no ppid chain to the
    // session's child pid, so the descendant walk does not see it.
    const table = [
      { pid: 100, ppid: 1, args: 'codex exec' },
      { pid: 500, ppid: 1, args: 'node long-running-build.js' },
      { pid: 501, ppid: 500, args: 'sleep 3600' },
    ];
    const { holders } = holdersFor([live({ pid: 100 })], { table });
    expect(holders).toHaveLength(0);
    // control: the same worker as a descendant does hold.
    const attached = [{ pid: 100, ppid: 1, args: 'codex exec' }, { pid: 500, ppid: 100, args: 'node long-running-build.js' }];
    expect(holdersFor([live({ pid: 100 })], { table: attached }).holders).toHaveLength(1);
  });

  it('gap: subagent from the current boot holds', () => {
    const subagentConvos = { runningCount: () => 1 };
    const { holders } = holdersFor([live({ subagentConvos })]);
    expect(holders.map((h) => h.reason)).toEqual(['1 subagent still running']);
  });

  it('gap: Codex native subagent (app-server child thread, outside subagentConvos)', () => {
    // Native children are recorded by lib/codex-app-wiring.js in its own map
    // and running store; no hold path reads them, so an idle parent with a
    // running native child is not a holder, with a readable or unreadable ps.
    const wiring = readFileSync(new URL('../lib/codex-app-wiring.js', import.meta.url), 'utf8');
    expect(wiring).toMatch(/runningStore\?\.add\(childId/);
    const session = live({ codex: { transport: 'app-server', childThreads: new Map([['t1', { running: true }]]) } });
    expect(holdersFor([session]).holders).toHaveLength(0);
    expect(holdersFor([session], { unreadable: true }).holders).toHaveLength(0);
    const body = sliceFunction('sessionsHoldingRestart') + sliceFunction('sessionWorkHold');
    expect(body).not.toMatch(/childThreads|runningStore|codex-app/);
  });

  it('gap: ps failure keeps subagents but loses background children', () => {
    const table = [{ pid: 500, ppid: 100, args: 'rake test' }];
    const noSub = holdersFor([live()], { table, unreadable: true });
    expect(noSub.unreadable).toBe(true);
    expect(noSub.holders).toHaveLength(0);
    const withSub = holdersFor([live({ subagentConvos: { runningCount: () => 2 } })], { table, unreadable: true });
    expect(withSub.holders).toHaveLength(1);
  });

  it('gap: 8 h age cap releases background work and subagents but not a running turn', () => {
    const table = [{ pid: 500, ppid: 100, args: 'rake test' }];
    const old = NOW - WORK_HOLD_MAX_MS - 1000;
    expect(holdersFor([live({ idleSince: old })], { table }).holders).toHaveLength(0);
    expect(holdersFor([live({ idleSince: old, subagentConvos: { runningCount: () => 1 } })]).holders).toHaveLength(0);
    // A turn is judged before the cap, so it holds however old.
    expect(holdersFor([live({ idleSince: old, busy: true })]).holders).toHaveLength(1);
  });
});

describe('restart hold gaps: debounce', () => {
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);

  it('gap: two quiet readings are not required, but work that appears after the gate answers is re-checked', async () => {
    const state = { busy: 0, restarts: [], gateCalls: 0 };
    const watcher = createCodeUpdateWatcher({
      readHead: () => ({ sha: NEW, at: NOW - 3600_000 }),
      busySessions: () => state.busy,
      preflight: async () => ({ ok: true }),
      restart: (info) => state.restarts.push(info),
      gate: async () => {
        state.gateCalls++;
        // Work appears while the gate runs.
        if (state.gateCalls === 1) state.busy = 1;
        return { hold: false };
      },
      now: () => NOW,
      log: () => {}, warn: () => {},
      bootSha: OLD,
    });
    const result = await watcher.tick();
    expect(result.action).toBe('waiting');
    expect(state.restarts).toHaveLength(0);
    expect(state.gateCalls).toBe(1);
    // Quiet again: a single reading is enough to go (no second reading).
    state.busy = 0;
    const second = await watcher.tick();
    expect(second.action).toBe('restart');
    expect(state.restarts).toHaveLength(1);
  });
});
