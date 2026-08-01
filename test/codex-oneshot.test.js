import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexOneShot, parseTimeout } from '../lib/codex-oneshot.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 3_000;

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = vi.fn();
  child.kill = vi.fn();
  return child;
}

function agentMessage(text) {
  return `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  })}\n`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('codexOneShot', () => {
  it('returns the completed agent message on a clean exit', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    const resultPromise = codexOneShot('summarize this', { spawnImpl });

    child.stdout.emit('data', agentMessage('TITLE: A useful title'));
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      text: 'TITLE: A useful title',
      reason: null,
      exitCode: 0,
      signal: null,
    });
    expect(child.stdin.end).toHaveBeenCalledWith('summarize this');
  });

  it('uses the last completed agent message', async () => {
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });

    child.stdout.emit('data', agentMessage('first'));
    child.stdout.emit('data', agentMessage('last'));
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({ text: 'last', reason: null });
  });

  it('reports a nonzero exit', async () => {
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });

    child.emit('close', 1, null);

    await expect(resultPromise).resolves.toMatchObject({
      text: null,
      reason: 'nonzero-exit',
      exitCode: 1,
    });
  });

  it('reports no output when no agent message completed', async () => {
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });

    child.stdout.emit('data', '{"type":"thread.started"}\nnot-json\n');
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      text: null,
      reason: 'no-output',
      exitCode: 0,
    });
  });

  it('escalates a timeout from SIGTERM to SIGKILL and resolves once', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', {
      spawnImpl: () => child,
      timeoutMs: 1_000,
    });
    const resolved = vi.fn();
    void resultPromise.then(resolved);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(resolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(resultPromise).resolves.toMatchObject({ text: null, reason: 'timeout' });
    expect(resolved).toHaveBeenCalledTimes(1);

    child.emit('close', null, 'SIGKILL');
    await Promise.resolve();
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('reports an stdin error', async () => {
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });

    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));

    await expect(resultPromise).resolves.toMatchObject({ text: null, reason: 'stdin-error' });
  });

  it('handles an asynchronous child ENOENT error without throwing', async () => {
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });

    expect(() => child.emit(
      'error',
      Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    )).not.toThrow();
    await expect(resultPromise).resolves.toMatchObject({ text: null, reason: 'spawn-error' });
  });

  it('handles a synchronous spawn failure', async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('spawn failed synchronously');
    });

    await expect(codexOneShot('prompt', { spawnImpl })).resolves.toMatchObject({
      text: null,
      reason: 'spawn-error',
    });
  });

  it('kills the child and rejects an oversized stdout chunk without accumulating it', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const resultPromise = codexOneShot('prompt', { spawnImpl: () => child });
    const oversizedChunk = Buffer.alloc(MAX_OUTPUT_BYTES + 1, 'x');

    child.stdout.emit('data', oversizedChunk);
    child.stdout.emit('data', agentMessage('must not replace the overflow result'));

    await expect(resultPromise).resolves.toMatchObject({
      text: null,
      reason: 'output-overflow',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('passes the security argv and includes a model only when configured', async () => {
    vi.stubEnv('SUMMARY_CODEX_MODEL', 'gpt-summary');
    const modeledChild = fakeChild();
    const modeledSpawn = vi.fn(() => modeledChild);
    const modeledResult = codexOneShot('prompt', { spawnImpl: modeledSpawn });
    modeledChild.emit('close', 0, null);
    await modeledResult;

    const modeledArgs = modeledSpawn.mock.calls[0][1];
    expect(modeledArgs).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--ignore-user-config',
      '--ephemeral',
      '-m',
      'gpt-summary',
      '-',
    ]);

    vi.stubEnv('SUMMARY_CODEX_MODEL', '');
    const defaultChild = fakeChild();
    const defaultSpawn = vi.fn(() => defaultChild);
    const defaultResult = codexOneShot('prompt', { spawnImpl: defaultSpawn });
    defaultChild.emit('close', 0, null);
    await defaultResult;

    expect(defaultSpawn.mock.calls[0][1]).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--ignore-user-config',
      '--ephemeral',
      '-',
    ]);
  });

  it('passes only the auth-related environment and excludes bridge secrets', async () => {
    vi.stubEnv('PATH', '/test/bin');
    vi.stubEnv('HOME', '/test/home');
    vi.stubEnv('CODEX_HOME', '/test/codex-home');
    vi.stubEnv('HMAC_SECRET', 'SENTINEL');
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    const resultPromise = codexOneShot('prompt', { spawnImpl });

    child.emit('close', 0, null);
    await resultPromise;

    const options = spawnImpl.mock.calls[0][2];
    expect(options.env).toEqual({
      PATH: '/test/bin',
      HOME: '/test/home',
      CODEX_HOME: '/test/codex-home',
    });
    expect(options.env).not.toHaveProperty('HMAC_SECRET');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
});

describe('parseTimeout', () => {
  it.each([
    ['negative', '-1'],
    ['infinite', 'Infinity'],
    ['zero', '0'],
    ['non-numeric', 'abc'],
    ['above maximum', '999999999'],
    ['empty', ''],
    ['unset', undefined],
  ])('uses the default for %s input', (_label, value) => {
    expect(parseTimeout(value)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('accepts an in-range integer string', () => {
    expect(parseTimeout('1500')).toBe(1_500);
  });
});
