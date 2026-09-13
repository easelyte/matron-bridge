import { CodexPromptQueue } from './codex-prompts.js';
import { toolOutputSnippet } from './tool-stream-pump.js';
import { createPublishRedactor } from './redact.js';
import { createSlowToolNotices, renderSlowToolNotice, resolveSlowToolNoticeMs } from './slow-tool-notice.js';
import { childConvoId } from './subagent-convos.js';
import path from 'node:path';

// Matron publication stays outside the transport so protocol/lifecycle tests
// never need a journal connection. Only parent assistant text enters history.
export function wireCodexAppSession(session, { publisher, convoIdFor, stream, activity, status, notice,
  publishPrompt, publishText, submitAsyncAnswer, onLoginComplete, runningStore, enabled = true } = {}) {
  const codex = session.codex;
  const text = new Map();
  const outputs = new Map();
  const children = new Map();
  const approvalItems = new Map();
  const childFinalMessages = new Map();
  const childOutcomes = new Map();
  const compactionItems = new Map();
  let compacting = false;
  let manualCompactCompleted = false;
  function compactComplete() {
    compacting = false;
    notice(session, '✅ Context compacted — conversation history summarized.');
    activity(session, 'thinking');
  }
  let redact;
  try { redact = createPublishRedactor(); } catch { /* fail closed */ }
  const safe = value => {
    try {
      // The general redactor requires a complete PEM. Also mask an unfinished
      // PEM while streaming, before its closing delimiter has arrived.
      const body = String(value ?? '').replace(/-----BEGIN ([A-Z0-9 -]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[Private key withheld]');
      return redact(body);
    } catch { return '[Output withheld: redaction unavailable]'; }
  };
  session.codexSafeOutput = safe;
  const slowTools = createSlowToolNotices({ thresholdMs: resolveSlowToolNoticeMs(process.env.MATRON_SLOW_TOOL_NOTICE_MS),
    notify: event => {
      if (session.alive && !session._codexAwaitingAnswer) notice(session,
        renderSlowToolNotice(event).replace('send "interrupt"', 'send !esc'));
    } });
  const refFor = (turnId, itemId, threadId = codex.threadId) => `codex:${threadId}:${turnId}:${itemId}`;
  session.codexPrompts = new CodexPromptQueue({
    respond: (id, result) => codex.client?.respond(id, result) === true,
    reject: id => codex.client?.rejectRequest(id),
    publish: payload => publishPrompt(session, { ...payload, question: safe(payload.question) }),
    submitAsync: body => submitAsyncAnswer?.(session, body),
    notice: message => notice(session, message),
    onPending: pending => {
      session._codexAwaitingAnswer = pending;
      activity(session, pending ? 'idle' : (session.busy ? 'thinking' : 'idle'));
    },
    timeoutMs: process.env.PERMISSION_PROMPT_TIMEOUT_MS,
  });
  codex.on('request', request => {
    if (request.params?.turnId && codex.finishedTurns?.has(request.params.turnId)) {
      codex.client?.rejectRequest(request.id); return;
    }
    if (request.params?.threadId && request.params.threadId !== codex.threadId
        && !codex.childThreads.has(request.params.threadId)) {
      codex.client?.rejectRequest(request.id); return;
    }
    const item = approvalItems.get(request.params?.itemId);
    if (item?.type === 'fileChange') request = { ...request, params: { ...request.params, fileChanges: item.changes } };
    session.codexPrompts.add(request, { planMode: codex.planMode });
  });
  codex.on('request-resolved', id => session.codexPrompts.remove(id));
  codex.on('requests-cleared', () => session.codexPrompts.clear({ preserveAsync: true }));
  codex.on('process', child => { session.proc = child; });
  codex.on('notice', message => notice(session, safe(message)));
  codex.on('metadata', result => {
    session._codexObservedModel = result.model;
    session._codexObservedEffort = result.reasoningEffort;
    status(session);
  });
  codex.on('usage', usage => {
    if (!usage) return;
    session._codexNativeUsage = {
      input_tokens: usage.total?.inputTokens || 0, output_tokens: usage.total?.outputTokens || 0,
      cache_read: usage.total?.cachedInputTokens || 0, reasoning_tokens: usage.total?.reasoningOutputTokens || 0,
      cache_create: usage.total?.cacheWriteInputTokens || 0, cost_usd: 0,
    };
    session._lastContextTokens = usage.last?.inputTokens;
    session._codexContextWindow = usage.modelContextWindow;
    session._codexUsageRevision = (session._codexUsageRevision || 0) + 1;
    status(session);
  });
  codex.on('text-delta', event => {
    if (!session.alive || !session.busy || typeof event.delta !== 'string') return;
    const ref = refFor(event.turnId, event.itemId);
    const full = (text.get(ref) || '') + event.delta;
    if (full.length > 4 * 1024 * 1024) return;
    text.set(ref, full);
    // Apply the same redaction policy to cumulative and completed text.
    stream(session, ref, safe(full));
  });
  codex.on('item', ({ method, item, turnId }) => {
    if (!session.alive) return;
    if (item.type === 'contextCompaction') {
      // Native compaction is a lifecycle item, not assistant text or a tool.
      // Track item IDs so replayed starts/completions cannot duplicate notices.
      const previous = compactionItems.get(item.id);
      if (previous === 'item/completed' || previous === method) return;
      if (compactionItems.size >= 128) compactionItems.delete(compactionItems.keys().next().value);
      compactionItems.set(item.id, method);
      if (method === 'item/started') {
        if (!compacting) notice(session, '🗜️ Compacting context — summarizing conversation history…');
        compacting = true;
        activity(session, 'thinking', 'Compacting context');
      } else if (method === 'item/completed') {
        // Manual /compact owns a turn: wait for its successful exit before
        // confirming. Automatic compaction happens mid-turn and must leave
        // the running task and queued input alone.
        if (codex.operation?.kind === 'compact') manualCompactCompleted = true;
        else compactComplete();
      }
      return;
    }
    const ref = refFor(turnId || codex.turnId, item.id);
    const toolName = item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}`
      : ['commandExecution', 'fileChange', 'webSearch', 'collabAgentToolCall'].includes(item.type) ? item.type : null;
    if (toolName) {
      if (method === 'item/started') slowTools.toolStarted(item.id, toolName);
      else slowTools.toolEnded(item.id);
    }
    if (method === 'item/started' && ['commandExecution', 'fileChange'].includes(item.type) && approvalItems.size < 128) approvalItems.set(item.id, item);
    if (method === 'item/completed') approvalItems.delete(item.id);
    if (method === 'item/completed' && item.type === 'fileChange') publishChanges(convoIdFor(session), item);
    if (method === 'item/completed' && item.type === 'agentMessage') {
      text.delete(ref);
      if (item.delivery === 'async') session.codexPrompts.addAsync(`async:${ref}`, item.questions);
    }
    if (item.type === 'plan' && method === 'item/completed') {
      session._codexHadAssistantMessage = Boolean(item.text);
      session._codexPlanText = item.text;
      publishText(session, safe(item.text));
    }
    if (item.type !== 'commandExecution') return;
    if (!outputs.has(ref) && outputs.size < 16) outputs.set(ref, { ref, command: safe(item.command), offset: 0, raw: '', published: '', truncated: false });
    if (!outputs.has(ref)) return;
    outputs.get(ref).command = safe(item.command);
    if (method === 'item/completed') {
      const entry = outputs.get(ref);
      if (!entry.raw && item.aggregatedOutput) appendOutput(entry, item.aggregatedOutput);
      finalize(entry, item.exitCode ?? null);
    }
  });
  function appendOutput(entry, delta) {
    if (entry.truncated) return;
    entry.raw += delta;
    if (Buffer.byteLength(entry.raw) > 1024 * 1024) {
      entry.raw = Buffer.from(entry.raw).subarray(0, 1024 * 1024).toString('utf8');
      entry.truncated = true;
    }
    // Redact with all prior context (PEMs, YAML block scalars), and hold the
    // incomplete line. Never append a suffix if redaction rewrote its prefix.
    const end = entry.raw.lastIndexOf('\n') + 1;
    if (!end) return;
    const body = safe(entry.raw.slice(0, end));
    if (!body.startsWith(entry.published)) return;
    const chunk = body.slice(entry.published.length);
    if (!chunk) return;
    if (enabled && session.showBashOutput !== false) {
      if (publisher.streamAppend(entry.convoId || convoIdFor(session), entry.ref, entry.offset, chunk, { command: entry.command })) {
        entry.offset += Buffer.byteLength(chunk);
        entry.published = body;
      }
    }
  }
  codex.on('output-delta', event => {
    if (!session.alive || typeof event.delta !== 'string') return;
    const ref = refFor(event.turnId, event.itemId);
    if (!outputs.has(ref) && outputs.size < 16) outputs.set(ref, { ref, command: 'Command', offset: 0, raw: '', published: '', truncated: false });
    if (!outputs.has(ref)) return;
    appendOutput(outputs.get(ref), event.delta);
  });
  function finalize(entry, exitCode) {
    outputs.delete(entry.ref);
    if (!enabled || session.showBashOutput === false) return;
    const body = safe(entry.raw);
    const id = entry.convoId || convoIdFor(session);
    if (body.startsWith(entry.published) && body.length > entry.published.length) {
      const chunk = body.slice(entry.published.length);
      publisher.streamAppend(id, entry.ref, entry.offset, chunk, { command: entry.command });
    }
    // Retire the live overlay even if log upload fails or the socket drops.
    void (async () => {
      let media = null;
      try { if (body) media = await publisher.uploadMedia({ bytes: Buffer.from(body), contentType: 'text/plain', name: 'codex-command.log' }); }
      catch { /* snippet remains available */ }
      publisher.finalizeToolOutput(id, entry.ref, { message_ref: entry.ref, command: entry.command,
        exit_code: exitCode, snippet: toolOutputSnippet(body), truncated: entry.truncated,
        blob_ref: media?.media_id || null, live_log: true }, media?.media_id || null);
    })().catch(() => {});
  }
  function finishChild(id, outcome) {
    if (!enabled) return;
    childOutcomes.set(id, outcome);
    const opts = { sessionState: 'done', sessionOutcome: outcome, parentConvoId: convoIdFor(session) };
    if (publisher.upsertConvoBestEffort) publisher.upsertConvoBestEffort(id, opts, { onDelivered: () => runningStore?.remove(id) });
    else if (publisher.upsertConvo(id, opts)) runningStore?.remove(id);
  }
  function publishChanges(id, item) {
    if (!enabled) return;
    for (const change of (item.changes || []).slice(0, 100)) {
      if (typeof change.path !== 'string' || typeof change.diff !== 'string') continue;
      const diff = safe(change.diff.slice(0, 256 * 1024));
      const lines = diff.split('\n');
      publisher.publishDiff?.(id, { file_path: path.resolve(session.workdir, change.path), display_path: safe(change.path),
        viewer_url: null, tool: 'apply_patch', label: null, diff, from: 'assistant',
        added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
        removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
        truncated: change.diff.length > 256 * 1024, new_file: change.kind?.type === 'add' });
    }
  }
  function cleanup({ code = 0 } = {}) {
    compactionItems.clear();
    compacting = false;
    manualCompactCompleted = false;
    if (!session.alive || code !== 0) session.codexPrompts.clear();
    slowTools.reset();
    approvalItems.clear();
    for (const ref of text.keys()) for (const [threadId, id] of children) {
      if (ref.startsWith(`codex:${threadId}:`)) publisher.endStream(id, ref, { clear: true });
    }
    text.clear();
    for (const entry of outputs.values()) finalize(entry, null);
    if (!session.alive || code !== 0) for (const id of children.values()) {
      if (!childOutcomes.has(id)) finishChild(id, 'interrupted');
    }
    // The connection is long-lived: the cap bounds active children, not the
    // lifetime number of child conversations this session may create.
    for (const [threadId, id] of children) if (childOutcomes.has(id)) {
      children.delete(threadId);
      childOutcomes.delete(id);
      childFinalMessages.delete(threadId);
      codex.childThreads.delete(threadId);
    }
  }
  codex.on('turn-exit', (result = {}) => {
    if (session.alive && result.code === 0 && manualCompactCompleted) compactComplete();
    cleanup(result);
  });
  function clearLogin() {
    const pending = session._codexLoginId;
    session._codexLoginId = null;
    if (pending && session.alive) notice(session, 'Codex sign-in was interrupted. Use /login to get a new code.');
  }
  codex.on('closed', () => { clearLogin(); cleanup({ code: 1 }); });
  // Reconnecting closes the old app-server and its collaboration runtime.
  // Do not leave child rooms claiming to run without an event subscription.
  // A later collab event may rediscover/reopen the same native child thread.
  codex.on('connection-reset', () => {
    clearLogin();
    const unfinished = [...children.values()].some(id => !childOutcomes.has(id));
    cleanup({ code: 1 });
    if (unfinished) notice(session, 'Codex reconnected; previous subagent views were marked interrupted. Later child activity can reopen them.');
  });
  codex.on('account', ({ method, params }) => {
    if (method === 'account/login/completed') {
      if (!session.alive || !session._codexLoginId || params.loginId !== session._codexLoginId) return;
      session._codexLoginId = null;
      session._codexMetadata = null;
      notice(session, params.success
        ? '✅ Codex login completed. You can send messages now. If a turn failed, send it again to retry.'
        : `Codex login did not complete${params.error ? `: ${safe(params.error)}` : '.'} Use /login to get a new code.`);
      status(session);
      if (params.success) onLoginComplete?.(session);
    }
  });
  codex.on('child-discovered', ({ id, item }) => {
    if (!enabled) return;
    if (children.size >= 64) {
      codex.childThreads.delete(id);
      notice(session, 'Native subagent view limit reached (64 active children); an additional child is not displayed.');
      return;
    }
    const parentConvoId = convoIdFor(session);
    const childId = childConvoId(parentConvoId, `codex-${id}`);
    if (runningStore?.add(childId, { parentConvoId, agentId: `codex-${id}` }) === false) {
      codex.childThreads.delete(id); // a later collaboration event may retry setup
      notice(session, 'Could not record native subagent recovery state; child view disabled.'); return;
    }
    children.set(id, childId);
    publisher.upsertConvo(childId, { parentConvoId: convoIdFor(session), title: `Codex ${id.slice(0, 8)}`, sessionState: 'running' });
    if (item.prompt) publisher.publishText(childId, { body: safe(item.prompt), from: 'user' });
    // Read-only hydration/subscription; never send a turn to a child owned by
    // Codex's collaboration runtime.
    void codex.rpc('thread/resume', { threadId: id, excludeTurns: true }).catch(() => {});
  });
  codex.on('child-event', ({ method, params }) => {
    const id = children.get(params.threadId);
    if (!id) return;
    const ref = refFor(params.turnId, params.itemId || params.item?.id, params.threadId);
    if (method === 'item/agentMessage/delta') {
      const value = (text.get(ref) || '') + params.delta;
      text.set(ref, value);
      publisher.stream(id, ref, safe(value));
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      publisher.endStream(id, ref, { clear: true });
      text.delete(ref);
      childFinalMessages.set(params.threadId, params.item.text);
      publisher.publishText(id, { body: safe(params.item.text), from: 'assistant', message_ref: ref });
    }
    if (method === 'item/completed' && params.item?.type === 'fileChange') publishChanges(id, params.item);
    if (method === 'item/commandExecution/outputDelta' || (method.startsWith('item/') && params.item?.type === 'commandExecution')) {
      if (!outputs.has(ref) && outputs.size < 16) outputs.set(ref, { ref, convoId: id, command: 'Command', offset: 0, raw: '', published: '', truncated: false });
      const entry = outputs.get(ref);
      if (entry) {
        if (params.item?.command) entry.command = safe(params.item.command);
        if (typeof params.delta === 'string') appendOutput(entry, params.delta);
        if (method === 'item/completed') {
          if (!entry.raw && params.item.aggregatedOutput) appendOutput(entry, params.item.aggregatedOutput);
          finalize(entry, params.item.exitCode ?? null);
        }
      }
    }
    if (method === 'turn/completed') finishChild(id,
      params.turn?.status === 'failed' ? 'failed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'completed');
  });
  codex.on('children-state', item => {
    for (const [threadId, state] of Object.entries(item.agentsStates || {})) {
      const id = children.get(threadId);
      if (!id) continue;
      if (state.status === 'completed' && state.message && childFinalMessages.get(threadId) !== state.message) {
        publisher.publishText(id, { body: safe(state.message), from: 'assistant' });
        childFinalMessages.set(threadId, state.message);
      }
      if (['completed', 'errored', 'shutdown'].includes(state.status)) finishChild(id,
        state.status === 'completed' ? 'completed' : state.status === 'errored' ? 'failed' : 'interrupted');
      else {
        childOutcomes.delete(id);
        runningStore?.add(id, { parentConvoId: convoIdFor(session), agentId: `codex-${threadId}` });
        publisher.upsertConvo(id, { sessionState: 'running' });
      }
    }
  });
  return { safe };
}
