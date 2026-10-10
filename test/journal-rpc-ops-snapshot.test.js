import { describe, it, expect, vi } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

function harness(overrides = {}) {
  const responses = [];
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession: () => ({ claudeSessionId: 's1' }),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: '/home/dan',
    expandHome: (p) => p,
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    ...overrides,
  });
  return { handler, responses };
}

describe('ops_snapshot RPC handler', () => {
  it('forwards params.section and answers the snapshot result', async () => {
    const result = { section: 'host', generated_at_ms: 1, truncated: false, data: {} };
    const opsSnapshot = vi.fn(async () => ({ ok: true, result }));
    const { handler, responses } = harness({ opsSnapshot });
    await handler(REQ('ops_snapshot', { section: 'host', extra: 'ignored' }));
    expect(opsSnapshot).toHaveBeenCalledWith('host');
    expect(responses).toEqual([{ requestId: 'r1', toDeviceId: 7, ok: true, result }]);
  });

  it('maps an error outcome onto the wire error body', async () => {
    const opsSnapshot = async () => ({ ok: false, error: { code: 'not_configured', detail: 'MATRON_OPS_SNAPSHOT_CMD is not set' } });
    const { handler, responses } = harness({ opsSnapshot });
    await handler(REQ('ops_snapshot', { section: 'timers' }));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'not_configured', detail: 'MATRON_OPS_SNAPSHOT_CMD is not set' } });
  });

  it('missing params -> the snapshot sees undefined (bad_request comes from the module)', async () => {
    const opsSnapshot = vi.fn(async () => ({ ok: false, error: { code: 'bad_request', detail: 'unknown section' } }));
    const { handler, responses } = harness({ opsSnapshot });
    await handler(REQ('ops_snapshot', undefined));
    expect(opsSnapshot).toHaveBeenCalledWith(undefined);
    expect(responses[0].error.code).toBe('bad_request');
  });

  it('unwired build answers unknown_method (same as an old bridge)', async () => {
    const { handler, responses } = harness();
    await handler(REQ('ops_snapshot', { section: 'host' }));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'unknown_method' } });
  });

  it('a throwing snapshot still gets exactly one answer (internal)', async () => {
    const { handler, responses } = harness({ opsSnapshot: async () => { throw new Error('boom'); } });
    await handler(REQ('ops_snapshot', { section: 'host' }));
    expect(responses).toHaveLength(1);
    expect(responses[0].error.code).toBe('internal');
  });
});
