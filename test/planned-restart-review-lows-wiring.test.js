import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createWakeHandler } from '../lib/wake-route.js';

// The real function text is cut out of index.js and run against fakes, so the
// guards are exercised as shipped rather than matched as source text.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = index.indexOf(from);
  expect(start, `${from} is missing from index.js`).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf(to, start + 1));
};
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('journalOnCoordinator across its awaits', () => {
  const source = between('async function journalOnCoordinator(', '\nasync function deliverCoordinatorTurn(');
  async function run({ shutdownDuringAwait, awaitAt }) {
    let release;
    const pause = () => new Promise(resolve => { release = resolve; });
    const refresh = vi.fn(awaitAt === 'coordinator' ? pause : async () => ({ convoId: 'convo-a' }));
    const context = {
      shuttingDown: false,
      coordinatorLookup: { apply() {}, refresh },
      memoryLookup: { refresh: vi.fn(awaitAt === 'memory' ? pause : async () => {}) },
      findSessionByClaudeSessionId: vi.fn(() => ({ alive: true, roomId: 'room-a' })),
      decideCoordinatorEvent: vi.fn(() => 'stale'),
      console: { warn() {} },
    };
    runInNewContext(`${source}\nglobalThis.handler = journalOnCoordinator;`, context);
    const done = context.handler('convo-a', { role: 'assigned' });
    await tick();
    if (shutdownDuringAwait) context.shuttingDown = true;
    release({ convoId: 'convo-a' });
    await done;
    return context;
  }

  it.each(['coordinator', 'memory'])('looks up and decides after the %s lookup when still running', async awaitAt => {
    const context = await run({ shutdownDuringAwait: false, awaitAt });
    expect(context.decideCoordinatorEvent).toHaveBeenCalledOnce();
  });

  it.each(['coordinator', 'memory'])('does nothing when shutdown began during the %s lookup', async awaitAt => {
    const context = await run({ shutdownDuringAwait: true, awaitAt });
    expect(context.findSessionByClaudeSessionId).not.toHaveBeenCalled();
    expect(context.decideCoordinatorEvent).not.toHaveBeenCalled();
  });
});

describe('runPreReapHandoff across its awaits', () => {
  const source = between('async function runPreReapHandoff(', '\nfunction drainPreReapCompact(');
  async function run({ shutdownDuringAwait, awaitAt }) {
    let release;
    const pause = () => new Promise(resolve => { release = resolve; });
    const finishInput = vi.fn();
    const session = { roomId: 'room-a', alive: true };
    const context = {
      shuttingDown: false,
      restartLatch: { beginInput: vi.fn(() => finishInput) },
      sessions: new Map([['room-a', session]]),
      journalConvoIdFor: () => 'convo-a',
      missionsHandlers: { resolveMission: vi.fn(awaitAt === 'resolve' ? pause : async () => ({ id: 'task-a' })) },
      missionsClient: { get: vi.fn(awaitAt === 'status' ? pause : async () => ({ status: 200, data: {} })) },
      controlOccupied: vi.fn(() => true),
      sendTextToSession: vi.fn(() => true),
      debug() {},
    };
    runInNewContext(`${source}\nglobalThis.handler = runPreReapHandoff;`, context);
    const done = context.handler(session, 1000, 0);
    await tick();
    if (shutdownDuringAwait) context.shuttingDown = true;
    release(awaitAt === 'status' ? { status: 200, data: {} } : null);
    await done;
    expect(context.restartLatch.beginInput).toHaveBeenCalledOnce();
    expect(finishInput).toHaveBeenCalledOnce();
    return context;
  }

  it.each(['resolve', 'status'])('checks occupancy after the %s lookup when still running', async awaitAt => {
    const context = await run({ shutdownDuringAwait: false, awaitAt });
    expect(context.controlOccupied).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'status'])('dispatches nothing when shutdown began during the %s lookup', async awaitAt => {
    const context = await run({ shutdownDuringAwait: true, awaitAt });
    expect(context.controlOccupied).not.toHaveBeenCalled();
    expect(context.sendTextToSession).not.toHaveBeenCalled();
  });
});

describe('listen-time restart token failure', () => {
  const source = between('apiServer.listen(API_PORT,', '\nfunction hydrateAgentState');
  it('hands the carry-on cards back and logs an error', () => {
    const publish = vi.fn(), error = vi.fn(), warn = vi.fn();
    const context = {
      plannedRestartAvailable: true, restartBoot: { listenerReady: vi.fn(), suppressCard: () => true },
      apiServer: { listen: (_port, _host, callback) => callback() }, API_PORT: 0,
      atomicWriteFileSync() { throw new Error('read-only file system'); },
      RESTART_ENV_FILE: 'token', RESTART_TOKEN: 'token', restartTokenWritten: false, publishOperatorToken: vi.fn(),
      publishRestartCarryOnCards: publish, console: { warn, error, log() {} },
    };
    runInNewContext(source, context);
    expect(context.plannedRestartAvailable).toBe(false);
    expect(context.restartBoot).toBe(null);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith();
    expect(error).toHaveBeenCalledWith('[restart] token initialization failed; planned restart unavailable');
  });
});

describe('/wake availability as wired in index.js', () => {
  const source = between('const handleWake = createWakeHandler({', '\n// send_attachment into a room: a journal transfer');
  function wire({ shuttingDown = false, stamped = false } = {}) {
    const session = { alive: true, roomId: 'room-a' };
    const context = {
      createWakeHandler, shuttingDown, plannedRestartRuntime: { stamped },
      process: { env: { MATRON_WAKE_CONVO_ID: 'convo-a', MATRON_WAKE_TEXT: 'wake up' } },
      findSessionByClaudeSessionId: vi.fn(() => session),
      journalResumeConvo: vi.fn(() => session),
      journalRouteTextToSession: vi.fn(async () => true),
      journalPublishNotice: vi.fn(),
      journalConvoIdFor: () => 'convo-a',
    };
    runInNewContext(`${source}\nglobalThis.handle = handleWake;`, context);
    return context;
  }

  it.each([
    ['shutting down', { shuttingDown: true }],
    ['a restart latched', { stamped: true }],
    ['both', { shuttingDown: true, stamped: true }],
  ])('answers 503 and delivers nothing while %s', async (_label, flags) => {
    const context = wire(flags);
    expect((await context.handle()).status).toBe(503);
    expect(context.findSessionByClaudeSessionId).not.toHaveBeenCalled();
    expect(context.journalResumeConvo).not.toHaveBeenCalled();
    expect(context.journalRouteTextToSession).not.toHaveBeenCalled();
  });

  it('delivers normally when neither is set', async () => {
    const context = wire();
    expect((await context.handle()).status).toBe(200);
    expect(context.journalRouteTextToSession).toHaveBeenCalledOnce();
  });

  it('checks current availability even when a previous wake could be coalesced', async () => {
    const context = wire();
    expect((await context.handle()).status).toBe(200);
    const session = context.findSessionByClaudeSessionId.mock.results[0].value;
    session.busy = true;
    context.findSessionByClaudeSessionId.mockClear();
    context.plannedRestartRuntime.stamped = true;
    expect((await context.handle()).status).toBe(503);
    expect(context.findSessionByClaudeSessionId).not.toHaveBeenCalled();
    expect(context.journalRouteTextToSession).toHaveBeenCalledOnce();
    context.plannedRestartRuntime.stamped = false;
    expect((await context.handle()).body.coalesced).toBe(true);
    expect(context.journalRouteTextToSession).toHaveBeenCalledOnce();
  });

  it('uses the same handler after shutdown is cancelled', async () => {
    const context = wire({ shuttingDown: true });
    expect((await context.handle()).status).toBe(503);
    context.shuttingDown = false;
    expect((await context.handle()).status).toBe(200);
    expect(context.journalRouteTextToSession).toHaveBeenCalledOnce();
  });
});
