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
  it('keeps reasoning ephemeral and caps durable tool output per run', () => {
    const { calls, ctx } = makeContext();

    const reasoningEvents = [
      { type: 'item.started', item: { id: 'reasoning-started', type: 'reasoning' } },
      { type: 'item.completed', item: { id: 'reasoning-completed', type: 'reasoning', text: 'thought' } },
      { type: 'item.started', item: { id: 'interstitial-started', type: 'interstitial' } },
      { type: 'item.completed', item: { id: 'interstitial-completed', type: 'interstitial', text: 'update' } },
    ];
    for (let index = 0; index < 500; index += 1) {
      formatAndRoute(reasoningEvents[index % reasoningEvents.length], ctx);
    }

    expect(calls.filter(call => (
      call.method === 'publishText' || call.method === 'publishToolOutput'
    ))).toHaveLength(0);
    expect(calls.filter(call => call.method === 'publishActivity')).toHaveLength(500);
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
});
