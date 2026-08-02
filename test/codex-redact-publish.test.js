import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexWatcher, connectCodexWatcherPublisher } from '../lib/codex-watcher.js';
import { redactAndRoute } from '../lib/codex-event-format.js';
import { createPublishRedactor } from '../lib/redact.js';

const RUN_ID = '1722600000000-1234-abcd';
const SCHEMA_VERSION = 'codex-cli 0.146.0';
const SENTINEL = 'SENTINEL_CREDENTIAL';
const REDACTED = '[REDACTED:test]';

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
    publishStatus() {},
  };
}

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
      readFileSyncFn: () => [
        'patterns:',
        "  - name: test-token",
        "    regex: 'SENTINEL_[A-Z]+'",
      ].join('\n'),
    });

    expect(redact(SENTINEL)).toMatch(/^\[REDACTED:test-token:[0-9a-f]{8}\]$/);
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

  it('drops raw env-dump output instead of redacting it in place', () => {
    const publisher = makePublisher();
    const state = {};

    redactAndRoute(commandEvent('env', `API_TOKEN=${SENTINEL}`), {
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

  it('connects a tail replay to redacted journal publication inside isolation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-redact-publish-'));
    const publisher = makePublisher();
    const isolation = {
      guardRun: vi.fn((_runId, _entryPoint, operation) => operation()),
      auditStart: vi.fn(),
      requestTerminalization: vi.fn(),
      retryPending: vi.fn(),
    };
    class ReplayTail extends EventEmitter {
      async start() {
        this.emit('event', commandEvent('printf replay', `replayed=${SENTINEL}`));
      }
      async stop() {}
    }
    const watcher = new CodexWatcher({
      dir,
      sessionId: 'session-1',
      TailClass: ReplayTail,
      isolation,
      onDiscover: () => true,
    });
    writeFileSync(path.join(dir, `codex-${RUN_ID}.jsonl`), '');

    try {
      connectCodexWatcherPublisher(watcher, {
        publisher,
        convoIdFor: runId => `parent:codex:${runId}`,
        redact: replaceSentinel,
        log: { warn: vi.fn() },
      });
      watcher._discover({ runId: RUN_ID, schemaVersion: SCHEMA_VERSION });
      await watcher.attach(RUN_ID);

      expect(isolation.guardRun).toHaveBeenCalledWith(RUN_ID, 'publish', expect.any(Function));
      expect(publisher.calls[0].payload.output).toBe(`replayed=${REDACTED}`);
    } finally {
      await watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
