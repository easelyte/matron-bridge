import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCodexConvoTracker } from '../lib/codex-convos.js';
import { redactAndRoute } from '../lib/codex-event-format.js';
import { setupCodexWatcherForSession } from '../lib/codex-watcher-setup.js';
import { createPublishRedactor, resolveRedactorConfigPath } from '../lib/redact.js';

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
  it('uses the policy shape and hashed replacement format', () => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });

    expect(redact(SENTINEL)).toMatch(/^\[REDACTED:test-token:[0-9a-f]{8}\]$/);
  });

  it('does not classify ordinary identifier collisions as secret keys', () => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });

    expect(redact('author=Alice\nsession_count=4\ncookiecutter=yes')).toBe(
      'author=Alice\nsession_count=4\ncookiecutter=yes',
    );
    expect(redact('AUTH=hidden\nGOOGLE_TOKEN=hidden')).not.toContain('=hidden');
  });

  it('applies the built-in baseline when no policy is configured', () => {
    // With no policy file the redactor still runs the built-in secret-key /
    // private-key-PEM / env-dump belt. It never reads from disk in this mode.
    const reads = [];
    const redact = createPublishRedactor({
      env: {},
      readFileSyncFn: file => {
        reads.push(file);
        return '';
      },
    });
    expect(redact('API_KEY=unstructured-value')).not.toContain('unstructured-value');
    expect(redact('GOOGLE_TOKEN=ya29.a0AfH6SMB-example_token')).not.toContain('ya29.');
    expect(redact('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'))
      .toContain('[REDACTED:private-key-pem:');
    // The baseline is key-oriented: an ordinary identifier is left intact.
    expect(redact('author=Alice')).toBe('author=Alice');
    expect(reads).toEqual([]);
  });

  it('layers optional policy value-patterns on top of the baseline', () => {
    // An optional YAML policy adds value-format rules (bare tokens with no
    // key=) on top of the built-in belt, with the hashed replacement format.
    const policy = [
      'patterns:',
      '  - name: aws-access-key-id',
      "    regex: 'AKIA[0-9A-Z]{16}'",
      '  - name: github-token',
      "    regex: 'ghp_[A-Za-z0-9]{36}'",
    ].join('\n');
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => policy,
    });
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toMatch(/^\[REDACTED:aws-access-key-id:[0-9a-f]{8}\]$/);
    expect(redact(`ghp_${'c'.repeat(36)}`)).toMatch(/^\[REDACTED:github-token:[0-9a-f]{8}\]$/);
    // The built-in belt still fires alongside the extra patterns.
    expect(redact('API_KEY=unstructured-value')).not.toContain('unstructured-value');
  });

  it('resolves an explicit tilde config, an env override, and a workspace root', () => {
    // Explicit configPath wins and tilde-expands.
    expect(resolveRedactorConfigPath({
      workspaceRoot: '/some/workspace',
      configPath: '~/policy/redactor.yaml',
      homedir: '/home/tester',
      env: {},
    })).toBe('/home/tester/policy/redactor.yaml');
    // The MATRON_REDACTOR_CONFIG env var is honored when no configPath is given.
    expect(resolveRedactorConfigPath({
      homedir: '/home/tester',
      env: { MATRON_REDACTOR_CONFIG: '/etc/matron/redactor.yaml' },
    })).toBe('/etc/matron/redactor.yaml');
    // A workspaceRoot supplies a conventional location.
    expect(resolveRedactorConfigPath({
      workspaceRoot: '/some/workspace',
      homedir: '/home/tester',
      env: {},
    })).toBe('/some/workspace/config/redactor.yaml');
    // With nothing configured there is no path (baseline-only mode).
    expect(resolveRedactorConfigPath({ homedir: '/home/tester', env: {} })).toBeNull();

    // Baseline-only redactor never touches the filesystem.
    const reads = [];
    const redact = createPublishRedactor({
      homedir: '/home/tester',
      env: {},
      readFileSyncFn: file => {
        reads.push(file);
        return POLICY;
      },
    });
    redact('safe');
    expect(reads).toEqual([]);
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
  ])('fails closed for %s instead of applying a partial policy', (_label, policy) => {
    const log = { error: vi.fn() };
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => policy,
      log,
    });
    expect(() => redact(SENTINEL)).toThrow('publish redactor config failed');
    expect(() => redact('safe')).toThrow('publish redactor is unavailable');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it.each([
    ['whitespace', '\\s+', ' \t'],
    ['word boundary', '\\btoken\\b', 'token'],
    ['digit and word classes', '\\d+\\w+', '12abc'],
    ['negative lookahead', 'sk-(?!ant-)[A-Za-z0-9]{4}', 'sk-abcd'],
    ['inline case flag', 'prefix(?i)token', 'PREFIXTOKEN'],
  ])('translates canonical Python regex feature %s', (_label, regex, sample) => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => ['patterns:', '  - name: translated', `    regex: '${regex}'`].join('\n'),
    });
    expect(redact(sample)).toMatch(/^\[REDACTED:translated:[0-9a-f]{8}\]$/);
  });

  it('keys the redaction marker so it correlates within a run but is not a plaintext fingerprint', () => {
    const redact = createPublishRedactor({});
    const first = redact('password=hunter2');
    const second = redact('password=hunter2');
    const marker = /\[REDACTED:secret-key:([0-9a-f]{8})\]/.exec(first)?.[1];

    expect(marker).toMatch(/^[0-9a-f]{8}$/);
    // Identical secret -> identical marker within the process: the useful property.
    expect(second).toBe(first);
    // ...but the marker is an HMAC under a per-process key, not a bare sha256
    // prefix of the plaintext, so it can't be brute-forced offline from the journal.
    const plaintextFingerprint = createHash('sha256').update('hunter2', 'utf8').digest('hex').slice(0, 8);
    expect(marker).not.toBe(plaintextFingerprint);
  });

  const makeOversizeRedactor = (overrides = {}) => createPublishRedactor({
    configPath: '/test/redactor.yaml',
    readFileSyncFn: () => ['patterns:', '  - name: cc', '    regex: SECRETVAL'].join('\n'),
    maxOperatorPatternBytes: 32,
    ...overrides,
  });

  it('defaults to fail-closed truncate over the size threshold: drops the un-vetted tail', () => {
    const log = { warn: vi.fn() };
    const redact = makeOversizeRedactor({ log });

    // A secret past the bound (after 64 chars) must NOT publish once the payload is
    // over the operator-pattern limit — the old fail-open let it through.
    const oversize = `${'x'.repeat(64)}\npassword=hunter2\nSECRETVAL`;
    const out = redact(oversize);
    expect(out).not.toContain('SECRETVAL');
    expect(out).toContain('[REDACTED-OVERSIZE:');
    expect(log.warn).toHaveBeenCalledOnce();

    // A second oversize input does not warn again.
    redact(`${oversize}\nmore`);
    expect(log.warn).toHaveBeenCalledOnce();

    // A small input still runs the operator pattern in full.
    expect(redact('SECRETVAL')).toMatch(/^\[REDACTED:cc:[0-9a-f]{8}\]$/);
  });

  it('truncate still fully redacts operator secrets that fall within the bounded head', () => {
    const redact = makeOversizeRedactor();
    // SECRETVAL sits in the first 32 chars → inside the head → redacted; tail dropped.
    const out = redact(`SECRETVAL\n${'x'.repeat(200)}`);
    expect(out).not.toContain('SECRETVAL');
    expect(out).toMatch(/\[REDACTED:cc:[0-9a-f]{8}\]/);
    expect(out).toContain('[REDACTED-OVERSIZE:');
  });

  it("oversizePolicy 'drop' withholds the whole payload", () => {
    const redact = makeOversizeRedactor({ oversizePolicy: 'drop' });
    const out = redact(`${'x'.repeat(64)}\nSECRETVAL`);
    expect(out).not.toContain('SECRETVAL');
    expect(out).not.toContain('x'.repeat(64));
    expect(out).toMatch(/^\[REDACTED-OVERSIZE: \d+B payload withheld/);
  });

  it("oversizePolicy 'skip' preserves the legacy fail-open behavior (opt-in)", () => {
    const redact = makeOversizeRedactor({ oversizePolicy: 'skip' });
    const oversize = `${'x'.repeat(64)}\npassword=hunter2\nSECRETVAL`;
    const out = redact(oversize);
    // Legacy: operator pattern skipped so SECRETVAL survives, baseline still redacts.
    expect(out).toContain('SECRETVAL');
    expect(out).toContain('[REDACTED:secret-key:');
  });

  it('reads the oversize policy from MATRON_REDACT_OVERSIZE_POLICY when no explicit option is set', () => {
    const redact = makeOversizeRedactor({ env: { MATRON_REDACT_OVERSIZE_POLICY: 'skip' } });
    const out = redact(`${'x'.repeat(64)}\nSECRETVAL`);
    expect(out).toContain('SECRETVAL'); // env-selected 'skip' → operator pattern skipped
  });

  it('measures the bound in UTF-8 bytes, not UTF-16 code units', () => {
    const redact = makeOversizeRedactor(); // 32-byte bound
    // 30 three-byte chars = 30 code units (< 32) but 90 UTF-8 bytes (> 32). A
    // code-unit check would wrongly treat this as under the bound.
    const out = redact('中'.repeat(30));
    expect(out).toContain('[REDACTED-OVERSIZE:'); // detected as oversize despite <32 code units
  });

  it('drops a secret that straddles the truncation cut — never a partial prefix', () => {
    const redact = makeOversizeRedactor(); // 32-byte bound
    // The safe head ends at the last newline within the bound (byte 9). SECRETVAL
    // begins after it, so it lands entirely in the dropped tail.
    const out = redact(`8 chars.\nSECRETVAL${'x'.repeat(80)}`);
    expect(out).not.toContain('SECRET'); // not even a prefix of the secret leaks
    expect(out).toContain('[REDACTED-OVERSIZE:');
  });

  it('drops the whole payload (empty head) when no newline fits in the bound', () => {
    const redact = makeOversizeRedactor(); // 32-byte bound
    const out = redact(`${'x'.repeat(64)}\nSECRETVAL`); // no newline in the first 32 bytes
    expect(out).not.toContain('x'.repeat(64));
    expect(out).not.toContain('SECRETVAL');
    expect(out.startsWith('[REDACTED-OVERSIZE:')).toBe(true); // annotation only, no partial line
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

  it('preserves the real unpinned schema and safely publishes new textual diagnostics', () => {
    const publisher = makePublisher();
    const log = { warn: vi.fn() };

    redactAndRoute({
      type: 'item.completed',
      item: {
        type: 'future_answer',
        answer: `result ${SENTINEL}`,
        newBinaryShape: { raw: SENTINEL },
      },
    }, {
      publisher,
      convoId: `parent:codex:${RUN_ID}`,
      runId: RUN_ID,
      meta: { schemaVersion: 'codex-cli 0.999.0' },
      state: {},
      redact: replaceSentinel,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('codex-cli 0.999.0'));
    const body = publisher.calls.find(call => call.method === 'publishText')?.payload.body;
    expect(body).toContain(REDACTED);
    expect(body).toContain('future_answer');
    expect(body).not.toContain(SENTINEL);
    expect(body).not.toContain('newBinaryShape');
  });

  it.each([
    ['env | sort', `API_TOKEN=${SENTINEL}`],
    ['env -0', `API_TOKEN=${SENTINEL}`],
    ['printenv | cat', `API_TOKEN=${SENTINEL}`],
    ['printenv --null', `API_TOKEN=${SENTINEL}`],
    ['command env', `API_TOKEN=${SENTINEL}`],
    ['/usr/bin/env', `API_TOKEN=${SENTINEL}`],
    ['set', `API_TOKEN=${SENTINEL}`],
    ['export', `API_TOKEN=${SENTINEL}`],
    ['export -p', `API_TOKEN=${SENTINEL}`],
    ['declare -x', 'declare -x PRIVATE_KEY="pem-material"'],
    ['declare -x | grep PRIVATE_KEY', 'declare -x PRIVATE_KEY="pem-material"'],
    ["python -c 'import os; print(os.environ)'", "{'HARMLESS_NAME': 'one-line-secret'}"],
    ["python3 -c 'import os; print(os.environ)'", "{'HARMLESS_NAME': 'one-line-secret'}"],
    ["node -e 'console.log(process.env)'", 'HARMLESS_NAME=one-line-secret'],
    ["node -p 'process.env'", 'HARMLESS_NAME=one-line-secret'],
    ["/usr/bin/bash -lc 'env'", `API_TOKEN=${SENTINEL}`],
    ['bash -c env | grep DATABASE_PASSWORD', 'DATABASE_PASSWORD=hunter2'],
    ["sh -lc 'printenv | grep API_TOKEN'", `API_TOKEN=${SENTINEL}`],
    ['printenv DATABASE_PASSWORD', 'hunter2'],
    ['echo $AWS_SECRET_ACCESS_KEY', 'AKIA-secret-value'],
    ['echo "${AUTH_TOKEN}"', 'opaque-value'],
    ["node -p 'process.env[\"API_KEY\"]'", 'opaque-value'],
    ["python -c 'import os; print(os.getenv(\"AUTH_TOKEN\"))'", 'opaque-value'],
    ['unknown-diagnostic', `API_TOKEN=${SENTINEL}\nDATABASE_PASSWORD=hunter2\nHOME=/root\nPATH=/bin`],
    ['unknown-diagnostic', `HOME=/root\0PATH=/bin\0API_TOKEN=${SENTINEL}`],
    ['cat /proc/self/environ', `HOME=/root\0API_TOKEN=${SENTINEL}\0PATH=/bin`],
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

  it('redacts a secret-key assignment after a harmless NUL-delimited segment', () => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });
    const output = redact('HOME=/root\0API_TOKEN=unstructured-secret\0PATH=/bin');

    expect(output).not.toContain('unstructured-secret');
    expect(output).toContain('HOME=/root\0API_TOKEN=[REDACTED:secret-key:');
    expect(output).toContain('\0PATH=/bin');
  });

  it.each([
    ['space-separated', 'curl --password hunter2 https://x', 'hunter2'],
    ['equals-separated', 'curl --password=hunter2 https://x', 'hunter2'],
    ['single-dash long flag', 'tool -token opaque-secret-value', 'opaque-secret-value'],
    ['hyphenated key suffix', 'svc --api-key abc123def --verbose', 'abc123def'],
    ['auth flag mid-command', 'mytool --auth Bearer-xyz next-arg', 'Bearer-xyz'],
    ['quoted value with spaces', 'cmd --secret "s3 cr3t val" tail', 's3 cr3t val'],
  ])('redacts a secret-named CLI flag value (%s)', (_label, input, secret) => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });
    const output = redact(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED:secret-key:');
  });

  it('leaves non-secret CLI flags and their values untouched', () => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });
    const input = 'curl --output result.json --retry 3 https://example.com';
    expect(redact(input)).toBe(input);
  });

  it.each([
    [
      'a multiline dotenv quoted value',
      'API_TOKEN="dotenv-first\ndotenv-second"\nSAFE=value',
      ['dotenv-first', 'dotenv-second'],
    ],
    [
      'a JSON secret value spanning a line boundary',
      '{\n  "API_TOKEN":\n    "json-first\njson-second",\n  "safe": true\n}',
      ['json-first', 'json-second'],
    ],
    [
      'a YAML block scalar secret',
      'safe: value\nAPI_TOKEN: |-\n  yaml-first\n  yaml-second\nnext: value\n',
      ['yaml-first', 'yaml-second'],
    ],
    [
      'a PEM private key block',
      'before\n-----BEGIN PRIVATE KEY-----\npem-first\npem-second\n-----END PRIVATE KEY-----\nafter',
      ['pem-first', 'pem-second', '-----END PRIVATE KEY-----'],
    ],
  ])('fully redacts %s before line-oriented handling', (_label, input, secrets) => {
    const redact = createPublishRedactor({
      configPath: '/test/redactor.yaml',
      readFileSyncFn: () => POLICY,
    });
    const output = redact(input);

    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED:');
  });

  it.each([
    ['env NODE_ENV=test npm test', 'test suite passed'],
    ['printenv HOME', '/home/tester'],
    ['export NAME=value', ''],
    ['declare -x NAME=value', ''],
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

  it('uses the side-effect-free production setup with tracker, canonical redactor, and isolation for replay and live tail', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-redact-publish-'));
    const publisher = makePublisher();
    const liveSession = {
      roomId: 'room-1',
      claudeSessionId: 'session-1',
      journalConvoId: 'parent',
    };
    writeFileSync(path.join(dir, `codex-${RUN_ID}.meta.json`), JSON.stringify({
      runId: RUN_ID,
      wrapperPid: process.pid,
      wrapperStartTicks: 'test',
      deadlineTs: Date.now() + 60_000,
      schemaVersion: SCHEMA_VERSION,
    }));
    writeFileSync(
      path.join(dir, `codex-${RUN_ID}.jsonl`),
      [
        commandEvent('printf replay', 'API_TOKEN=replayed-secret'),
        { type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: 'replayed final answer' } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n',
    );
    const watcher = setupCodexWatcherForSession(liveSession, dir, 'session-1', {
      publisher,
      liveSessions: new Map([['room-1', liveSession]]),
      watcherOptions: {
        dir,
        pollIntervalMs: 60_000,
        isWrapperAliveFn: () => true,
      },
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      watcherDependencies: { env: { MATRON_CODEX_VIZ: '1' }, detectProducer: () => true },
    });

    try {
      expect(liveSession.codexConvos).toBeDefined();
      expect(liveSession.codexWatcherIsolation).toBeDefined();
      expect(watcher.isolation).toBe(liveSession.codexWatcherIsolation);
      await vi.waitFor(() => expect(watcher.started).toBe(true));
      await vi.waitFor(() => {
        expect(publisher.calls.some(call => call.method === 'publishToolOutput')).toBe(true);
        expect(publisher.calls.some(call => call.method === 'publishText')).toBe(true);
      });
      const replayCall = publisher.calls.find(call => call.method === 'publishToolOutput');
      expect(replayCall.payload.output).not.toContain('replayed-secret');
      expect(replayCall.payload.output).toContain('[REDACTED:secret-key:');
      expect(replayCall.convoId).toBe(`parent:codex:${RUN_ID}`);
      expect(publisher.calls).toContainEqual(expect.objectContaining({
        method: 'publishText',
        convoId: `parent:codex:${RUN_ID}`,
        payload: expect.objectContaining({ body: 'replayed final answer' }),
      }));

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
      configPath: '/test/redactor.yaml',
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
