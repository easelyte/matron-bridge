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

    expect(() => startCodexWatcherIfEnabled({}, { WatcherClass, log, onFailure })).not.toThrow();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
