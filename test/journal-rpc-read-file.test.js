import { describe, it, expect } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { ReadFileError } from '../lib/read-file.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

// Minimal harness: the read_file handler only needs the roots thunk + an
// (injectable) readFileGuarded. The other deps are stubbed to no-ops.
function harness(overrides = {}) {
  const responses = [];
  const calls = [];
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession: () => ({ claudeSessionId: 's1' }),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: '/home/dan',
    expandHome: (p) => p,
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    getEditAllowedRoots: () => ({ roots: [{ realPath: '/w', dev: 1, ino: 2 }] }),
    readFileGuarded: async (input, opts) => {
      calls.push({ input, opts });
      return { path: '/w/config.txt', content: 'PORT=3000\n', sha256: 'a'.repeat(64), bytes: 10, mode: 0o644 };
    },
    ...overrides,
  });
  return { handler, responses, calls };
}

describe('read_file RPC handler', () => {
  it('happy path: forwards to readFileGuarded and responds ok with {path,content,sha256,bytes,mode}', async () => {
    const { handler, responses, calls } = harness();
    await handler(REQ('read_file', { path: '/w/config.txt' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ path: '/w/config.txt' });
    expect(responses[0]).toEqual({
      requestId: 'r1', toDeviceId: 7, ok: true,
      result: { path: '/w/config.txt', content: 'PORT=3000\n', sha256: 'a'.repeat(64), bytes: 10, mode: 0o644 },
    });
  });

  it('passes the pinned allowed roots (never client strings) to readFileGuarded', async () => {
    const pinned = { roots: [{ realPath: '/scoped', dev: 9, ino: 9 }] };
    const { handler, calls } = harness({ getEditAllowedRoots: () => pinned });
    await handler(REQ('read_file', { path: '/scoped/f' }));
    expect(calls[0].opts.allowedRoots).toBe(pinned);
  });

  it('maps a ReadFileError to the wire error body {code, detail}', async () => {
    const { handler, responses } = harness({
      readFileGuarded: async () => { throw new ReadFileError('outside-scope', 'path rejected: outside-scope'); },
    });
    await handler(REQ('read_file', { path: '/etc/passwd' }));
    expect(responses[0]).toEqual({
      requestId: 'r1', toDeviceId: 7, ok: false,
      error: { code: 'outside-scope', detail: 'path rejected: outside-scope' },
    });
  });

  it('surfaces the too_large size-guard code', async () => {
    const { handler, responses } = harness({
      readFileGuarded: async () => { throw new ReadFileError('too_large', 'path rejected: too-large'); },
    });
    await handler(REQ('read_file', { path: '/w/big' }));
    expect(responses[0].error.code).toBe('too_large');
  });

  it('a non-ReadFileError throw is converted to {code:internal} by the dispatch guard', async () => {
    const { handler, responses } = harness({
      readFileGuarded: async () => { throw new Error('unexpected'); },
    });
    await handler(REQ('read_file', { path: '/w/f' }));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'unexpected' });
  });

  it('non-object params are treated as {} (path becomes undefined)', async () => {
    const { handler, calls } = harness();
    await handler(REQ('read_file', undefined));
    expect(calls[0].input).toEqual({ path: undefined });
  });
});
