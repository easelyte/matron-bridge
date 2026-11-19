import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSpawnCwd, attachSpawnErrorHandler, attachStdinErrorHandler } from '../lib/spawn-guard.js';

describe('resolveSpawnCwd', () => {
  const exists = (p) => p === '/exists' || p === '/fallback';

  it('keeps the requested workdir when it exists', () => {
    expect(resolveSpawnCwd('/exists', ['/fallback'], { exists }))
      .toEqual({ cwd: '/exists', fellBack: false, missing: null });
  });

  it('falls back to the first existing fallback when the workdir is gone', () => {
    expect(resolveSpawnCwd('/renamed-away', ['/also-gone', '/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: '/renamed-away' });
  });

  it('treats a null/empty workdir as missing', () => {
    expect(resolveSpawnCwd(null, ['/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: null });
    expect(resolveSpawnCwd('', ['/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: null });
  });

  it('returns the last fallback even when nothing exists', () => {
    expect(resolveSpawnCwd('/gone', ['/gone-too'], { exists }))
      .toEqual({ cwd: '/gone-too', fellBack: true, missing: '/gone' });
  });

  it('checks the real filesystem by default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spawn-guard-'));
    try {
      expect(resolveSpawnCwd(dir, ['/nope']).cwd).toBe(dir);
      expect(resolveSpawnCwd(path.join(dir, 'missing'), [dir]))
        .toEqual({ cwd: dir, fellBack: true, missing: path.join(dir, 'missing') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attachSpawnErrorHandler', () => {
  it("absorbs the 'error' event instead of crashing the process", () => {
    const proc = new EventEmitter();
    attachSpawnErrorHandler(proc, { notify: () => {}, log: () => {} });
    // Without a listener, EventEmitter throws on 'error' — the bridge crash.
    expect(() => proc.emit('error', new Error('spawn claude ENOENT'))).not.toThrow();
  });

  it('logs and notifies with the error message', () => {
    const proc = new EventEmitter();
    const notify = vi.fn();
    const log = vi.fn();
    attachSpawnErrorHandler(proc, { notify, log });
    proc.emit('error', new Error('spawn claude ENOENT'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('spawn claude ENOENT'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('spawn claude ENOENT'));
  });

  it('survives a notifier that throws', () => {
    const proc = new EventEmitter();
    attachSpawnErrorHandler(proc, {
      notify: () => { throw new Error('room send failed'); },
      log: () => {},
    });
    expect(() => proc.emit('error', new Error('boom'))).not.toThrow();
  });

  // index.js keeps ALL session cleanup (alive=false, teardown, the 3-restart
  // cap) in proc.on('close') and relies on Node emitting 'close' even when
  // spawn itself fails. Pin that runtime contract with a real failed spawn —
  // if a future Node stops emitting 'close' after a spawn 'error', sessions
  // would leak exactly as PR #145's review feared.
  it("real failed spawn emits 'close' after 'error'", async () => {
    const { spawn } = await import('node:child_process');
    const proc = spawn('matron-bridge-no-such-binary', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    attachSpawnErrorHandler(proc, { notify: () => {}, log: () => {} });
    const events = [];
    proc.on('error', () => events.push('error'));
    await new Promise((resolve) => proc.on('close', () => { events.push('close'); resolve(); }));
    expect(events).toEqual(['error', 'close']);
  });
});

describe('attachStdinErrorHandler', () => {
  it('logs a stdin error instead of letting it throw', () => {
    const stdin = new EventEmitter();
    const log = vi.fn();
    attachStdinErrorHandler({ stdin }, { log });
    expect(() => stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('claude stdin error: write EPIPE');
  });

  it('adds one listener only, and tolerates a process with no stdin', () => {
    const stdin = new EventEmitter();
    attachStdinErrorHandler({ stdin }, { log: () => {} });
    attachStdinErrorHandler({ stdin }, { log: () => {} });
    expect(stdin.listenerCount('error')).toBe(1);
    expect(() => attachStdinErrorHandler({ stdin: null }, { log: () => {} })).not.toThrow();
  });

  it('survives a logger that throws', () => {
    const stdin = new EventEmitter();
    attachStdinErrorHandler({ stdin }, { log: () => { throw new Error('log failed'); } });
    expect(() => stdin.emit('error', new Error('boom'))).not.toThrow();
  });

  // The real case: the reading end of the pipe has gone but the bridge has
  // not seen the child exit yet, and it writes one more message. Unguarded,
  // this write ends the process with "Unhandled 'error' event". POSIX only:
  // a Windows pipe does not report the closed reader as EPIPE on this write.
  it.skipIf(process.platform === 'win32')('absorbs the error from a write into a pipe the child has closed', async () => {
    const { spawn } = await import('node:child_process');
    const child = 'require("fs").closeSync(0); console.log("closed"); setTimeout(() => {}, 10000)';
    const proc = spawn(process.execPath, ['-e', child], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const log = vi.fn();
      attachStdinErrorHandler(proc, { log });
      await new Promise((resolve) => proc.stdout.once('data', resolve));
      const writeError = await new Promise((resolve) => proc.stdin.write('{"type":"user"}\n', resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(writeError?.code).toBe('EPIPE');
      expect(log).toHaveBeenCalledWith('claude stdin error: write EPIPE');
    } finally {
      proc.kill();
    }
  });
});
