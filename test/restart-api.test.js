import { describe, expect, it, vi } from 'vitest';
import { decideRestartRequest, installRestartToken, removeRestartToken, restartTokenFile, RESTART_TOKEN_HEADER } from '../lib/restart-api.js';

const token = 'a'.repeat(64);
const headers = { [RESTART_TOKEN_HEADER]: token };

describe('restart token file', () => {
  it('writes the token and the API port, and closes the route when it cannot', () => {
    const write = vi.fn();
    const installed = installRestartToken({ file: '/h/.t', port: 9802, random: () => token, write });
    expect(installed).toEqual({ token, file: '/h/.t', port: 9802 });
    expect(write).toHaveBeenCalledWith('/h/.t', `MATRON_RESTART_TOKEN=${token}\nMATRON_BRIDGE_API_PORT=9802\n`);
    expect(installRestartToken({ file: '/h/.t', port: 1, write: () => { throw new Error('EACCES'); } })).toBeNull();
  });

  it('lives in the home directory', () => {
    expect(restartTokenFile({ homedir: () => '/home/x' })).toBe('/home/x/.matron-bridge-restart.env');
  });

  it('removes the file only while it is still this bridge\'s', () => {
    const installed = { token, file: '/h/.t', port: 9802 };
    const unlink = vi.fn();
    removeRestartToken(installed, { readFile: () => `MATRON_RESTART_TOKEN=${token}\nMATRON_BRIDGE_API_PORT=9802\n`, unlink });
    expect(unlink).toHaveBeenCalledWith('/h/.t');
    unlink.mockClear();
    removeRestartToken(installed, { readFile: () => `MATRON_RESTART_TOKEN=${'b'.repeat(64)}\nMATRON_BRIDGE_API_PORT=9802\n`, unlink });
    expect(unlink).not.toHaveBeenCalled();
    expect(() => removeRestartToken(installed, { readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, unlink })).not.toThrow();
    expect(() => removeRestartToken(installed, { readFile: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); }, unlink })).toThrow();
  });
});

describe('decideRestartRequest', () => {
  const store = (impl = request => ({ id: 'r1', state: 'pending', request })) => ({ addRequest: vi.fn(impl) });

  it.each([
    ['no header', {}],
    ['a short token', { [RESTART_TOKEN_HEADER]: 'abc' }],
    ['a wrong token', { [RESTART_TOKEN_HEADER]: 'b'.repeat(64) }],
    ['a non-string token', { [RESTART_TOKEN_HEADER]: ['a'.repeat(64)] }],
  ])('refuses %s without touching state', (_name, bad) => {
    const stateStore = store();
    expect(decideRestartRequest({ headers: bad, token, body: { reason: 'x' }, stateStore })).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(stateStore.addRequest).not.toHaveBeenCalled();
  });

  it('refuses everything when no token was installed', () => {
    expect(decideRestartRequest({ headers, token: null, body: { reason: 'x' }, stateStore: store() }).status).toBe(401);
  });

  it.each([
    [{}], [{ reason: '  ' }], [{ reason: 5 }], [{ reason: 'x', sha: '' }], [{ reason: 'x', sha: '--upload-pack=y' }],
    [{ reason: 'x', request_key: '' }], [{ reason: 'x', request_key: 7 }], [[]],
  ])('rejects the invalid request %j', body => {
    const stateStore = store();
    expect(decideRestartRequest({ headers, token, body, stateStore }).status).toBe(400);
    expect(stateStore.addRequest).not.toHaveBeenCalled();
  });

  it('records a request and returns the restart id', () => {
    const stateStore = store();
    const result = decideRestartRequest({ headers, token, body: { reason: ' ship it ', sha: 'abc123', request_key: 'k1' }, stateStore });
    expect(result).toEqual({ status: 200, body: { id: 'r1', state: 'pending', request: { reason: 'ship it', sha: 'abc123', request_key: 'k1' } } });
  });

  it('mints a request key when none is given and ignores a force field', () => {
    const stateStore = store();
    decideRestartRequest({ headers, token, body: { reason: 'x', force: true }, stateStore, makeKey: () => 'minted' });
    expect(stateStore.addRequest).toHaveBeenCalledWith({ reason: 'x', request_key: 'minted' });
  });

  it('answers 503 with the restart id while the restart is latched', () => {
    const stateStore = store(() => ({ busy: 'restarting', id: 'r9' }));
    expect(decideRestartRequest({ headers, token, body: { reason: 'x' }, stateStore })).toEqual({ status: 503, body: { error: 'restarting', id: 'r9' } });
  });

  it('answers 503 without details when the state cannot be written', () => {
    const stateStore = store(() => { throw new Error('ENOSPC: /home/x/state'); });
    const result = decideRestartRequest({ headers, token, body: { reason: 'x' }, stateStore });
    expect(result).toEqual({ status: 500, body: { error: 'restart state unavailable' } });
  });
});
