import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatAndRoute, redactAndRoute } from '../lib/codex-event-format.js';
import { createJournalPublisher } from '../lib/journal-publisher.js';
import { createPublishRedactor } from '../lib/redact.js';

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
          args: [
            ctx.convoId,
            { body: finalMessage, from: 'assistant' },
            { idemKey: 'run-1:final', onDelivered: expect.any(Function) },
          ],
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
    // A COMPLETE frame, not a bare { model }: the journal's replay cache is
    // replace-not-merge, so if this happens to be the last frame before a
    // client cold-starts, a partial one would strand it without the composer's
    // argument lists. Codex states its own offer — empty lists and a null
    // effort — so a client switched mid-session from Claude clears that
    // session's levels instead of keeping them stickily.
    expect(calls.filter(call => call.method === 'publishStatus')).toEqual([
      {
        method: 'publishStatus',
        args: [ctx.convoId, {
          model: 'gpt-5.6-sol',
          model_options: [],
          effort_levels: [],
          effort: null,
        }],
      },
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
          { idemKey: 'run-1:final', onDelivered: expect.any(Function) },
        ],
      },
    ]);
    expect(ctx.state.durableEvents).toBe(201);
    expect(ctx.state.droppedEvents).toBe(1);
    expect(ctx.state.terminalSeen).toBe(true);
  });

  it('evicts the retained final answer after publisher delivery', () => {
    const retained = new Map();
    const { ctx } = makeContext({
      retainFinalAnswer(runId, payload) { retained.set(runId, payload); },
      markFinalAnswerDelivered(runId) { retained.delete(runId); },
    });
    ctx.publisher.publishText = (_convoId, _payload, options) => {
      expect(retained.has(ctx.runId)).toBe(true);
      options.onDelivered();
      return true;
    };

    formatAndRoute({
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'Delivered result' },
    }, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);

    expect(retained.has(ctx.runId)).toBe(false);
  });

  // An unrecognized item.completed type renders a DURABLE compact,
  // formatted line, NOT a raw JSON dump. The line carries only a humanized
  // label; no other item field (and not even the id) survives. It is a neutral
  // text line, NOT a "done" tool card — see the mcp-failure rationale.
  it('renders an unrecognized item.completed type as a compact formatted line, not raw JSON', () => {
    const { calls, ctx } = makeContext();
    const unknown = { type: 'item.completed', item: { id: 'x', type: 'future_item', value: 42 } };

    formatAndRoute(unknown, ctx);

    const nonStatus = calls.filter(call => call.method !== 'publishStatus');
    expect(nonStatus).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: '`Future item`', from: 'assistant' }],
      },
    ]);
    // No raw-JSON leak, and no other item field is forwarded.
    const serialized = JSON.stringify(nonStatus);
    expect(serialized).not.toBe(JSON.stringify(unknown));
    expect(serialized).not.toContain('42');
    expect(nonStatus[0].args[1].body).not.toBe(JSON.stringify(unknown));
    // No "done" tool card is emitted (would misreport a failed tool as success).
    expect(calls.some(call => call.method === 'publishToolOutput')).toBe(false);
    expect(ctx.state.unparsed).toBe(0);
    expect(ctx.state.durableEvents).toBe(1);
  });

  // An unrecognized item.started type shows an ephemeral "tool"
  // activity indicator (like command_execution/file_change started), NOT raw
  // JSON. Ephemeral -> no durable-cap consumption, no unparsed increment.
  it('renders an unrecognized item.started type as a tool activity, not raw JSON', () => {
    const { calls, ctx } = makeContext();
    const unknown = { type: 'item.started', item: { id: 'x', type: 'future_item', value: 42 } };

    formatAndRoute(unknown, ctx);

    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([
      { method: 'publishActivity', args: [ctx.convoId, 'tool', 'Future item'] },
    ]);
    expect(calls.some(call => call.method === 'publishText')).toBe(false);
    expect(ctx.state.unparsed).toBe(0);
    expect(ctx.state.durableEvents).toBe(0);
  });

  // Web_search item.started/completed no longer
  // leak raw `{"type":"item.started","item":{"type":"web_search",...}}` blobs
  // between the clean bash-command cards.
  it('renders web_search item.started as a tool activity, not a raw JSON publishText', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute(
      { type: 'item.started', item: { id: 'exec-1', type: 'web_search' } },
      ctx,
    );

    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([
      { method: 'publishActivity', args: [ctx.convoId, 'tool', 'Web search'] },
    ]);
    expect(calls.some(call => call.method === 'publishText')).toBe(false);
  });

  it('renders web_search item.completed as a formatted line whose body is not the raw event', () => {
    const { calls, ctx } = makeContext();
    const event = { type: 'item.completed', item: { id: 'exec-1', type: 'web_search' } };

    formatAndRoute(event, ctx);

    const textPosts = calls.filter(call => call.method === 'publishText');
    expect(textPosts).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: '`Web search`', from: 'assistant' }],
      },
    ]);
    // The published line is a formatted label, NOT a stringified raw event, and
    // not a "done" tool card.
    expect(textPosts[0].args[1].body).not.toBe(JSON.stringify(event));
    expect(calls.some(call => call.method === 'publishToolOutput')).toBe(false);
  });

  // Proves the fallback is GENERIC (a formatter over the item.* family), not a
  // web_search special case: a different novel item type renders the same way.
  it('renders a different novel item type (mcp_tool_call) generically too', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute(
      { type: 'item.started', item: { id: 'mcp-1', type: 'mcp_tool_call' } },
      ctx,
    );
    formatAndRoute(
      { type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call' } },
      ctx,
    );

    expect(calls.filter(call => call.method === 'publishActivity')).toContainEqual(
      { method: 'publishActivity', args: [ctx.convoId, 'tool', 'Mcp tool call'] },
    );
    expect(calls.filter(call => call.method === 'publishText')).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: '`Mcp tool call`', from: 'assistant' }],
      },
    ]);
    // Never a "done" card: a status-bearing item's real status was stripped
    // upstream, so the bridge must not assert success.
    expect(calls.some(call => call.method === 'publishToolOutput')).toBe(false);
  });

  // A truly unstructured item (no string type) still falls to raw passthrough —
  // the fallback keys on a string item.type, so shapeless events are unaffected.
  it('still passes a typeless item through as raw text', () => {
    const { calls, ctx } = makeContext();
    const shapeless = { type: 'item.completed', item: { id: 'x' } };

    formatAndRoute(shapeless, ctx);

    expect(ctx.state.unparsed).toBe(1);
    expect(calls.filter(call => call.method !== 'publishStatus')).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: JSON.stringify(shapeless), from: 'assistant' }],
      },
    ]);
  });

  it('warns once and degrades every event to text below the schema floor', () => {
    // Rendering is version-tolerant (no upper band), so a NEWER
    // version renders richly. Only versions BELOW the hardened-schema floor
    // (0.146.0) still fail safe to the text-passthrough path.
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: 'codex-cli 0.145.0', model: 'legacy-model' },
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

  it('lands the durable final answer below the schema floor (text passthrough)', () => {
    const retained = [];
    const delivered = [];
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: 'codex-cli 0.145.0', model: 'legacy-model' },
      retainFinalAnswer: (runId, payload) => retained.push({ runId, payload }),
      markFinalAnswerDelivered: runId => delivered.push(runId),
    });
    const agentMessage = {
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'Review complete: LGTM' },
    };

    formatAndRoute(agentMessage, ctx);
    formatAndRoute({ type: 'turn.completed' }, ctx);

    // The final answer lands as the clean durable post with the stable idemKey,
    // NOT as a raw JSON dump — and finalPostProduced flips so the watcher's
    // terminal audit reports finalPostLanded truthy instead of false.
    expect(ctx.state.finalPostProduced).toBe(true);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    const textCalls = calls.filter(call => call.method === 'publishText');
    expect(textCalls).toEqual([
      {
        method: 'publishText',
        args: [
          ctx.convoId,
          { body: 'Review complete: LGTM', from: 'assistant' },
          expect.objectContaining({ idemKey: `${ctx.runId}:final` }),
        ],
      },
    ]);
    expect(retained).toEqual([
      { runId: ctx.runId, payload: { body: 'Review complete: LGTM', from: 'assistant' } },
    ]);
    // turn.completed still marks the session idle under passthrough.
    expect(calls.filter(call => call.method === 'publishActivity')).toContainEqual({
      method: 'publishActivity',
      args: [ctx.convoId, 'idle'],
    });
    expect(ctx.state.terminalSeen).toBe(true);
  });

  it('lands a pending answer before a turn.failed below the schema floor', () => {
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: 'codex-cli 0.145.0', model: 'legacy-model' },
    });

    formatAndRoute({
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'Partial answer' },
    }, ctx);
    formatAndRoute({ type: 'turn.failed' }, ctx);

    const bodies = calls.filter(call => call.method === 'publishText').map(call => call.args[1].body);
    expect(bodies).toEqual(['Partial answer', JSON.stringify({ type: 'turn.failed' })]);
    expect(ctx.state.finalPostProduced).toBe(true);
    expect(ctx.state.pendingAgentMessage).toBeNull();
    expect(ctx.state.terminalSeen).toBe(true);
    expect(calls.filter(call => call.method === 'publishActivity')).toContainEqual({
      method: 'publishActivity',
      args: [ctx.convoId, 'idle'],
    });
  });

  it('still text-passes non-lifecycle events below the schema floor', () => {
    const { calls, ctx } = makeContext({
      meta: { schemaVersion: 'codex-cli 0.145.0', model: 'legacy-model' },
    });
    const commandEvent = {
      type: 'item.completed',
      item: {
        id: 'item_1', type: 'command_execution', command: 'printf ok',
        aggregated_output: 'ok', exit_code: 0, status: 'completed',
      },
    };

    formatAndRoute(commandEvent, ctx);

    expect(ctx.state.unparsed).toBe(1);
    expect(calls.filter(call => call.method === 'publishText')).toEqual([
      {
        method: 'publishText',
        args: [ctx.convoId, { body: JSON.stringify(commandEvent), from: 'assistant' }],
      },
    ]);
    expect(calls.some(call => call.method === 'publishToolOutput')).toBe(false);
  });

  it('routes every version at/above the floor through the rich item mapping (no upper band)', () => {
    const commandEvent = {
      type: 'item.completed',
      item: {
        id: 'item_1', type: 'command_execution', command: 'printf ok',
        aggregated_output: 'ok', exit_code: 0, status: 'completed',
      },
    };
    // Rendering keys on event shape, not an upper version band, so
    // 0.155.1 (live) AND future majors (0.156.0, 1.0.0) all render richly with
    // no manual band bump, reusing the hardened allowlist path unchanged.
    for (const schemaVersion of [
      'codex-cli 0.146.1', 'codex-cli 0.147.0', 'codex-cli 0.155.1',
      'codex-cli 0.156.0', 'codex-cli 1.0.0',
    ]) {
      const { calls, ctx } = makeContext({ meta: { schemaVersion } });
      formatAndRoute(commandEvent, ctx);
      expect(ctx.log.warn, schemaVersion).not.toHaveBeenCalled();
      const itemCalls = calls.filter(call => call.method !== 'publishStatus');
      expect(itemCalls, schemaVersion).toEqual([{
        method: 'publishToolOutput',
        args: [ctx.convoId, {
          tool_use_id: 'item_1', command: 'printf ok',
          output: 'ok', exit_code: 0, status: 'completed',
        }],
      }]);
    }
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

// The known codex exec --json protocol events that still reached the
// journal as raw JSON text on the SUPPORTED schema path (error, turn.failed,
// item.updated). Every one must render as a readable line or an ephemeral
// activity, never as a stringified event body.
describe('formatAndRoute known protocol events', () => {
  const isRawJsonBody = call => call.method === 'publishText'
    && typeof call.args[1]?.body === 'string'
    && call.args[1].body.trimStart().startsWith('{');

  it('renders a top-level error as a readable warning line, not raw JSON', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({ type: 'error', message: 'unexpected status 404 Not Found' }, ctx);

    expect(calls.some(isRawJsonBody)).toBe(false);
    expect(calls.filter(call => call.method === 'publishText')).toEqual([{
      method: 'publishText',
      args: [ctx.convoId, { body: '⚠️ Codex error: `unexpected status 404 Not Found`', from: 'assistant' }],
    }]);
    expect(ctx.state.unparsed).toBe(0);
  });

  it('keeps an error message inside its code span (no markdown escape, bounded)', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({ type: 'error', message: 'bad `x` [link](http://e.vil)\nsecond line' + 'y'.repeat(900) }, ctx);

    const body = calls.find(call => call.method === 'publishText').args[1].body;
    const inner = body.slice('⚠️ Codex error: `'.length, -1);
    expect(inner).not.toContain('`');
    expect(inner).not.toMatch(/[\r\n]/);
    expect(inner.length).toBeLessThanOrEqual(500);
  });

  it('renders turn.failed as a failure line, lands any pending answer, and goes idle', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'partial answer' } }, ctx);
    formatAndRoute({ type: 'turn.failed', message: 'stream disconnected' }, ctx);

    expect(calls.some(isRawJsonBody)).toBe(false);
    const bodies = calls.filter(call => call.method === 'publishText').map(call => call.args[1].body);
    expect(bodies).toEqual(['partial answer', '⚠️ Codex turn failed: `stream disconnected`']);
    expect(calls).toContainEqual({ method: 'publishActivity', args: [ctx.convoId, 'idle'] });
    expect(ctx.state.terminalSeen).toBe(true);
  });

  it('keeps the turn.failed line even when the answer takes the last durable slot', () => {
    for (const schemaVersion of ['codex-cli 0.146.0', 'codex-cli 0.145.0']) {
      const { calls, ctx } = makeContext({ meta: { schemaVersion }, maxDurableEvents: 1 });
      ctx.state = { durableEvents: 0 };
      formatAndRoute({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'partial answer' } }, ctx);
      formatAndRoute({ type: 'turn.failed' }, ctx);

      const bodies = calls.filter(call => call.method === 'publishText').map(call => call.args[1].body);
      expect(bodies[0], schemaVersion).toBe('partial answer');
      expect(bodies.slice(1).some(body => body.includes('turn.failed') || body.includes('turn failed')), schemaVersion).toBe(true);
      expect(bodies, schemaVersion).not.toContain('Additional events truncated');
    }
  });

  it('renders a bare turn.failed stub without a message', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({ type: 'turn.failed' }, ctx);

    expect(calls.filter(call => call.method === 'publishText').map(call => call.args[1].body))
      .toEqual(['⚠️ Codex turn failed']);
  });

  it('carries turn.failed error.message through the allowlist (redacted), not as JSON', () => {
    const { calls, ctx } = makeContext({ redact: value => value.replaceAll('sk-live-123', '[REDACTED]') });

    redactAndRoute({ type: 'turn.failed', error: { message: 'auth failed for sk-live-123' } }, ctx);

    expect(calls.some(isRawJsonBody)).toBe(false);
    expect(calls.filter(call => call.method === 'publishText').map(call => call.args[1].body))
      .toEqual(['⚠️ Codex turn failed: `auth failed for [REDACTED]`']);
  });

  it('scrubs an assignment behind prose in a NUL-framed turn.failed diagnostic (production redactor)', () => {
    const { calls, ctx } = makeContext({ redact: createPublishRedactor() });

    redactAndRoute({
      type: 'turn.failed',
      error: { message: 'fatal\nALPHA=canary-secret-value\nmore-value\0BRAVO=other-value' },
    }, ctx);

    const bodies = calls.filter(call => call.method === 'publishText').map(call => call.args[1].body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('canary-secret-value');
    expect(bodies[0]).not.toContain('more-value');
    expect(bodies[0]).not.toContain('other-value');
    expect(bodies[0]).toContain('fatal');
  });

  it('scrubs a NUL-framed top-level error diagnostic the same way', () => {
    const { calls, ctx } = makeContext({ redact: createPublishRedactor() });

    redactAndRoute({ type: 'error', message: 'boom\r\nALPHA=canary-secret-value\0tail' }, ctx);

    const body = calls.find(call => call.method === 'publishText').args[1].body;
    expect(body).not.toContain('canary-secret-value');
    expect(body).toContain('boom');
  });

  it('routes item.updated (todo_list) to an ephemeral activity, never a durable post', () => {
    const { calls, ctx } = makeContext();

    formatAndRoute({ type: 'item.updated', item: { id: 'item_1', type: 'todo_list' } }, ctx);

    expect(calls.filter(call => call.method === 'publishText')).toEqual([]);
    expect(calls).toContainEqual({ method: 'publishActivity', args: [ctx.convoId, 'tool', 'Todo list'] });
    expect(ctx.state.durableEvents).toBe(0);
  });
});
