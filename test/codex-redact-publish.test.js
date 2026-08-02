import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupCodexWatcherForSession } from '../index.js';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import { redactAndRoute } from '../lib/codex-event-format.js';
import { createPublishRedactor, resolveRedactorConfigPath } from '../lib/redact.js';

const RUN_ID = '1722600000000-1234-abcd';
const SCHEMA_VERSION = 'codex-cli 0.146.0';
const SENTINEL = 'SENTINEL_CREDENTIAL';
const REDACTED = '[REDACTED:test]';
const CANONICAL_WORKSPACE = path.resolve('.');

function replaceSentinel(value) {
  return value.replaceAll(SENTINEL, REDACTED);
}

function makePublisher() {
  const calls = [];
  return {
    calls,
    publishToolOutput(convoId, payload) {
      calls.push({ method: 'publishToolOutput', convoId, payload });
      return true;
    },
    publishText(convoId, payload, options) {
      calls.push({ method: 'publishText', convoId, payload, options });
      return true;
    },
    publishActivity(convoId, state, detail) {
      calls.push({ method: 'publishActivity', convoId, state, detail });
    },
    publishStatus(convoId, payload) {
      calls.push({ method: 'publishStatus', convoId, payload });
    },
    upsertConvo(convoId, payload) {
      calls.push({ method: 'upsertConvo', convoId, payload });
      return true;
    },
  };
}

const POLICY = [
  'patterns:',
  '  - name: test-token',
  "    regex: 'SENTINEL_[A-Z]+'",
].join('\n');

function commandEvent(command, output = 'ok') {
  return {
    type: 'item.completed',
    item: {
      id: 'command-1',
      type: 'command_execution',
      command,
      aggregated_output: output,
      exit_code: 0,
      status: 'completed',
      raw_env: { SHOULD_NOT: 'LEAVE_THE_ALLOWLIST' },
    },
    unexpected: SENTINEL,
  };
}

describe('publish-side Codex redaction', () => {
  it('uses the canonical policy shape and hashed replacement format', () => {
    const redact = createPublishRedactor({
      configPath: '/test/lesson_redactor.yaml',
      readFileSyncFn: () => POLICY,
    });

    expect(redact(SENTINEL)).toMatch(/^\[REDACTED:test-token:[0-9a-f]{8}\]$/);
  });

  it('loads the real canonical policy and redacts its representative secret families', () => {
    const policyPath = resolveRedactorConfigPath({ workspaceRoot: CANONICAL_WORKSPACE, env: {} });
    expect(policyPath).toBe(path.join(CANONICAL_WORKSPACE, 'memory/config/lesson_redactor.yaml'));
    const redact = createPublishRedactor({ workspaceRoot: CANONICAL_WORKSPACE, env: {} });
    const samples = [
      'xoxb-EXAMPLEONLYNOTAREALTOKEN',
      'ya29.a0AfH6SMB-example_token',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    const canonicalPolicy = readFileSync(policyPath, 'utf8');
    expect(canonicalPolicy).toContain('slack-token');
    for (const sample of samples) {
      expect(redact(sample), sample).not.toContain(sample);
      expect(redact(sample), sample).toContain('[REDACTED:');
    }
    expect(redact('API_KEY=unstructured-value')).not.toContain('unstructured-value');
  });

  it('resolves an explicit tilde config and otherwise uses the canonical workspace root', () => {
    expect(resolveRedactorConfigPath({
      workspaceRoot: '/canonical/workspace',
      configPath: '~/policy/redactor.yaml',
      homedir: '/home/tester',
      env: {},
    })).toBe('/home/tester/policy/redactor.yaml');
    expect(resolveRedactorConfigPath({
      workspaceRoot: '/canonical/workspace',
      homedir: '/home/tester',
      env: {},
    })).toBe('/canonical/workspace/memory/config/lesson_redactor.yaml');

    const reads = [];
    const redact = createPublishRedactor({
      workspaceRoot: '/canonical/workspace',
      env: {},
      readFileSyncFn: file => {
        reads.push(file);
        return POLICY;
      },
    });
    redact('safe');
    expect(reads).toEqual(['/canonical/workspace/memory/config/lesson_redactor.yaml']);
    expect(reads[0]).not.toContain('/arbitrary/session-workdir');
  });

  it.each([
    [
      'an incomplete entry',
      [
        'patterns:',
        '  - name: valid',
        "    regex: 'safe'",
        '  - name: missing-regex',
      ].join('\n'),
    ],
    [
      'an unknown property',
      [
        'patterns:',
        '  - name: valid',
        "    regex: 'safe'",
        '    replacement: hidden',
      ].join('\n'),
    ],
    [
      'unsupported Python regex semantics',
      [
        'patterns:',
        '  - name: python-group',
        "    regex: '(?P<token>safe)'",
      ].join('\n'),
    ],
    ...['\\w+', '\\d+', '\\s+', '\\btoken\\b', '(?i)token', '.', '[^A-Z]+'].map(regex => [
      `non-parity regex ${regex}`,
      ['patterns:', '  - name: non-parity', `    regex: '${regex}'`].join('\n'),
    ]),
  ])('fails closed for %s instead of applying a partial policy', (_label, policy) => {
    const log = { error: vi.fn() };
    const redact = createPublishRedactor({
      configPath: '/test/lesson_redactor.yaml',
      readFileSyncFn: () => policy,
      log,
    });
    expect(() => redact(SENTINEL)).toThrow('publish redactor config failed');
    expect(() => redact('safe')).toThrow('publish redactor is unavailable');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('redacts every allowlisted string and excludes unknown fields before publishing', () => {
    const publisher = makePublisher();
    const state = {};

    redactAndRoute(commandEvent(`printf ${SENTINEL}`, `result=${SENTINEL}`), {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state,
      redact: replaceSentinel,
    });

    expect(publisher.calls).toEqual([{
      method: 'publishToolOutput',
      convoId: `parent:codex:${RUN_ID}`,
      payload: {
        tool_use_id: 'command-1',
        command: `printf ${REDACTED}`,
        output: `result=${REDACTED}`,
        exit_code: 0,
        status: 'completed',
      },
    }]);
    expect(JSON.stringify(publisher.calls)).not.toContain(SENTINEL);
    expect(JSON.stringify(publisher.calls)).not.toContain('SHOULD_NOT');
    expect(state.redactionDropCount).toBe(0);
  });

  it.each([
    ['env | sort', `API_TOKEN=${SENTINEL}`],
    ['env -0', `API_TOKEN=${SENTINEL}`],
    ['printenv | cat', `API_TOKEN=${SENTINEL}`],
    ['command env', `API_TOKEN=${SENTINEL}`],
    ['/usr/bin/env', `API_TOKEN=${SENTINEL}`],
    ['set', `API_TOKEN=${SENTINEL}`],
    ['export -p', `API_TOKEN=${SENTINEL}`],
    ["/usr/bin/bash -lc 'env'", `API_TOKEN=${SENTINEL}`],
    ['bash -c env | grep DATABASE_PASSWORD', 'DATABASE_PASSWORD=hunter2'],
    ["sh -lc 'printenv | grep API_TOKEN'", `API_TOKEN=${SENTINEL}`],
    ['unknown-diagnostic', `API_TOKEN=${SENTINEL}\nDATABASE_PASSWORD=hunter2\nHOME=/root\nPATH=/bin`],
  ])('drops raw env-dump output for bypass %s', (command, output) => {
    const publisher = makePublisher();
    const state = {};
    redactAndRoute(commandEvent(command, output), {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state,
      redact: replaceSentinel,
    });
    expect(publisher.calls).toEqual([]);
    expect(state.redactionDropCount).toBe(1);
  });

  it.each([
    ["node -e 'console.log(process.env)'", 'DATABASE_PASSWORD=hunter2'],
    ["python -c 'import os; print(os.environ)'", "{'API_TOKEN': 'one-line-secret'}"],
    ['declare -x | grep PRIVATE_KEY', 'declare -x PRIVATE_KEY="pem-material"'],
  ])('redacts secret-key values even when env-dump command classification is undecidable: %s', (command, output) => {
    const publisher = makePublisher();
    const redact = createPublishRedactor({ workspaceRoot: CANONICAL_WORKSPACE, env: {} });
    redactAndRoute(commandEvent(command, output), {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state: {},
      redact,
    });
    expect(publisher.calls).toHaveLength(1);
    expect(JSON.stringify(publisher.calls)).not.toContain('hunter2');
    expect(JSON.stringify(publisher.calls)).not.toContain('one-line-secret');
    expect(JSON.stringify(publisher.calls)).not.toContain('pem-material');
    expect(JSON.stringify(publisher.calls)).toContain('[REDACTED:secret-key:');
  });

  it.each([
    ['env NODE_ENV=test npm test', 'test suite passed'],
    ["echo 'env'", 'env'],
  ])('does not drop non-dump command %s', (command, output) => {
    const publisher = makePublisher();
    const state = {};
    redactAndRoute(commandEvent(command, output), {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state,
      redact: replaceSentinel,
    });
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].payload.output).toBe(output);
    expect(state.redactionDropCount).toBe(0);
  });

  it('drops a redactor-failed event and continues publishing later tail events', () => {
    const publisher = makePublisher();
    const state = {};
    let fail = true;
    const redact = value => {
      if (fail) throw new Error('injected redactor failure');
      return replaceSentinel(value);
    };
    const ctx = {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state,
      redact,
      log: { warn: vi.fn() },
    };

    expect(() => redactAndRoute(commandEvent(`printf ${SENTINEL}`), ctx)).not.toThrow();
    fail = false;
    redactAndRoute(commandEvent('printf safe', 'safe'), ctx);

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].payload.command).toBe('printf safe');
    expect(state.redactionDropCount).toBe(1);
    expect(ctx.log.warn).toHaveBeenCalledOnce();
  });

  it('leaves publisher failures for the watcher isolation boundary', () => {
    const publisher = makePublisher();
    publisher.publishToolOutput = () => { throw new Error('injected publisher failure'); };

    expect(() => redactAndRoute(commandEvent('printf safe'), {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: SCHEMA_VERSION },
      state: {},
      redact: replaceSentinel,
    })).toThrow('injected publisher failure');
  });

  it('uses the real index.js setup with tracker, canonical redactor, and isolation for replay and live tail', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-redact-publish-'));
    const publisher = makePublisher();
    const liveSession = {
      roomId: 'room-1',
      claudeSessionId: 'session-1',
      journalConvoId: 'parent',
    };
    const watcher = setupCodexWatcherForSession(liveSession, dir, 'session-1', {
      publisher,
      liveSessions: new Map([['room-1', liveSession]]),
      workspaceRoot: CANONICAL_WORKSPACE,
      watcherOptions: {
        dir,
        pollIntervalMs: 60_000,
        isWrapperAliveFn: () => true,
      },
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    try {
      expect(liveSession.codexConvos).toBeDefined();
      expect(liveSession.codexWatcherIsolation).toBeDefined();
      expect(watcher.isolation).toBe(liveSession.codexWatcherIsolation);
      await vi.waitFor(() => expect(watcher.started).toBe(true));
      writeFileSync(path.join(dir, `codex-${RUN_ID}.meta.json`), JSON.stringify({
        runId: RUN_ID,
        wrapperPid: process.pid,
        wrapperStartTicks: 'test',
        deadlineTs: Date.now() + 60_000,
        schemaVersion: SCHEMA_VERSION,
      }));
      writeFileSync(
        path.join(dir, `codex-${RUN_ID}.jsonl`),
        `${JSON.stringify(commandEvent('printf replay', 'API_TOKEN=replayed-secret'))}\n`,
      );
      await watcher.scan();
      const replayCall = publisher.calls.find(call => call.method === 'publishToolOutput');
      expect(replayCall.payload.output).not.toContain('replayed-secret');
      expect(replayCall.payload.output).toContain('[REDACTED:secret-key:');
      expect(replayCall.convoId).toBe(`parent:codex:${RUN_ID}`);

      const transcript = path.join(dir, `codex-${RUN_ID}.jsonl`);
      writeFileSync(transcript, `${JSON.stringify(commandEvent('printf live', 'COOKIE=live-secret'))}\n`, {
        flag: 'a',
      });
      await watcher.tails.get(RUN_ID).drain({ windowMs: 0 });
      const toolCalls = publisher.calls.filter(call => call.method === 'publishToolOutput');
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[1].payload.output).not.toContain('live-secret');
      expect(toolCalls[1].payload.output).toContain('[REDACTED:secret-key:');
    } finally {
      await watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses one production redactor for every publication route and the child title', () => {
    const publisher = makePublisher();
    const redact = createPublishRedactor({
      configPath: '/test/lesson_redactor.yaml',
      readFileSyncFn: () => POLICY,
    });
    const cases = [
      {
        route: 'command output',
        events: [commandEvent(`printf ${SENTINEL}`, `output=${SENTINEL}\nAPI_TOKEN=route-secret`)],
        method: 'publishToolOutput',
      },
      {
        route: 'file paths and diffs',
        events: [{
          type: 'item.completed',
          item: {
            id: 'file-1', type: 'file_change', status: 'completed',
            changes: [{
              kind: 'update',
              path: `/tmp/${SENTINEL}/API_TOKEN=route-secret`,
              diff: `+${SENTINEL}\n+API_TOKEN=route-secret`,
            }],
          },
        }],
        method: 'publishToolOutput',
      },
      {
        route: 'model metadata',
        meta: { schemaVersion: SCHEMA_VERSION, model: `model-${SENTINEL} API_TOKEN=route-secret` },
        events: [{ type: 'thread.started' }],
        method: 'publishStatus',
      },
      {
        route: 'reasoning activity',
        events: [{
          type: 'item.completed',
          item: {
            id: 'reason-1',
            type: 'reasoning',
            text: `thinking ${SENTINEL}\nAPI_TOKEN=route-secret`,
          },
        }],
        method: 'publishActivity',
      },
      {
        route: 'buffered final message',
        events: [
          {
            type: 'item.completed',
            item: {
              id: 'answer-1',
              type: 'agent_message',
              text: `${SENTINEL}\nAPI_TOKEN=route-secret`,
            },
          },
          { type: 'turn.completed' },
        ],
        method: 'publishText',
      },
    ];

    for (const testCase of cases) {
      const start = publisher.calls.length;
      const ctx = {
        publisher,
        convoId: `parent:codex:${RUN_ID}`,
        runId: RUN_ID,
        meta: testCase.meta ?? { schemaVersion: SCHEMA_VERSION },
        state: {},
        redact,
      };
      for (const event of testCase.events) redactAndRoute(event, ctx);
      const routeCalls = publisher.calls.slice(start);
      expect(routeCalls.some(call => call.method === testCase.method), testCase.route).toBe(true);
      expect(JSON.stringify(routeCalls), testCase.route).not.toContain(SENTINEL);
      expect(JSON.stringify(routeCalls), testCase.route).not.toContain('route-secret');
      expect(JSON.stringify(routeCalls), testCase.route).toContain('[REDACTED:test-token:');
      expect(JSON.stringify(routeCalls), testCase.route).toContain('[REDACTED:secret-key:');
    }

    const tracker = createCodexConvoTracker({
      sessionId: 'session-1',
      publisher,
      getParentConvoId: () => 'parent',
      redact,
    });
    const start = publisher.calls.length;
    tracker.ensureChild({ runId: RUN_ID, label: `review ${SENTINEL} API_TOKEN=route-secret` });
    const titleCalls = publisher.calls.slice(start);
    expect(titleCalls.some(call => call.method === 'upsertConvo')).toBe(true);
    expect(JSON.stringify(titleCalls)).not.toContain(SENTINEL);
    expect(JSON.stringify(titleCalls)).not.toContain('route-secret');
    expect(JSON.stringify(titleCalls)).toContain('[REDACTED:test-token:');
    expect(JSON.stringify(titleCalls)).toContain('[REDACTED:secret-key:');
  });
});
