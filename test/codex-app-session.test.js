import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerSession, codexInput, codexPlanConfig } from '../lib/codex-app-session.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.child = { pid: 42 };
    this.serverRequests = new Set();
    this.turnCounter = 0;
    this.connect = vi.fn(async () => ({}));
    this.request = vi.fn(async (method, params) => {
      if (method === 'config/read') return { config: { model: 'model-default', model_reasoning_effort: 'medium', mcp_servers: { local: {} } } };
      if (method === 'model/list') return { data: [] };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'thread-1', turns: [], status: { type: 'idle' } }, model: params.model };
      if (method === 'turn/start') return { turn: { id: `turn-${++this.turnCounter}` } };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      return {};
    });
    this.close = vi.fn(() => { this.closed = true; });
  }
  notify(method, params) { this.emit('notification', { method, params }); }
}
function setup(options = {}) {
  const clients = [];
  const session = new CodexAppServerSession({ cwd: '/workspace', ...options, clientFactory: () => {
    const client = new FakeClient(); clients.push(client); return client;
  } });
  const events = [], exits = [];
  session.on('event', e => events.push(e));
  session.on('turn-exit', e => exits.push(e));
  const send = () => session.send([{ type: 'text', text: 'hello' }]);
  const complete = (status = 'completed') => clients.at(-1).notify('turn/completed', { threadId: session.threadId, turn: { id: session.turnId, status } });
  return { session, clients, events, exits, send, complete };
}

describe('native Codex session lifecycle', () => {
  it('keeps one connection across turns; messages do not finish the turn', async () => {
    const h = setup();
    expect(h.send()).toBe(true);
    expect(h.send()).toBe(false);
    await settle();
    h.clients[0].notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg', type: 'agentMessage', text: 'Working' } });
    expect(h.events.at(-1).item).toMatchObject({ type: 'agent_message', text: 'Working' });
    expect(h.session.busy).toBe(true);
    expect(h.exits).toHaveLength(0);
    h.complete();
    expect(h.session.busy).toBe(false);
    h.send(); await settle();
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].request.mock.calls.filter(([m]) => m === 'thread/start')).toHaveLength(1);
    h.complete(); h.session.kill();
  });

  it('supports native images without silently accepting unsupported inputs', async () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcd' } };
    expect(codexInput([image])).toEqual([{ type: 'image', url: 'data:image/png;base64,abcd' }]);
    const h = setup();
    expect(h.session.send([{ type: 'audio', data: 'x' }])).toBe(false);
    expect(h.session.send([image])).toBe(true); await settle();
    expect(h.clients[0].request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ input: codexInput([image]) }), expect.anything());
    h.session.kill();
  });

  it('uses YOLO permissions on start/resume and restores them after read-only Plan mode', async () => {
    for (const threadId of [null, 'saved']) {
      const h = setup({ threadId, sandbox: 'danger-full-access' }); h.send(); await settle();
      expect(h.clients[0].request).toHaveBeenCalledWith(threadId ? 'thread/resume' : 'thread/start',
        expect.objectContaining({ sandbox: 'danger-full-access', approvalPolicy: 'never' }), expect.anything());
      h.complete(); h.session.planMode = true; h.send(); await settle();
      expect(h.clients[1].request).toHaveBeenCalledWith('thread/resume',
        expect.objectContaining({ sandbox: 'read-only', approvalPolicy: 'never' }), expect.anything());
      h.complete(); h.session.planMode = false; h.send(); await settle();
      expect(h.clients[2].request).toHaveBeenCalledWith('thread/resume',
        expect.objectContaining({ sandbox: 'danger-full-access', approvalPolicy: 'never' }), expect.anything());
      h.session.kill();
    }
  });

  it('resumes IDs, resets model/effort defaults, and rebuilds MCP for Plan/Build', async () => {
    const h = setup({ threadId: 'saved', model: 'special', effort: 'high', config: { mcp_servers: { bridge: { enabled: true } } } });
    h.send(); await settle(); h.complete();
    h.session.model = null; h.session.effort = null; h.session.planMode = true;
    h.send(); await settle();
    expect(h.clients[0].close).toHaveBeenCalled();
    expect(h.clients[1].request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'saved', model: 'model-default', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
      config: expect.objectContaining({ model_reasoning_effort: 'medium', 'features.apps': false,
        mcp_servers: { local: { enabled: false }, bridge: { enabled: false } } }),
    }), expect.anything());
    h.complete(); h.session.planMode = false; h.send(); await settle();
    expect(h.clients[2].request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ sandbox: 'workspace-write', approvalPolicy: 'on-request' }), expect.anything());
    h.session.kill();
  });

  it('supports steering with expected turn identity and detects uncertain delivery', async () => {
    const h = setup(); h.send(); await settle();
    expect(await h.session.steer([{ type: 'text', text: 'Use the other file' }])).toBe(true);
    expect(h.clients[0].request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({ expectedTurnId: 'turn-1', threadId: 'thread-1' }), undefined);
    h.clients[0].request.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    expect(await h.session.steer([{ type: 'text', text: 'more' }])).toBe(false);
    expect(h.session.steerUncertain).toBe(true);
    h.session.kill();
  });

  it.each([true, false, 'true', 'false'])('applies explicit workspace networking (%s) on start and resume', async networkAccess => {
    for (const threadId of [null, 'saved']) {
      const h = setup({ threadId, networkAccess });
      h.send(); await settle();
      expect(h.clients[0].request).toHaveBeenCalledWith(threadId ? 'thread/resume' : 'thread/start',
        expect.objectContaining({ sandbox: 'workspace-write', approvalPolicy: 'on-request',
          config: expect.objectContaining({ 'sandbox_workspace_write.network_access': String(networkAccess) === 'true' }) }),
        expect.anything());
      h.session.kill();
    }
  });

  it.each([null, undefined, '', 'invalid'])('inherits workspace networking when not explicitly configured (%s)', async networkAccess => {
    const h = setup({ networkAccess });
    h.send(); await settle();
    const params = h.clients[0].request.mock.calls.find(([method]) => method === 'thread/start')[1];
    expect(params.config).not.toHaveProperty('sandbox_workspace_write.network_access');
    h.session.kill();
  });

  it.each(['read-only', 'danger-full-access'])('does not apply workspace network settings to %s', async sandbox => {
    const h = setup({ sandbox, networkAccess: true });
    h.send(); await settle();
    const params = h.clients[0].request.mock.calls.find(([method]) => method === 'thread/start')[1];
    expect(params.sandbox).toBe(sandbox);
    expect(params.config).not.toHaveProperty('sandbox_workspace_write.network_access');
    h.session.kill();
  });

  it('does not enable workspace networking in Plan and restores it on Build', async () => {
    const h = setup({ networkAccess: true });
    h.session.planMode = true;
    h.send(); await settle();
    const params = h.clients[0].request.mock.calls.find(([method]) => method === 'thread/start')[1];
    expect(params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(params.config).not.toHaveProperty('sandbox_workspace_write.network_access');
    h.complete(); h.session.planMode = false;
    h.send(); await settle();
    expect(h.clients[1].request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      sandbox: 'workspace-write', approvalPolicy: 'on-request',
      config: expect.objectContaining({ 'sandbox_workspace_write.network_access': true }),
    }), expect.anything());
    h.session.kill();
  });

  it('interrupts startup without sending a model turn', async () => {
    const h = setup(); h.send(); h.session.interrupt(); await settle();
    expect(h.clients[0].request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0].signal).toBe('SIGINT');
    h.session.kill();
  });

  it('ignores old threads/turns and closes exactly once on disconnect', async () => {
    const h = setup(); h.send(); await settle();
    h.clients[0].notify('turn/completed', { threadId: 'other', turn: { id: 'turn-1', status: 'completed' } });
    h.clients[0].notify('turn/completed', { threadId: 'thread-1', turn: { id: 'old', status: 'completed' } });
    expect(h.exits).toHaveLength(0);
    h.clients[0].closed = true;
    h.clients[0].emit('disconnect', new Error('connection lost'));
    expect(h.exits).toHaveLength(1);
    h.send(); await settle();
    h.clients[0].notify('item/completed', { item: { type: 'agentMessage', text: 'old process' } });
    expect(h.events.some(e => e.item?.text === 'old process')).toBe(false);
    expect(h.clients).toHaveLength(2);
    h.session.kill();
  });

  it('does not replay a turn after its start acknowledgement times out', async () => {
    const h = setup();
    const client = h.session.connection();
    const original = client.request.getMockImplementation();
    client.request.mockImplementation((method, ...args) => method === 'turn/start'
      ? Promise.reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })) : original(method, ...args));
    h.send(); await settle();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(h.session.busy).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.clients).toHaveLength(1);
  });

  it('ignores stale nested turn IDs both during startup and during an active turn', async () => {
    const h = setup(); h.send(); await settle(); h.complete();
    h.send();
    h.clients[0].notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    h.clients[0].notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    expect(h.session.busy).toBe(true);
    await settle(); expect(h.session.turnId).toBe('turn-2');
    h.clients[0].notify('turn/started', { threadId: 'thread-1', turn: { id: 'unknown-stale-turn' } });
    expect(h.session.turnId).toBe('turn-2');
    h.complete(); expect(h.exits).toHaveLength(2); expect(h.session.busy).toBe(false);
    h.session.kill();
  });

  it('announces connection replacement and disconnect so child views can terminate', async () => {
    const h = setup(); const reset = vi.fn(); h.session.on('connection-reset', reset);
    h.send(); await settle(); h.complete();
    h.session.effort = 'high'; h.send(); await settle();
    expect(reset).toHaveBeenCalledTimes(1);
    h.clients[1].closed = true; h.clients[1].emit('disconnect', new Error('lost'));
    expect(reset).toHaveBeenCalledTimes(2); h.session.kill();
  });

  it('denies every per-origin browser capability in Plan mode', () => {
    const result = codexPlanConfig({}, { browser_use: { origins: { 'https://example.test': {
      access: 'allow', uploads: 'allow', downloads: 'allow', full_cdp_access: 'allow',
    } } } });
    expect(result.browser_use.origins['https://example.test']).toEqual({
      access: 'deny', uploads: 'deny', downloads: 'deny', full_cdp_access: 'deny',
    });
  });

  it('compacts natively without starting an ordinary prompt', async () => {
    const h = setup({ threadId: 'saved' });
    expect(h.session.compact()).toBe(true); await settle();
    expect(h.clients[0].request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'saved' }, expect.anything());
    expect(h.clients[0].request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
    h.clients[0].notify('turn/started', { threadId: 'saved', turn: { id: 'compact' } });
    h.complete(); expect(h.session.busy).toBe(false); h.session.kill();
  });

  it('does not count a resumed thread’s lifetime tokens as one new bridge turn', async () => {
    const h = setup({ threadId: 'saved' }); h.send(); await settle();
    h.clients[0].notify('thread/tokenUsage/updated', { threadId: 'saved', turnId: 'turn-1', tokenUsage: { total: { inputTokens: 50000 } } });
    h.complete(); expect(h.events.at(-1).usage).toBeNull();
    h.send(); await settle();
    h.clients[0].notify('thread/tokenUsage/updated', { threadId: 'saved', turnId: h.session.turnId, tokenUsage: { total: { inputTokens: 50100 } } });
    h.complete(); expect(h.events.at(-1).usage.input_tokens).toBe(100); h.session.kill();
  });
});
