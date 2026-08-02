import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import { formatAndRoute } from '../lib/codex-event-format.js';
import { CodexWatcher, createCodexWatcherIsolation } from '../lib/codex-watcher.js';

const RUN_ID = '1722600000000-1234-abcd';

class FakeTail extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.started = false;
    this.drainCount = 0;
  }

  start() { this.started = true; }
  drain() { this.drainCount += 1; }
  async stop() { this.started = false; }
}

const watchers = [];
const tempDirs = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHarness({ alive = true, deadlineTs = Date.now() + 60_000, exitCode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-'));
  tempDirs.push(dir);
  const meta = {
    runId: RUN_ID,
    wrapperPid: process.pid,
    wrapperStartTicks: '1',
    deadlineTs,
    schemaVersion: 'codex-cli 0.146.0',
  };
  if (exitCode !== undefined) meta.exitCode = exitCode;
  const metaPath = path.join(dir, `codex-${RUN_ID}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, `codex-${RUN_ID}.jsonl`), '');

  const calls = { upsertConvo: [], publishText: [] };
  const publisher = {
    upsertConvo(convoId, opts) { calls.upsertConvo.push({ convoId, opts }); },
    publishText(convoId, payload, options) { calls.publishText.push({ convoId, payload, options }); },
    publishActivity() {},
  };
  const tracker = createCodexConvoTracker({
    publisher,
    getParentConvoId: () => 'parent',
    log: { warn() {} },
  });
  const audits = [];
  const isolation = createCodexWatcherIsolation({
    sessionId: 'session',
    publisher,
    getParentConvoId: () => 'parent',
    terminalize: (runId, outcome) => tracker.terminalize(runId, outcome),
    terminalizeAll: () => tracker.interruptAll(),
    isAdmittedRun: runId => tracker.hasChild(runId),
    log: { info(_message, record) { audits.push(record); }, warn() {} },
  });
  let wrapperAlive = true;
  const watcher = new CodexWatcher({
    dir,
    onDiscover: discovered => tracker.ensureChild(discovered),
    isWrapperAliveFn: () => wrapperAlive,
    pollIntervalMs: 60_000,
    drainWindowMs: 100,
    TailClass: FakeTail,
    isolation,
  });
  watchers.push(watcher);
  return {
    audits,
    calls,
    dir,
    isolation,
    meta,
    metaPath,
    publisher,
    tracker,
    watcher,
    setAlive(value) { wrapperAlive = value; },
    initiallyAlive: alive,
  };
}

async function attach(harness) {
  await harness.watcher.start();
  expect(harness.watcher.attached.has(RUN_ID)).toBe(true);
  harness.setAlive(harness.initiallyAlive);
  harness.calls.upsertConvo.length = 0;
}

describe('Codex completion state machine', () => {
  it('does not interrupt a live run merely because its transcript is silent', async () => {
    const harness = makeHarness({ alive: true });
    await attach(harness);

    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    expect(harness.calls.upsertConvo).toHaveLength(0);
  });

  it.each([
    ['dead wrapper', false],
    ['reused pid', false],
  ])('interrupts on %s without an exit code', async (_reason, alive) => {
    const harness = makeHarness({ alive });
    await attach(harness);

    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
  });

  it('interrupts an alive wrapper after its hard deadline', async () => {
    const harness = makeHarness({ alive: true, deadlineTs: Date.now() - 1 });
    await attach(harness);

    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
  });

  it('latches a watchdog interruption against a later clean exit', async () => {
    const harness = makeHarness({ alive: false });
    await attach(harness);
    await harness.watcher.watchdogTick();
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();

    expect(harness.calls.upsertConvo).toHaveLength(1);
    expect(harness.calls.upsertConvo[0].opts.sessionOutcome).toBe('interrupted');
  });

  it('publishes a repeated final answer with one stable idempotency key', () => {
    const harness = makeHarness();
    const ctx = {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: {},
    };
    const final = { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } };

    formatAndRoute(final, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);
    formatAndRoute(final, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);

    expect(harness.calls.publishText).toEqual([
      expect.objectContaining({ options: { idemKey: `${RUN_ID}:final` } }),
      expect.objectContaining({ options: { idemKey: `${RUN_ID}:final` } }),
    ]);
  });

  it('drains through a delayed final item before clean completion', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true });
    await attach(harness);
    const tail = harness.watcher.tails.get(RUN_ID);
    const routed = {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: {},
    };
    harness.watcher.on('codex-event', ({ event }) => formatAndRoute(event, routed));
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    tail.emit('event', { type: 'item.completed', item: { type: 'agent_message', text: 'late answer' } });
    tail.emit('event', { type: 'turn.completed' });
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.calls.publishText).toContainEqual(expect.objectContaining({
      payload: { body: 'late answer', from: 'assistant' },
      options: { idemKey: `${RUN_ID}:final` },
    }));
    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'completed' });
    expect(tail.drainCount).toBeGreaterThan(0);
  });

  it('bounds a final-less drain and maps a nonzero exit to failed', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true });
    await attach(harness);
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 2 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'failed' });
    expect(harness.audits).toContainEqual(expect.objectContaining({
      runId: RUN_ID,
      outcome: 'failed',
      winningSignal: 'clean-exit',
      finalPostLanded: false,
    }));
  });

  it('retries a failed terminal upsert on a later watchdog tick without a stream callback', async () => {
    const harness = makeHarness({ alive: false });
    let terminalAttempts = 0;
    harness.publisher.upsertConvo = (convoId, opts) => {
      harness.calls.upsertConvo.push({ convoId, opts });
      if (opts.sessionOutcome && terminalAttempts++ === 0) throw new Error('journal unavailable');
    };
    await attach(harness);

    await harness.watcher.watchdogTick();
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
    expect(terminalAttempts).toBe(2);
  });

  it('interrupts an attached run on watcher teardown', async () => {
    const harness = makeHarness({ alive: true });
    await attach(harness);

    await harness.watcher.stop();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
  });
});
