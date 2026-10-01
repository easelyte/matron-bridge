import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { hookEntry, nodeHookEntry, shellQuote } from '../lib/hook-command.js';

const HOOKS = '/opt/bridge/hooks';
const WIN_HOOKS = 'C:\\bridge\\hooks';

describe('hookEntry', () => {
  it('POSIX: the .sh script path as a shell-form command', () => {
    expect(hookEntry({ hooksDir: HOOKS, name: 'stop-notify', timeout: 10, platform: 'linux' }))
      .toEqual({ type: 'command', command: path.posix.join(HOOKS, 'stop-notify.sh'), timeout: 10 });
    expect(hookEntry({ hooksDir: HOOKS, name: 'matron-bash-tee', platform: 'darwin' }))
      .toEqual({ type: 'command', command: path.posix.join(HOOKS, 'matron-bash-tee.sh') });
  });

  it('win32: exec form — node.exe plus the .mjs port and literal args, no shell', () => {
    const entry = hookEntry({ hooksDir: WIN_HOOKS, name: 'stop-notify', timeout: 10, platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
    expect(entry).toEqual({
      type: 'command',
      command: 'C:\\nodejs\\node.exe',
      args: [path.win32.join(WIN_HOOKS, 'stop-notify.mjs')],
      timeout: 10,
    });
  });

  it('omits timeout when not given', () => {
    expect(hookEntry({ hooksDir: HOOKS, name: 'x', platform: 'linux' })).not.toHaveProperty('timeout');
    expect(hookEntry({ hooksDir: HOOKS, name: 'x', platform: 'win32', execPath: 'node' })).not.toHaveProperty('timeout');
  });

  it('refuses a missing hooksDir or name', () => {
    expect(() => hookEntry({ name: 'x' })).toThrow(TypeError);
    expect(() => hookEntry({ hooksDir: HOOKS })).toThrow(TypeError);
  });
});

describe('nodeHookEntry', () => {
  it('POSIX: node + single-quoted script and args as one shell string', () => {
    const entry = nodeHookEntry({ hooksDir: HOOKS, name: 'permission-gate', args: ['--port', '9802', '--room', "r'1"], timeout: 30, platform: 'linux' });
    expect(entry.command).toBe(`node '${path.posix.join(HOOKS, 'permission-gate.mjs')}' --port '9802' --room 'r'\\''1'`);
    expect(entry.args).toBeUndefined();
    expect(entry.timeout).toBe(30);
  });

  it('win32: exec form with the args verbatim', () => {
    const entry = nodeHookEntry({ hooksDir: WIN_HOOKS, name: 'permission-gate', args: ['--port', 9802, '--room', 'r 1'], platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
    expect(entry).toEqual({
      type: 'command',
      command: 'C:\\nodejs\\node.exe',
      args: [path.win32.join(WIN_HOOKS, 'permission-gate.mjs'), '--port', '9802', '--room', 'r 1'],
    });
  });
});

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});
