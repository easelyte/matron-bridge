import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import {
  CodexWatcher,
  createCodexWatcherIsolation,
  registerCodexWatcherForSession,
} from '../lib/codex-watcher.js';

const RUN_INTERRUPTED = '1722600000000-1234-abcd';
const RUN_MALFORMED = '1722600000001-1234-beef';
const RUN_FINISHED = '1722600000002-1234-cafe';

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

function makeWatcher(dir, { onDiscover } = {}) {
  const calls = [];
  const publisher = {
    upsertConvo(convoId, options) {
      calls.push({ convoId, options });
      return true;
    },
  };
  const tracker = createCodexConvoTracker({
    sessionId: 'session-1',
    publisher,
    getParentConvoId: () => 'parent-1',
    log: { warn() {} },
  });
  const isolation = createCodexWatcherIsolation({
    sessionId: 'session-1',
    publisher,
    getParentConvoId: () => 'parent-1',
    terminalize: (runId, outcome) => tracker.terminalize(runId, outcome),
    terminalizeAll: () => tracker.interruptAll(),
    isAdmittedRun: runId => tracker.hasChild(runId),
    log: { info() {}, warn() {} },
  });
  const discover = onDiscover ?? (meta => tracker.ensureChild(meta));
  const watcher = new CodexWatcher({
    dir,
    sessionId: 'session-1',
    onDiscover: discover,
    isolation,
    isWrapperAliveFn: () => true,
    pollIntervalMs: 60_000,
    TailClass: FakeTail,
  });
  watchers.push(watcher);
  return { calls, tracker, watcher };
}

describe('Codex restart reconciliation', () => {
  it('interrupts a running child before snapshot can re-tail it', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    writeRun(dir, RUN_FINISHED, { exitCode: 0 });
    const { calls, tracker, watcher } = makeWatcher(dir);
    const session = { claudeSessionId: 'session-1' };

    await expect(watcher.reconcile(session)).resolves.toBe(true);
    await watcher.start();

    expect(tracker.childFor(RUN_INTERRUPTED)).toMatchObject({
      state: 'done',
      terminal: true,
      outcome: 'interrupted',
    });
    expect(tracker.childFor(RUN_FINISHED)).toMatchObject({
      state: 'done',
      terminal: true,
      outcome: 'completed',
    });
    expect(calls.map(call => call.options)).toEqual([
      expect.objectContaining({ sessionState: 'running' }),
      expect.objectContaining({ sessionState: 'done', sessionOutcome: 'interrupted' }),
      expect.objectContaining({ sessionState: 'running' }),
      expect.objectContaining({ sessionState: 'done', sessionOutcome: 'completed' }),
    ]);
    expect(watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(watcher.seen.has(RUN_FINISHED)).toBe(true);
    expect(FakeTail.starts).toEqual([]);
  });

  it('runs the production registration hook for a session added after boot and before watcher startup', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    const liveSessions = new Map();
    const { tracker, watcher } = makeWatcher(dir);
    watcher.sessionId = 'late-session';
    const session = { claudeSessionId: 'late-session' };
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

    expect(liveSessions.size).toBe(0);
    await Promise.resolve(); // bridge boot completes before this session appears
    liveSessions.set('late', session);
    const registered = registerCodexWatcherForSession(session, {}, {
      WatcherClass: ExistingWatcher,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    expect(registered).toBe(watcher);
    expect(reconcile).toHaveBeenCalledWith(session);
    expect(order.slice(0, 2)).toEqual(['reconcile', 'start']);
    expect(tracker.childFor(RUN_INTERRUPTED)?.outcome).toBe('interrupted');

    const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const setupStart = indexSource.indexOf('function setupSubagentWatcher(');
    const setupEnd = indexSource.indexOf('\nfunction ', setupStart + 1);
    expect(indexSource.slice(setupStart, setupEnd)).toContain(
      'registerCodexWatcherForSession(session',
    );
  });

  it('leaves a transient discovery failure unseen so reconciliation can retry it', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_INTERRUPTED);
    let attempts = 0;
    const harness = makeWatcher(dir, {
      onDiscover: meta => {
        attempts += 1;
        return attempts === 1 ? null : harness.tracker.ensureChild(meta);
      },
    });
    const session = { claudeSessionId: 'session-1' };

    await harness.watcher.reconcile(session);
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(false);
    expect(harness.tracker.childFor(RUN_INTERRUPTED)).toBeNull();

    await harness.watcher.start();
    expect(harness.watcher.seen.has(RUN_INTERRUPTED)).toBe(true);
    expect(harness.tracker.childFor(RUN_INTERRUPTED)?.outcome).toBe('interrupted');
    expect(FakeTail.starts).toEqual([]);
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

  it('isolates a malformed old run and continues reconciling siblings', async () => {
    const dir = makeDir();
    writeRun(dir, RUN_MALFORMED);
    writeRun(dir, RUN_INTERRUPTED);
    let tracker;
    const onDiscover = meta => {
      if (meta.runId === RUN_MALFORMED) throw new Error('malformed old metadata');
      return tracker.ensureChild(meta);
    };
    const harness = makeWatcher(dir, { onDiscover });
    tracker = harness.tracker;

    await expect(harness.watcher.reconcile({ claudeSessionId: 'session-1' })).resolves.toBe(true);
    expect(tracker.childFor(RUN_MALFORMED)).toBeNull();
    expect(tracker.childFor(RUN_INTERRUPTED)?.outcome).toBe('interrupted');
  });
});
