import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getPersistedAgentState, normalizeHistoryCursor } from '../lib/agent-handoff.js';

// Execute the real helpers without importing index.js's sockets and services.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function helper(name, dependencies) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  const end = source.indexOf('\n}\n', match.index) + 2;
  return vm.runInNewContext(`(${source.slice(match.index, end)})`, dependencies);
}

describe('Codex telemetry lifecycle', () => {
  it('forces a final read after an in-flight poll without double-counting', async () => {
    let release;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ usage: { input_tokens: 12000 } });
    const session = { alive: true, roomId: 'room', claudeSessionId: 'thread' };
    const journalStatus = vi.fn();
    const refresh = helper('refreshCodexTelemetry', {
      codexTelemetryReader: { read }, sessions: new Map([['room', session]]), journalStatus,
    });
    const poll = refresh(session);
    const finish = refresh(session, { force: true });
    release({ usage: { input_tokens: 10000 }, context: { tokens: 1000, window: 258400 } });
    await Promise.all([poll, finish]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(session._codexNativeUsage.input_tokens).toBe(12000);
    expect(session._lastContextTokens).toBe(1000);
    expect(session._codexContextWindow).toBe(258400);
    expect(session._codexTelemetryInflight).toBeNull();
  });

  it('drops telemetry arriving after a provider/session replacement', async () => {
    let release;
    const session = { alive: true, roomId: 'room', claudeSessionId: 'thread' };
    const sessions = new Map([['room', session]]);
    const journalStatus = vi.fn();
    const refresh = helper('refreshCodexTelemetry', {
      codexTelemetryReader: { read: () => new Promise(resolve => { release = resolve; }) }, sessions, journalStatus,
    });
    const pending = refresh(session);
    sessions.set('room', { agent: 'claude' });
    release({ usage: { input_tokens: 12000 } });
    await pending;
    expect(session._codexNativeUsage).toBeUndefined();
    expect(journalStatus).not.toHaveBeenCalled();
  });

  it('restores effort when resuming into a new room from inherited provider state', () => {
    const hydrate = helper('hydrateAgentState', {
      AGENT_CODEX: 'codex', otherAgent: () => 'claude', getPersistedAgentState, normalizeHistoryCursor,
    });
    const session = { agent: 'codex', codex: { effort: null }, chatHistory: [], totalUsage: {} };
    hydrate(session, { agentSessions: { codex: { sessionId: 'thread', effort: 'high', totalUsage: { input_tokens: 8000 } } } });
    expect(session.codex.effort).toBe('high');
    expect(session.totalUsage.input_tokens).toBe(8000);
  });
});
