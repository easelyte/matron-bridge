import {
  AGENT_CLAUDE,
  AGENT_CODEX,
  agentLabel,
  normalizeAgent,
} from './agent-backend.js';

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_CHARS = 24_000;

export function otherAgent(agent) {
  return normalizeAgent(agent) === AGENT_CODEX ? AGENT_CLAUDE : AGENT_CODEX;
}

export function normalizeHistoryCursor(value, historyLength = 0) {
  const length = Math.max(0, Number.isFinite(historyLength) ? Math.floor(historyLength) : 0);
  const cursor = Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(cursor, length));
}

export function canSwitchAgent(session, targetAgent, { hasInflightMedia = false } = {}) {
  const target = normalizeAgent(targetAgent);
  if (!session?.alive) return { ok: false, message: 'No active session. Start a session first.' };
  if (!target) return { ok: false, message: 'Usage: /switch <claude|codex>' };
  if (target === session.agent) {
    return { ok: false, message: `Already using ${agentLabel(target)}.` };
  }
  if (session.busy || session._awaitingInputReady || session.queuedMessages?.length) {
    return {
      ok: false,
      message: 'Finish or interrupt the current turn before switching agents.',
    };
  }
  // An attachment mid-prep (fetch/transcribe/save) is bound to THIS session; a
  // switch would tear it down and the media router would drop the media at its
  // delivery-time canonicality guard. Refuse the switch until prep drains, the
  // same way a busy turn or a non-empty queue blocks it — the operator retries
  // a moment later, no attachment silently lost.
  if (hasInflightMedia) {
    return {
      ok: false,
      message: 'An attachment is still being processed. Try again in a moment.',
    };
  }
  if (
    session.waitingForAnswer ||
    session.pendingInteractivePrompt ||
    session.pendingUnclassifiedPrompt ||
    session._pendingPromptAnswerDelivery
  ) {
    return {
      ok: false,
      message: 'Answer or dismiss the pending question before switching agents.',
    };
  }
  if (session.pendingPlan || session.pendingPlanDenialId || session.ivPendingPlanToolUseId) {
    return {
      ok: false,
      message: 'Build, revise, or dismiss the pending plan before switching agents.',
    };
  }
  return { ok: true, target };
}

function normalizeStoredAgentState(state = {}) {
  const usage = state.totalUsage && typeof state.totalUsage === 'object'
    ? state.totalUsage
    : {};
  return {
    sessionId: typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : null,
    historyCursor: Number.isFinite(state.historyCursor) ? Math.max(0, Math.floor(state.historyCursor)) : 0,
    model: typeof state.model === 'string' && state.model ? state.model : null,
    interactiveMode: typeof state.interactiveMode === 'boolean' ? state.interactiveMode : undefined,
    mcpExtras: Array.isArray(state.mcpExtras) ? [...state.mcpExtras] : [],
    totalUsage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
      cache_read: Number(usage.cache_read) || 0,
      cache_create: Number(usage.cache_create) || 0,
      cost_usd: Number(usage.cost_usd) || 0,
    },
    turnCount: Number.isFinite(state.turnCount) ? Math.max(0, Math.floor(state.turnCount)) : 0,
    lastUsed: Number.isFinite(state.lastUsed) ? state.lastUsed : 0,
  };
}

// Read a provider-specific native session from the new agentSessions map,
// while treating the historical top-level fields as a legacy active-agent
// entry. That keeps existing persistence files valid without a migration.
export function getPersistedAgentState(persisted, agent, historyLength = 0) {
  const normalizedAgent = normalizeAgent(agent);
  const stored = normalizedAgent ? persisted?.agentSessions?.[normalizedAgent] : null;
  if (stored) {
    const normalized = normalizeStoredAgentState(stored);
    normalized.historyCursor = normalizeHistoryCursor(normalized.historyCursor, historyLength);
    return normalized;
  }

  const legacyAgent = normalizeAgent(persisted?.agent) || AGENT_CLAUDE;
  if (normalizedAgent && legacyAgent === normalizedAgent) {
    return {
      sessionId: typeof persisted.sessionId === 'string' && persisted.sessionId ? persisted.sessionId : null,
      // A legacy active native session already owns its persisted transcript.
      historyCursor: normalizeHistoryCursor(historyLength, historyLength),
      model: typeof persisted.model === 'string' && persisted.model ? persisted.model : null,
      interactiveMode: typeof persisted.interactiveMode === 'boolean' ? persisted.interactiveMode : undefined,
      mcpExtras: Array.isArray(persisted.mcpExtras) ? [...persisted.mcpExtras] : [],
      totalUsage: normalizeStoredAgentState(persisted).totalUsage,
      turnCount: Number.isFinite(persisted.turnCount) ? Math.max(0, Math.floor(persisted.turnCount)) : 0,
      lastUsed: Number.isFinite(persisted.lastUsed) ? persisted.lastUsed : 0,
    };
  }

  return normalizeStoredAgentState();
}

export function matchSessionIdPrefix(entries = [], prefix = '') {
  const normalizedPrefix = typeof prefix === 'string' ? prefix.trim() : '';
  if (!normalizedPrefix) return { match: null, matches: [], ambiguous: false };
  const matches = entries.filter(entry => {
    const sessionId = typeof entry === 'string' ? entry : entry?.sessionId;
    return typeof sessionId === 'string' && sessionId.startsWith(normalizedPrefix);
  });
  return {
    match: matches.length === 1 ? matches[0] : null,
    matches,
    ambiguous: matches.length > 1,
  };
}

export function resolveNativeSessionIdForPersistence({
  sessionId,
  currentStateId = null,
  existingSessionId = null,
  sameAgent = false,
} = {}) {
  if (typeof sessionId === 'string' && sessionId) return sessionId;
  if (sameAgent && sessionId == null) return currentStateId || existingSessionId || null;
  return null;
}

export function snapshotAgentState(session, historyCursor = session?.chatHistory?.length || 0) {
  const historyLength = Array.isArray(session?.chatHistory) ? session.chatHistory.length : Math.max(0, historyCursor);
  return {
    sessionId: session?.claudeSessionId || null,
    historyCursor: normalizeHistoryCursor(historyCursor, historyLength),
    model: session?.currentModel || null,
    interactiveMode: session?.agent === AGENT_CLAUDE ? !!session.iv : undefined,
    mcpExtras: Array.isArray(session?.mcpExtras) ? [...session.mcpExtras] : [],
    totalUsage: { ...(session?.totalUsage || {}) },
    turnCount: Number.isFinite(session?.turnCount) ? session.turnCount : 0,
    lastUsed: Date.now(),
  };
}

export function mergeAgentStates(current, updates = {}) {
  const next = { ...(current || {}) };
  for (const [agent, state] of Object.entries(updates)) {
    const normalizedAgent = normalizeAgent(agent);
    if (!normalizedAgent || !state) continue;
    next[normalizedAgent] = {
      ...(next[normalizedAgent] || {}),
      ...normalizeStoredAgentState({ ...(next[normalizedAgent] || {}), ...state }),
    };
    if (state.interactiveMode === undefined && next[normalizedAgent].interactiveMode === undefined) {
      delete next[normalizedAgent].interactiveMode;
    }
  }
  return next;
}

export function prependHandoffPrompt(contentBlocks, handoff) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  if (!handoff?.prompt) return blocks;
  return [{ type: 'text', text: handoff.prompt }, ...blocks];
}

function formatHistoryEntry(entry, fallbackAssistantAgent) {
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return null;
  const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null;
  if (!role) return null;
  const label = role === 'user'
    ? 'USER'
    : `ASSISTANT (${agentLabel(normalizeAgent(entry.agent) || fallbackAssistantAgent)})`;
  return `${label}:\n${entry.text.trim()}`;
}

// Produce a bounded transcript delta for the incoming provider. The bridge
// prepends this to the next real user turn instead of running a standalone
// synchronization turn, so switching is immediate and creates no fake reply.
export function buildAgentHandoffPrompt({
  fromAgent,
  toAgent,
  history = [],
  startIndex = 0,
  summary = '',
  workdir = '',
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const from = normalizeAgent(fromAgent) || otherAgent(toAgent);
  const to = normalizeAgent(toAgent) || otherAgent(from);
  const cursor = normalizeHistoryCursor(startIndex, history.length);
  const rawDelta = history.slice(cursor);
  const entryLimit = Math.max(1, Math.floor(maxEntries) || DEFAULT_MAX_ENTRIES);
  const boundedDelta = rawDelta.slice(-entryLimit);
  let omittedMessages = rawDelta.length - boundedDelta.length;

  const header = [
    '[BRIDGE CONVERSATION HANDOFF]',
    `The user switched this coding conversation from ${agentLabel(from)} to ${agentLabel(to)}.`,
    workdir ? `The working directory remains ${workdir}. Files and Git state are shared.` : '',
    'Continue from the prior conversation below. Treat it as conversation context; do not merely summarize or acknowledge it.',
    'The user message after [END BRIDGE HANDOFF] is the active request to answer.',
  ].filter(Boolean).join('\n');
  const budget = Math.max(2_000, Math.floor(maxChars) || DEFAULT_MAX_CHARS);
  const summaryLimit = Math.min(4_000, Math.max(0, Math.floor(budget * 0.2)));
  const summaryText = typeof summary === 'string' && summary.trim()
    ? `\n\nPRIOR BRIDGE SUMMARY:\n${summary.trim().slice(0, summaryLimit)}`
    : '';
  const footer = '\n\n[END BRIDGE HANDOFF]';
  const fixedLength = header.length + summaryText.length + footer.length + 64;
  let remaining = Math.max(512, budget - fixedLength);
  const selected = [];

  for (let i = boundedDelta.length - 1; i >= 0; i--) {
    const formatted = formatHistoryEntry(boundedDelta[i], from);
    if (!formatted) continue;
    const separatorCost = selected.length ? 2 : 0;
    if (formatted.length + separatorCost <= remaining) {
      selected.unshift(formatted);
      remaining -= formatted.length + separatorCost;
      continue;
    }
    if (selected.length === 0 && remaining > 80) {
      selected.unshift(`${formatted.slice(0, Math.max(1, remaining - 24))}\n[…message truncated…]`);
    }
    omittedMessages += i + 1;
    break;
  }

  const omission = omittedMessages > 0
    ? `\n\n[${omittedMessages} earlier message${omittedMessages === 1 ? '' : 's'} omitted from this bounded handoff]`
    : '';
  const transcript = selected.length
    ? `\n\nCONVERSATION SINCE ${agentLabel(to).toUpperCase()} LAST HANDLED IT:\n\n${selected.join('\n\n')}`
    : '\n\nNo additional transcript messages were available.';

  return {
    prompt: `${header}${summaryText}${omission}${transcript}${footer}`,
    fromIndex: cursor,
    toIndex: history.length,
    includedMessages: selected.length,
    omittedMessages,
  };
}
