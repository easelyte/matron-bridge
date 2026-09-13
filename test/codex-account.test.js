import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { codexLimitLines, codexSessionOptions, createCodexAccountReader, withCodexAppServer } from '../lib/codex-account.js';
import { handlePickerValue } from '../lib/picker-dispatch.js';

const models = [{ model: 'gpt-test', displayName: 'Test model', isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];

function fakeServer(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  const messages = [];
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id && message.method) queueMicrotask(() => handler(message, child));
    }
  });
  return { child, messages, spawnImpl: vi.fn(() => child) };
}

describe('Codex account stdio transport', () => {
  it('initializes before queries, correlates out-of-order split replies, and closes the child', async () => {
    const harness = fakeServer((message, child) => {
      const result = { id: message.id, result: { method: message.method } };
      if (message.method === 'initialize') child.stdout.write(JSON.stringify(result) + '\n');
      if (message.method === 'model/list') {
        setTimeout(() => child.stdout.write(JSON.stringify(result) + '\n'), 5);
      }
      if (message.method === 'account/rateLimits/read') {
        const text = JSON.stringify(result);
        child.stdout.write(text.slice(0, 12));
        child.stdout.write(text.slice(12) + '\n');
      }
    });
    const results = await withCodexAppServer(request => Promise.all([
      request('model/list'), request('account/rateLimits/read'),
    ]), harness);
    expect(results.map(r => r.method)).toEqual(['model/list', 'account/rateLimits/read']);
    expect(harness.messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'model/list', 'account/rateLimits/read']);
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(harness.spawnImpl.mock.calls[0][1]).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('rejects a hung server within the timeout', async () => {
    const harness = fakeServer(() => {});
    await expect(withCodexAppServer(() => {}, { ...harness, timeoutMs: 10 })).rejects.toThrow('timed out');
    expect(harness.child.kill).toHaveBeenCalled();
  });

  it('does not leak server error data or diagnostics', async () => {
    const harness = fakeServer((message, child) => {
      child.stderr.write('private account diagnostic');
      child.stdout.write(JSON.stringify({ id: message.id, error: { message: 'private account diagnostic' } }) + '\n');
    });
    await expect(withCodexAppServer(() => {}, harness)).rejects.toThrow('Check CLI login');
  });

  it('rejects early process exit instead of hanging', async () => {
    const harness = fakeServer((_message, child) => child.emit('close', 1));
    await expect(withCodexAppServer(() => {}, harness)).rejects.toThrow('exited before responding');
  });
});

describe('Codex account metadata', () => {
  it('uses all quota buckets, real durations, zero usage, and seconds-based resets', () => {
    const rateLimits = { primary: { usedPercent: 99, windowDurationMins: 300 } };
    const lines = codexLimitLines({ rateLimits, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1789230818 }, secondary: null },
      special: { limitName: 'Special', primary: { usedPercent: 25, windowDurationMins: 300 } },
    } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'codex:codex:primary', label: 'Codex · Weekly', percent: 0, resets_at: '2026-09-12T16:33:38.000Z' });
    expect(lines[1]).toMatchObject({ label: 'Special · 5-hour', percent: 25 });
    expect(lines[1]).not.toHaveProperty('resets_at');
    expect(codexLimitLines({ rateLimits })[0].percent).toBe(99);
    expect(codexLimitLines({ rateLimits: { primary: { usedPercent: 24.75 } } })[0].percent).toBe(25);
    expect(codexLimitLines({ rateLimits: { primary: { usedPercent: null } } })).toEqual([]);
  });

  it('paginates models, coalesces reads, resolves project config, and isolates account failures', async () => {
    const request = vi.fn(async (method, params) => {
      if (method === 'model/list') return params.cursor ? { data: [{ model: 'gpt-other' }], nextCursor: null } : { data: models, nextCursor: 'next' };
      if (method === 'config/read') return { config: { model: 'gpt-test', model_reasoning_effort: 'high', privateSetting: 'must not escape' } };
      throw new Error('No subscription data');
    });
    const query = vi.fn(callback => callback(request));
    const reader = createCodexAccountReader({ query });
    const [first, second] = await Promise.all([reader.read('/repo'), reader.read('/repo')]);
    expect(first).toBe(second);
    expect(query).toHaveBeenCalledTimes(1);
    expect(first.models).toHaveLength(2);
    expect(first.model).toBe('gpt-test');
    expect(first.effort).toBe('high');
    expect(first.limitsError).toBe('No subscription data');
    expect(JSON.stringify(first)).not.toContain('must not escape');
    expect(request).toHaveBeenCalledWith('config/read', { cwd: '/repo', includeLayers: false });
    await reader.read('/repo');
    expect(query).toHaveBeenCalledTimes(1);
    await reader.read('/repo', { force: true });
    expect(query).toHaveBeenCalledTimes(2);
    await reader.read('/other');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('caches failures briefly and retries after expiry', async () => {
    let now = 100;
    const query = vi.fn(async () => { throw new Error('private diagnostic'); });
    const reader = createCodexAccountReader({ query, now: () => now, ttlMs: 50 });
    const first = await reader.read('/repo');
    expect(first.modelsError).toContain('unavailable');
    expect(JSON.stringify(first)).not.toContain('private diagnostic');
    await reader.read('/repo');
    expect(query).toHaveBeenCalledTimes(1);
    now += 51;
    await reader.read('/repo');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('offers model-specific efforts and dispatches only advertised Codex picker values', () => {
    const session = { agent: 'codex', codex: { model: 'gpt-test', effort: 'high' }, _codexMetadata: { models } };
    const options = codexSessionOptions(session);
    expect(options.effortLevels.map(e => e.value)).toEqual(['low', 'high', 'default']);
    const applyModelSwitch = vi.fn();
    const switchEffortInSession = vi.fn();
    const deps = { applyModelSwitch, switchEffortInSession };
    expect(handlePickerValue('model:gpt-test', 'room', session, deps)).toBe(true);
    expect(handlePickerValue('model:sonnet', 'room', session, deps)).toBe(false);
    expect(handlePickerValue('model:gpt-unlisted', 'room', session, deps)).toBe(false);
    expect(handlePickerValue('effort:high', 'room', session, deps)).toBe(true);
    expect(handlePickerValue('effort:ultra', 'room', session, deps)).toBe(false);
    expect(applyModelSwitch).toHaveBeenCalledTimes(1);
    expect(switchEffortInSession).toHaveBeenCalledTimes(1);
  });
});
