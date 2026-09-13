import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { CodexRpcClient } from '../lib/codex-rpc.js';

afterEach(() => vi.useRealTimers());
function setup() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const sent = [];
  child.stdin.on('data', chunk => sent.push(JSON.parse(String(chunk))));
  const spawn = vi.fn(() => child);
  const rpc = new CodexRpcClient({ spawnImpl: spawn, timeoutMs: 1000 });
  const receive = message => child.stdout.write(JSON.stringify(message) + '\n');
  const initialize = async () => { const pending = rpc.connect(); receive({ id: 1, result: { userAgent: 'Codex' } }); await pending; };
  return { rpc, child, sent, spawn, receive, initialize };
}

describe('Codex stdio RPC', () => {
  it('initializes once and correlates concurrent replies out of order', async () => {
    const h = setup(); await h.initialize(); await h.rpc.connect();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.sent[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } });
    expect(h.sent[1].method).toBe('initialized');
    const first = h.rpc.request('first'), second = h.rpc.request('second');
    h.receive({ id: 3, result: 'two' }); h.receive({ id: 2, result: 'one' });
    expect(await first).toBe('one'); expect(await second).toBe('two'); h.rpc.close();
  });

  it('decodes split multibyte UTF-8 and routes server requests independently of client ids', async () => {
    const h = setup(); await h.initialize();
    const notice = vi.fn(), request = vi.fn(); h.rpc.on('notification', notice); h.rpc.on('request', request);
    const bytes = Buffer.from(JSON.stringify({ method: 'delta', params: { text: '🎉' } }) + '\n');
    for (const b of bytes) h.child.stdout.write(Buffer.from([b]));
    expect(notice).toHaveBeenCalledWith({ method: 'delta', params: { text: '🎉' } });
    h.receive({ id: 2, method: 'approval', params: {} });
    const pending = h.rpc.request('read');
    expect(h.rpc.respond(2, { decision: 'decline' })).toBe(true);
    expect(h.rpc.respond(2, { decision: 'accept' })).toBe(false);
    h.receive({ id: 2, result: 'read result' });
    expect(await pending).toBe('read result'); expect(request).toHaveBeenCalledTimes(1); h.rpc.close();
  });

  it('times out, ignores late acknowledgements, and does not replay', async () => {
    vi.useFakeTimers(); const h = setup(); await h.initialize();
    const p = expect(h.rpc.request('turn/start')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000); await p;
    h.receive({ id: 2, result: {} });
    expect(h.rpc.pending.size).toBe(0); expect(h.sent.filter(m => m.method === 'turn/start')).toHaveLength(1); h.rpc.close();
  });

  it('fails pending work on broken input, refuses stale approvals, and shuts down safely', async () => {
    const h = setup(); await h.initialize(); h.receive({ id: 'ask', method: 'approval' });
    const p = expect(h.rpc.request('read')).rejects.toThrow('closed');
    const disconnect = vi.fn(); h.rpc.on('disconnect', disconnect);
    h.child.stdin.emit('error', new Error('EPIPE')); await p;
    expect(h.rpc.respond('ask', { decision: 'accept' })).toBe(false);
    h.child.emit('close', 1); expect(disconnect).toHaveBeenCalledTimes(1);
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects malformed protocol without forwarding raw diagnostics', async () => {
    const h = setup(); await h.initialize(); const disconnect = vi.fn(); h.rpc.on('disconnect', disconnect);
    h.child.stderr.write('API_TOKEN=private'); h.child.stdout.write('not-json\n');
    expect(disconnect.mock.calls[0][0].message).toBe('Invalid JSON from Codex app server.');
    expect(h.rpc.closed).toBe(true);
  });
});
