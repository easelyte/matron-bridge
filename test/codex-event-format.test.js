import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatAndRoute } from '../lib/codex-event-format.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/codex-json/review-run.jsonl', import.meta.url),
);
const PINNED_SCHEMA_VERSION = 'codex-cli 0.146.0';

function fixtureEvents() {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

function makeContext(overrides = {}) {
  const calls = [];
  const publisher = Object.fromEntries(
    ['publishToolOutput', 'publishDiff', 'publishActivity', 'publishText', 'publishStatus'].map(method => [
      method,
      (...args) => calls.push({ method, args }),
    ]),
  );
  return {
    calls,
    ctx: {
      publisher,
      convoId: 'parent:codex:run-1',
      runId: 'run-1',
      meta: { schemaVersion: PINNED_SCHEMA_VERSION, model: 'gpt-5.6-sol' },
      state: {},
      log: { warn: vi.fn() },
      ...overrides,
    },
  };
}

describe('formatAndRoute', () => {
  it('replays the golden sample through the pinned item-to-post mapping', () => {
    const { calls, ctx } = makeContext();

    for (const event of fixtureEvents()) formatAndRoute(event, ctx);

    expect(calls.filter(call => call.method === 'publishToolOutput')).toHaveLength(3);
    expect(calls.filter(call => call.method === 'publishDiff')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'publishActivity').length).toBeGreaterThan(0);
    expect(calls.filter(call => call.method === 'publishStatus')).toEqual([
      { method: 'publishStatus', args: [ctx.convoId, { model: 'gpt-5.6-sol' }] },
    ]);

    const toolPosts = calls.filter(call => call.method === 'publishToolOutput');
    expect(toolPosts[0].args).toEqual([
      ctx.convoId,
      expect.objectContaining({
        command: "/bin/bash -lc 'cat sentinel.env'",
        output: 'SECRET_TOKEN=sk-REDACTED-FIXTURE-TOKEN\n',
        exit_code: 0,
      }),
    ]);

    const diffPost = calls.find(call => call.method === 'publishDiff');
    expect(diffPost.args).toEqual([
      ctx.convoId,
      expect.objectContaining({
        changes: [{ path: '/tmp/codex-fixture-wt/mutate_me.txt', kind: 'update' }],
      }),
    ]);

    const finalPosts = calls.filter(call => call.method === 'publishText');
    expect(finalPosts).toHaveLength(1);
    expect(finalPosts[0].args).toEqual([
      ctx.convoId,
      expect.objectContaining({ body: expect.stringContaining('Completed in order'), from: 'assistant' }),
      { idemKey: 'run-1:final' },
    ]);
    expect(ctx.state.terminalSeen).toBe(true);
    expect(ctx.state.durableEvents).toBe(5);
  });

  it('routes reasoning ephemerally without consuming the durable cap', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({
      type: 'item.completed',
      item: { id: 'reason-1', type: 'reasoning', text: 'private chain summary' },
    }, ctx);

    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([
      { method: 'publishActivity', args: [ctx.convoId, 'thinking', 'private chain summary'] },
    ]);
    expect(ctx.state.durableEvents).toBe(0);
  });

  it('caps durable posts and emits exactly one truncation marker', () => {
    const { calls, ctx } = makeContext({ maxDurableEvents: 2 });

    for (let i = 0; i < 5; i += 1) {
      formatAndRoute({ type: 'mystery', sequence: i }, ctx);
    }

    const textPosts = calls.filter(call => call.method === 'publishText');
    expect(textPosts).toHaveLength(3);
    expect(textPosts.at(-1).args[1].body).toContain('events (truncated)');
    expect(ctx.state.durableEvents).toBe(2);
    expect(ctx.state.droppedEvents).toBe(3);
    expect(ctx.state.unparsed).toBe(5);
  });

  it('passes an unknown item through as text and increments unparsed', () => {
    const { calls, ctx } = makeContext();
    const unknown = { type: 'item.completed', item: { id: 'x', type: 'future_item', value: 42 } };

    formatAndRoute(unknown, ctx);

    expect(ctx.state.unparsed).toBe(1);
    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: JSON.stringify(unknown), from: 'assistant' }],
      },
    ]);
  });

  it('warns once and degrades every event to text for an unpinned schema', () => {
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: 'codex-cli 0.147.0', model: 'future-model' },
    });
    const events = fixtureEvents().slice(0, 2);

    for (const event of events) formatAndRoute(event, ctx);

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual(events.map(event => ({
      method: 'publishText',
      args: [ctx.convoId, { body: JSON.stringify(event), from: 'assistant' }],
    })));
    expect(ctx.state.unparsed).toBe(2);
  });

  it('omits model data when meta has no model', () => {
    const { calls, ctx } = makeContext({ meta: { schemaVersion: PINNED_SCHEMA_VERSION } });

    formatAndRoute({
      type: 'item.completed',
      item: {
        id: 'command-1', type: 'command_execution', command: 'true',
        aggregated_output: '', exit_code: 0, status: 'completed',
      },
    }, ctx);

    expect(calls.find(call => call.method === 'publishStatus')).toBeUndefined();
    expect(calls[0].args[1]).not.toHaveProperty('model');
  });
});
