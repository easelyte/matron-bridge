import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatAndRoute } from '../lib/codex-event-format.js';
import { createJournalPublisher } from '../lib/journal-publisher.js';

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
  const record = (method, args) => calls.push({ method, args });
  const publisher = {
    publishToolOutput(convoId, payload) { record('publishToolOutput', [convoId, payload]); },
    publishDiff(convoId, payload) { record('publishDiff', [convoId, payload]); },
    publishActivity(convoId, state, detail) {
      const args = detail === undefined ? [convoId, state] : [convoId, state, detail];
      record('publishActivity', args);
    },
    publishText(convoId, payload, options) {
      const args = options === undefined ? [convoId, payload] : [convoId, payload, options];
      record('publishText', args);
      return true;
    },
    publishStatus(convoId, status) { record('publishStatus', [convoId, status]); },
  };
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

function makeFrameTransport() {
  const frames = [];
  class FrameTransport extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      queueMicrotask(() => this.emit('open'));
    }

    send(data, callback) {
      const frame = JSON.parse(data);
      if (frame.op === 'hello') {
        queueMicrotask(() => this.emit('message', JSON.stringify({ op: 'hello_ok', seq: 0 })));
      } else {
        frames.push(frame);
      }
      callback?.();
    }

    terminate() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  return { frames, FrameTransport };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for publisher frames');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('formatAndRoute', () => {
  it('replays the golden sample through the pinned item-to-post mapping', () => {
    const { calls, ctx } = makeContext();
    const events = fixtureEvents();
    const openingMessage = 'I’ll execute the three operations strictly in the requested order, using a patch for the file edit.';
    const finalMessage = 'Completed in order:\n\n1. Printed `sentinel.env`.\n2. Appended `second line` to `mutate_me.txt`.\n3. Ran the sleep command; output: `done`.';
    const expectedByFixtureItem = [
      [{ method: 'publishActivity', args: [ctx.convoId, 'thinking'] }],
      [{ method: 'publishActivity', args: [ctx.convoId, 'thinking'] }],
      [],
      [
        { method: 'publishActivity', args: [ctx.convoId, 'thinking', openingMessage] },
        { method: 'publishActivity', args: [ctx.convoId, 'tool', "/bin/bash -lc 'cat sentinel.env'"] },
      ],
      [{
        method: 'publishToolOutput',
        args: [ctx.convoId, {
          tool_use_id: 'item_1', command: "/bin/bash -lc 'cat sentinel.env'",
          output: 'SECRET_TOKEN=sk-REDACTED-FIXTURE-TOKEN\n', exit_code: 0, status: 'completed',
        }],
      }],
      [{ method: 'publishActivity', args: [ctx.convoId, 'tool', 'Applying file changes'] }],
      [{
        method: 'publishToolOutput',
        args: [ctx.convoId, {
          tool_use_id: 'item_2', command: 'file_change',
          output: 'update /tmp/codex-fixture-wt/mutate_me.txt', status: 'completed',
        }],
      }],
      [{ method: 'publishActivity', args: [ctx.convoId, 'tool', "/bin/bash -lc 'sleep 3 && echo done'"] }],
      [{
        method: 'publishToolOutput',
        args: [ctx.convoId, {
          tool_use_id: 'item_3', command: "/bin/bash -lc 'sleep 3 && echo done'",
          output: 'done\n', exit_code: 0, status: 'completed',
        }],
      }],
      [{ method: 'publishActivity', args: [ctx.convoId, 'tool', "/bin/bash -lc 'tail -n 3 mutate_me.txt'"] }],
      [{
        method: 'publishToolOutput',
        args: [ctx.convoId, {
          tool_use_id: 'item_4', command: "/bin/bash -lc 'tail -n 3 mutate_me.txt'",
          output: 'first line\nsecond line\n', exit_code: 0, status: 'completed',
        }],
      }],
      [],
      [
        {
          method: 'publishText',
          args: [ctx.convoId, { body: finalMessage, from: 'assistant' }, { idemKey: 'run-1:final' }],
        },
        { method: 'publishActivity', args: [ctx.convoId, 'idle'] },
      ],
    ];

    for (const [index, event] of events.entries()) {
      const start = calls.length;
      formatAndRoute(event, ctx);
      const itemCalls = calls.slice(start).filter(call => call.method !== 'publishStatus');
      expect(itemCalls, `fixture line ${index + 1}`).toEqual(expectedByFixtureItem[index]);
    }

    expect(expectedByFixtureItem).toHaveLength(events.length);
    expect(calls.filter(call => call.method === 'publishStatus')).toEqual([
      { method: 'publishStatus', args: [ctx.convoId, { model: 'gpt-5.6-sol' }] },
    ]);
    expect(calls.filter(call => call.method === 'publishDiff')).toHaveLength(0);
    expect(ctx.state.terminalSeen).toBe(true);
    expect(ctx.state.durableEvents).toBe(5);
  });

  it('emits exact publisher frames and preserves explicit final idempotency across replays', async () => {
    const transport = makeFrameTransport();
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn: vi.fn() },
      backoffBaseMs: 10,
      backoffCapMs: 20,
      WebSocketImpl: transport.FrameTransport,
    });

    try {
      for (let replay = 0; replay < 2; replay += 1) {
        const ctx = {
          publisher,
          convoId: 'parent:codex:run-1',
          runId: 'run-1',
          meta: { schemaVersion: PINNED_SCHEMA_VERSION },
          state: {},
        };
        formatAndRoute({
          type: 'item.completed',
          item: {
            id: 'command-1', type: 'command_execution', command: 'printf ok',
            aggregated_output: 'ok', exit_code: 0, status: 'completed',
          },
        }, ctx);
        formatAndRoute({
          type: 'item.completed',
          item: { id: 'answer-1', type: 'agent_message', text: 'Finished' },
        }, ctx);
        formatAndRoute({ type: 'turn.completed' }, ctx);
      }
      publisher.publishText('parent:codex:run-1', { body: 'random fallback', from: 'assistant' });

      await waitFor(() => transport.frames.filter(frame => frame.op === 'publish').length === 5);
      const published = transport.frames.filter(frame => frame.op === 'publish');
      expect(published).toEqual([
        {
          op: 'publish',
          convo_id: 'parent:codex:run-1',
          type: 'tool_output',
          payload: {
            tool_use_id: 'command-1', command: 'printf ok', output: 'ok',
            exit_code: 0, status: 'completed',
          },
          idem_key: expect.any(String),
        },
        {
          op: 'publish',
          convo_id: 'parent:codex:run-1',
          type: 'text',
          payload: { body: 'Finished', from: 'assistant' },
          idem_key: 'run-1:final',
        },
        {
          op: 'publish',
          convo_id: 'parent:codex:run-1',
          type: 'tool_output',
          payload: {
            tool_use_id: 'command-1', command: 'printf ok', output: 'ok',
            exit_code: 0, status: 'completed',
          },
          idem_key: expect.any(String),
        },
        {
          op: 'publish',
          convo_id: 'parent:codex:run-1',
          type: 'text',
          payload: { body: 'Finished', from: 'assistant' },
          idem_key: 'run-1:final',
        },
        {
          op: 'publish',
          convo_id: 'parent:codex:run-1',
          type: 'text',
          payload: { body: 'random fallback', from: 'assistant' },
          idem_key: expect.any(String),
        },
      ]);
      expect(published[4].idem_key).not.toBe('run-1:final');
      expect(published[4].idem_key).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      publisher.close();
    }
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
    expect(textPosts.at(-1).args[1].body).toBe('Additional events truncated');
    expect(textPosts.at(-1).args[1].body).not.toMatch(/\b\d+\b/);
    expect(ctx.state.durableEvents).toBe(2);
    expect(ctx.state.droppedEvents).toBe(3);
    expect(ctx.state.unparsed).toBe(5);
  });

  it('durably publishes the final answer after intermediate posts exhaust the cap', () => {
    const { calls, ctx } = makeContext({ maxDurableEvents: 200 });

    for (let i = 0; i < 201; i += 1) {
      formatAndRoute({
        type: 'item.completed',
        item: {
          id: `command-${i}`, type: 'command_execution', command: `command ${i}`,
          aggregated_output: `output ${i}`, exit_code: 0, status: 'completed',
        },
      }, ctx);
    }
    formatAndRoute({
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'The durable result' },
    }, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);

    expect(calls.filter(call => call.method === 'publishToolOutput')).toHaveLength(200);
    expect(calls.filter(call => call.method === 'publishText')).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: 'Additional events truncated', from: 'assistant' }],
      },
      {
        method: 'publishText',
        args: [
          ctx.convoId,
          { body: 'The durable result', from: 'assistant' },
          { idemKey: 'run-1:final' },
        ],
      },
    ]);
    expect(ctx.state.durableEvents).toBe(201);
    expect(ctx.state.droppedEvents).toBe(1);
    expect(ctx.state.terminalSeen).toBe(true);
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

  it('passes an unknown item.started type through as text and increments unparsed', () => {
    const { calls, ctx } = makeContext();
    const unknown = { type: 'item.started', item: { id: 'x', type: 'future_item', value: 42 } };

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

  it('requires an exact complete schema version identifier', () => {
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: `${PINNED_SCHEMA_VERSION} schema-v2` },
    });
    const event = fixtureEvents()[4];

    formatAndRoute(event, ctx);

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([{
      method: 'publishText',
      args: [ctx.convoId, { body: JSON.stringify(event), from: 'assistant' }],
    }]);
  });

  it('skips the durable final and warns once when runId is missing', () => {
    const { calls, ctx } = makeContext({ runId: undefined });
    const finalMessage = {
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'Finished' },
    };

    formatAndRoute(finalMessage, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);
    formatAndRoute(finalMessage, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);

    expect(calls.filter(call => call.method === 'publishText')).toHaveLength(0);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.state.durableEvents).toBe(0);
    expect(ctx.state.terminalSeen).toBe(true);
  });

  it('rejects a partially numeric durable-event environment value', () => {
    vi.stubEnv('CODEX_MAX_DURABLE_EVENTS', '2junk');
    try {
      const { calls, ctx } = makeContext();
      for (let i = 0; i < 3; i += 1) {
        formatAndRoute({ type: 'mystery', sequence: i }, ctx);
      }

      expect(calls.filter(call => call.method === 'publishText')).toHaveLength(3);
      expect(ctx.state.durableEvents).toBe(3);
      expect(ctx.state.droppedEvents).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
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
