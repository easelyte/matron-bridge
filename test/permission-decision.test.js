import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSessionSettings } from '../lib/session-settings.js';
import { classifyPermission } from '../lib/permission-eval.js';
import {
  auditPermissionDecision,
  buildPermissionCardPayload,
  buildPermissionKey,
  createPermissionDecisionBodyCollector,
  createPermissionSeams,
  createRequestPermissionDecision,
  handlePermissionDecisionRoute,
  PERMISSION_DECISION_MAX_BODY_BYTES,
  PERMISSION_MAX_PENDING_GLOBAL,
  PERMISSION_MAX_PENDING_PER_CONVO,
} from '../lib/permission-registry.js';

const HOOK = path.resolve('hooks/permission-decision.sh');
const DEFAULT_INPUT = {
  session_id: 'session-1',
  tool_use_id: 'tool-1',
  tool_name: 'Bash',
  tool_input: { command: 'echo super-secret-value' },
};

let testDir;
let capturePath;

function runHook({ input = DEFAULT_INPUT, mode = 'allow', enabled = true } = {}) {
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MATRON_'))
  );
  const result = spawnSync(HOOK, [], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: {
      ...parentEnv,
      PATH: `${testDir}:${parentEnv.PATH}`,
      FAKE_CURL_MODE: mode,
      CURL_CAPTURE: capturePath,
      ...(enabled ? { MATRON_PERMISSION_CARDS: '1' } : {}),
    },
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result;
}

function permissionOutput(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

beforeEach(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'permission-hook-'));
  capturePath = path.join(testDir, 'curl-args');
  writeFileSync(path.join(testDir, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "$CURL_CAPTURE"

case "$FAKE_CURL_MODE" in
  unreachable) exit 7 ;;
  empty) printf '\\n200' ;;
  malformed) printf 'not-json\\n200' ;;
  non2xx) printf '{"decision":"allow","reason":"must not pass"}\\n503' ;;
  pass) printf '{"decision":"pass"}\\n200' ;;
  deny) printf '{"decision":"deny","reason":"operator denied"}\\n200' ;;
  *) printf '{"decision":"allow","reason":"operator allowed"}\\n200' ;;
esac
`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('permission-decision.sh', () => {
  it('passes through without contacting the bridge when permission cards are disabled', () => {
    const result = runHook({ enabled: false });

    expect(JSON.parse(result.stdout)).toEqual({});
    expect(existsSync(capturePath)).toBe(false);
  });

  it.each([
    ['unreachable', 'bridge unreachable or timed out'],
    ['empty', 'bridge returned an empty response'],
    ['malformed', 'bridge returned an invalid response'],
    ['non2xx', 'bridge returned HTTP status 503'],
  ])('fails closed for a %s bridge response', (mode, reason) => {
    const result = runHook({ mode });
    const output = permissionOutput(result.stdout);
    const audit = JSON.parse(result.stderr);

    expect(output).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
    expect(audit).toEqual({
      tool_use_id: 'tool-1',
      decision: 'deny',
      source: 'unreachable',
      reason,
    });
  });

  it('returns a valid allow decision and sends only non-secret tool identity', () => {
    const result = runHook();

    expect(permissionOutput(result.stdout)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'operator allowed',
    });

    const curlArgs = readFileSync(capturePath, 'utf8').trimEnd().split('\n');
    expect(curlArgs).toEqual([
      '-q',
      '-s',
      '--noproxy',
      '*',
      '--max-time',
      '1740',
      '-X',
      'POST',
      'http://127.0.0.1:9802/permission-decision',
      '-H',
      'Content-Type: application/json',
      '-d',
      '{"session_id":"session-1","tool_use_id":"tool-1","tool_name":"Bash"}',
      '--write-out',
      '\\n%{http_code}',
    ]);

    const rawBody = curlArgs[curlArgs.indexOf('-d') + 1];
    expect(JSON.parse(rawBody)).toEqual({
      session_id: 'session-1',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(rawBody).not.toContain('tool_input');
    expect(rawBody).not.toContain('super-secret-value');
  });

  it('returns a neutral hook result for a pass decision', () => {
    const result = runHook({ mode: 'pass' });

    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('returns a valid deny decision', () => {
    const result = runHook({ mode: 'deny' });

    expect(permissionOutput(result.stdout)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'operator denied',
    });
  });
});

describe('buildPermissionCardPayload', () => {
  it('builds a server-generic Allow/Deny card without tool argument values', () => {
    const tokenShapedArgumentValue = 'sk_live_argument_secret_123456789';
    const request = {
      tool_use_id: 'toolu_permission_1',
      tool_name: 'mcp__vercel__deploy_to_vercel',
      expires_at: 1_780_000_000_000,
      tool_input: { token: tokenShapedArgumentValue },
    };

    expect(buildPermissionCardPayload).toHaveLength(3);
    const payload = buildPermissionCardPayload(
      request.tool_use_id,
      request.tool_name,
      request.expires_at,
    );

    expect(payload).toEqual({
      kind: 'permission',
      tool_use_id: 'toolu_permission_1',
      description: 'Allow vercel tool "deploy_to_vercel"?',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
      expires_at: 1_780_000_000_000,
    });
    expect(payload.description).toContain('vercel');
    expect(payload.description).toContain('deploy_to_vercel');
    expect(payload.description).not.toContain('webflow');
    expect(JSON.stringify(payload)).not.toContain(tokenShapedArgumentValue);
    expect(JSON.stringify(payload)).not.toContain('tool_input');
  });

  it('falls back safely to the full unparseable tool name', () => {
    expect(buildPermissionCardPayload(
      'toolu_permission_2',
      'unqualified_tool_name',
      1_780_000_000_001,
    ).description).toBe('Allow tool "unqualified_tool_name"?');
  });
});

describe('permission hook session settings', () => {
  function parsedSettings(mode) {
    return JSON.parse(JSON.stringify(buildSessionSettings(mode)));
  }

  it('registers exactly one complete permission hook in print mode', () => {
    const preToolUse = parsedSettings('print').hooks.PreToolUse;
    const permissionRegistrations = preToolUse.flatMap(entry =>
      entry.hooks
        .filter(hook => hook.command.endsWith('permission-decision.sh'))
        .map(() => entry)
    );

    expect(permissionRegistrations).toHaveLength(1);
    expect(permissionRegistrations[0]).toEqual({
      matcher: 'mcp__.*',
      hooks: [{
        type: 'command',
        command: HOOK,
        timeout: 1800,
      }],
    });
  });

  it('does not register the permission hook in interactive mode', () => {
    const preToolUse = parsedSettings('iv').hooks.PreToolUse;

    expect(preToolUse.some(entry =>
      entry.hooks?.some(hook => hook.command.endsWith('permission-decision.sh'))
    )).toBe(false);
  });
});

describe('permission hook spawn environment wiring (source inspection)', () => {
  const indexSource = readFileSync(path.resolve('index.js'), 'utf8');
  const printSpawn = indexSource.slice(
    indexSource.indexOf('function createSession('),
    indexSource.indexOf('// --- Codex programmatic sessions ---')
  );
  const interactiveSpawn = indexSource.slice(
    indexSource.indexOf('function createInteractiveSessionForRoom('),
    indexSource.indexOf('// --- Structured Question Handling ---')
  );

  it('builds print spawn settings in print mode', () => {
    expect(printSpawn).toContain("'--settings', JSON.stringify(buildSessionSettings('print')),");
  });

  it('builds interactive spawn settings in iv mode', () => {
    expect(interactiveSpawn).toContain("'--settings', JSON.stringify(buildSessionSettings('iv')),");
  });

  it('snapshots MATRON_PERMISSION_CARDS only into the print spawn environment', () => {
    expect(printSpawn).toContain("MATRON_PERMISSION_CARDS: process.env.MATRON_PERMISSION_CARDS || '',");
    expect(interactiveSpawn).not.toContain('MATRON_PERMISSION_CARDS:');
  });
});

const INDEX_SOURCE = readFileSync(path.resolve('index.js'), 'utf8');
const handlePermissionDecisionRouteSource = handlePermissionDecisionRoute.toString();
const PRINT_SESSION_SOURCE = INDEX_SOURCE.slice(
  INDEX_SOURCE.indexOf('function createSession('),
  INDEX_SOURCE.indexOf('// --- Codex programmatic sessions ---'),
);
const INTERACTIVE_SESSION_SOURCE = INDEX_SOURCE.slice(
  INDEX_SOURCE.indexOf('function createInteractiveSessionForRoom('),
  INDEX_SOURCE.indexOf('// --- Structured Question Handling ---'),
);

const TOOL_NAME = 'mcp__server__tool';
const PENDING_KEY = buildPermissionKey('convo-1', 'tool-1');
const DEFAULT_GATED_SNAPSHOT = Object.freeze({
  mcpAllow: Object.freeze([]),
  mcpDeny: Object.freeze([]),
  mcpAsk: Object.freeze([]),
  uncertain: false,
});

function permissionSnapshotFor(classification) {
  return Object.freeze({
    mcpAllow: Object.freeze(classification === 'allow' ? [TOOL_NAME] : []),
    mcpDeny: Object.freeze(classification === 'deny' ? [TOOL_NAME] : []),
    mcpAsk: Object.freeze(classification === 'ask' ? [TOOL_NAME] : []),
    uncertain: false,
  });
}

async function openPermissionRouteHarness({
  snapshot = DEFAULT_GATED_SNAPSHOT,
  requestPermissionDecision = () => {},
  includeSession = true,
  includeHandler = true,
  classifyPermissionFn = classifyPermission,
  timeoutMs = 1000,
  initialPending = new Map(),
} = {}) {
  const pending = new Map(initialPending);
  const audits = [];
  const evictions = [];
  const target = {
    claudeSessionId: 'session-1',
    alive: true,
    permissionSnapshot: snapshot,
    ...(includeHandler ? { requestPermissionDecision } : {}),
  };
  const sessions = new Map(includeSession ? [['room-1', target]] : []);
  const auditPermissionDecisionFn = record => auditPermissionDecision(
    record,
    line => audits.push(JSON.parse(line)),
  );
  const permissionSeams = createPermissionSeams({ pendingPermissionDecisions: pending });
  const server = createServer((req, res) => {
    const bodyCollector = createPermissionDecisionBodyCollector({
      res,
      auditPermissionDecisionFn,
    });
    req.on('data', chunk => { bodyCollector.append(chunk); });
    req.on('end', () => {
      if (bodyCollector.tooLarge) return;
      handlePermissionDecisionRoute({
        body: bodyCollector.body,
        res,
        sessions,
        pendingPermissionDecisions: pending,
        classifyPermissionFn,
        journalConvoIdForFn: () => 'convo-1',
        evictPermissionSeq: (key, convoId) => evictions.push([key, convoId]),
        auditPermissionDecisionFn,
        timeoutMs,
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    audits,
    evictions,
    pending,
    ...permissionSeams,
    target,
    url: `http://127.0.0.1:${port}/permission-decision`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function postPermission(url, body = {}) {
  return postPermissionRaw(url, JSON.stringify(body));
}

async function postPermissionRaw(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, body: await response.json() };
}

function expectSingleAudit(harness, expected) {
  const expectedSessionId = Object.hasOwn(expected, 'session_id')
    ? expected.session_id
    : 'session-1';
  const expectedToolUseId = Object.hasOwn(expected, 'tool_use_id')
    ? expected.tool_use_id
    : 'tool-1';
  const expectedToolName = Object.hasOwn(expected, 'tool_name')
    ? expected.tool_name
    : TOOL_NAME;
  expect(harness.audits).toHaveLength(1);
  expect(harness.audits[0]).toEqual({
    event: 'permission_decision',
    session_id: expectedSessionId,
    tool_use_id: expectedToolUseId,
    seq: expected.seq ?? null,
    tool_name: expectedToolName,
    decision: expected.decision,
    source: expected.source,
    reason: expected.reason ?? '',
    ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  expect(harness.audits[0]).not.toHaveProperty('tool_input');
  expect(harness.audits[0]).not.toHaveProperty('executed');
}

describe('print session requestPermissionDecision', () => {
  it('publishes exactly one redacted permission request with the route deadline', () => {
    const session = { journalConvoId: 'convo-card' };
    const journalPublisher = { publishPermissionRequest: vi.fn() };
    const pendingPermissionDecisions = new Map();
    session.requestPermissionDecision = createRequestPermissionDecision(session, {
      journalPublisher,
      pendingPermissionDecisions,
      journalConvoIdFor: value => value?.journalConvoId || value?.claudeSessionId || null,
      timeoutMs: 1000,
    });

    session.requestPermissionDecision('tool-card', {
      tool_name: 'mcp__vercel__deploy_to_vercel',
      expires_at: 1_780_000_000_002,
      tool_input: { token: 'must-not-cross-the-card-boundary' },
    });

    expect(journalPublisher.publishPermissionRequest).toHaveBeenCalledOnce();
    expect(journalPublisher.publishPermissionRequest).toHaveBeenCalledWith('convo-card', {
      kind: 'permission',
      tool_use_id: 'tool-card',
      description: 'Allow vercel tool "deploy_to_vercel"?',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
      expires_at: 1_780_000_000_002,
    });
    expect(JSON.stringify(journalPublisher.publishPermissionRequest.mock.calls))
      .not.toContain('must-not-cross-the-card-boundary');
    expect(journalPublisher.publishPermissionRequest.mock.calls[0][1])
      .not.toHaveProperty('tool_input');
  });

  it('denies the matching pending entry when the session has no output channel', () => {
    const session = { claudeSessionId: 'session-no-channel' };
    const resolve = vi.fn();
    const pendingPermissionDecisions = new Map([
      [buildPermissionKey(null, 'tool-no-convo'), { resolve }],
    ]);
    const journalPublisher = { publishPermissionRequest: vi.fn() };
    session.requestPermissionDecision = createRequestPermissionDecision(session, {
      journalPublisher,
      pendingPermissionDecisions,
      journalConvoIdFor: () => null,
      timeoutMs: 1000,
    });

    session.requestPermissionDecision('tool-no-convo', { tool_name: TOOL_NAME });

    expect(journalPublisher.publishPermissionRequest).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      decision: 'deny',
      reason: 'no output channel for session',
      source: 'error',
    });
  });

  it('is attached to print sessions only', () => {
    expect(PRINT_SESSION_SOURCE).toContain(
      'session.requestPermissionDecision = createRequestPermissionDecision(session, {',
    );
    expect(INTERACTIVE_SESSION_SOURCE).not.toContain('createRequestPermissionDecision(');
  });
});

describe('/permission-decision route', () => {
  it('fails closed and audits malformed JSON exactly once', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    try {
      const result = await postPermissionRaw(harness.url, '{not json');

      expect(result).toEqual({
        status: 400,
        body: { decision: 'deny', reason: 'invalid json' },
      });
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        session_id: null,
        tool_use_id: null,
        tool_name: null,
        decision: 'deny',
        source: 'error',
        reason: 'invalid json',
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ['object', {}],
    ['array', []],
    ['boolean true', true],
    ['boolean false', false],
    ['whitespace', ' \t\n'],
  ])('fails closed when tool_use_id is a %s', async (_label, toolUseId) => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    try {
      const result = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: toolUseId,
        tool_name: TOOL_NAME,
      });

      expect(result).toEqual({
        status: 400,
        body: { decision: 'deny', reason: 'tool_use_id required' },
      });
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        tool_use_id: toolUseId,
        decision: 'deny',
        source: 'error',
        reason: 'tool_use_id required',
      });
    } finally {
      await harness.close();
    }
  });

  it('fails closed and audits exactly once when the request body exceeds 64 KiB', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    try {
      const result = await postPermissionRaw(
        harness.url,
        'x'.repeat(PERMISSION_DECISION_MAX_BODY_BYTES + 1),
      );

      expect(result).toEqual({
        status: 413,
        body: { decision: 'deny', reason: 'request too large' },
      });
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        session_id: null,
        tool_use_id: null,
        tool_name: null,
        decision: 'deny',
        source: 'error',
        reason: 'request too large',
      });
    } finally {
      await harness.close();
    }
  });

  it.each(['deny', 'ask'])('%s policy matches deny immediately without a card or pending entry', async classification => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({
      snapshot: permissionSnapshotFor(classification),
      requestPermissionDecision,
    });
    try {
      const result = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
        tool_input: { secret: 'must-not-be-read-or-audited' },
      });

      expect(result).toEqual({ status: 200, body: { decision: 'deny', reason: 'policy' } });
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([]);
      expectSingleAudit(harness, {
        decision: 'deny',
        source: 'policy-deny',
        reason: 'policy',
      });
      expect(JSON.stringify(harness.audits)).not.toContain('must-not-be-read-or-audited');
    } finally {
      await harness.close();
    }
  });

  it('passes an exact confident allow to the canonical evaluator without a card or pending entry', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({
      snapshot: permissionSnapshotFor('allow'),
      requestPermissionDecision,
    });
    try {
      const result = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
      });

      expect(result).toEqual({ status: 200, body: { decision: 'pass' } });
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        decision: 'pass',
        source: 'auto-allow',
        reason: 'passthrough to canonical evaluator',
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ['object', { malformed: true }],
    ['number', 42],
    ['missing', undefined],
  ])('fails closed when tool_name is %s', async (_label, toolName) => {
    const classifyPermissionFn = vi.fn(() => 'allow');
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({
      classifyPermissionFn,
      requestPermissionDecision,
    });
    try {
      const requestBody = {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        ...(toolName === undefined ? {} : { tool_name: toolName }),
      };
      const result = await postPermission(harness.url, requestBody);

      expect(result).toEqual({
        status: 400,
        body: { decision: 'deny', reason: 'tool_name required' },
      });
      expect(classifyPermissionFn).not.toHaveBeenCalled();
      expect(requestPermissionDecision).not.toHaveBeenCalled();
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        tool_name: null,
        decision: 'deny',
        source: 'error',
        reason: 'tool_name required',
      });
    } finally {
      await harness.close();
    }
  });

  it('registers default-gated requests before surfacing the card and survives normal request completion', async () => {
    let handlerEntered;
    const entered = new Promise(resolve => { handlerEntered = resolve; });
    const requestPermissionDecision = vi.fn(handlerEntered);
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    const now = 1_780_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const responsePromise = postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
      });
      await entered;
      dateNow.mockRestore();

      expect(requestPermissionDecision).toHaveBeenCalledWith('tool-1', {
        tool_name: TOOL_NAME,
        expires_at: now + 1000,
      });
      expect(harness.pending.has(PENDING_KEY)).toBe(true);
      expect(harness.pending.get(PENDING_KEY)).toMatchObject({
        expiresAt: now + 1000,
        seq: null,
        convoId: 'convo-1',
        tool_name: TOOL_NAME,
        resolve: expect.any(Function),
        timer: expect.anything(),
      });
      expect(harness.audits).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(harness.pending.has(PENDING_KEY)).toBe(true);

      const pending = harness.pending.get(PENDING_KEY);
      pending.seq = 42;
      harness.resolvePermissionReply(PENDING_KEY, 'allow');
      harness.resolvePermissionReply(PENDING_KEY, 'deny');

      await expect(responsePromise).resolves.toEqual({
        status: 200,
        body: { decision: 'allow', reason: '' },
      });
      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expectSingleAudit(harness, {
        seq: 42,
        decision: 'allow',
        source: 'operator',
      });
    } finally {
      dateNow.mockRestore();
      await harness.close();
    }
  });

  it('rejects duplicate live keys without overwriting the original and ignores its stale finalizer', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    const requestBody = {
      session_id: 'session-1',
      tool_use_id: 'tool-1',
      tool_name: TOOL_NAME,
    };
    try {
      const firstResponse = postPermission(harness.url, requestBody);
      await vi.waitFor(() => expect(requestPermissionDecision).toHaveBeenCalledOnce());
      const firstEntry = harness.pending.get(PENDING_KEY);

      const duplicateResponse = await postPermission(harness.url, requestBody);

      expect(duplicateResponse).toEqual({
        status: 200,
        body: { decision: 'deny', reason: 'duplicate pending decision' },
      });
      expect(requestPermissionDecision).toHaveBeenCalledOnce();
      expect(harness.pending.get(PENDING_KEY)).toBe(firstEntry);
      expect(harness.evictions).toEqual([]);
      expectSingleAudit(harness, {
        decision: 'deny',
        source: 'error',
        reason: 'duplicate pending decision',
      });

      harness.resolvePermissionReply(PENDING_KEY, 'allow');
      await expect(firstResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'allow', reason: '' },
      });
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expect(harness.audits[1]).toMatchObject({
        decision: 'allow',
        source: 'operator',
        reason: '',
      });

      const replacementResponse = postPermission(harness.url, requestBody);
      await vi.waitFor(() => {
        expect(requestPermissionDecision).toHaveBeenCalledTimes(2);
        expect(harness.pending.get(PENDING_KEY)).not.toBe(firstEntry);
      });
      const replacementEntry = harness.pending.get(PENDING_KEY);

      firstEntry.resolve({ decision: 'deny', reason: 'stale', source: 'timeout' });
      expect(harness.pending.get(PENDING_KEY)).toBe(replacementEntry);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expect(harness.audits).toHaveLength(2);

      harness.resolvePermissionReply(PENDING_KEY, 'deny');
      await expect(replacementResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'deny', reason: '' },
      });
      expect(harness.evictions).toEqual([
        [PENDING_KEY, 'convo-1'],
        [PENDING_KEY, 'convo-1'],
      ]);
      expect(harness.audits[2]).toMatchObject({
        decision: 'deny',
        source: 'operator',
        reason: '',
      });
      for (const audit of harness.audits) {
        expect(audit).not.toHaveProperty('tool_input');
        expect(audit).not.toHaveProperty('executed');
      }
    } finally {
      await harness.close();
    }
  });

  it('finalizes a conversation on teardown and admits an immediate resume of the same tuple', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision });
    const requestBody = {
      session_id: 'session-1',
      tool_use_id: 'tool-1',
      tool_name: TOOL_NAME,
    };
    try {
      const firstResponse = postPermission(harness.url, requestBody);
      await vi.waitFor(() => expect(requestPermissionDecision).toHaveBeenCalledOnce());
      harness.pending.get(PENDING_KEY).seq = 42;

      harness.finalizePendingPermissionsForConvo('convo-1', 'session ended');

      await expect(firstResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'deny', reason: 'session ended' },
      });
      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expectSingleAudit(harness, {
        seq: 42,
        decision: 'deny',
        source: 'disconnect',
        reason: 'session ended',
      });

      const resumedResponse = postPermission(harness.url, requestBody);
      await vi.waitFor(() => expect(requestPermissionDecision).toHaveBeenCalledTimes(2));
      expect(harness.pending.has(PENDING_KEY)).toBe(true);
      expect(harness.audits).toHaveLength(1);

      harness.resolvePermissionReply(PENDING_KEY, 'deny');
      await expect(resumedResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'deny', reason: '' },
      });
      expect(harness.audits[1]).toMatchObject({
        decision: 'deny',
        source: 'operator',
        reason: '',
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      name: 'per-conversation',
      cap: PERMISSION_MAX_PENDING_PER_CONVO,
      keyFor: index => buildPermissionKey('convo-1', `existing-${index}`),
    },
    {
      name: 'global',
      cap: PERMISSION_MAX_PENDING_GLOBAL,
      keyFor: index => buildPermissionKey(`other-convo-${index}`, 'existing'),
    },
  ])('fails closed at the $name pending cap and admits a new entry after finalize', async testCase => {
    const initialPending = new Map(
      Array.from({ length: testCase.cap - 1 }, (_, index) => [testCase.keyFor(index), {}]),
    );
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({
      initialPending,
      requestPermissionDecision,
    });
    const liveKey = buildPermissionKey('convo-1', 'live');
    const replacementKey = buildPermissionKey('convo-1', 'replacement');
    try {
      const liveResponse = postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'live',
        tool_name: TOOL_NAME,
      });
      await vi.waitFor(() => expect(requestPermissionDecision).toHaveBeenCalledOnce());
      expect(harness.pending.size).toBe(testCase.cap);

      const saturatedResponse = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'overflow',
        tool_name: TOOL_NAME,
      });
      expect(saturatedResponse).toEqual({
        status: 200,
        body: { decision: 'deny', reason: 'too many pending decisions' },
      });
      expect(requestPermissionDecision).toHaveBeenCalledOnce();
      expect(harness.pending.size).toBe(testCase.cap);
      expect(harness.pending.has(buildPermissionKey('convo-1', 'overflow'))).toBe(false);
      expectSingleAudit(harness, {
        tool_use_id: 'overflow',
        decision: 'deny',
        source: 'error',
        reason: 'too many pending decisions',
      });

      harness.resolvePermissionReply(liveKey, 'allow');
      await expect(liveResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'allow', reason: '' },
      });
      expect(harness.pending.size).toBe(testCase.cap - 1);

      const replacementResponse = postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'replacement',
        tool_name: TOOL_NAME,
      });
      await vi.waitFor(() => expect(requestPermissionDecision).toHaveBeenCalledTimes(2));
      expect(harness.pending.has(replacementKey)).toBe(true);
      expect(harness.pending.size).toBe(testCase.cap);

      harness.resolvePermissionReply(replacementKey, 'deny');
      await expect(replacementResponse).resolves.toEqual({
        status: 200,
        body: { decision: 'deny', reason: '' },
      });
      expect(harness.pending.size).toBe(testCase.cap - 1);
    } finally {
      await harness.close();
    }
  });

  it('fails closed on timeout and evicts the pending sequence exactly once', async () => {
    const requestPermissionDecision = vi.fn();
    const harness = await openPermissionRouteHarness({ requestPermissionDecision, timeoutMs: 10 });
    try {
      const result = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
      });

      expect(result).toEqual({ status: 200, body: { decision: 'deny', reason: 'timeout' } });
      expect(requestPermissionDecision).toHaveBeenCalledOnce();
      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expectSingleAudit(harness, { decision: 'deny', source: 'timeout', reason: 'timeout' });
    } finally {
      await harness.close();
    }
  });

  it('cleans up once when the real response socket closes before resolution', async () => {
    let handlerEntered;
    const entered = new Promise(resolve => { handlerEntered = resolve; });
    const harness = await openPermissionRouteHarness({
      requestPermissionDecision: vi.fn(handlerEntered),
      timeoutMs: 100,
    });
    try {
      const clientRequest = request(harness.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      clientRequest.on('error', () => {});
      clientRequest.end(JSON.stringify({
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
      }));
      await entered;
      const pending = harness.pending.get(PENDING_KEY);

      clientRequest.destroy();
      await vi.waitFor(() => expect(harness.audits).toHaveLength(1));
      pending.resolve({ decision: 'allow', source: 'operator' });
      await new Promise(resolve => setTimeout(resolve, 120));

      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expectSingleAudit(harness, {
        decision: 'deny',
        source: 'disconnect',
        reason: 'client disconnect',
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      name: 'missing tool_use_id',
      harness: {},
      request: { session_id: 'session-1', tool_name: TOOL_NAME },
      status: 400,
      reason: 'tool_use_id required',
      audit: { tool_use_id: null },
    },
    {
      name: 'unknown session',
      harness: { includeSession: false },
      request: { session_id: 'missing', tool_use_id: 'tool-1', tool_name: TOOL_NAME },
      status: 404,
      reason: 'unknown session',
      audit: { session_id: 'missing' },
    },
    {
      name: 'non-string session_id',
      harness: {},
      request: { session_id: { malformed: true }, tool_use_id: 'tool-1', tool_name: TOOL_NAME },
      status: 404,
      reason: 'unknown session',
      audit: { session_id: { malformed: true } },
    },
    {
      name: 'missing permission handler',
      harness: { includeHandler: false },
      request: { session_id: 'session-1', tool_use_id: 'tool-1', tool_name: TOOL_NAME },
      status: 503,
      reason: 'no permission handler',
      audit: {},
    },
  ])('fails closed and audits a $name', async testCase => {
    const harness = await openPermissionRouteHarness(testCase.harness);
    try {
      const result = await postPermission(harness.url, testCase.request);

      expect(result).toEqual({
        status: testCase.status,
        body: { decision: 'deny', reason: testCase.reason },
      });
      expect(harness.pending.size).toBe(0);
      expectSingleAudit(harness, {
        decision: 'deny',
        source: 'error',
        reason: testCase.reason,
        ...testCase.audit,
      });
    } finally {
      await harness.close();
    }
  });

  it('fails closed through the finalizer when the session handler throws', async () => {
    const harness = await openPermissionRouteHarness({
      requestPermissionDecision: () => { throw new Error('card failed'); },
    });
    try {
      const result = await postPermission(harness.url, {
        session_id: 'session-1',
        tool_use_id: 'tool-1',
        tool_name: TOOL_NAME,
      });

      expect(result).toEqual({
        status: 200,
        body: { decision: 'deny', reason: 'session handler threw: card failed' },
      });
      expect(harness.pending.size).toBe(0);
      expect(harness.evictions).toEqual([[PENDING_KEY, 'convo-1']]);
      expectSingleAudit(harness, {
        decision: 'deny',
        source: 'error',
        reason: 'session handler threw: card failed',
      });
    } finally {
      await harness.close();
    }
  });

  it('uses the reviewed production deadline and listens for disconnects on the response only', () => {
    expect(INDEX_SOURCE).toContain('const PERMISSION_DECISION_TIMEOUT_MS = 1680 * 1000;');
    expect(handlePermissionDecisionRouteSource).toContain("res.on('close'");
    expect(handlePermissionDecisionRouteSource).not.toContain("req.on('close'");
    expect(INDEX_SOURCE).toContain('createPermissionDecisionBodyCollector({');
    expect(INDEX_SOURCE).toContain("if (url.pathname === '/permission-decision') {");
  });

  it('finalizes pending conversation decisions before terminal router eviction', () => {
    const teardownSource = INDEX_SOURCE.slice(
      INDEX_SOURCE.indexOf('function journalEvictConvoInput(session)'),
      INDEX_SOURCE.indexOf('// Plan approval for the `build` keyword'),
    );
    const finalizeIndex = teardownSource.indexOf(
      "permissionSeams.finalizePendingPermissionsForConvo(convoId, 'session ended');",
    );
    const evictIndex = teardownSource.indexOf('journalInputConsumer.evictConvo(convoId, {');

    expect(finalizeIndex).toBeGreaterThan(-1);
    expect(evictIndex).toBeGreaterThan(finalizeIndex);
  });
});
