import { buildSessionStatus } from './session-status.js';

const PINNED_CODEX_VERSION = '0.146.0';
// The allowlisted item schema (command_execution, agent_message, file_change,
// reasoning, and the lifecycle events) stabilized at 0.146.0 and has been stable
// across every codex-cli release since. Rendering is now VERSION-TOLERANT: it
// keys on the event SHAPE (item type + envelope), not an upper version band, so
// a new codex major no longer needs a manual band bump. There is only a FLOOR
// (MIN_SUPPORTED_CODEX_VERSION) — the release where the hardened schema landed;
// anything at or above it renders richly through the positive allowlist, and
// anything below it (or a malformed/absent version string) still fails safe to
// the text-passthrough fallback (raw JSON, never a redaction bypass).
//
// SECURITY — guards-first, loop #762: this open-ended routing is only safe
// because the env-dump / secret-reference guards in allowlistedEvent run
// UNCONDITIONALLY for command_execution across EVERY envelope (item.started,
// item.completed, item.delta, and any unknown/newer type) and across EVERY
// output-carrying field (command, aggregated_output, and the output aliases in
// COMMAND_OUTPUT_FIELDS). The guards are gated on the item SHAPE, never the
// envelope. A previous attempt to generalize routing while leaving the guards
// gated on item.completed reopened a secret-egress hole 3-4 times (env dumps
// streamed under item.delta leaked via output/message/text under innocuous env
// names the baseline redactor cannot catch); that ordering is now inverted.
const MIN_SUPPORTED_CODEX_VERSION = [0, 146, 0];
const DEFAULT_MAX_DURABLE_EVENTS = 200;
const DEFAULT_ACTIVITY_INTERVAL_MS = 250;
const SECRET_ENV_NAME_RE = /(?:^|_)(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIALS?|AUTH(?:ORIZATION)?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)(?:$|_)/i;

// Every field a command_execution item may carry raw command OUTPUT in, across
// codex-cli envelopes: item.completed uses aggregated_output; streaming/delta
// and newer/unknown envelopes have used output/message/text/delta/stdout/stderr.
// ALL are treated as untrusted output for the env-dump guard, so a raw env dump
// can never egress no matter which alias a future codex version streams it in.
const COMMAND_OUTPUT_FIELDS = ['aggregated_output', 'output', 'message', 'text', 'delta', 'chunk', 'stdout', 'stderr'];

// Human-readable diagnostic/answer fields kept (redacted) when an event or item
// has no richer allowlisted shape — e.g. a top-level `{type:'error', message}`
// or a newer codex-cli item type. Never structural/unknown object fields.
const SAFE_TEXTUAL_KEYS = ['text', 'message', 'error', 'summary', 'detail', 'diagnostic', 'answer'];

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

// True when the run's producer version is at or above the hardened-schema
// floor. There is no upper bound: rendering is version-tolerant and keys on
// event shape, so a newer codex major renders richly without a manual band
// bump. Malformed/absent identifiers or versions below the floor return false
// and fail safe to the generic text-passthrough path (never throws on
// untrusted meta).
function schemaIsSupported(schemaVersion) {
  const parsed = parseCodexSchemaVersion(schemaVersion);
  if (parsed === null) return false;
  return compareVersions(parsed, MIN_SUPPORTED_CODEX_VERSION) >= 0;
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
  // Environment names are case-sensitive and may be lowercase/mixed-case (POSIX
  // permits it and shells honor it), so classify assignments under ANY casing —
  // an uppercase-only regex let lowercase dumps bypass the guard (loop #762 F2).
  const assignments = lines.filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).length;
  return assignments >= 3 && assignments / lines.length >= 0.6;
}

// Every output-carrying string a command_execution item exposes, across all its
// field aliases. Fed to the env-dump guard so a raw dump is caught no matter
// which alias a codex-cli version streams it in.
function commandOutputStrings(item) {
  const values = [];
  for (const field of COMMAND_OUTPUT_FIELDS) {
    const value = item?.[field];
    if (typeof value === 'string') values.push(value);
  }
  return values;
}

// Copy human-readable diagnostic fields from an untrusted source onto target
// (they are redacted downstream). Returns false when ANY such field looks like
// a raw env dump — the caller then drops the whole event, so a dump can never
// egress via a textual field on a top-level error or a newer/unknown item type.
function copySafeTextualFields(source, target) {
  if (!source || typeof source !== 'object') return true;
  for (const key of SAFE_TEXTUAL_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    if (looksLikeRawEnvDump(value)) return false;
    target[key] = value;
  }
  return true;
}

function allowlistedEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown';
  if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed') {
    return { type };
  }

  const allowed = { type };
  // Top-level textual diagnostics (e.g. a fatal `{type:'error', message}`)
  // survive redaction instead of being silently dropped by the item filter.
  if (!copySafeTextualFields(event, allowed)) return null;

  // Only events that actually carry an item get an item envelope; a bare
  // top-level event (error/notice) keeps rendering as its own message rather
  // than an empty { type:'unknown' } stub.
  if (event?.item && typeof event.item === 'object') {
    const itemType = typeof event.item.type === 'string' ? event.item.type : 'unknown';
    const item = { type: itemType };
    if (typeof event.item.id === 'string') item.id = event.item.id;

    if (itemType === 'command_execution') {
      // GUARDS-FIRST (loop #762): drop the whole event when the command is an
      // env dump / references a secret env var, OR when ANY output-carrying
      // field (aggregated_output or an alias in COMMAND_OUTPUT_FIELDS) looks
      // like a raw env dump. This runs for EVERY envelope
      // (item.started/completed/delta/unknown) because the extraction below is
      // unconditional too — gating the guard on item.completed while extracting
      // under other envelopes is exactly the egress hole this change closes.
      const command = event.item.command;
      if (
        isRawEnvDumpCommand(command) ||
        hasSecretEnvReference(command) ||
        commandOutputStrings(event.item).some(value => looksLikeRawEnvDump(value))
      ) return null;
      if (typeof command === 'string') item.command = command;
      // Output is FORWARDED only on the terminal item.completed envelope, where
      // codex has aggregated the full output. Non-completed envelopes
      // (started/delta/unknown) carry the command as an activity indicator only
      // — never streamed output — so a chunked env dump cannot leak its early
      // chunks below the classifier threshold before a later chunk trips the
      // guard (the guard above still scans output on EVERY envelope, so a full
      // dump under any envelope is dropped outright). See loop #762 F1.
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
          const allowedChange = {};
          if (typeof change?.kind === 'string') allowedChange.kind = change.kind;
          if (typeof change?.path === 'string') allowedChange.path = change.path;
          if (typeof change?.diff === 'string') allowedChange.diff = change.diff;
          return allowedChange;
        });
      }
    } else if (['agent_message', 'reasoning', 'interstitial'].includes(itemType)) {
      if (typeof event.item.text === 'string') item.text = event.item.text;
      if (typeof event.item.summary === 'string') item.summary = event.item.summary;
    } else if (!copySafeTextualFields(event.item, item)) {
      // Unknown/future item type: keep its safe textual diagnostics (redacted)
      // so a newer codex-cli renders its human-readable fields instead of an
      // opaque { type } stub — but drop the event if one is a raw env dump. It
      // never forwards command/output structural fields.
      return null;
    }

    allowed.item = item;
  }

  return allowed;
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

// Emit the run's final answer as the durable "final" post. Shared by the pinned
// turn.completed path and the schema-skew fallback so a newer/unknown codex-cli
// version still lands the completed-review message instead of silently dropping
// it. Idempotent on runId (stable `${runId}:final` idemKey); sets
// finalPostProduced only when the publisher accepts the enqueue.
function emitDurableFinalAnswer(ctx, state) {
  if (state.pendingAgentMessage == null) return;
  if (typeof ctx.runId === 'string' && ctx.runId.length > 0) {
    // The final answer is the run's durable result, not an intermediate
    // event. It must survive even when intermediate posts exhaust the cap.
    state.durableEvents += 1;
    const payload = { body: state.pendingAgentMessage, from: 'assistant' };
    ctx.retainFinalAnswer?.(ctx.runId, payload);
    // Socket-write completion is the publisher's delivery boundary. Until
    // then, keep a bounded copy available for idempotent reconnect repair.
    const enqueued = ctx.publisher.publishText(ctx.convoId, payload, {
      idemKey: `${ctx.runId}:final`,
      onDelivered: () => ctx.markFinalAnswerDelivered?.(ctx.runId),
    });
    if (enqueued === true) state.finalPostProduced = true;
  } else if (!state.finalRunIdWarningLogged) {
    state.finalRunIdWarningLogged = true;
    try {
      ctx.log?.warn?.('[codex-event-format] missing runId; skipping durable final answer');
    } catch { /* logging cannot interrupt the stream */ }
  }
  state.pendingAgentMessage = null;
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
    // Fail safe, not silent: even under an unrecognized/newer codex-cli the
    // run's final answer must still land as the durable final post. The
    // lifecycle event types (agent_message completion, turn.completed) have been
    // stable across the codex-cli line, so capture the answer and emit it with
    // the same idem/retain semantics as the pinned path. Every other event
    // stays a raw text dump — richer per-item rendering needs a schema pin.
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
      state.pendingAgentMessage = textOf(event.item);
      return state;
    }
    if (event?.type === 'turn.completed') {
      emitDurableFinalAnswer(ctx, state);
      state.terminalSeen = true;
      ctx.publisher.publishActivity(ctx.convoId, 'idle');
      return state;
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
    emitDurableFinalAnswer(ctx, state);
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
