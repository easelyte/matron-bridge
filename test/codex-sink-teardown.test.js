import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { removeCodexSinkForSession } from '../lib/codex-paths.js';

describe('removeCodexSinkForSession', () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes the whole sink directory, leaves other sinks, and tolerates repeated cleanup', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sink-teardown-'));
    const target = path.join(root, 'example');
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(target, 'codex-runs'), { recursive: true });
    fs.writeFileSync(path.join(target, 'codex-runs', 'events.jsonl'), '{}\n');
    fs.mkdirSync(other);

    removeCodexSinkForSession('example', { root });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(() => removeCodexSinkForSession('example', { root })).not.toThrow();
  });

  it('rejects unsafe identifiers without touching the filesystem', () => {
    const rmSync = vi.fn();
    for (const value of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x..y', undefined, null, 42]) {
      removeCodexSinkForSession(value, { root: 'sinks', fsImpl: { rmSync } });
    }
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('does not throw when removal fails', () => {
    const rmSync = vi.fn(() => { throw new Error('EBUSY'); });
    expect(() => removeCodexSinkForSession('example', { root: 'sinks', fsImpl: { rmSync } })).not.toThrow();
    expect(rmSync).toHaveBeenCalledWith(path.join('sinks', 'example'), { recursive: true, force: true });
  });
});

// Execute the real teardown without starting index.js's sockets and services.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf('function teardownSubagentTracking(');
const end = source.indexOf('\n}\n', start) + 2;

describe('visualization sink teardown wiring', () => {
  it.each([
    [{ MATRON_CODEX_VIZ: '1' }, {}, 'example', true],
    [undefined, { MATRON_CODEX_VIZ: '1' }, 'example', true],
    [{}, { MATRON_CODEX_VIZ: '1' }, 'example', false],
    [{ MATRON_CODEX_VIZ: '0' }, {}, 'example', false],
    [{ MATRON_CODEX_VIZ: '1' }, {}, undefined, false],
  ])('uses the session environment with a bridge fallback (%j, %j, %s)', (codexSpawnEnv, env, claudeSessionId, removes) => {
    const remove = vi.fn();
    const teardown = vm.runInNewContext(`(${source.slice(start, end)})`, {
      removeCodexSinkForSession: remove, process: { env }, sessions: new Map(),
    });
    teardown({ codexSpawnEnv, claudeSessionId });
    expect(remove.mock.calls).toEqual(removes ? [[claudeSessionId]] : []);
  });

  it('stops the watcher before removing the sink and settles child tracking', () => {
    const calls = [];
    const stop = vi.fn(() => { calls.push('stop'); return Promise.resolve(); });
    const finishAll = vi.fn();
    const session = {
      claudeSessionId: 'example', codexSpawnEnv: { MATRON_CODEX_VIZ: '1' },
      codexWatcher: { stop }, subagentWatcher: { stop }, subagentConvos: { finishAll },
    };
    const teardown = vm.runInNewContext(`(${source.slice(start, end)})`, {
      removeCodexSinkForSession: () => calls.push("remove"), sessions: new Map(),
    });
    teardown(session);
    expect(calls).toEqual(['stop', 'remove', 'stop']);
    expect(finishAll).toHaveBeenCalledOnce();
    expect(session.codexWatcher).toBeNull();
    expect(session.subagentWatcher).toBeNull();
    expect(session.subagentConvos).toBeNull();
  });

  it('removes once per session and leaves a sink a live resumed session now owns', () => {
    const remove = vi.fn();
    const sessions = new Map();
    const teardown = vm.runInNewContext(`(${source.slice(start, end)})`, {
      removeCodexSinkForSession: remove, process: { env: { MATRON_CODEX_VIZ: '1' } }, sessions,
    });
    const old = { claudeSessionId: 'example' };
    teardown(old);
    teardown(old);
    expect(remove).toHaveBeenCalledTimes(1);

    sessions.set('room', { claudeSessionId: 'resumed', alive: true });
    teardown({ claudeSessionId: 'resumed' });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
