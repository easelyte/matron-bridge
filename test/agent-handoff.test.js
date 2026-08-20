import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  buildAgentHandoffPrompt,
  canSwitchAgent,
  getPersistedAgentState,
  matchSessionIdPrefix,
  mergeAgentStates,
  normalizeHistoryCursor,
  prependHandoffPrompt,
  resolveNativeSessionIdForPersistence,
  snapshotAgentState,
} from '../lib/agent-handoff.js';

describe('canSwitchAgent', () => {
  const idleClaude = { alive: true, agent: 'claude', busy: false };

  it('allows an idle provider handoff', () => {
    expect(canSwitchAgent(idleClaude, 'codex')).toEqual({ ok: true, target: 'codex' });
  });

  it('rejects the active provider and unknown providers', () => {
    expect(canSwitchAgent(idleClaude, 'claude').message).toContain('Already using Claude');
    expect(canSwitchAgent(idleClaude, 'gemini').message).toContain('/switch');
  });

  it('blocks turns, queues, prompts, and plans', () => {
    expect(canSwitchAgent({ ...idleClaude, busy: true }, 'codex').ok).toBe(false);
    expect(canSwitchAgent({ ...idleClaude, queuedMessages: [{}] }, 'codex').ok).toBe(false);
    expect(canSwitchAgent({ ...idleClaude, waitingForAnswer: {} }, 'codex').message).toContain('pending question');
    expect(canSwitchAgent({ ...idleClaude, _pendingPromptAnswerDelivery: true }, 'codex').message).toContain('pending question');
    expect(canSwitchAgent({ ...idleClaude, pendingPlan: 'plan' }, 'codex').message).toContain('pending plan');
  });

  it('blocks a switch while an attachment is still being prepared (in-flight media drain)', () => {
    // A /switch can otherwise proceed while journal-media prep (fetch /
    // transcribe / save-to-disk) is still running for this conversation. The
    // switch tears the old session down, the router's canonicality guard then
    // drops the in-flight attachment — the media is silently lost from the
    // user's perspective. Gate the switch on in-flight media the same way it
    // gates on a busy turn or a non-empty queue, so the operator retries once
    // prep has drained.
    const res = canSwitchAgent(idleClaude, 'codex', { hasInflightMedia: true });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/attachment/i);
    // The default (no in-flight media) must not regress the idle handoff.
    expect(canSwitchAgent(idleClaude, 'codex', { hasInflightMedia: false })).toEqual({ ok: true, target: 'codex' });
  });
});

describe('agent handoff persistence', () => {
  it('reads legacy active-agent fields without requiring a migration', () => {
    const state = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
      lastUsed: 12,
    }, 'claude', 8);

    expect(state).toEqual({
      sessionId: 'claude-1',
      historyCursor: 8,
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
      lastUsed: 12,
    });
  });

  it('treats pre-agent persistence entries as Claude sessions', () => {
    expect(getPersistedAgentState({ sessionId: 'legacy-claude' }, 'claude', 0).sessionId)
      .toBe('legacy-claude');
    expect(getPersistedAgentState({ sessionId: 'legacy-claude' }, 'codex', 0).sessionId)
      .toBeNull();
  });

  it('prefers provider-specific state and clamps its cursor', () => {
    const state = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      agentSessions: {
        codex: { sessionId: 'codex-1', historyCursor: 99, model: 'gpt-test' },
      },
    }, 'codex', 4);

    expect(state.sessionId).toBe('codex-1');
    expect(state.historyCursor).toBe(4);
    expect(state.model).toBe('gpt-test');
  });

  it('does not leak the active provider model into a fresh target provider', () => {
    const codex = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      model: 'sonnet',
    }, 'codex', 2);

    expect(codex.sessionId).toBeNull();
    expect(codex.model).toBeNull();
    expect(codex.historyCursor).toBe(0);
  });

  it('snapshots and merges native state independently', () => {
    const claude = snapshotAgentState({
      agent: 'claude',
      claudeSessionId: 'c1',
      currentModel: 'sonnet',
      iv: {},
      mcpExtras: ['browser'],
      chatHistory: [{}, {}, {}],
    });
    const merged = mergeAgentStates({ codex: { sessionId: 'x1', historyCursor: 1 } }, { claude });

    expect(merged.codex.sessionId).toBe('x1');
    expect(merged.claude).toMatchObject({
      sessionId: 'c1',
      historyCursor: 3,
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
    });
  });

  it('normalizes invalid cursors', () => {
    expect(normalizeHistoryCursor(-5, 3)).toBe(0);
    expect(normalizeHistoryCursor(9, 3)).toBe(3);
    expect(normalizeHistoryCursor(undefined, 3)).toBe(0);
  });
});

describe('matchSessionIdPrefix', () => {
  it('returns one exact candidate from session objects or string IDs', () => {
    expect(matchSessionIdPrefix([
      { sessionId: 'claude-123' },
      { sessionId: 'claude-456' },
    ], 'claude-1')).toMatchObject({
      match: { sessionId: 'claude-123' },
      ambiguous: false,
    });
    expect(matchSessionIdPrefix(['codex-123'], 'codex').match).toBe('codex-123');
  });

  it('marks non-unique prefixes as ambiguous instead of choosing one', () => {
    const result = matchSessionIdPrefix(['shared-1', 'shared-2'], 'shared');
    expect(result.match).toBeNull();
    expect(result.matches).toEqual(['shared-1', 'shared-2']);
    expect(result.ambiguous).toBe(true);
  });
});

describe('resolveNativeSessionIdForPersistence', () => {
  it('preserves an established same-provider ID while a fresh process has not announced one', () => {
    expect(resolveNativeSessionIdForPersistence({
      sessionId: null,
      currentStateId: 'codex-existing',
      existingSessionId: 'legacy-existing',
      sameAgent: true,
    })).toBe('codex-existing');
  });

  it('keeps null when switching to a genuinely fresh provider', () => {
    expect(resolveNativeSessionIdForPersistence({
      sessionId: null,
      currentStateId: 'claude-outgoing',
      existingSessionId: 'claude-outgoing',
      sameAgent: false,
    })).toBeNull();
  });

  it('always accepts a newly announced native ID', () => {
    expect(resolveNativeSessionIdForPersistence({
      sessionId: 'codex-new',
      currentStateId: 'codex-old',
      sameAgent: true,
    })).toBe('codex-new');
  });
});

describe('buildAgentHandoffPrompt', () => {
  it('labels providers and includes only the unseen transcript delta', () => {
    const result = buildAgentHandoffPrompt({
      fromAgent: 'claude',
      toAgent: 'codex',
      workdir: '/repo',
      history: [
        { role: 'user', text: 'already known' },
        { role: 'assistant', agent: 'claude', text: 'implemented the parser' },
        { role: 'user', text: 'now add tests' },
      ],
      startIndex: 1,
    });

    expect(result.fromIndex).toBe(1);
    expect(result.toIndex).toBe(3);
    expect(result.prompt).not.toContain('already known');
    expect(result.prompt).toContain('Claude Code to Codex');
    expect(result.prompt).toContain('ASSISTANT (Claude Code):\nimplemented the parser');
    expect(result.prompt).toContain('USER:\nnow add tests');
    expect(result.prompt).toContain('/repo');
  });

  it('prepends context without mutating the real user blocks', () => {
    const userBlocks = [{ type: 'text', text: 'fix the tests' }];
    const result = prependHandoffPrompt(userBlocks, { prompt: 'prior context' });

    expect(result).toEqual([
      { type: 'text', text: 'prior context' },
      { type: 'text', text: 'fix the tests' },
    ]);
    expect(userBlocks).toEqual([{ type: 'text', text: 'fix the tests' }]);
  });

  it('bounds long handoffs from the oldest side', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ role: 'user', text: `message-${i}` }));
    const result = buildAgentHandoffPrompt({
      fromAgent: 'codex',
      toAgent: 'claude',
      history,
      maxEntries: 3,
      maxChars: 2_000,
    });

    expect(result.prompt).not.toContain('message-4');
    expect(result.prompt).toContain('message-5');
    expect(result.prompt).toContain('message-7');
    expect(result.omittedMessages).toBe(5);
  });
});

// switchAgentSession lives in index.js and leans on module-scope session state,
// so it can't be imported. Pin the queue-carry wiring (#537) by source
// inspection, matching the index.js-inspection tests in busy-queue.test.js.
describe('index.js switchAgentSession — queued-message carry (source inspection)', () => {
  it('carries queuedMessages + queueNotifications into the replacement agent session', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('async function switchAgentSession(');
    expect(start).toBeGreaterThan(-1);
    // Function closes at the first brace in column 0 after the declaration.
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    // Without these an !agent Claude<->Codex switch silently orphaned any
    // queued user input (recreateSession carried it, switchAgentSession did not).
    expect(body).toMatch(/next\.queuedMessages = existing\.queuedMessages/);
    expect(body).toMatch(/next\.queueNotifications = existing\.queueNotifications/);
  });
});
