import { buildSessionStatus } from './session-status.js';

const PINNED_CODEX_VERSION = '0.146.0';
// The allowlisted item schema (command_execution, agent_message, file_change,
// reasoning, and the lifecycle events) is stable across the 0.146.x–0.147.x
// codex-cli line, so we accept a compatibility BAND instead of an exact pin. An
// exact-equality pin silently raw-dumps every other version present in a mixed
// fleet (observed live: 0.146.0, 0.146.1 and 0.147.0 concurrently) and
// re-breaks on each codex upgrade. Versions outside [MIN, MAX_EXCLUSIVE) still
// fail safe to the text-passthrough fallback.
const MIN_SUPPORTED_CODEX_VERSION = [0, 146, 0];
const MAX_SUPPORTED_CODEX_VERSION_EXCLUSIVE = [0, 148, 0];
const DEFAULT_MAX_DURABLE_EVENTS = 200;
const DEFAULT_ACTIVITY_INTERVAL_MS = 250;
const SECRET_ENV_NAME_RE = /(?:^|_)(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIALS?|AUTH(?:ORIZATION)?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)(?:$|_)/i;

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

function parseCodexSchemaVersion(schemaVersion) {
  if (typeof schemaVersion !== 'string') return null;
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(schemaVersion.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// True when the run's producer version is within the supported compatibility
// band. Malformed or out-of-band identifiers return false and fail safe to the
// generic text-passthrough path (never throws on untrusted meta).
function schemaIsSupported(schemaVersion) {
  const parsed = parseCodexSchemaVersion(schemaVersion);
  if (parsed === null) return false;
  return (
    compareVersions(parsed, MIN_SUPPORTED_CODEX_VERSION) >= 0 &&
    compareVersions(parsed, MAX_SUPPORTED_CODEX_VERSION_EXCLUSIVE) < 0
  );
}

function stringify(item) {
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? String(item) : serialized;
  } catch {
    return '[unserializable codex event]';
  }
}

function redactionState(ctx) {
  const state = formatState(ctx);
  state.redactionDropCount ??= 0;
  return state;
}

function isRawEnvDumpCommand(command) {
  if (typeof command !== 'string') return false;
  const stages = splitShell(command);
  return stages.some(stage => isEnvDumpStage(stage));
}

function isSecretEnvName(value) {
  return typeof value === 'string' && (
    SECRET_ENV_NAME_RE.test(value) || /_(?:KEY|TOKEN|SECRET)$/i.test(value)
  );
}

function hasSecretEnvReference(command) {
  if (typeof command !== 'string') return false;
  const stages = splitShell(command);
  for (const stage of stages) {
    const words = shellWords(stage);
    if (words[0] === 'command') words.shift();
    const executable = executableName(words.shift());
    if (['sh', 'bash'].includes(executable) && /^-(?:c|lc|cl)$/.test(words[0] ?? '')) {
      words.shift();
      if (hasSecretEnvReference(words.join(' '))) return true;
    }
    if (executable === 'printenv' && words.some(word => isSecretEnvName(word))) return true;
  }

  const references = [
    ...command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g),
    ...command.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g),
    ...command.matchAll(/\bprocess\.env\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)/g),
    ...command.matchAll(/\bos\.(?:getenv\s*\(\s*|environ(?:\s*\[\s*|\.get\s*\(\s*))['"]([A-Za-z_][A-Za-z0-9_]*)/g),
  ];
  if (references.some(match => isSecretEnvName(match[1]))) return true;

  // `env | grep NAME` prints the matching assignment, whose value is secret.
  return isRawEnvDumpCommand(command) && stages.slice(1).some(stage =>
    shellWords(stage).some(word => isSecretEnvName(word.replace(/[^A-Za-z0-9_]/g, ''))),
  );
}

function splitShell(command) {
  const stages = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && quote !== "'") {
      current += char;
      if (index + 1 < command.length) current += command[++index];
    } else if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if ('|;&'.includes(char)) {
      if (current.trim()) stages.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) stages.push(current.trim());
  return stages;
}

function shellWords(stage) {
  const words = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < stage.length; index += 1) {
    const char = stage[index];
    if (char === '\\' && quote !== "'") {
      if (index + 1 < stage.length) current += stage[++index];
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function executableName(value) {
  return value?.split('/').at(-1);
}

function isEnvDumpStage(stage) {
  const words = shellWords(stage);
  if (words[0] === 'command') words.shift();
  const executable = executableName(words.shift());
  if (!executable) return false;
  if (['sh', 'bash'].includes(executable) && /^-(?:c|lc|cl)$/.test(words[0] ?? '')) {
    words.shift();
    return isRawEnvDumpCommand(words.join(' '));
  }
  if (['cat', 'less', 'head', 'xxd'].includes(executable) &&
      words.some(word => /^\/proc\/(?:self|\d+)\/environ$/.test(word))) {
    return true;
  }
  if (executable === 'printenv') {
    return words.every(word => word === '-0' || word === '--null');
  }
  if (executable === 'set') return words.length === 0;
  if (executable === 'export') return words.length === 0 || (words.length === 1 && words[0] === '-p');
  if (executable === 'declare') {
    return words.length === 1 && /^(?:-x|-xp|-px)$/.test(words[0]);
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    const codeIndex = words.findIndex(word => word === '-c');
    return codeIndex >= 0 && typeof words[codeIndex + 1] === 'string' &&
      /\bos\.environ\b/.test(words[codeIndex + 1]);
  }
  if (executable === 'node') {
    const codeIndex = words.findIndex(word => (
      word === '-e' || word === '--eval' || word === '-p' || word === '--print'
    ));
    return codeIndex >= 0 && typeof words[codeIndex + 1] === 'string' &&
      /\bprocess\.env\b/.test(words[codeIndex + 1]);
  }
  if (executable !== 'env') return false;

  // `env` dumps only when options and NAME=value assignments exhaust its
  // arguments. Once a child executable remains, it is an environment launcher.
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--') return index === words.length - 1;
    if (word === '-u' || word === '--unset') { index += 1; continue; }
    if (/^(?:-[i0]|--ignore-environment|--null|--unset=)/.test(word)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return false;
  }
  return true;
}

function looksLikeRawEnvDump(output) {
  if (typeof output !== 'string') return false;
  const lines = output.split(/(?:\0|\r?\n)/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const assignments = lines.filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line)).length;
  return assignments >= 3 && assignments / lines.length >= 0.6;
}

function allowlistedEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown';
  if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed') {
    return { type };
  }

  const itemType = typeof event?.item?.type === 'string' ? event.item.type : 'unknown';
  const item = { type: itemType };
  if (typeof event?.item?.id === 'string') item.id = event.item.id;

  if (itemType === 'command_execution') {
    if (type === 'item.completed' && (
      isRawEnvDumpCommand(event.item.command) ||
      hasSecretEnvReference(event.item.command) ||
      looksLikeRawEnvDump(event.item.aggregated_output)
    )) return null;
    if (typeof event.item.command === 'string') item.command = event.item.command;
    if (type === 'item.completed') {
      if (typeof event.item.aggregated_output === 'string') {
        item.aggregated_output = event.item.aggregated_output;
      }
      if (Number.isInteger(event.item.exit_code)) item.exit_code = event.item.exit_code;
      if (typeof event.item.status === 'string') item.status = event.item.status;
    }
  } else if (itemType === 'file_change') {
    if (typeof event.item.status === 'string') item.status = event.item.status;
    if (Array.isArray(event.item.changes)) {
      item.changes = event.item.changes.map(change => {
        const allowed = {};
        if (typeof change?.kind === 'string') allowed.kind = change.kind;
        if (typeof change?.path === 'string') allowed.path = change.path;
        if (typeof change?.diff === 'string') allowed.diff = change.diff;
        return allowed;
      });
    }
  } else if (['agent_message', 'reasoning', 'interstitial'].includes(itemType)) {
    if (typeof event.item.text === 'string') item.text = event.item.text;
    if (typeof event.item.summary === 'string') item.summary = event.item.summary;
  }

  return { type, item };
}

// Schema-skew fallback: keep identity plus a deliberately small set of
// human-readable diagnostic/answer fields. Values still pass through the
// shared redactor; arbitrary new object structure is never published.
function genericTextEvent(event) {
  const fallback = {
    type: typeof event?.type === 'string' ? event.type : 'unsupported-schema',
  };
  const textualKeys = new Set(['text', 'message', 'error', 'summary', 'detail', 'diagnostic', 'answer']);
  for (const [key, value] of Object.entries(event || {})) {
    if (textualKeys.has(key) && typeof value === 'string') fallback[key] = value;
  }
  if (event?.item && typeof event.item === 'object') {
    fallback.item = {};
    if (typeof event.item.type === 'string') fallback.item.type = event.item.type;
    if (typeof event.item.id === 'string') fallback.item.id = event.item.id;
    for (const [key, value] of Object.entries(event.item)) {
      if (textualKeys.has(key) && typeof value === 'string') fallback.item[key] = value;
    }
  }
  return fallback;
}

function redactStrings(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactStrings(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]),
    );
  }
  return value;
}

/**
 * Positive-allowlist and redact one untrusted Codex event before routing it.
 * Redactor failures are event-local: the raw event is discarded and the tail
 * remains active for later events.
 */
export function redactAndRoute(event, ctx) {
  if (!ctx || typeof ctx.redact !== 'function') {
    throw new TypeError('redactAndRoute requires a redactor');
  }
  const state = redactionState(ctx);
  let redactedEvent;
  let redactedMeta;
  try {
    const supportedSchema = schemaIsSupported(ctx.meta?.schemaVersion);
    const allowed = supportedSchema ? allowlistedEvent(event) : genericTextEvent(event);
    if (allowed === null) {
      state.redactionDropCount += 1;
      return state;
    }
    redactedEvent = redactStrings(allowed, ctx.redact);
    redactedMeta = {
      schemaVersion: typeof ctx.meta?.schemaVersion === 'string'
        ? ctx.redact(ctx.meta.schemaVersion)
        : null,
    };
    if (typeof ctx.meta?.model === 'string') redactedMeta.model = ctx.redact(ctx.meta.model);
  } catch (error) {
    state.redactionDropCount += 1;
    try {
      const kind = error instanceof Error ? error.name : typeof error;
      ctx.log?.warn?.(`[codex-event-format] publish redaction failed (${kind}); event dropped`);
    } catch { /* logging cannot interrupt the stream */ }
    return state;
  }
  return formatAndRoute(redactedEvent, { ...ctx, meta: redactedMeta, state });
}

// The Codex session's one status frame. Built through buildSessionStatus, and
// COMPLETE rather than a bare { model }: the journal's status replay cache is
// replace-not-merge, so whichever frame lands last is what a cold-starting
// client sees verbatim — a partial one here would strand it without the
// composer's argument lists. Codex states its own (empty) offer explicitly for
// the same reason journalStatus does: silence merges stickily, so a convo
// switched mid-session from Claude would keep rendering Claude's effort levels
// and a stale current level beside the Codex model.
function publishModelOnce(ctx, state) {
  if (state.modelPublished || typeof ctx.meta?.model !== 'string' || !ctx.meta.model) return;
  state.modelPublished = true;
  ctx.publisher.publishStatus?.(ctx.convoId, buildSessionStatus({
    model: ctx.meta.model,
    modelOptions: [],
    effortLevels: [],
    effort: null,
  }));
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

function publishEphemeralActivity(ctx, state, detail) {
  const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const interval = Number.isFinite(ctx.activityIntervalMs) && ctx.activityIntervalMs >= 0
    ? ctx.activityIntervalMs
    : DEFAULT_ACTIVITY_INTERVAL_MS;
  if (state.lastEphemeralActivityTs !== undefined &&
      now - state.lastEphemeralActivityTs < interval) {
    state.droppedActivityEvents = (state.droppedActivityEvents ?? 0) + 1;
    return false;
  }
  state.lastEphemeralActivityTs = now;
  ctx.publisher.publishActivity(ctx.convoId, 'thinking', detail);
  return true;
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

  if (['reasoning', 'interstitial'].includes(event?.item?.type)) {
    if (event?.type !== 'item.started' && event?.type !== 'item.completed') {
      state.unparsed += 1;
    }
    flushPendingAsActivity(ctx, state);
    publishEphemeralActivity(ctx, state, textOf(event.item));
    return state;
  }

  if (!schemaIsSupported(ctx.meta?.schemaVersion)) {
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
        const payload = { body: state.pendingAgentMessage, from: 'assistant' };
        ctx.retainFinalAnswer?.(ctx.runId, payload);
        // Socket-write completion is the publisher's delivery boundary. Until
        // then, keep a bounded copy available for idempotent reconnect repair.
        const publishOptions = {
          idemKey: `${ctx.runId}:final`,
          onDelivered: () => ctx.markFinalAnswerDelivered?.(ctx.runId),
        };
        const enqueued = ctx.publisher.publishText(
          ctx.convoId,
          payload,
          publishOptions,
        );
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

  flushPendingAsActivity(ctx, state);
  passThrough(event, ctx, state);
  return state;
}

export { DEFAULT_MAX_DURABLE_EVENTS, PINNED_CODEX_VERSION };
