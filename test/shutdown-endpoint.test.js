import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import {
  SHUTDOWN_TOKEN_HEADER, bridgeStateDir, shutdownTokenPath, installShutdownToken, decideShutdown,
} from '../lib/shutdown-endpoint.js';

describe('bridgeStateDir', () => {
  it('is %LOCALAPPDATA%\\matron-bridge', () => {
    expect(bridgeStateDir({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }))
      .toBe(path.join('C:\\Users\\u\\AppData\\Local', 'matron-bridge'));
  });
  it('falls back to the profile dir when LOCALAPPDATA is unset', () => {
    expect(bridgeStateDir({ env: {}, homedir: () => 'C:\\Users\\u' }))
      .toBe(path.join('C:\\Users\\u', 'AppData', 'Local', 'matron-bridge'));
    expect(shutdownTokenPath({ env: {}, homedir: () => 'H' })).toBe(path.join('H', 'AppData', 'Local', 'matron-bridge', 'shutdown.token'));
  });
});

describe('installShutdownToken', () => {
  it('writes the token to the file and returns it', () => {
    const writes = [];
    const dirs = [];
    const out = installShutdownToken({
      file: path.join('S', 'shutdown.token'),
      mkdir: (d) => dirs.push(d),
      writeFile: (f, data) => writes.push([f, data]),
      random: () => 'tok',
    });
    expect(out).toEqual({ token: 'tok', file: path.join('S', 'shutdown.token') });
    expect(dirs).toEqual(['S']);
    expect(writes).toEqual([[path.join('S', 'shutdown.token'), 'tok\n']]);
  });

  it('returns null (route disabled) and warns when the file cannot be written', () => {
    const warn = vi.fn();
    const out = installShutdownToken({ file: 'x', mkdir: () => {}, writeFile: () => { throw new Error('EACCES'); }, warn });
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});

describe('decideShutdown', () => {
  const token = 'a'.repeat(64);
  it('503 when no token is installed', () => {
    expect(decideShutdown({ headers: { [SHUTDOWN_TOKEN_HEADER]: token }, token: null })).toMatchObject({ status: 503, shutdown: false });
  });
  it('403 on a missing, short or wrong token', () => {
    expect(decideShutdown({ headers: {}, token })).toMatchObject({ status: 403, shutdown: false });
    expect(decideShutdown({ headers: { [SHUTDOWN_TOKEN_HEADER]: 'a' }, token })).toMatchObject({ status: 403, shutdown: false });
    expect(decideShutdown({ headers: { [SHUTDOWN_TOKEN_HEADER]: 'b'.repeat(64) }, token })).toMatchObject({ status: 403, shutdown: false });
  });
  it('202 and shutdown on the right token (whitespace tolerated)', () => {
    expect(decideShutdown({ headers: { [SHUTDOWN_TOKEN_HEADER]: ` ${token}\n` }, token })).toEqual({
      status: 202, body: { ok: true, shutting_down: true }, shutdown: true,
    });
  });
});
