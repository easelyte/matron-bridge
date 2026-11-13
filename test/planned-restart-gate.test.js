import { describe, expect, it, vi } from 'vitest';
import { createPlannedRestart } from '../lib/planned-restart.js';

function make({ requests = [{ request_key: 'a', sha: 'bbb' }], bootSha = 'aaa', head = 'ccc', quiet, status = '',
  ancestors = ['bbb'], preflight, onReady = () => ({ latched: false }), state: stateOverrides = {} } = {}) {
  let t = 1_000_000;
  const state = { id: 'r1', state: 'pending', requests, boot_sha: bootSha,
    first_request_at: t - 600_000, last_request_at: t - 600_000, ...stateOverrides };
  const git = vi.fn(args => {
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'merge-base') return ancestors.includes(args[2]);
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
  const fs = { readFileSync: () => Buffer.from('lock'), statSync: () => ({ ino: 1, mtimeMs: 2 }) };
  const warn = vi.fn();
  const gate = createPlannedRestart({
    repoDir: '/repo', stateStore: { getState: () => state }, git, fs, now: () => t, warn, onReady,
    quiet: quiet ?? (() => ({ holders: [], probe_error: null })),
    preflight: preflight ?? (() => Promise.resolve({ ok: true })),
  });
  return { gate, git, warn, state, advance: ms => { t += ms; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('planned restart gate', () => {
  it('names what holds the restart and never passes while a session holds work', () => {
    const quiet = () => ({ holders: [{ convoId: 'c1', why: 'busy' }], probe_error: null });
    const { gate } = make({ quiet });
    const result = gate.evaluate();
    expect(result.would_pass).toBe(false);
    expect(result.waiting_on.quiet.holders).toEqual([{ convoId: 'c1', why: 'busy' }]);
  });

  it('treats a failed probe as not quiet', () => {
    const { gate } = make({ quiet: () => ({ holders: [], probe_error: 'process_table' }) });
    const result = gate.evaluate();
    expect(result.would_pass).toBe(false);
    expect(result.waiting_on.quiet.probe_error).toBe('process_table');
    const thrown = make({ quiet: () => { throw new Error('boom'); } }).gate.evaluate();
    expect(thrown.waiting_on.quiet.probe_error).toBe('quiet');
  });

  it('requires a descendant of every requested sha and a clean tree', () => {
    expect(make({ ancestors: [] }).gate.evaluate().waiting_on.code).toBe('not a descendant');
    expect(make({ status: ' M index.js\n' }).gate.evaluate().waiting_on.code).toBe('dirty tree');
    expect(make().gate.evaluate().waiting_on.code).toBeNull();
    expect(make({ requests: [{ request_key: 'a', sha: '--upload-pack=x' }] }).gate.evaluate().waiting_on.code).toBe('not a descendant');
  });

  it('lets a sha-less request through only onto the code already running', () => {
    const configOnly = [{ request_key: 'a' }];
    expect(make({ requests: configOnly, head: 'aaa' }).gate.evaluate().waiting_on.code).toBeNull();
    expect(make({ requests: configOnly, head: 'ccc' }).gate.evaluate().waiting_on.code).toBe('head moved (config-only)');
    expect(make({ requests: configOnly, bootSha: null }).gate.evaluate().waiting_on.code).toBe('head moved (config-only)');
  });

  it('waits out the collect window, capped at 30 minutes after the first request', () => {
    const base = { first_request_at: 1_000_000 - 10_000, last_request_at: 1_000_000 - 10_000 };
    expect(make({ state: base }).gate.evaluate().waiting_on.collect).toEqual({ remaining_ms: 50_000 });
    const capped = { first_request_at: 1_000_000 - 31 * 60_000, last_request_at: 1_000_000 - 1000 };
    expect(make({ state: capped }).gate.evaluate().waiting_on.collect).toBeNull();
  });

  it('holds a restart that was pending at boot until the settle time has passed', () => {
    const settle = { first_request_at: 1_000_000 - 600_000, last_request_at: 1_000_000 - 600_000 };
    const result = make({ state: settle });
    expect(result.gate.evaluate().waiting_on.collect).toBeNull();
    const held = createPlannedRestart({ repoDir: '/repo', stateStore: { getState: () => result.state }, quiet: () => ({ holders: [], probe_error: null }),
      git: result.git, now: () => 1_000_000, notBefore: 1_000_000 + 45_000, preflight: () => Promise.resolve({ ok: true }),
      fs: { readFileSync: () => Buffer.from('lock'), statSync: () => ({ ino: 1, mtimeMs: 2 }) } });
    expect(held.evaluate().waiting_on.collect).toEqual({ remaining_ms: 45_000 });
    expect(held.evaluate().would_pass).toBe(false);
  });

  it('runs the preflight once per sha and reuses the result for five minutes', async () => {
    const preflight = vi.fn(() => Promise.resolve({ ok: true }));
    const { gate, advance } = make({ preflight });
    expect(gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await settle();
    expect(gate.evaluate().waiting_on.preflight).toBeNull();
    expect(preflight).toHaveBeenCalledTimes(1);
    advance(5 * 60_000 + 1);
    expect(gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed preflight pending, warns once and hides the runner output', async () => {
    const { gate, warn } = make({ preflight: () => Promise.resolve({ ok: false, error: 'secret=hunter2' }) });
    gate.evaluate();
    await settle();
    expect(gate.evaluate().waiting_on.preflight).toEqual({ error: 'preflight failed' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('hunter2');
    expect(gate.evaluate().would_pass).toBe(false);
  });

  it('survives a throwing preflight runner', async () => {
    const { gate } = make({ preflight: () => { throw new Error('spawn'); } });
    gate.evaluate();
    await settle();
    expect(gate.evaluate().waiting_on.preflight).toEqual({ error: 'preflight failed' });
  });

  it('hands over to the latch only after two quiet polls with everything else passed', async () => {
    const onReady = vi.fn(() => ({ latched: true }));
    const { gate } = make({ onReady });
    gate.tick();
    await settle();
    expect(onReady).not.toHaveBeenCalled();
    gate.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toMatchObject({ sha: 'ccc', key: { sha: 'ccc' }, state: { id: 'r1' } });
    gate.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('a busy poll resets the two-poll requirement', async () => {
    let busy = false;
    const onReady = vi.fn(() => ({ latched: true }));
    const { gate } = make({ onReady, quiet: () => ({ holders: busy ? [{ convoId: 'c', why: 'busy' }] : [], probe_error: null }) });
    gate.tick();
    await settle();
    busy = true;
    gate.tick();
    busy = false;
    gate.tick();
    expect(onReady).not.toHaveBeenCalled();
    gate.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('retries the latch at the next poll when it refuses', async () => {
    const onReady = vi.fn(() => ({ latched: false }));
    const { gate } = make({ onReady });
    gate.tick();
    await settle();
    gate.tick();
    gate.tick();
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a pending restart', () => {
    const onReady = vi.fn();
    const { gate } = make({ onReady, state: { state: 'back' } });
    expect(gate.tick().would_pass).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('warns every 30 minutes while held, and says it never forces', () => {
    const { gate, warn, advance } = make({ quiet: () => ({ holders: [{ convoId: 'c', why: 'busy' }], probe_error: null }),
      state: { first_request_at: 1_000_000 - 29 * 60_000 } });
    gate.tick();
    expect(warn).not.toHaveBeenCalled();
    advance(2 * 60_000);
    gate.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/never forcing/);
    gate.tick();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid collect duration', () => {
    expect(() => createPlannedRestart({ repoDir: '/r', collectMs: -1 })).toThrow('Invalid collect duration');
  });
});
