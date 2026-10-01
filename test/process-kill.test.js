import { describe, it, expect, vi } from 'vitest';
import { killProcessTree, taskkillArgs } from '../lib/process-kill.js';

describe('killProcessTree', () => {
  it('POSIX: just the signal, no taskkill', async () => {
    const kill = vi.fn();
    const exec = vi.fn();
    await expect(killProcessTree(1234, 'SIGTERM', { kill, exec, platform: 'linux' })).resolves.toBe('signal');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(exec).not.toHaveBeenCalled();
  });

  it('win32: taskkill /T /F on the pid first, then the direct kill (releases pty handles)', async () => {
    const order = [];
    const kill = vi.fn(() => order.push('kill'));
    const exec = vi.fn((file, args, opts, cb) => { order.push('taskkill'); cb(null); });
    await expect(killProcessTree(1234, 'SIGTERM', { kill, exec, platform: 'win32' })).resolves.toBe('taskkill');
    expect(exec).toHaveBeenCalledWith('taskkill', ['/PID', '1234', '/T', '/F'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
    expect(order).toEqual(['taskkill', 'kill']);
  });

  it('win32: falls back to the direct kill when taskkill fails', async () => {
    const kill = vi.fn();
    const log = vi.fn();
    const exec = vi.fn((file, args, opts, cb) => cb(new Error('not found')));
    await expect(killProcessTree(1234, 'SIGKILL', { kill, exec, platform: 'win32', log })).resolves.toBe('kill');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('taskkill /T failed for pid 1234'));
  });

  it('win32: a throwing exec (no taskkill binary) still ends the child', async () => {
    const kill = vi.fn();
    const exec = vi.fn(() => { throw new Error('ENOENT'); });
    await expect(killProcessTree(1234, 'SIGTERM', { kill, exec, platform: 'win32' })).resolves.toBe('kill');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('win32: no usable pid → direct kill only', async () => {
    const kill = vi.fn();
    const exec = vi.fn();
    await expect(killProcessTree(undefined, 'SIGTERM', { kill, exec, platform: 'win32' })).resolves.toBe('kill');
    expect(exec).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('taskkillArgs', () => {
    expect(taskkillArgs(7)).toEqual(['/PID', '7', '/T', '/F']);
  });
});
