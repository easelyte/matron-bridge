import { EventEmitter } from 'node:events';
import { CodexRpcClient } from './codex-rpc.js';
import { normalizeCodexSandbox, normalizeCodexNetworkAccess } from './codex-session.js';

export function codexInput(blocks = []) {
  return blocks.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return [{ type: 'text', text: block.text }];
    }
    if (block?.type === 'image' && block.source?.type === 'base64'
        && /^image\/(png|jpeg|webp|gif)$/.test(block.source.media_type)
        && typeof block.source.data === 'string') {
      return [{ type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` }];
    }
    return [];
  });
}

export function codexItem(item = {}) {
  const types = { agentMessage: 'agent_message', commandExecution: 'command_execution',
    fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search' };
  return { ...item, type: types[item.type] || item.type,
    ...(item.aggregatedOutput != null ? { aggregated_output: item.aggregatedOutput } : {}),
    ...(item.exitCode != null ? { exit_code: item.exitCode } : {}) };
}

const PLAN_INSTRUCTIONS = '\n\nMatron plan mode is active. Investigate and produce an implementation plan. Do not change files or perform external writes. End with the proposed plan and wait for the user to choose Build in Matron.';
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;

export function codexPlanConfig(config = {}, defaults = {}) {
  const browser = { ...defaults.browser_use, ...config.browser_use };
  const computer = { ...defaults.computer_use, ...config.computer_use };
  return { ...config,
    mcp_servers: Object.fromEntries(Object.entries({ ...defaults.mcp_servers, ...config.mcp_servers })
      .map(([name, server]) => [name, { ...server, enabled: false }])),
    plugins: Object.fromEntries(Object.entries({ ...defaults.plugins, ...config.plugins })
      .map(([name, plugin]) => [name, { ...plugin, enabled: false }])),
    'features.apps': false, 'features.hooks': false,
    browser_use: { ...browser, default_origin_policy: { access: 'deny', uploads: 'deny', downloads: 'deny', full_cdp_access: 'deny' },
      origins: Object.fromEntries(Object.entries(browser.origins || {}).map(([origin, policy]) => [origin,
        { ...policy, access: 'deny', uploads: 'deny', downloads: 'deny', full_cdp_access: 'deny' }])) },
    computer_use: { ...computer, default_app_access: 'deny', macos: { ...computer.macos,
      bundle_ids: Object.fromEntries(Object.keys(computer.macos?.bundle_ids || {}).map(id => [id, 'deny'])) } },
  };
}

export class CodexAppServerSession extends EventEmitter {
  constructor({ cwd, threadId = null, model = null, effort = null, sandbox = 'workspace-write', networkAccess = null,
    developerInstructions = '', config = {}, env = process.env, clientFactory = options => new CodexRpcClient(options),
    command = 'codex', spawnImpl, approvalPolicy = null } = {}) {
    super();
    Object.assign(this, { cwd, threadId, model, effort, developerInstructions, config, env, clientFactory,
      command, spawnImpl, approvalPolicy });
    this.sandbox = normalizeCodexSandbox(sandbox);
    this.approvalPolicy = approvalPolicy ?? (this.sandbox === 'danger-full-access' ? 'never' : 'on-request');
    this.networkAccess = normalizeCodexNetworkAccess(networkAccess);
    this.transport = 'app-server';
    this.alive = true;
    this.busy = false;
    this.lastError = null;
    this.client = null;
    this.turnId = null;
    this.operation = null;
    this.planMode = false;
    this.threadReady = null;
    this.threadSignature = null;
    this.usage = null;
    this.childThreads = new Set();
    this.finishedTurns = new Set();
  }

  get child() { return this.client?.child || null; }

  connection() {
    if (!this.alive) throw new Error('Codex session is stopped.');
    if (this.client && !this.client.closed) return this.client;
    const client = this.clientFactory({ cwd: this.cwd, env: this.env, command: this.command, spawnImpl: this.spawnImpl });
    this.client = client;
    this.finishedTurns.clear();
    this.threadSignature = null;
    this.threadReady = null;
    client.on('notification', event => { if (this.client === client && this.alive) this.notification(event); });
    client.on('request', request => {
      if (this.client === client && this.alive) this.emit('request', request);
    });
    client.on('disconnect', error => {
      if (this.client !== client) return;
      this.threadSignature = null;
      this.threadReady = null;
      this.emit('requests-cleared');
      this.emit('connection-reset');
      if (this.operation) this.finish({ error });
      else if (this.alive) this.emit('notice', error.message);
    });
    return client;
  }

  async rpc(method, params = {}, options) {
    const client = this.connection();
    await client.connect();
    return client.request(method, params, options);
  }

  async ensureThread(settings = { model: this.model, effort: this.effort, planMode: this.planMode }) {
    this.connection(); // invalidate cached thread state after a disconnect
    while (this.threadReady) await this.threadReady;
    const signature = JSON.stringify([settings.model, settings.effort, settings.planMode, this.approvalPolicy,
      this.sandbox, this.networkAccess]);
    if (this.threadSignature === signature) return;
    if (this.threadSignature) {
      // Some CLI releases rejoin an already loaded thread without rebuilding
      // its MCP runtime. Reconnect on settings changes so Plan/Build really
      // reconfigures tools and permissions. Ordinary turns reuse the server.
      const previous = this.client;
      this.client = null;
      previous?.close();
      this.emit('requests-cleared');
      this.emit('connection-reset');
      this.connection();
    }
    const work = async () => {
      // Live threads remember turn overrides: omission cannot reset a pick.
      const { config: defaults = {} } = await this.rpc('config/read', { cwd: this.cwd, includeLayers: false });
      let model = settings.model || defaults.model;
      let effort = settings.effort || defaults.model_reasoning_effort;
      if (!model || !effort) {
        const { data = [] } = await this.rpc('model/list', { limit: 100, includeHidden: false });
        model ||= data.find(m => m.isDefault)?.model;
        effort ||= data.find(m => m.model === model)?.defaultReasoningEffort;
      }
      const params = { cwd: this.cwd, sandbox: settings.planMode ? 'read-only' : this.sandbox,
        approvalPolicy: settings.planMode ? 'never' : this.approvalPolicy,
        approvalsReviewer: 'user',
        developerInstructions: [defaults.developer_instructions, this.developerInstructions, settings.planMode ? PLAN_INSTRUCTIONS : ''].filter(Boolean).join('\n\n'),
        // MCP, apps, plugins, hooks and desktop tools are outside the shell
        // sandbox. Plan mode must restrict those surfaces as well.
        config: { ...(settings.planMode ? codexPlanConfig(this.config, defaults) : this.config),
          ...(!settings.planMode && this.sandbox === 'workspace-write' && this.networkAccess !== null
            ? { 'sandbox_workspace_write.network_access': this.networkAccess } : {}),
          ...(effort ? { model_reasoning_effort: effort } : {}) },
        ...(model ? { model } : {}) };
      const result = await this.rpc(this.threadId ? 'thread/resume' : 'thread/start',
        { ...params, ...(this.threadId ? { threadId: this.threadId } : {}) }, { timeoutMs: 120_000 });
      if (!this.alive) return;
      if (!result?.thread?.id) throw new Error('Codex did not return a thread ID.');
      // Never take over a thread with a turn already running in another client.
      if (result.thread.status?.type === 'active' || result.thread.turns?.some(turn => turn.status === 'inProgress')) {
        throw new Error('This Codex thread is already running. Finish its turn before resuming it in Matron.');
      }
      this.threadId = result.thread.id;
      this.threadSignature = signature;
      this.emit('event', { type: 'thread.started', thread_id: this.threadId });
      this.emit('metadata', result);
    };
    const pending = work();
    this.threadReady = pending;
    try { await pending; } finally { if (this.threadReady === pending) this.threadReady = null; }
  }

  send(blocks) {
    const input = codexInput(blocks);
    if (!this.alive || this.busy || !input.length) return false;
    this.begin('turn');
    const operation = this.operation;
    this.start(input, operation).catch(error => this.failOperation(operation, error));
    return true;
  }

  begin(kind) {
    this.busy = true;
    this.lastError = null;
    this.turnId = null;
    this.operation = { kind, baseline: this.usage?.total || {}, baselineKnown: !!this.usage || !this.threadId, cancelled: false,
      settings: { model: this.model, effort: this.effort, planMode: this.planMode } };
    // Match the exec adapter's logical turn-start event. The actual server is
    // long-lived; process is published separately once its connection opens.
    this.emit('spawn', { child: this.child, args: ['app-server'] });
  }

  async start(input, operation) {
    await this.ensureThread(operation.settings);
    if (this.operation !== operation || !this.alive) return;
    this.emit('process', this.child);
    if (operation.cancelled) { this.finish({ interrupted: true }); return; }
    if (this.usage) { operation.baseline = this.usage.total; operation.baselineKnown = true; }
    const result = await this.rpc('turn/start', { threadId: this.threadId, input,
      ...(operation.settings.model ? { model: operation.settings.model } : {}),
      ...(operation.settings.effort ? { effort: operation.settings.effort } : {}) }, { timeoutMs: 120_000 });
    if (this.operation !== operation) return;
    this.turnId = result?.turn?.id || this.turnId;
    if (!this.turnId) throw new Error('Codex did not return a turn ID.');
    if (operation.cancelled) await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  failOperation(operation, error) {
    if (this.operation !== operation) return;
    // A timed-out turn/start could have been accepted. Close the connection
    // rather than replaying the user's task and possibly executing it twice.
    if (error.code === 'TIMEOUT') this.client?.close();
    this.finish({ error });
  }

  async steer(blocks) {
    this.steerUncertain = false;
    const input = codexInput(blocks);
    const turnId = this.turnId;
    if (!this.alive || !this.busy || !turnId || !input.length) return false;
    try {
      const result = await this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, input });
      return result?.turnId === turnId;
    } catch (error) {
      this.lastError = error;
      // Protocol rejection is definite; losing the connection/ack is not.
      // Callers must not automatically resend uncertain steering requests.
      this.steerUncertain = typeof error.code !== 'number';
      return false;
    }
  }

  interrupt() {
    if (!this.alive || !this.operation) return false;
    this.operation.cancelled = true;
    this.emit('requests-cleared');
    if (this.turnId) {
      const operation = this.operation;
      this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
        .catch(error => this.failOperation(operation, error));
    }
    return true;
  }

  compact() {
    if (!this.alive || this.busy) return false;
    this.begin('compact');
    const operation = this.operation;
    (async () => {
      await this.ensureThread(operation.settings);
      if (this.operation !== operation) return;
      this.emit('process', this.child);
      if (operation.cancelled) { this.finish({ interrupted: true }); return; }
      await this.rpc('thread/compact/start', { threadId: this.threadId }, { timeoutMs: 120_000 });
    })().catch(error => this.failOperation(operation, error));
    return true;
  }

  notification({ method, params = {} }) {
    if (method === 'serverRequest/resolved') {
      this.client?.serverRequests.delete(params.requestId);
      this.emit('request-resolved', params.requestId);
      return;
    }
    if (method.startsWith('account/')) { this.emit('account', { method, params }); return; }
    // Child thread events belong in child conversations, never the parent.
    if (params.threadId && params.threadId !== this.threadId) {
      if (this.childThreads.has(params.threadId)) this.emit('child-event', { method, params });
      return;
    }
    const eventTurnId = params.turnId || (method.startsWith('turn/') ? params.turn?.id : null);
    if (eventTurnId && this.finishedTurns.has(eventTurnId)) return;
    if (method.startsWith('item/') && !this.operation) return;
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) return;
    if (method === 'turn/started' && this.operation) this.turnId = params.turn?.id || this.turnId;
    if (method === 'thread/tokenUsage/updated') {
      this.usage = params.tokenUsage;
      this.emit('usage', params.tokenUsage);
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'collabAgentToolCall') {
        for (const id of item.receiverThreadIds || []) {
          if (!this.childThreads.has(id)) {
            this.childThreads.add(id);
            this.emit('child-discovered', { id, item });
          }
        }
        this.emit('children-state', item);
      }
      this.emit('event', { type: method.replace('/', '.'), item: codexItem(item) });
      this.emit('item', { method, item, turnId: params.turnId });
    }
    if (method === 'item/agentMessage/delta') this.emit('text-delta', params);
    if (method === 'item/commandExecution/outputDelta') this.emit('output-delta', params);
    if (method === 'turn/plan/updated') this.emit('plan', params);
    if (method === 'turn/diff/updated') this.emit('diff', params);
    if (method === 'error') {
      this.lastError = new Error(params.error?.message || 'Codex turn failed.');
      this.emit('event', { type: 'error', message: this.lastError.message });
    }
    if (method === 'turn/completed' && this.operation) {
      const turn = params.turn || {};
      if (this.turnId && turn.id !== this.turnId) return;
      this.finish({ error: turn.status === 'failed' ? new Error(turn.error?.message || this.lastError?.message || 'Codex turn failed.') : null,
        interrupted: turn.status === 'interrupted' || this.operation.cancelled });
    }
  }

  finish({ error = null, interrupted = false } = {}) {
    if (!this.operation) return;
    const { baseline, baselineKnown } = this.operation;
    const total = this.usage?.total || {};
    const usage = baselineKnown ? {
      input_tokens: Math.max(0, count(total.inputTokens) - count(baseline.inputTokens)),
      output_tokens: Math.max(0, count(total.outputTokens) - count(baseline.outputTokens)),
      cached_input_tokens: Math.max(0, count(total.cachedInputTokens) - count(baseline.cachedInputTokens)),
    } : null;
    if (this.turnId) {
      if (this.finishedTurns.size >= 128) this.finishedTurns.delete(this.finishedTurns.values().next().value);
      this.finishedTurns.add(this.turnId);
    }
    this.operation = null;
    this.turnId = null;
    this.busy = false;
    this.lastError = error;
    this.emit('requests-cleared');
    if (error || interrupted) this.emit('event', { type: 'turn.failed', error: { message: error?.message || 'Codex turn interrupted.' }, usage });
    else this.emit('event', { type: 'turn.completed', usage });
    this.emit('turn-exit', { code: error || interrupted ? 1 : 0, signal: interrupted ? 'SIGINT' : null,
      stderr: error?.message || '', sawTurnCompleted: !error && !interrupted });
  }

  kill() {
    this.alive = false;
    this.emit('requests-cleared');
    this.client?.close();
    this.finish({ interrupted: true });
    this.emit('closed');
    return true;
  }
}
