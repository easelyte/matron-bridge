const PINNED_CODEX_VERSION = '0.146.0';
const PINNED_SCHEMA_VERSION = `codex-cli ${PINNED_CODEX_VERSION}`;
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
  const rawConfigured = process.env.CODEX_MAX_DURABLE_EVENTS || '';
  const configured = /^\d+$/.test(rawConfigured) ? Number(rawConfigured) : NaN;
  return Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_MAX_DURABLE_EVENTS;
}

function schemaIsPinned(schemaVersion) {
  return schemaVersion === PINNED_SCHEMA_VERSION;
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
      body: 'Additional events truncated',
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
      if (typeof ctx.runId === 'string' && ctx.runId.length > 0) {
        // The final answer is the run's durable result, not an intermediate
        // event. It must survive even when intermediate posts exhaust the cap.
        state.durableEvents += 1;
        const enqueued = ctx.publisher.publishText(
          ctx.convoId,
          { body: state.pendingAgentMessage, from: 'assistant' },
          { idemKey: `${ctx.runId}:final` },
        );
        // This records acceptance into the local durable queue, not delivery
        // acknowledgement. Reconnect re-emission repairs post-enqueue loss.
        if (enqueued === true) state.finalPostProduced = true;
      } else if (!state.finalRunIdWarningLogged) {
        state.finalRunIdWarningLogged = true;
        try {
          ctx.log?.warn?.('[codex-event-format] missing runId; skipping durable final answer');
        } catch { /* logging cannot interrupt the stream */ }
      }
      state.pendingAgentMessage = null;
    }
    state.terminalSeen = true;
    ctx.publisher.publishActivity(ctx.convoId, 'idle');
    return state;
  }

  if (event?.type === 'item.started') {
    flushPendingAsActivity(ctx, state);
    if (event.item?.type === 'command_execution') {
      ctx.publisher.publishActivity(ctx.convoId, 'tool', event.item.command);
    } else if (event.item?.type === 'file_change') {
      ctx.publisher.publishActivity(ctx.convoId, 'tool', 'Applying file changes');
    } else {
      passThrough(event, ctx, state);
    }
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
    const changes = Array.isArray(event.item.changes) ? event.item.changes : [];
    // SCHEMA-NOTES.md: exec --json file_change items have no diff body, so
    // publish the touched path + kind as tool output; publishDiff would be empty.
    publishDurable(ctx, state, 'publishToolOutput', {
      tool_use_id: event.item.id,
      command: 'file_change',
      output: changes
        .map(change => `${String(change?.kind || 'change')} ${String(change?.path || 'unknown path')}`)
        .join('\n'),
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
