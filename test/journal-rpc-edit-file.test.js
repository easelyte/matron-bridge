import { describe, it, expect } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { EditFileError } from '../lib/edit-file.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

// Minimal harness: the edit_file handler only needs the roots thunk + an
// (injectable) applyFileEdit. The other deps are stubbed to no-ops.
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
    applyFileEdit: async (input, opts) => {
      calls.push({ input, opts });
      return { path: '/w/config.txt', bytes: 5, mode: 'content' };
    },
    ...overrides,
  });
  return { handler, responses, calls };
}

describe('edit_file RPC handler', () => {
  it('happy path: forwards to applyFileEdit and responds ok with {path,bytes,mode}', async () => {
    const { handler, responses, calls } = harness();
    await handler(REQ('edit_file', { path: '/w/config.txt', content: 'NEW=1' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ path: '/w/config.txt', content: 'NEW=1' });
    expect(responses[0]).toEqual({
      requestId: 'r1', toDeviceId: 7, ok: true,
      result: { path: '/w/config.txt', bytes: 5, mode: 'content' },
    });
  });

  it('passes the pinned allowed roots (never client strings) to applyFileEdit', async () => {
    const pinned = { roots: [{ realPath: '/scoped', dev: 9, ino: 9 }] };
    const { handler, calls } = harness({ getEditAllowedRoots: () => pinned });
    await handler(REQ('edit_file', { path: '/scoped/f', content: 'x' }));
    expect(calls[0].opts.allowedRoots).toBe(pinned);
  });

  it('forwards ONLY the params actually present (targeted-edit keys, not undefined content)', async () => {
    const { handler, calls } = harness();
    await handler(REQ('edit_file', { path: '/w/f', old_string: 'a', new_string: 'b' }));
    expect(calls[0].input).toEqual({ path: '/w/f', old_string: 'a', new_string: 'b' });
    expect('content' in calls[0].input).toBe(false);
  });

  it('forwards the optional expected_sha256 compare-and-swap precondition when present', async () => {
    const { handler, calls } = harness();
    const digest = 'a'.repeat(64);
    await handler(REQ('edit_file', { path: '/w/f', content: 'x', expected_sha256: digest }));
    expect(calls[0].input).toEqual({ path: '/w/f', content: 'x', expected_sha256: digest });
  });

  it('maps an EditFileError to the wire error body {code, detail}', async () => {
    const { handler, responses } = harness({
      applyFileEdit: async () => { throw new EditFileError('outside-scope', 'path rejected: outside-scope'); },
    });
    await handler(REQ('edit_file', { path: '/etc/passwd', content: 'x' }));
    expect(responses[0]).toEqual({
      requestId: 'r1', toDeviceId: 7, ok: false,
      error: { code: 'outside-scope', detail: 'path rejected: outside-scope' },
    });
  });

  it('a non-EditFileError throw is converted to {code:internal} by the dispatch guard', async () => {
    const { handler, responses } = harness({
      applyFileEdit: async () => { throw new Error('unexpected'); },
    });
    await handler(REQ('edit_file', { path: '/w/f', content: 'x' }));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'unexpected' });
  });

  it('non-object params are treated as {} (path becomes undefined -> EditFileError bad_request)', async () => {
    // Here applyFileEdit is the REAL one indirectly via bad_request; use a stub
    // that asserts it received an object input with undefined path.
    const { handler, calls } = harness();
    await handler(REQ('edit_file', undefined));
    expect(calls[0].input).toEqual({ path: undefined });
  });
});

describe('dispatch one-response guarantee extends to async handlers', () => {
  it('an async handler rejection still answers exactly one internal response', async () => {
    const { handler, responses } = harness({
      applyFileEdit: async () => { throw new Error('async boom'); },
    });
    await handler(REQ('edit_file', { path: '/w/f', content: 'x' }));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'async boom' });
  });
});
