import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexWatcher,
  DEFAULT_CODEX_TRANSCRIPT_MAX_BYTES,
  createCodexWatcherIfEnabled,
  startCodexWatcherIfEnabled,
} from '../lib/codex-watcher.js';

const RUN_LATE = '1722600000000-1234-abcd';
const RUN_PENDING = '1722600000001-1234-1234';
const RUN_TERMINAL = '1722600000002-1234-beef';
const RUN_LIVE = '1722600000003-1234-cafe';
const RUN_DEAD = '1722600000004-1234-dead';

function writeMeta(dir, runId, patch = {}) {
  const meta = {
    runId,
    wrapperPid: process.pid,
    wrapperStartTicks: '1',
    deadlineTs: Date.now() + 60_000,
    ...patch,
  };
  fs.writeFileSync(path.join(dir, `codex-${runId}.meta.json`), JSON.stringify(meta));
  return meta;
}

class FakeTail extends EventEmitter {
  constructor(filePath, options) {
    super();
    this.filePath = filePath;
    this.options = options;
    this.started = false;
  }

  start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }
}

const watchers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-'));
  tempDirs.push(dir);
  return dir;
}

describe('CodexWatcher', () => {
  it('keeps watching persistently and discovers meta created after startup', async () => {
    const dir = makeDir();
    const onDiscover = vi.fn();
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      pollIntervalMs: 10,
      TailClass: FakeTail,
    });
    watchers.push(watcher);
    await watcher.start();

    expect(watcher.pollTimer).not.toBeNull();
    writeMeta(dir, RUN_LATE);

    await vi.waitFor(() => expect(onDiscover).toHaveBeenCalledOnce());
    expect(onDiscover).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_LATE }));
    expect(watcher.pollTimer).not.toBeNull();
  });

  it('discovers through polling when native fs.watch is unavailable', async () => {
    const dir = makeDir();
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('native watch unavailable');
    });
    const onDiscover = vi.fn();
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      pollIntervalMs: 10,
      TailClass: FakeTail,
    });
    watchers.push(watcher);

    try {
      await watcher.start();
      writeMeta(dir, RUN_LATE);
      await vi.waitFor(() => expect(onDiscover).toHaveBeenCalledOnce());
      expect(watchSpy).toHaveBeenCalled();
    } finally {
      watchSpy.mockRestore();
    }
  });

  it('holds a discovered meta pending until JSONL exists and tracks live attachment separately', async () => {
    const dir = makeDir();
    const onDiscover = vi.fn();
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);
    await watcher.start();
    const meta = writeMeta(dir, RUN_PENDING);

    await watcher.scan();

    expect(onDiscover).toHaveBeenCalledWith(meta);
    expect(watcher.pending.has(RUN_PENDING)).toBe(true);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);

    fs.writeFileSync(path.join(dir, `codex-${RUN_PENDING}.jsonl`), '{"type":"thread.started"}\n');
    await watcher.scan();

    expect(watcher.pending.has(RUN_PENDING)).toBe(false);
    expect(watcher.attached.has(RUN_PENDING)).toBe(true);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);
    expect(watcher.tails.get(RUN_PENDING)?.started).toBe(true);
  });

  it('retries discovery when the child handoff fails open', async () => {
    const dir = makeDir();
    const onDiscover = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValue({ convoId: 'child' });
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);
    await watcher.start();
    writeMeta(dir, RUN_PENDING);

    await watcher.scan();
    expect(watcher.pending.has(RUN_PENDING)).toBe(false);

    await watcher.scan();
    expect(onDiscover).toHaveBeenCalledTimes(2);
    expect(watcher.pending.has(RUN_PENDING)).toBe(true);
  });

  it('replays a live snapshot after listeners are registered and skips both terminal branches', async () => {
    const dir = makeDir();
    writeMeta(dir, RUN_TERMINAL, { exitCode: 0 });
    fs.writeFileSync(path.join(dir, `codex-${RUN_TERMINAL}.jsonl`), '{"type":"terminal"}\n');
    const deadMeta = writeMeta(dir, RUN_DEAD);
    fs.writeFileSync(path.join(dir, `codex-${RUN_DEAD}.jsonl`), '{"type":"dead"}\n');
    const liveMeta = writeMeta(dir, RUN_LIVE, { wrapperStartTicks: 'matching' });
    fs.writeFileSync(path.join(dir, `codex-${RUN_LIVE}.jsonl`), '{"type":"live"}\n');
    const onDiscover = vi.fn();
    const isWrapperAliveFn = vi.fn(meta => meta.runId === RUN_LIVE);

    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      isWrapperAliveFn,
      pollIntervalMs: 60_000,
    });
    watchers.push(watcher);
    const replayed = [];
    watcher.on('codex-event', payload => replayed.push(payload));

    expect(replayed).toEqual([]);
    await watcher.start();

    expect(watcher.seen.has(RUN_TERMINAL)).toBe(true);
    expect(watcher.tails.has(RUN_TERMINAL)).toBe(false);
    expect(watcher.seen.has(RUN_DEAD)).toBe(true);
    expect(watcher.tails.has(RUN_DEAD)).toBe(false);
    expect(watcher.attached.has(RUN_LIVE)).toBe(true);
    expect(watcher.seen.has(RUN_LIVE)).toBe(false);
    expect(replayed).toEqual([{ runId: RUN_LIVE, meta: liveMeta, event: { type: 'live' } }]);
    expect(onDiscover).toHaveBeenCalledTimes(1);
    expect(onDiscover).toHaveBeenCalledWith(liveMeta);
    expect(isWrapperAliveFn).toHaveBeenCalledWith(deadMeta);
    expect(isWrapperAliveFn).toHaveBeenCalledWith(liveMeta);
  });

  it('snapshots terminal runs beyond the first bounded directory batch', async () => {
    const dir = makeDir();
    writeMeta(dir, RUN_TERMINAL, { exitCode: 0 });
    fs.writeFileSync(path.join(dir, `codex-${RUN_TERMINAL}.jsonl`), '{"type":"terminal"}\n');
    const entries = ['junk', `codex-${RUN_TERMINAL}.jsonl`];
    const opendirSpy = vi.spyOn(fs, 'opendirSync').mockReturnValue({
      readSync: vi.fn(() => {
        const name = entries.shift();
        return name === undefined ? null : { name };
      }),
      closeSync: vi.fn(),
    });
    const onDiscover = vi.fn();
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      maxMetaScanCount: 1,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);

    try {
      await watcher.snapshot();
    } finally {
      opendirSpy.mockRestore();
    }
    await watcher.scan();

    expect(watcher.seen.has(RUN_TERMINAL)).toBe(true);
    expect(watcher.tails.has(RUN_TERMINAL)).toBe(false);
    expect(onDiscover).not.toHaveBeenCalled();
  });

  it('rolls back a rejected tail start and retries attachment', async () => {
    const dir = makeDir();
    writeMeta(dir, RUN_PENDING);
    fs.writeFileSync(path.join(dir, `codex-${RUN_PENDING}.jsonl`), '{"type":"live"}\n');
    let attempts = 0;
    class RetryTail extends FakeTail {
      async start() {
        attempts += 1;
        if (attempts <= 2) throw new Error('open failed');
        this.started = true;
      }
    }
    const watcher = new CodexWatcher({
      dir,
      pollIntervalMs: 60_000,
      TailClass: RetryTail,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);

    await watcher.start();
    expect(watcher.pending.has(RUN_PENDING)).toBe(true);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);
    expect(watcher.tails.has(RUN_PENDING)).toBe(false);

    await watcher.scan();
    expect(attempts).toBe(3);
    expect(watcher.pending.has(RUN_PENDING)).toBe(false);
    expect(watcher.attached.has(RUN_PENDING)).toBe(true);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);
  });

  it('does not commit an attachment that finishes after stop', async () => {
    const dir = makeDir();
    writeMeta(dir, RUN_PENDING);
    fs.writeFileSync(path.join(dir, `codex-${RUN_PENDING}.jsonl`), '{"type":"live"}\n');
    let releaseStart;
    const startGate = new Promise(resolve => { releaseStart = resolve; });
    const instances = [];
    class DelayedTail extends FakeTail {
      constructor(...args) {
        super(...args);
        instances.push(this);
      }
      async start() {
        await startGate;
        this.started = true;
      }
    }
    const watcher = new CodexWatcher({
      dir,
      pollIntervalMs: 60_000,
      TailClass: DelayedTail,
      isWrapperAliveFn: () => true,
    });
    const starting = watcher.start();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    const stopping = watcher.stop();
    releaseStart();
    await Promise.all([starting, stopping]);

    expect(instances[0].started).toBe(false);
    expect(watcher.tails.size).toBe(0);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);
    expect(await watcher.scan()).toBeUndefined();
  });

  it('rejects symlinked and non-regular sinks but attaches an oversized regular transcript', async () => {
    const dir = makeDir();
    const symlinkRun = RUN_PENDING;
    const fifoRun = RUN_LATE;
    const largeRun = RUN_LIVE;
    for (const runId of [symlinkRun, fifoRun, largeRun]) writeMeta(dir, runId);
    const target = path.join(dir, 'target.jsonl');
    fs.writeFileSync(target, '{"type":"forged"}\n');
    fs.symlinkSync(target, path.join(dir, `codex-${symlinkRun}.jsonl`));
    fs.mkdirSync(path.join(dir, `codex-${fifoRun}.jsonl`));
    const largePath = path.join(dir, `codex-${largeRun}.jsonl`);
    fs.closeSync(fs.openSync(largePath, 'w'));
    fs.truncateSync(largePath, DEFAULT_CODEX_TRANSCRIPT_MAX_BYTES + 1);
    const watcher = new CodexWatcher({
      dir,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);

    await watcher.start();

    expect(watcher.tails.has(largeRun)).toBe(true);
    expect(watcher.attached.has(largeRun)).toBe(true);
    expect([...watcher.pending.keys()].sort()).toEqual([fifoRun, symlinkRun].sort());
  });

  it('bounds each metadata scan and permanently skips rejected discoveries', async () => {
    const dir = makeDir();
    for (const runId of [RUN_LATE, RUN_PENDING, RUN_LIVE]) writeMeta(dir, runId);
    const onDiscover = vi.fn(() => false);
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      maxMetaScanCount: 2,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);

    await watcher.start();
    expect(onDiscover).toHaveBeenCalledTimes(2);
    await watcher.scan();
    await watcher.scan();
    expect(onDiscover).toHaveBeenCalledTimes(3);
  });

  it('permanently skips oversized metadata without reading it again', async () => {
    const dir = makeDir();
    const metaPath = path.join(dir, `codex-${RUN_PENDING}.meta.json`);
    const malformedName = 'codex-.meta.json';
    fs.writeFileSync(metaPath, 'x'.repeat(65));
    fs.writeFileSync(path.join(dir, malformedName), '{}');
    const watcher = new CodexWatcher({ dir, maxMetaBytes: 64, pollIntervalMs: 60_000 });
    watchers.push(watcher);

    await watcher.start();
    expect(watcher.permanentlySkipped.has(path.basename(metaPath))).toBe(true);
    expect(watcher.permanentlySkipped.has(malformedName)).toBe(true);
    fs.writeFileSync(metaPath, JSON.stringify({ runId: RUN_PENDING }));
    await watcher.scan();
    expect(watcher.pending.has(RUN_PENDING)).toBe(false);
  });

  it('clamps forged deadlines and detaches a continuous sub-cap transcript at its cumulative cap', async () => {
    const dir = makeDir();
    let now = Date.now();
    writeMeta(dir, RUN_LIVE, { deadlineTs: now + 10_000_000 });
    const transcript = path.join(dir, `codex-${RUN_LIVE}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"a","n":1}\n');
    const watcher = new CodexWatcher({
      dir,
      now: () => now,
      maxRunMs: 1_000,
      maxTranscriptBytes: 80,
      pollIntervalMs: 60_000,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);
    const caps = [];
    watcher.on('resourceCap', payload => caps.push(payload));

    await watcher.start();
    const acceptedDeadline = watcher.attachedMeta.get(RUN_LIVE).deadlineTs;
    expect(acceptedDeadline).toBe(now + 1_000);
    now += 100;
    expect(watcher._readMeta(RUN_LIVE).deadlineTs).toBe(acceptedDeadline);

    const append = `${JSON.stringify({ type: 'item', body: 'x'.repeat(18) })}\n`;
    fs.appendFileSync(transcript, append);
    await watcher.tails.get(RUN_LIVE).drain({ windowMs: 0 });
    expect(watcher.seen.has(RUN_LIVE)).toBe(false);
    fs.appendFileSync(transcript, append);
    await watcher.tails.get(RUN_LIVE).drain({ windowMs: 0 });

    expect(caps).toEqual([expect.objectContaining({ runId: RUN_LIVE, resource: 'bytes' })]);
    expect(watcher.seen.has(RUN_LIVE)).toBe(true);
    expect(watcher.attached.has(RUN_LIVE)).toBe(false);
    expect(watcher.tails.has(RUN_LIVE)).toBe(false);
  });

  it('terminalizes a run after its cumulative event budget including ephemerals', async () => {
    const dir = makeDir();
    writeMeta(dir, RUN_LIVE);
    const transcript = path.join(dir, `codex-${RUN_LIVE}.jsonl`);
    fs.writeFileSync(transcript, [1, 2, 3].map(n => JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', text: `thought ${n}` },
    })).join('\n') + '\n');
    const watcher = new CodexWatcher({
      dir,
      maxTranscriptEvents: 2,
      pollIntervalMs: 60_000,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);
    const events = [];
    const caps = [];
    watcher.on('codex-event', payload => events.push(payload));
    watcher.on('resourceCap', payload => caps.push(payload));

    await watcher.start();

    expect(events).toHaveLength(2);
    expect(caps).toEqual([expect.objectContaining({ runId: RUN_LIVE, resource: 'events' })]);
    expect(watcher.streamStates.get(RUN_LIVE).processedEvents).toBe(2);
    expect(watcher.seen.has(RUN_LIVE)).toBe(true);
    expect(watcher.attached.has(RUN_LIVE)).toBe(false);
  });
});

describe('CodexWatcher F5 partial-meta transient retry', () => {
  const PARTIAL = RUN_PENDING;
  const SIBLING = RUN_TERMINAL;

  function writePartialMeta(dir, runId) {
    // A genuinely half-written meta: valid prefix, truncated mid-object → JSON.parse
    // throws SyntaxError. This is exactly what a NON-atomic producer would expose.
    fs.writeFileSync(path.join(dir, `codex-${runId}.meta.json`), `{"runId":"${runId}","wrapperPid":`);
  }

  it('retains a mid-write partial meta without stalling sibling discovery, then discovers it once complete', async () => {
    const dir = makeDir();
    let now = 1_000_000;
    writeMeta(dir, SIBLING, { exitCode: 0 }); // valid terminal sibling
    writePartialMeta(dir, PARTIAL);
    const reconciled = [];
    const watcher = new CodexWatcher({
      dir,
      sessionId: 'sess',
      now: () => now,
      onReconcile: (runId, outcome) => { reconciled.push([runId, outcome]); return true; },
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);

    const complete = await watcher.reconcile({ claudeSessionId: 'sess' });

    // No global-discovery stall: the pass completes and reconciliationRequired clears
    // even though the partial meta is still unparseable.
    expect(complete).toBe(true);
    expect(watcher.reconciliationRequired).toBe(false);
    // Sibling valid run in the same pass IS discovered/terminalized.
    expect(reconciled).toEqual([[SIBLING, 'completed']]);
    // Partial run is RETAINED (not permanentlySkipped) for a later retry.
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);
    expect(watcher.metaParsePending.has(PARTIAL)).toBe(true);
    expect(watcher.reconcilePending.has(PARTIAL)).toBe(true);

    // Complete the file before either bound fires → discovery on the next scan.
    writeMeta(dir, PARTIAL);
    fs.writeFileSync(path.join(dir, `codex-${PARTIAL}.jsonl`), '{"type":"thread.started"}\n');
    await watcher.scan();

    expect(watcher.metaParsePending.has(PARTIAL)).toBe(false);
    expect(watcher.attached.has(PARTIAL)).toBe(true);
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);
  });

  it('recovers a partial meta completed within <=4 attempts (below the cap)', async () => {
    const dir = makeDir();
    let now = 1_000_000;
    writePartialMeta(dir, PARTIAL);
    const watcher = new CodexWatcher({
      dir, sessionId: 'sess', now: () => now,
      metaParseMaxAttempts: 5, metaParseTtlMs: 5000,
      onReconcile: () => true, pollIntervalMs: 60_000, TailClass: FakeTail,
      isWrapperAliveFn: () => true,
    });
    watchers.push(watcher);

    // 3 failing passes, clock barely moves (well within TTL, below attempt cap).
    for (let i = 0; i < 3; i += 1) { now += 10; await watcher._reconcile(); }
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);
    expect(watcher.metaParsePending.get(PARTIAL)?.attempts).toBe(3);

    // Complete it, then a scan recovers it (never quarantined).
    writeMeta(dir, PARTIAL);
    fs.writeFileSync(path.join(dir, `codex-${PARTIAL}.jsonl`), '{"type":"thread.started"}\n');
    await watcher.scan();
    expect(watcher.attached.has(PARTIAL)).toBe(true);
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);
  });

  it('quarantines at the attempt cap under rapid ticks inside the TTL', async () => {
    const dir = makeDir();
    let now = 1_000_000;
    writePartialMeta(dir, PARTIAL);
    const watcher = new CodexWatcher({
      dir, sessionId: 'sess', now: () => now,
      metaParseMaxAttempts: 5, metaParseTtlMs: 5000,
      onReconcile: () => true, pollIntervalMs: 60_000, TailClass: FakeTail,
    });
    watchers.push(watcher);

    for (let i = 0; i < 4; i += 1) { now += 10; await watcher._reconcile(); }
    // 4 rapid attempts, still within TTL → NOT yet quarantined.
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);

    now += 10; // 5th attempt, still well inside 5000ms → attempt cap trips.
    await watcher._reconcile();
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(true);
    expect(watcher.metaParsePending.has(PARTIAL)).toBe(false);
  });

  it('quarantines at the TTL when a valid meta never arrives (few attempts)', async () => {
    const dir = makeDir();
    let now = 1_000_000;
    writePartialMeta(dir, PARTIAL);
    const watcher = new CodexWatcher({
      dir, sessionId: 'sess', now: () => now,
      metaParseMaxAttempts: 5, metaParseTtlMs: 5000,
      onReconcile: () => true, pollIntervalMs: 60_000, TailClass: FakeTail,
    });
    watchers.push(watcher);

    now += 10; await watcher._reconcile(); // attempt 1, firstObservedAt=1_000_010
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(false);

    now += 6000; // past the 5000ms TTL, only 2 attempts total
    await watcher._reconcile();
    expect(watcher.permanentlySkipped.has(`codex-${PARTIAL}.meta.json`)).toBe(true);
    expect(watcher.metaParsePending.has(PARTIAL)).toBe(false);
  });
});

describe('bridge watcher wiring', () => {
  it('does not construct a watcher when Codex visualization is disabled', () => {
    const WatcherClass = vi.fn();

    const watcher = createCodexWatcherIfEnabled(
      { dir: '/unused' },
      { env: { MATRON_CODEX_VIZ: '0' }, WatcherClass },
    );

    expect(watcher).toBeNull();
    expect(WatcherClass).not.toHaveBeenCalled();
  });

  it.each(['construction', 'startup'])('fails open when watcher %s throws', async failure => {
    const onFailure = vi.fn();
    const log = { warn: vi.fn() };
    const WatcherClass = failure === 'construction'
      ? class { constructor() { throw new Error('construct'); } }
      : class { start() { throw new Error('start'); } };

    // A producer is present, so activation proceeds to construction/startup.
    expect(() => startCodexWatcherIfEnabled({}, {
      env: { MATRON_CODEX_VIZ: '1' }, WatcherClass, log, onFailure, detectProducer: () => true,
    })).not.toThrow();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  // T-1.6 / AC#2: the fail-loud activation guard.
  it('warns and does NOT construct a watcher when VIZ=1 but no producer is detected', () => {
    const WatcherClass = vi.fn();
    const log = { warn: vi.fn() };

    const watcher = createCodexWatcherIfEnabled(
      { dir: '/unused' },
      { env: { MATRON_CODEX_VIZ: '1' }, WatcherClass, log, detectProducer: () => false },
    );

    expect(watcher).toBeNull();
    expect(WatcherClass).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toMatch(/no producer/);
  });

  it('constructs the watcher when a producer IS detected (e.g. wrapper-only, shim absent)', () => {
    const WatcherClass = vi.fn();
    const log = { warn: vi.fn() };

    // MATRON_CODEX_REAL_BIN set → the real detectProducer returns true even with
    // the shim absent from PATH (no false-disable of the valid wrapper producer).
    const watcher = createCodexWatcherIfEnabled(
      { dir: '/unused' },
      { env: { MATRON_CODEX_VIZ: '1', MATRON_CODEX_REAL_BIN: '/usr/bin/codex' }, WatcherClass, log },
    );

    expect(watcher).not.toBeNull();
    expect(WatcherClass).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
