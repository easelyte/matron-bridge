import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexWatcher } from '../lib/codex-watcher.js';

const RUN_LATE = '1722600000000-1234-abcd';
const RUN_PENDING = '1722600000001-1234-1234';
const RUN_TERMINAL = '1722600000002-1234-beef';
const RUN_LIVE = '1722600000003-1234-cafe';

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

afterEach(async () => {
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
});

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-'));
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

    expect(watcher.pollTimer).not.toBeNull();
    writeMeta(dir, RUN_LATE);

    await vi.waitFor(() => expect(onDiscover).toHaveBeenCalledOnce());
    expect(onDiscover).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_LATE }));
    expect(watcher.pollTimer).not.toBeNull();
  });

  it('holds a discovered meta pending until JSONL exists and marks seen only after attach', () => {
    const dir = makeDir();
    const onDiscover = vi.fn();
    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);
    const meta = writeMeta(dir, RUN_PENDING);

    watcher.scan();

    expect(onDiscover).toHaveBeenCalledWith(meta);
    expect(watcher.pending.has(RUN_PENDING)).toBe(true);
    expect(watcher.seen.has(RUN_PENDING)).toBe(false);

    fs.writeFileSync(path.join(dir, `codex-${RUN_PENDING}.jsonl`), '{"type":"thread.started"}\n');
    watcher.scan();

    expect(watcher.pending.has(RUN_PENDING)).toBe(false);
    expect(watcher.seen.has(RUN_PENDING)).toBe(true);
    expect(watcher.tails.get(RUN_PENDING)?.started).toBe(true);
  });

  it('retries discovery when the child handoff fails open', () => {
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
    writeMeta(dir, RUN_PENDING);

    watcher.scan();
    expect(watcher.pending.has(RUN_PENDING)).toBe(false);

    watcher.scan();
    expect(onDiscover).toHaveBeenCalledTimes(2);
    expect(watcher.pending.has(RUN_PENDING)).toBe(true);
  });

  it('snapshots terminal JSONL as seen but attaches and resumes a live JSONL', () => {
    const dir = makeDir();
    writeMeta(dir, RUN_TERMINAL, { exitCode: 0 });
    fs.writeFileSync(path.join(dir, `codex-${RUN_TERMINAL}.jsonl`), '{"type":"terminal"}\n');
    const liveMeta = writeMeta(dir, RUN_LIVE, { wrapperStartTicks: 'matching' });
    fs.writeFileSync(path.join(dir, `codex-${RUN_LIVE}.jsonl`), '{"type":"live"}\n');
    const onDiscover = vi.fn();
    const isWrapperAliveFn = vi.fn(meta => meta.runId === RUN_LIVE);

    const watcher = new CodexWatcher({
      dir,
      onDiscover,
      isWrapperAliveFn,
      pollIntervalMs: 60_000,
      TailClass: FakeTail,
    });
    watchers.push(watcher);

    expect(watcher.seen.has(RUN_TERMINAL)).toBe(true);
    expect(watcher.tails.has(RUN_TERMINAL)).toBe(false);
    expect(watcher.seen.has(RUN_LIVE)).toBe(true);
    expect(watcher.tails.get(RUN_LIVE)).toMatchObject({
      started: true,
      options: { readFromStart: true },
    });
    expect(onDiscover).toHaveBeenCalledTimes(1);
    expect(onDiscover).toHaveBeenCalledWith(liveMeta);
    expect(isWrapperAliveFn).toHaveBeenCalledWith(liveMeta);
  });
});

describe('bridge watcher wiring', () => {
  it('constructs the per-session watcher only when Codex visualization is enabled', () => {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

    expect(source).toContain("import { CodexWatcher");
    expect(source).toMatch(/if \(process\.env\.MATRON_CODEX_VIZ !== '0'\) \{[\s\S]*?new CodexWatcher\(\{/);
  });
});
