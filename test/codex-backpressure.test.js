import { describe, expect, it } from 'vitest';
import { formatAndRoute } from '../lib/codex-event-format.js';

const PINNED_SCHEMA_VERSION = 'codex-cli 0.146.0';

function makeContext() {
  const calls = [];
  const record = (method, args) => calls.push({ method, args });
  return {
    calls,
    ctx: {
      publisher: {
        publishActivity(...args) { record('publishActivity', args); },
        publishStatus(...args) { record('publishStatus', args); },
        publishText(...args) { record('publishText', args); },
        publishToolOutput(...args) { record('publishToolOutput', args); },
      },
      convoId: 'parent:codex:backpressure-run',
      meta: { schemaVersion: PINNED_SCHEMA_VERSION },
      maxDurableEvents: 200,
      state: {},
    },
  };
}

describe('Codex event backpressure', () => {
  it('keeps 500 completed reasoning items ephemeral and caps durable tool output per run', () => {
    const { calls, ctx } = makeContext();

    for (let index = 0; index < 500; index += 1) {
      formatAndRoute({
        type: 'item.completed',
        item: { id: `reasoning-${index}`, type: 'reasoning', text: `thought ${index}` },
      }, ctx);
    }

    expect(calls.filter(call => (
      call.method === 'publishText' || call.method === 'publishToolOutput'
    ))).toHaveLength(0);
    expect(calls.filter(call => call.method === 'publishActivity')).toHaveLength(1);
    expect(ctx.state.droppedActivityEvents).toBe(499);
    expect(ctx.state.durableEvents).toBe(0);

    for (let index = 0; index < 250; index += 1) {
      formatAndRoute({
        type: 'item.completed',
        item: {
          id: `command-${index}`,
          type: 'command_execution',
          command: `command ${index}`,
          aggregated_output: `output ${index}`,
          exit_code: 0,
          status: 'completed',
        },
      }, ctx);
    }

    expect(calls.filter(call => call.method === 'publishToolOutput')).toHaveLength(200);
    expect(calls.filter(call => call.method === 'publishText')).toEqual([{
      method: 'publishText',
      args: [ctx.convoId, { body: 'Additional events truncated', from: 'assistant' }],
    }]);
    expect(ctx.state.durableEvents).toBe(200);
    expect(ctx.state.droppedEvents).toBe(50);
  });

  it('keeps started reasoning and recognized interstitial items ephemeral', () => {
    const { calls, ctx } = makeContext();
    const events = [
      { type: 'item.started', item: { id: 'reasoning-started', type: 'reasoning', text: 'thinking' } },
      { type: 'item.started', item: { id: 'interstitial-started', type: 'interstitial', text: 'starting' } },
      { type: 'item.completed', item: { id: 'interstitial-completed', type: 'interstitial', text: 'update' } },
    ];

    for (const event of events) formatAndRoute(event, ctx);

    expect(calls).toEqual([
      { method: 'publishActivity', args: [ctx.convoId, 'thinking', 'thinking'] },
    ]);
    expect(ctx.state.droppedActivityEvents).toBe(2);
    expect(ctx.state.unparsed).toBe(0);
    expect(ctx.state.durableEvents).toBe(0);
  });

  it('keeps an unknown reasoning envelope ephemeral and counts it as unparsed', () => {
    const { calls, ctx } = makeContext();
    const event = {
      type: 'item.delta',
      item: { id: 'reasoning-delta', type: 'reasoning', text: 'partial thought' },
    };

    formatAndRoute(event, ctx);

    expect(calls).toEqual([{
      method: 'publishActivity',
      args: [ctx.convoId, 'thinking', 'partial thought'],
    }]);
    expect(ctx.state.unparsed).toBe(1);
    expect(ctx.state.durableEvents).toBe(0);
  });

  it('keeps reasoning ephemeral before unpinned-schema fallback', () => {
    const { calls, ctx } = makeContext();
    ctx.meta.schemaVersion = 'codex-cli 0.147.0';

    formatAndRoute({
      type: 'item.completed',
      item: { id: 'reasoning-future-schema', type: 'reasoning', text: 'private thought' },
    }, ctx);

    expect(calls).toEqual([{
      method: 'publishActivity',
      args: [ctx.convoId, 'thinking', 'private thought'],
    }]);
    expect(ctx.state.unparsed).toBe(0);
    expect(ctx.state.durableEvents).toBe(0);
  });
});
