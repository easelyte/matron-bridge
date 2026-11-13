import { describe, expect, it, vi } from 'vitest';
import { createRestartLatch } from '../lib/restart-latch.js';
import { RESTART_EXIT_CODE } from '../lib/code-update-restart.js';

function make(overrides = {}) {
  let t = 5000;
  let state = { id: 'r1', state: 'pending', requests: [{ request_key: 'a' }], boot_sha: 'aaa' };
  const calls = [];
  const stateStore = {
    getState: () => state,
    setState: vi.fn((next, patch) => { calls.push(`state:${next}`); state = { ...state, ...patch, state: next }; return state; }),
  };
  const deps = {
    stateStore, bootId: 'boot-1', now: () => t,
    quiet: () => ({ holders: [], probe_error: null }),
    readCode: () => ({ sha: 'bbb', code: null }),
    cacheKey: sha => ({ sha, deps_stamp: 'd' }),
    getPreflight: () => ({ status: 'ok', at: t - 1000, key: { sha: 'bbb', deps_stamp: 'd' } }),
    participants: () => ['c1'],
    writeStamp: vi.fn(() => calls.push('stamp')),
    deleteStamp: vi.fn(() => calls.push('unstamp')),
    reportState: vi.fn(status => calls.push(`publish:${status}`)),
    gracefulShutdown: vi.fn(() => calls.push('shutdown')),
    log: vi.fn(),
    ...overrides,
  };
  const latch = createRestartLatch(deps);
  const verdict = { sha: 'bbb', state };
  return { latch, deps, calls, verdict, get state() { return state; } };
}

describe('restart latch', () => {
  it('records the restart, writes the stamp, publishes, then shuts down with the restart exit code', () => {
    const h = make();
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: true });
    expect(h.calls).toEqual(['state:restarting', 'stamp', 'publish:restarting', 'shutdown']);
    expect(h.state).toMatchObject({ state: 'restarting', expected_sha: 'bbb', previous_sha: 'aaa', boot_id: 'boot-1', participants: ['c1'] });
    expect(h.deps.writeStamp).toHaveBeenCalledWith({ bootId: 'boot-1', sha: 'bbb', busy: 0, reason: 'planned', restartId: 'r1', at: 5000 });
    expect(h.deps.gracefulShutdown).toHaveBeenCalledWith('planned-restart', { exitCode: RESTART_EXIT_CODE });
  });

  it.each([
    ['a session holds work', { quiet: () => ({ holders: [{ convoId: 'c', why: 'busy' }], probe_error: null }) }],
    ['the quiet probe failed', { quiet: () => ({ holders: [], probe_error: 'process_table' }) }],
    ['the quiet probe returned nothing', { quiet: () => undefined }],
    ['the code no longer pins', { readCode: () => ({ sha: 'bbb', code: 'dirty tree' }) }],
    ['HEAD moved since the gate', { readCode: () => ({ sha: 'ddd', code: null }) }],
    ['the preflight is for another sha', { getPreflight: () => ({ status: 'ok', at: 4000, key: { sha: 'zzz', deps_stamp: 'd' } }) }],
    ['the dependencies changed', { cacheKey: sha => ({ sha, deps_stamp: 'other' }) }],
    ['the preflight failed', { getPreflight: () => ({ status: 'error', at: 4000, key: { sha: 'bbb', deps_stamp: 'd' } }) }],
    ['the preflight is stale', { getPreflight: () => ({ status: 'ok', at: 5000 - 300_000, key: { sha: 'bbb', deps_stamp: 'd' } }) }],
    ['the restart is switched off', { available: () => false }],
  ])('does not latch when %s', (_name, overrides) => {
    const h = make(overrides);
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: false });
    expect(h.deps.gracefulShutdown).not.toHaveBeenCalled();
    expect(h.deps.writeStamp).not.toHaveBeenCalled();
    expect(h.state.state).toBe('pending');
  });

  it('does not latch a restart that is no longer pending', () => {
    const h = make();
    h.deps.stateStore.setState('back');
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: false });
    expect(h.deps.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('reverts to pending and removes the stamp when the stamp write fails, without shutting down', () => {
    const h = make({ writeStamp: vi.fn(() => { throw new Error('EACCES /secret/path'); }) });
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: false });
    expect(h.state).toMatchObject({ state: 'pending', restarting_at: null, expected_sha: null, participants: [] });
    expect(h.deps.deleteStamp).toHaveBeenCalledTimes(1);
    expect(h.deps.gracefulShutdown).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith('Planned restart refused: latch failed');
  });

  it('removes the stamp even when the revert itself cannot write the state', () => {
    const h = make({ writeStamp: vi.fn(() => { throw new Error('EIO'); }) });
    h.deps.stateStore.setState.mockImplementation((next, patch) => {
      if (next === 'pending') throw new Error('EROFS');
      return patch;
    });
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: false });
    expect(h.deps.deleteStamp).toHaveBeenCalledTimes(1);
    expect(h.deps.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('reverts when the durable state write fails', () => {
    const h = make();
    h.deps.stateStore.setState.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: false });
    expect(h.deps.gracefulShutdown).not.toHaveBeenCalled();
    expect(h.deps.writeStamp).not.toHaveBeenCalled();
  });

  it('can latch again after a refusal', () => {
    let failing = true;
    const h = make({ writeStamp: vi.fn(() => { if (failing) throw new Error('EIO'); }) });
    expect(h.latch.onReady(h.verdict).latched).toBe(false);
    failing = false;
    expect(h.latch.onReady(h.verdict).latched).toBe(true);
  });

  it('a second call after the shutdown has started changes nothing', () => {
    const h = make();
    h.latch.onReady(h.verdict);
    expect(h.latch.onReady(h.verdict)).toEqual({ latched: true });
    expect(h.deps.gracefulShutdown).toHaveBeenCalledTimes(1);
  });
});
