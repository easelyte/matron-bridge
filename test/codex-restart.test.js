import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import {
  CodexWatcher,
  createCodexWatcherIsolation,
  registerCodexWatcherForLiveSession,
} from '../lib/codex-watcher.js';

const RUN_INTERRUPTED = '1722600000000-1234-abcd';
const RUN_MALFORMED = '1722600000001-1234-beef';
const RUN_FINISHED = '1722600000002-1234-cafe';
const RUN_FAILED = '1722600000003-1234-fade';

const tempDirs = [];
const watchers = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  FakeTail.starts = [];
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-'));
  tempDirs.push(dir);
  return dir;
}

function writeRun(dir, runId, patch = {}) {
  fs.writeFileSync(path.join(dir, `codex-${runId}.meta.json`), JSON.stringify({
    runId,
    wrapperPid: process.pid,
    wrapperStartTicks: 'matching',
    deadlineTs: Date.now() + 60_000,
    ...patch,
  }));
  fs.writeFileSync(path.join(dir, `codex-${runId}.jsonl`), '{"type":"thread.started"}\n');
}

class FakeTail extends EventEmitter {
  static starts = [];

  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  start() {
    FakeTail.starts.push(this.filePath);
  }

  stop() {}
}

function makeWatcher(dir, {
  onDiscover,
  onReconcile,
  breakerThreshold,
  maxChildren,
  isWrapperAliveFn = () => false,
  metaParseMaxAttempts,
  metaParseTtlMs,
} = {}) {
  const calls = [];
  const notices = [];
  const publisher = {
    upsertConvo(convoId, options) {
      calls.push({ convoId, options });
      return true;
    },
    publishText(convoId, payload, options) {
      notices.push({ convoId, payload, options });
      return true;
    },
  };
  const tracker = createCodexConvoTracker({
    sessionId: 'session-1',
    publisher,
    getParentConvoId: () => 'parent-1',
    log: { warn() {} },
    maxChildren,
  });
  const isolation = createCodexWatcherIsolation({
    sessionId: 'session-1',
    publisher,
    getParentConvoId: () => 'parent-1',
    terminalize: (runId, outcome) => tracker.terminalize(runId, outcome),
    terminalizeAll: () => tracker.interruptAll(),
    isAdmittedRun: runId => tracker.hasChild(runId),
    breakerThreshold,
    log: { info() {}, warn() {} },
  });
  const discover = onDiscover ?? (meta => tracker.ensureChild(meta));
  const watcher = new CodexWatcher({
    dir,
    sessionId: 'session-1',
    onDiscover: discover,
    onReconcile: onReconcile ?? ((runId, outcome) => tracker.terminalizeByRunId(runId, outcome)),
    isolation,
    isWrapperAliveFn,
    pollIntervalMs: 60_000,
    TailClass: FakeTail,
    metaParseMaxAttempts,
    metaParseTtlMs,
  });
  watchers.push(watcher);
  return { calls, notices, tracker, watcher };
}

describe('Codex restart reconciliation', () => {
  it('attaches a live run and reconciles terminal metadata with honest outcomes', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    writeRun(dir, RUN_FINISHED, { exitCode: 0 });
    writeRun(dir, RUN_FAILED, { exitCode: 1 });
    const { calls, tracker, watcher } = makeWatcher(dir, {
      isWrapperAliveFn: meta => meta.runId === RUN_INTERRUPTED,
    });
    const session = { claudeSessionId: 'session-1' };

    await expect(watcher.reconcile(session)).resolves.toBe(true);
    await watcher.start();

    expect(tracker.childFor(RUN_INTERRUPTED)).toMatchObject({ terminal: false });
    expect(tracker.childFor(RUN_FINISHED)).toBeNull();
    expect(tracker.childFor(RUN_FAILED)).toBeNull();
    expect(Object.fromEntries(calls.map(call => [call.convoId, call.options]))).toEqual({
      [`parent-1:codex:${RUN_INTERRUPTED}`]: expect.objectContaining({
        sessionState: 'running',
      }),
      [`parent-1:codex:${RUN_FINISHED}`]: expect.objectContaining({
        sessionState: 'done', sessionOutcome: 'completed',
      }),
      [`parent-1:codex:${RUN_FAILED}`]: expect.objectContaining({
        sessionState: 'done', sessionOutcome: 'failed',
      }),
    });
    expect(watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
    expect(watcher.attached.has(RUN_INTERRUPTED)).toBe(true);
    expect(watcher.seen.has(RUN_FINISHED)).toBe(true);
    expect(watcher.seen.has(RUN_FAILED)).toBe(true);
    expect(FakeTail.starts).toEqual([path.join(dir, `codex-${RUN_INTERRUPTED}.jsonl`)]);
  });

  it('runs the production registration hook for a session added after boot and before watcher startup', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    const { tracker, watcher } = makeWatcher(dir, { isWrapperAliveFn: () => true });
    watcher.sessionId = 'late-session';
    const session = { roomId: 'late-room', claudeSessionId: 'late-session' };
    const liveSessions = new Map([['late-room', session]]);
    const order = [];
    const reconcile = vi.spyOn(watcher, 'reconcile').mockImplementation(value => {
      order.push('reconcile');
      return CodexWatcher.prototype.reconcile.call(watcher, value);
    });
    const start = vi.spyOn(watcher, 'start').mockImplementation(async () => {
      order.push('start');
      return CodexWatcher.prototype.start.call(watcher);
    });
    class ExistingWatcher {
      constructor() { return watcher; }
    }

    await Promise.resolve(); // bridge boot completes before this session appears
    const registered = registerCodexWatcherForLiveSession(liveSessions, 'late-room', {}, {
      env: { MATRON_CODEX_VIZ: '1' },
      WatcherClass: ExistingWatcher,
      detectProducer: () => true, // T-1.6: a producer is present in this scenario
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    expect(registered).toBe(watcher);
    expect(session.codexWatcher).toBe(watcher);
    expect(reconcile).toHaveBeenCalledWith(session);
    expect(order.slice(0, 2)).toEqual(['reconcile', 'start']);
    expect(tracker.childFor(RUN_INTERRUPTED)).toMatchObject({ terminal: false });
    expect(watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
    expect(watcher.attached.has(RUN_INTERRUPTED)).toBe(true);

  });

  it('interrupts dead, reused-pid, and past-deadline runs during reconciliation', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    writeRun(dir, RUN_MALFORMED, { wrapperStartTicks: 'reused' });
    writeRun(dir, RUN_FINISHED, { deadlineTs: Date.now() - 1 });
    const alive = new Set([RUN_FINISHED]);
    const harness = makeWatcher(dir, {
      isWrapperAliveFn: meta => alive.has(meta.runId),
    });

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(true);

    for (const runId of [RUN_INTERRUPTED, RUN_MALFORMED, RUN_FINISHED]) {
      expect(harness.watcher.seen.has(runId)).toBe(true);
      expect(harness.calls).toContainEqual(expect.objectContaining({
        convoId: `parent-1:codex:${runId}`,
        options: expect.objectContaining({ sessionOutcome: 'interrupted' }),
      }));
    }
    expect(FakeTail.starts).toEqual([]);
  });

  it('leaves a transient terminalization failure pending so reconciliation retries it', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    let attempts = 0;
    let harness;
    harness = makeWatcher(dir, {
      onReconcile: (runId, outcome) => {
        attempts += 1;
        return attempts === 1 ? null : harness.tracker.terminalizeByRunId(runId, outcome);
      },
    });
    const session = { claudeSessionId: 'session-1' };

    await harness.watcher.reconcile(session);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
    expect(harness.tracker.childFor(RUN_INTERRUPTED)).toBeNull();
    expect(harness.watcher.permanentlySkipped.has(`codex-${RUN_INTERRUPTED}.meta.json`)).toBe(false);

    await harness.watcher.start();
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.calls).toEqual([expect.objectContaining({
      convoId: `parent-1:codex:${RUN_INTERRUPTED}`,
      options: expect.objectContaining({ sessionOutcome: 'interrupted' }),
    })]);
    expect(FakeTail.starts).toEqual([]);
  });

  it('caps historical reconciliation without consuming live admission capacity', async () => {
    const dir = makeDir();
    const historicalRuns = Array.from({ length: 66 }, (_, index) =>
      `${1722600100000 + index}-1234-${index.toString(16).padStart(4, '0')}`);
    for (const runId of historicalRuns) writeRun(dir, runId);
    const liveRun = '1722600200000-1234-feed';
    const harness = makeWatcher(dir, { maxChildren: 64 });

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(true);
    await harness.watcher.start();

    expect(historicalRuns.every(runId => harness.watcher.seen.has(runId))).toBe(true);
    expect(harness.calls.filter(call => call.options.sessionState === 'done')).toHaveLength(64);
    expect(harness.notices).toEqual([expect.objectContaining({
      convoId: 'parent-1',
      payload: expect.objectContaining({ body: expect.stringContaining('child limit reached') }),
    })]);
    expect(harness.calls.filter(call => call.options.sessionState === 'running')).toHaveLength(0);

    writeRun(dir, liveRun);
    await harness.watcher.scan();

    expect(harness.tracker.hasChild(liveRun)).toBe(true);
    expect(harness.calls.filter(call => call.options.sessionState === 'running')).toEqual([
      expect.objectContaining({ convoId: `parent-1:codex:${liveRun}` }),
    ]);
  });

  it('keeps startup in forced reconciliation mode after an incomplete sweep', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    const harness = makeWatcher(dir, { breakerThreshold: 3 });
    const reconcile = harness.watcher._reconcile.bind(harness.watcher);
    harness.watcher._reconcile = async () => { throw new Error('directory read failed'); };

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBeUndefined();
    await harness.watcher.start();

    expect(harness.watcher.reconciliationRequired).toBe(true);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
    expect(FakeTail.starts).toEqual([]);

    harness.watcher._reconcile = reconcile;
    await expect(harness.watcher._retryReconciliation()).resolves.toBe(true);
    expect(harness.watcher.reconciliationRequired).toBe(false);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
  });

  it('clears reconciliation after an attached run survives a sibling retry, then watchdogs it', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    writeRun(dir, RUN_FAILED, { exitCode: 1 });
    const alive = new Set([RUN_INTERRUPTED]);
    let terminalAttempts = 0;
    let harness;
    harness = makeWatcher(dir, {
      isWrapperAliveFn: meta => alive.has(meta.runId),
      onReconcile: (runId, outcome) => {
        if (runId === RUN_FAILED && terminalAttempts++ === 0) {
          throw new Error('transient terminalization failure');
        }
        return harness.tracker.terminalizeByRunId(runId, outcome);
      },
      breakerThreshold: 3,
    });

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(false);
    expect(harness.watcher.attached.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.watcher.reconciliationRequired).toBe(true);

    await expect(harness.watcher._retryReconciliation()).resolves.toBe(true);
    expect(harness.watcher.reconciliationRequired).toBe(false);
    expect(harness.watcher.attached.has(RUN_INTERRUPTED)).toBe(true);

    alive.delete(RUN_INTERRUPTED);
    await harness.watcher.watchdogTick();

    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.watcher.attached.has(RUN_INTERRUPTED)).toBe(false);
    expect(harness.calls).toContainEqual(expect.objectContaining({
      convoId: `parent-1:codex:${RUN_INTERRUPTED}`,
      options: expect.objectContaining({ sessionState: 'done', sessionOutcome: 'interrupted' }),
    }));
  });

  it('yields between bounded reconciliation batches', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    writeRun(dir, RUN_MALFORMED);
    const { watcher } = makeWatcher(dir);
    watcher.maxMetaScanCount = 1;
    const session = { claudeSessionId: 'session-1' };
    let yielded = false;
    setImmediate(() => { yielded = true; });

    await watcher.reconcile(session);

    expect(yielded).toBe(true);
  });

  it('rejects reconciliation for a different session identity', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    const { tracker, watcher } = makeWatcher(dir);

    expect(watcher.reconcile({ claudeSessionId: 'session-2' })).toBe(false);
    expect(tracker.childFor(RUN_INTERRUPTED)).toBeNull();
    expect(watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
  });

  it('resolves a vanished reconcile meta and still discovers later live runs', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    const harness = makeWatcher(dir);
    const vanishedPath = path.join(dir, `codex-${RUN_INTERRUPTED}.meta.json`);
    const originalOpen = fs.openSync;
    let vanished = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (!vanished && file === vanishedPath) {
        vanished = true;
        const error = new Error('vanished');
        error.code = 'ENOENT';
        throw error;
      }
      return originalOpen(file, ...args);
    });

    try {
      await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(true);
    } finally {
      openSpy.mockRestore();
    }
    await harness.watcher.start();
    writeRun(dir, RUN_FINISHED);
    await harness.watcher.scan();

    expect(harness.watcher.reconciliationRequired).toBe(false);
    expect(harness.watcher.permanentlySkipped.has(path.basename(vanishedPath))).toBe(true);
    expect(harness.tracker.hasChild(RUN_FINISHED)).toBe(true);
    expect(FakeTail.starts).toContain(path.join(dir, `codex-${RUN_FINISHED}.jsonl`));
  });

  it('isolates an operational reconciliation throw without quarantining the run', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_MALFORMED);
    writeRun(dir, RUN_INTERRUPTED);
    let attempts = 0;
    let harness;
    const onReconcile = (runId, outcome) => {
      if (runId === RUN_MALFORMED && attempts++ === 0) throw new Error('publisher unavailable');
      return harness.tracker.terminalizeByRunId(runId, outcome);
    };
    harness = makeWatcher(dir, { onReconcile, breakerThreshold: 3 });

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(false);
    expect(harness.watcher.permanentlySkipped.has(`codex-${RUN_MALFORMED}.meta.json`)).toBe(false);
    await harness.watcher.start();

    expect(harness.watcher.seen.has(RUN_MALFORMED)).toBe(true);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.watcher.isolation.breakerState()).toEqual({ disabled: false, errorCount: 1 });
  });

  it('quarantines malformed JSON and invalid-shape old metadata while polling stays healthy', async () => {
    const dir = makeDir();
    const malformedJson = `codex-${RUN_MALFORMED}.meta.json`;
    const invalidShapeRun = '1722600000003-1234-baad';
    const invalidShape = `codex-${invalidShapeRun}.meta.json`;
    fs.writeFileSync(path.join(dir, malformedJson), '{"runId":');
    fs.writeFileSync(path.join(dir, invalidShape), JSON.stringify({
      runId: invalidShapeRun,
      wrapperPid: process.pid,
      wrapperStartTicks: 123,
    }));
    writeRun(dir, RUN_INTERRUPTED);
    // metaParseMaxAttempts:1 → a malformed-JSON meta quarantines on first
    // observation (this test asserts the quarantine OUTCOME + polling health).
    // The DEFAULT bounded transient-retry (F5) is covered in codex-watcher.test.js.
    const harness = makeWatcher(dir, { breakerThreshold: 2, metaParseMaxAttempts: 1 });

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(true);
    await harness.watcher.start();
    await harness.watcher.scan();
    await harness.watcher.scan();

    expect(harness.watcher.permanentlySkipped.has(malformedJson)).toBe(true);
    expect(harness.watcher.permanentlySkipped.has(invalidShape)).toBe(true);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.watcher.isolation.breakerState()).toEqual({ disabled: false, errorCount: 0 });
  });
});
