const PINNED_CODEX_VERSION = '0.146.0';
const DEFAULT_MAX_DURABLE_EVENTS = 200;

function formatState(ctx) {
  const state = ctx.state || (ctx.state = {});
  state.durableEvents ??= 0;
  state.droppedEvents ??= 0;
  state.unparsed ??= 0;
  state.truncationPublished ??= false;
  state.terminalSeen ??= false;
  return state;
}

function maxDurableEvents(ctx) {
  if (Number.isInteger(ctx.maxDurableEvents) && ctx.maxDurableEvents >= 0) {
    return ctx.maxDurableEvents;
  }
  const configured = Number.parseInt(process.env.CODEX_MAX_DURABLE_EVENTS || '', 10);
  return Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_MAX_DURABLE_EVENTS;
}

function schemaIsPinned(schemaVersion) {
  return typeof schemaVersion === 'string'
    && new RegExp(`(^|\\s)${PINNED_CODEX_VERSION.replaceAll('.', '\\.')}(\\s|$)`).test(schemaVersion);
}

function stringify(item) {
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? String(item) : serialized;
  } catch {
    return '[unserializable codex event]';
  }
}

function publishModelOnce(ctx, state) {
  if (state.modelPublished || typeof ctx.meta?.model !== 'string' || !ctx.meta.model) return;
  state.modelPublished = true;
  ctx.publisher.publishStatus?.(ctx.convoId, { model: ctx.meta.model });
}

function publishDurable(ctx, state, method, payload, options) {
  const limit = maxDurableEvents(ctx);
  if (state.durableEvents < limit) {
    state.durableEvents += 1;
    ctx.publisher[method](ctx.convoId, payload, ...(options ? [options] : []));
    return true;
  }

  state.droppedEvents += 1;
  if (!state.truncationPublished) {
    state.truncationPublished = true;
    ctx.publisher.publishText(ctx.convoId, {
      body: `${state.droppedEvents} more events (truncated)`,
      from: 'assistant',
    });
  }
  return false;
}

function textOf(item) {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.summary === 'string') return item.summary;
  return stringify(item);
}

function flushPendingAsActivity(ctx, state) {
  if (state.pendingAgentMessage == null) return;
  ctx.publisher.publishActivity(ctx.convoId, 'thinking', state.pendingAgentMessage);
  state.pendingAgentMessage = null;
}

function passThrough(event, ctx, state) {
  state.unparsed += 1;
  publishDurable(ctx, state, 'publishText', {
    body: stringify(event),
    from: 'assistant',
  });
}

/**
 * Route one parsed line from `codex exec --json` to a child conversation.
 * `ctx.state` is deliberately caller-owned so the watcher can include the
 * counters in its bounded per-run audit event.
 */
export function formatAndRoute(event, ctx) {
  if (!ctx || !ctx.publisher || !ctx.convoId) {
    throw new TypeError('formatAndRoute requires publisher and convoId');
  }
  const state = formatState(ctx);
  publishModelOnce(ctx, state);

  if (!schemaIsPinned(ctx.meta?.schemaVersion)) {
    if (!state.schemaWarningLogged) {
      state.schemaWarningLogged = true;
      try {
        ctx.log?.warn?.(`[codex-event-format] unpinned schema ${String(ctx.meta?.schemaVersion)}; using text passthrough`);
      } catch { /* logging cannot interrupt the stream */ }
    }
    passThrough(event, ctx, state);
    return state;
  }

  if (event?.type === 'thread.started' || event?.type === 'turn.started') {
    flushPendingAsActivity(ctx, state);
    ctx.publisher.publishActivity(ctx.convoId, 'thinking');
    return state;
  }

  if (event?.type === 'turn.completed') {
    if (state.pendingAgentMessage != null) {
      publishDurable(
        ctx,
        state,
        'publishText',
        { body: state.pendingAgentMessage, from: 'assistant' },
        { idemKey: `${ctx.runId}:final` },
      );
      state.pendingAgentMessage = null;
    }
    state.terminalSeen = true;
    ctx.publisher.publishActivity(ctx.convoId, 'idle');
    return state;
  }

  if (event?.type === 'item.started') {
    flushPendingAsActivity(ctx, state);
    const detail = event.item?.type === 'command_execution'
      ? event.item.command
      : event.item?.type === 'file_change'
        ? 'Applying file changes'
        : undefined;
    ctx.publisher.publishActivity(ctx.convoId, detail ? 'tool' : 'thinking', detail);
    return state;
  }

  if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
    flushPendingAsActivity(ctx, state);
    state.pendingAgentMessage = textOf(event.item);
    return state;
  }

  if (event?.type === 'item.completed' && event.item?.type === 'command_execution') {
    flushPendingAsActivity(ctx, state);
    publishDurable(ctx, state, 'publishToolOutput', {
      tool_use_id: event.item.id,
      command: event.item.command,
      output: event.item.aggregated_output,
      exit_code: event.item.exit_code,
      status: event.item.status,
    });
    return state;
  }

  if (event?.type === 'item.completed' && event.item?.type === 'file_change') {
    flushPendingAsActivity(ctx, state);
    publishDurable(ctx, state, 'publishDiff', {
      tool_use_id: event.item.id,
      changes: Array.isArray(event.item.changes) ? event.item.changes : [],
      status: event.item.status,
    });
    return state;
  }

  if (event?.type === 'item.completed'
      && ['reasoning', 'interstitial'].includes(event.item?.type)) {
    flushPendingAsActivity(ctx, state);
    ctx.publisher.publishActivity(ctx.convoId, 'thinking', textOf(event.item));
    return state;
  }

  flushPendingAsActivity(ctx, state);
  passThrough(event, ctx, state);
  return state;
}

export { DEFAULT_MAX_DURABLE_EVENTS, PINNED_CODEX_VERSION };
