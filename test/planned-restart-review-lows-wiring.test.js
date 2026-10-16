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
  async function run({ shutdownDuringAwait }) {
    let release;
    const refresh = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const context = {
      shuttingDown: false,
      coordinatorLookup: { apply() {}, refresh },
      memoryLookup: { refresh: async () => {} },
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

  it('looks up and decides when the bridge is still running', async () => {
    const context = await run({ shutdownDuringAwait: false });
    expect(context.decideCoordinatorEvent).toHaveBeenCalledOnce();
  });

  it('does nothing when shutdown began while the journal was answering', async () => {
    const context = await run({ shutdownDuringAwait: true });
    expect(context.findSessionByClaudeSessionId).not.toHaveBeenCalled();
    expect(context.decideCoordinatorEvent).not.toHaveBeenCalled();
  });
});

describe('runPreReapHandoff across its awaits', () => {
  const source = between('async function runPreReapHandoff(', '\nfunction drainPreReapCompact(');
  async function run({ shutdownDuringAwait }) {
    let release;
    const session = { roomId: 'room-a', alive: true };
    const context = {
      shuttingDown: false,
      restartLatch: null,
      sessions: new Map([['room-a', session]]),
      journalConvoIdFor: () => 'convo-a',
      missionsHandlers: { resolveMission: vi.fn(() => new Promise(resolve => { release = resolve; })) },
      missionsClient: { get: async () => ({ status: 200, data: {} }) },
      controlOccupied: vi.fn(() => true),
      sendTextToSession: vi.fn(() => true),
      debug() {},
    };
    runInNewContext(`${source}\nglobalThis.handler = runPreReapHandoff;`, context);
    const done = context.handler(session, 1000, 0);
    await tick();
    if (shutdownDuringAwait) context.shuttingDown = true;
    release(null);
    await done;
    return context;
  }

  it('goes on to the occupancy check when the bridge is still running', async () => {
    const context = await run({ shutdownDuringAwait: false });
    expect(context.controlOccupied).toHaveBeenCalledOnce();
  });

  it('dispatches nothing when shutdown began during the mission lookup', async () => {
    const context = await run({ shutdownDuringAwait: true });
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
      RESTART_ENV_FILE: 'token', RESTART_TOKEN: 'token', restartTokenWritten: false,
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
  const source = between('const handleWake = createWakeHandler({', '\nconst handleSendAttachment');
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

  it('is unavailable while shutting down or a restart is latched', () => {
    const handler = between('const handleWake = createWakeHandler({', '\nconst handleSendAttachment');
    expect(handler).toContain('unavailable: () => shuttingDown || plannedRestartRuntime.stamped === true,');
  });
});
