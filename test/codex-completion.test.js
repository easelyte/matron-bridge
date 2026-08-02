import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import { formatAndRoute, redactAndRoute } from '../lib/codex-event-format.js';
import { CodexWatcher, createCodexWatcherIsolation } from '../lib/codex-watcher.js';
import { TranscriptTail } from '../lib/transcript-tail.js';

const RUN_ID = '1722600000000-1234-abcd';

function currentStartTicks() {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}

class FakeTail extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.started = false;
    this.drainCount = 0;
    this.offset = 0;
  }

  start() { this.started = true; }
  async drain() {
    this.drainCount += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    const content = fs.readFileSync(this.filePath, 'utf8').slice(this.offset);
    this.offset += Buffer.byteLength(content);
    for (const line of content.split('\n')) {
      if (line.trim()) this.emit('event', JSON.parse(line));
    }
    return { ok: true };
  }
  async stop() { this.started = false; }
}

class HangingTail extends FakeTail {
  drain() {
    this.drainCount += 1;
    return new Promise(() => {});
  }
}

class RejectingTail extends FakeTail {
  drain() {
    this.drainCount += 1;
    return Promise.resolve({ ok: false, error: new Error('drain failed') });
  }
}

const watchers = [];
const tempDirs = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHarness({
  alive = true,
  deadlineTs = Date.now() + 60_000,
  exitCode,
  realLiveness = false,
  TailClass = FakeTail,
  maxTranscriptBytes,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-'));
  tempDirs.push(dir);
  const meta = {
    runId: RUN_ID,
    wrapperPid: process.pid,
    wrapperStartTicks: realLiveness ? currentStartTicks() : '1',
    deadlineTs,
    schemaVersion: 'codex-cli 0.146.0',
  };
  if (exitCode !== undefined) meta.exitCode = exitCode;
  const metaPath = path.join(dir, `codex-${RUN_ID}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, `codex-${RUN_ID}.jsonl`), '');

  const calls = { upsertConvo: [], publishText: [] };
  const publisher = {
    upsertConvo(convoId, opts) {
      calls.upsertConvo.push({ convoId, opts });
      return true;
    },
    publishText(convoId, payload, options) {
      calls.publishText.push({ convoId, payload, options });
      return true;
    },
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
    hasPendingCapNote: () => tracker.hasPendingCapNote(),
    retryCapNote: () => tracker.retryPendingCapNote(),
    isAdmittedRun: runId => tracker.hasChild(runId),
    log: { info(_message, record) { audits.push(record); }, warn() {} },
  });
  let wrapperAlive = true;
  const watcher = new CodexWatcher({
    dir,
    onDiscover: discovered => tracker.ensureChild(discovered),
    ...(!realLiveness ? { isWrapperAliveFn: () => wrapperAlive } : {}),
    pollIntervalMs: 60_000,
    drainWindowMs: 100,
    TailClass,
    ...(maxTranscriptBytes === undefined ? {} : { maxTranscriptBytes }),
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

  it('interrupts a dead wrapper without an exit code', async () => {
    const harness = makeHarness({ alive: false });
    await attach(harness);

    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
  });

  it('uses the last valid attached metadata when the sidecar disappears', async () => {
    const harness = makeHarness({ alive: false });
    await attach(harness);
    fs.rmSync(harness.metaPath);

    await harness.watcher.watchdogTick();

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({
      terminal: true,
      outcome: 'interrupted',
    });
    expect(harness.audits).toContainEqual(expect.objectContaining({
      winningSignal: 'liveness',
      livenessEvidence: { pidAlive: false, pastDeadline: false },
    }));
  });

  it('interrupts a reused pid whose process start ticks do not match', async () => {
    const harness = makeHarness({ realLiveness: true });
    await attach(harness);
    harness.meta.wrapperStartTicks = '0';
    fs.writeFileSync(harness.metaPath, JSON.stringify(harness.meta));

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

    expect(harness.isolation.requestTerminalization(RUN_ID, 'completed', {
      winningSignal: 'clean-exit',
    })).toBe(false);

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
    harness.watcher.on('codex-event', ({ event }, streamState) => {
      routed.state = streamState;
      formatAndRoute(event, routed);
    });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    setTimeout(() => {
      fs.appendFileSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`), [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'late answer' },
        }),
        JSON.stringify({ type: 'turn.completed' }),
        '',
      ].join('\n'));
    }, 25);
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.calls.publishText).toContainEqual(expect.objectContaining({
      payload: { body: 'late answer', from: 'assistant' },
      options: { idemKey: `${RUN_ID}:final` },
    }));
    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'completed' });
    expect(tail.drainCount).toBeGreaterThan(0);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      winningSignal: 'clean-exit',
      livenessEvidence: { pidAlive: true, pastDeadline: false },
    }));
  });

  it('interrupts when an attached tail does not finish its bounded drain', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: HangingTail });
    await attach(harness);
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 2 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
    expect(harness.audits).toContainEqual(expect.objectContaining({
      runId: RUN_ID,
      outcome: 'interrupted',
      winningSignal: 'drain-timeout',
      finalPostLanded: false,
    }));
  });

  it('does not report an intermediate agent message as a landed final post', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true });
    await attach(harness);
    const routed = {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: {},
    };
    harness.watcher.on('codex-event', ({ event }, streamState) => {
      routed.state = streamState;
      formatAndRoute(event, routed);
    });
    const tail = harness.watcher.tails.get(RUN_ID);
    tail.emit('event', {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'intermediate' },
    });
    tail.emit('event', {
      type: 'item.started',
      item: { type: 'command_execution', command: 'true' },
    });
    tail.emit('event', { type: 'turn.completed' });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.audits).toContainEqual(expect.objectContaining({
      outcome: 'completed',
      finalPostLanded: false,
    }));
  });

  it('does not report a final post as landed when its enqueue is rejected', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true });
    await attach(harness);
    harness.publisher.publishText = (convoId, payload, options) => {
      harness.calls.publishText.push({ convoId, payload, options });
      return false;
    };
    const routed = {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: {},
    };
    harness.watcher.on('codex-event', ({ event }, streamState) => {
      routed.state = streamState;
      formatAndRoute(event, routed);
    });
    const tail = harness.watcher.tails.get(RUN_ID);
    tail.emit('event', {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'final answer' },
    });
    tail.emit('event', { type: 'turn.completed' });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.calls.publishText).toHaveLength(1);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      outcome: 'completed',
      finalPostLanded: false,
    }));
  });

  it('reports a final post as landed only after publisher delivery confirmation', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true });
    await attach(harness);
    harness.publisher.publishText = (convoId, payload, options) => {
      harness.calls.publishText.push({ convoId, payload, options });
      options?.onDelivered?.();
      return true;
    };
    const tail = harness.watcher.tails.get(RUN_ID);
    harness.watcher.on('codex-event', ({ event }, streamState) => formatAndRoute(event, {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: streamState,
    }));
    tail.emit('event', { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } });
    tail.emit('event', { type: 'turn.completed' });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.audits).toContainEqual(expect.objectContaining({ finalPostLanded: true }));
  });

  it('threads formatter durability and redaction-drop counters into terminal audit', async () => {
    const harness = makeHarness({ alive: false });
    await attach(harness);
    harness.watcher.on('codex-event', ({ event }, streamState) => redactAndRoute(event, {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: streamState,
      maxDurableEvents: 0,
      redact: value => value,
    }));
    const tail = harness.watcher.tails.get(RUN_ID);
    tail.emit('event', {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'true', aggregated_output: 'ok' },
    });
    tail.emit('event', {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'env', aggregated_output: 'A=1\nB=2\nC=3' },
    });

    await harness.watcher.watchdogTick();

    expect(harness.audits).toContainEqual(expect.objectContaining({
      durableEventCount: 0,
      droppedEventCount: 1,
      redactionDropCount: 1,
    }));
  });

  it('keeps a capped production transcript nonfatal and routes its terminal suffix', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail, maxTranscriptBytes: 180 });
    await attach(harness);
    harness.watcher.on('codex-event', ({ event }, streamState) => formatAndRoute(event, {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: streamState,
    }));
    const transcript = path.join(harness.dir, `codex-${RUN_ID}.jsonl`);
    fs.appendFileSync(transcript, `${'x'.repeat(400)}\n${JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'bounded answer' },
    })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
    await harness.watcher.tails.get(RUN_ID).drain({ windowMs: 0 });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.calls.publishText).toContainEqual(expect.objectContaining({
      payload: { body: 'bounded answer', from: 'assistant' },
    }));
    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'completed' });
    expect(harness.isolation.breakerState().errorCount).toBe(0);
  });

  it('keeps a drain failure interruption authoritative over clean exit', async () => {
    const harness = makeHarness({ alive: true, TailClass: RejectingTail });
    await attach(harness);
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await new Promise(resolve => setImmediate(resolve));

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({
      terminal: true,
      outcome: 'interrupted',
    });
    expect(harness.audits.filter(record => record.event === 'codex_run_terminal')).toEqual([
      expect.objectContaining({ outcome: 'interrupted', winningSignal: 'drain-error' }),
    ]);
  });

  it('retries a failed terminal upsert on a later watchdog tick without a stream callback', async () => {
    const harness = makeHarness({ alive: false });
    let terminalAttempts = 0;
    harness.publisher.upsertConvo = (convoId, opts) => {
      harness.calls.upsertConvo.push({ convoId, opts });
      if (opts.sessionOutcome && terminalAttempts++ === 0) return false;
      return true;
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

  it('waits for a pending JSONL and drains it with the production tail', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail });
    fs.rmSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`));
    await harness.watcher.start();
    expect(harness.watcher.pending.has(RUN_ID)).toBe(true);
    const routed = {
      publisher: harness.publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: harness.meta,
      state: {},
    };
    harness.watcher.on('codex-event', ({ event }, streamState) => {
      routed.state = streamState;
      formatAndRoute(event, routed);
    });
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));
    await harness.watcher.watchdogTick();
    expect(harness.tracker.childFor(RUN_ID)?.terminal).toBe(false);

    fs.writeFileSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`), [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'late file' } }),
      JSON.stringify({ type: 'turn.completed' }),
      '',
    ].join('\n'));
    await harness.watcher.scan();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.calls.publishText).toContainEqual(expect.objectContaining({
      payload: { body: 'late file', from: 'assistant' },
    }));
    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'completed' });
  });

  it('interrupts when a clean-exit JSONL never attaches within the drain window', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail });
    fs.rmSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`));
    await harness.watcher.start();
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
    expect(harness.audits).toContainEqual(expect.objectContaining({ winningSignal: 'drain-unattached' }));
  });

  it('lets teardown win as interrupted during a production-tail drain', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail });
    await attach(harness);
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));
    await harness.watcher.watchdogTick();

    await harness.watcher.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
    expect(harness.audits).toContainEqual(expect.objectContaining({ winningSignal: 'teardown' }));
  });

  it('consumes an append late in the production tail drain window', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail });
    await attach(harness);
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));
    await harness.watcher.watchdogTick();
    setTimeout(() => {
      fs.appendFileSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`),
        `${JSON.stringify({ type: 'turn.completed', late: true })}\n`);
    }, 75);
    const events = [];
    harness.watcher.on('codex-event', ({ event }) => events.push(event));

    await vi.advanceTimersByTimeAsync(100);

    expect(events).toContainEqual({ type: 'turn.completed', late: true });
    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'completed' });
  });

  it('does not complete cleanly when the attached transcript disappears', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ alive: true, TailClass: TranscriptTail });
    await attach(harness);
    fs.rmSync(path.join(harness.dir, `codex-${RUN_ID}.jsonl`));
    fs.writeFileSync(harness.metaPath, JSON.stringify({ ...harness.meta, exitCode: 0 }));

    await harness.watcher.watchdogTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.tracker.childFor(RUN_ID)).toMatchObject({ terminal: true, outcome: 'interrupted' });
    expect(harness.audits).toContainEqual(expect.objectContaining({ winningSignal: 'drain-error' }));
  });
});
