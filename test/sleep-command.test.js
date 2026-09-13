import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  sleepConfig, sleepButtons, sleepCardText, performSleep, runSleepCommand,
  DEFAULT_WAKE_HINT, SLEEP_NOT_CONFIGURED, SLEEP_SETTLE_MS,
} from '../lib/sleep-command.js';

describe('sleepConfig', () => {
  it('reports no command when MATRON_SLEEP_COMMAND is unset', () => {
    // The shipped open-source default: /sleep is inert until a deployer
    // opts in, because "poweroff" is only reversible where something else
    // can start the box again.
    expect(sleepConfig({}).command).toBeNull();
  });

  it('treats a whitespace-only command as unset', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: '   ' }).command).toBeNull();
  });

  it('returns the configured command, trimmed', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: ' sudo systemctl poweroff ' }).command)
      .toBe('sudo systemctl poweroff');
  });

  it('falls back to a deployment-neutral wake hint', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: 'x' }).wakeHint).toBe(DEFAULT_WAKE_HINT);
  });

  it('returns the configured wake hint when set', () => {
    const cfg = sleepConfig({
      MATRON_SLEEP_COMMAND: 'x',
      MATRON_SLEEP_WAKE_HINT: 'message this chat and I will wake up',
    });
    expect(cfg.wakeHint).toBe('message this chat and I will wake up');
  });
});

describe('sleepButtons', () => {
  it('offers confirm and cancel with sleep- ids and sleep: values', () => {
    // The `sleep-` id prefix is what marks the frame non-answerable in
    // lib/journal-input-router.js; the `sleep:` value is what
    // lib/picker-dispatch.js routes. Both halves must line up or a tap
    // silently no-ops.
    const [confirm, cancel] = sleepButtons();
    expect(confirm.id).toBe('sleep-confirm');
    expect(confirm.value).toBe('sleep:confirm');
    expect(cancel.id).toBe('sleep-cancel');
    expect(cancel.value).toBe('sleep:cancel');
  });

  it('labels both buttons', () => {
    for (const b of sleepButtons()) expect(b.label.trim()).not.toBe('');
  });
});

describe('sleepCardText', () => {
  it('names the wake path so the card can say how to undo itself', () => {
    const text = sleepCardText({ wakeHint: 'message this chat', busyCount: 0 });
    expect(text).toContain('message this chat');
  });

  it('warns when sessions are mid-turn', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 2 })).toMatch(/2 sessions/);
  });

  it('warns in the singular for one busy session', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 1 })).toMatch(/1 session\b/);
  });

  it('says nothing about sessions when none are mid-turn', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 0 })).not.toMatch(/session/);
  });
});

describe('performSleep', () => {
  function seams() {
    const calls = [];
    return {
      calls,
      publish: vi.fn(async text => { calls.push(`publish:${text}`); }),
      flush: vi.fn(async () => { calls.push('flush'); }),
      exec: vi.fn(async cmd => { calls.push(`exec:${cmd}`); }),
    };
  }

  it('flushes the journal before executing, so the goodbye survives the shutdown', async () => {
    // The whole point of the ordering: the command kills this process. A
    // goodbye still sitting in the outbound queue is a goodbye nobody sees.
    const s = seams();
    await performSleep({ command: 'poweroff', ...s });
    expect(s.calls).toEqual(['publish:😴 Sleeping now.', 'flush', 'exec:poweroff']);
  });

  it('reports ok when the command was launched', async () => {
    const s = seams();
    expect(await performSleep({ command: 'poweroff', ...s })).toEqual({ ok: true });
  });

  it('refuses without a configured command and never execs', async () => {
    const s = seams();
    const result = await performSleep({ command: null, ...s });
    expect(result.ok).toBe(false);
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.publish).toHaveBeenCalledWith(SLEEP_NOT_CONFIGURED);
  });

  it('tells the user when the sleep command fails, because the box is still awake', async () => {
    // A failed poweroff leaves a live bridge and a user who was told it was
    // going away. Silence here is the worst outcome.
    const s = seams();
    s.exec = vi.fn(async () => { throw new Error('sudo: a password is required'); });
    const result = await performSleep({ command: 'poweroff', ...s });
    expect(result.ok).toBe(false);
    expect(s.publish).toHaveBeenLastCalledWith(
      expect.stringContaining('sudo: a password is required'));
  });

  it('still executes when the flush fails, so a dead socket cannot block sleep', async () => {
    const s = seams();
    s.flush = vi.fn(async () => { throw new Error('socket closed'); });
    const result = await performSleep({ command: 'poweroff', ...s });
    expect(result.ok).toBe(true);
    expect(s.exec).toHaveBeenCalledWith('poweroff');
  });
});

describe('runSleepCommand', () => {
  // A stand-in for a real ChildProcess: an EventEmitter with the stderr
  // stream and unref() the seam actually touches.
  function fakeChild() {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = vi.fn();
    return child;
  }

  function harness() {
    const child = fakeChild();
    const timers = [];
    return {
      child,
      timers,
      spawn: vi.fn(() => child),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return 'handle'; },
      fire: () => timers.forEach(t => t.fn()),
    };
  }

  it('runs the command through sh -c, detached, so it outlives this process', () => {
    const h = harness();
    runSleepCommand('poweroff', h);
    expect(h.spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'poweroff'],
      expect.objectContaining({ detached: true }));
  });

  it('rejects when the spawn itself fails, instead of crashing the bridge', async () => {
    // An unhandled 'error' event on a ChildProcess terminates the process.
    // fork(2) returning EAGAIN under memory pressure is a real way to get one.
    const h = harness();
    const promise = runSleepCommand('poweroff', h);
    h.child.emit('error', new Error('spawn EAGAIN'));
    await expect(promise).rejects.toThrow('spawn EAGAIN');
  });

  it('rejects on a non-zero exit so a failed sleep is never reported as success', async () => {
    const h = harness();
    const promise = runSleepCommand('sudo systemctl poweroff', h);
    h.child.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
    h.child.emit('exit', 1);
    await expect(promise).rejects.toThrow(/sudo: a password is required/);
  });

  it('treats a signal kill as the shutdown reaping us, not as a failure', async () => {
    // `exit` reports code === null when the child was killed by a signal, and
    // a real poweroff SIGTERMs everything inside the settle window. Reporting
    // that as "still awake" contradicts a machine that is genuinely going
    // down — the opposite of the honest failure this seam exists for.
    const h = harness();
    const promise = runSleepCommand('poweroff', h);
    h.child.emit('exit', null, 'SIGTERM');
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on a clean exit', async () => {
    const h = harness();
    const promise = runSleepCommand('poweroff', h);
    h.child.emit('exit', 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves once the command is still running at the settle window', async () => {
    // The shutdown is under way and this process is about to be torn down —
    // waiting for an exit that will never be observed would hang the reply.
    const h = harness();
    const promise = runSleepCommand('poweroff', h);
    expect(h.timers[0].ms).toBe(SLEEP_SETTLE_MS);
    h.fire();
    await expect(promise).resolves.toBeUndefined();
    expect(h.child.unref).toHaveBeenCalled();
  });

  it('caps how much stderr it retains from a failing command', async () => {
    const h = harness();
    const promise = runSleepCommand('poweroff', h);
    h.child.stderr.emit('data', Buffer.from('x'.repeat(10_000)));
    h.child.emit('exit', 1);
    await expect(promise).rejects.toThrow(/x{100}/);
    const err = await promise.catch(e => e);
    expect(err.message.length).toBeLessThan(3000);
  });
});
