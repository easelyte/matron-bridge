import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTelemetryReader, codexUsageFor, parseCodexTelemetry } from '../lib/codex-telemetry.js';
import { buildSessionStatus } from '../lib/session-status.js';
import { buildCodexExecArgs } from '../lib/codex-session.js';
import { getPersistedAgentState, mergeAgentStates, snapshotAgentState } from '../lib/agent-handoff.js';

const uuid = '01991426-5f00-7000-8000-000000000001';
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const tokenEvent = (input, context = 1000) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: 6000, output_tokens: 300, reasoning_output_tokens: 100 },
  last_token_usage: { input_tokens: context, cached_input_tokens: 800, output_tokens: 50 },
  model_context_window: 258400,
} } });
const jsonl = (...events) => events.map(e => JSON.stringify(e) + '\n').join('');

describe('Codex native telemetry', () => {
  it('uses the latest absolute totals, separates context, and never adds cached/reasoning subsets', () => {
    const event = tokenEvent(10000);
    const result = parseCodexTelemetry('partial record\n' + jsonl(tokenEvent(8000), event, event));
    expect(result.usage).toMatchObject({ input_tokens: 10000, output_tokens: 300, cache_read: 6000, reasoning_tokens: 100 });
    expect(result.context).toEqual({ tokens: 1000, window: 258400 });
    expect(codexUsageFor({ _codexNativeUsage: result.usage, totalUsage: { input_tokens: 3 } }).input_tokens).toBe(10000);
  });

  it('accepts post-compaction decreases and ignores malformed/missing data', () => {
    const result = parseCodexTelemetry(jsonl(tokenEvent(8000, 5000), tokenEvent(10000, 1200), { type: 'event_msg', payload: { type: 'token_count', info: null } }));
    expect(result.context.tokens).toBe(1200);
    expect(parseCodexTelemetry(jsonl({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: -1 } } } }))).toEqual({});
  });

  it('reads the matching native thread, ignores incomplete writes, and finds archived sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-'));
    roots.push(root);
    const dir = path.join(root, 'sessions', '2026', '09', '05');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-05-${uuid}.jsonl`);
    await fs.writeFile(file, jsonl(tokenEvent(10000)) + JSON.stringify(tokenEvent(12000)));
    const reader = new CodexTelemetryReader({ codexHome: root });
    expect((await reader.read(uuid)).usage.input_tokens).toBe(10000);
    await fs.appendFile(file, '\n');
    expect((await reader.read(uuid)).usage.input_tokens).toBe(12000);
    await fs.mkdir(path.join(root, 'archived_sessions'));
    await fs.rename(file, path.join(root, 'archived_sessions', path.basename(file)));
    expect(await reader.read(uuid)).toEqual({}); // invalidates the old path
    expect((await reader.read(uuid)).usage.input_tokens).toBe(12000);
    expect(await reader.read('../../auth')).toEqual({});
  });

  it('uses the actual Codex window and suppresses an unknown window', () => {
    expect(buildSessionStatus({ model: 'gpt-test', contextTokens: 129200, contextWindow: 258400 }).context)
      .toEqual({ tokens: 129200, window: 258400, pct: 50 });
    expect(buildSessionStatus({ model: 'gpt-test', contextTokens: 1000, contextWindow: null })).not.toHaveProperty('context');
  });

  it('persists provider-local effort and passes it on initial and resumed turns', () => {
    const state = snapshotAgentState({ agent: 'codex', codex: { model: null, effort: 'high' }, currentModel: 'observed-model' });
    const agentSessions = mergeAgentStates({}, { codex: state });
    expect(getPersistedAgentState({ agentSessions }, 'codex')).toMatchObject({ model: null, effort: 'high' });
    for (const threadId of [null, uuid]) {
      expect(buildCodexExecArgs({ threadId, effort: 'high' })).toContain('model_reasoning_effort="high"');
      expect(buildCodexExecArgs({ threadId, effort: null }).join(' ')).not.toContain('model_reasoning_effort');
    }
  });
});
