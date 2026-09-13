import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexExecSession,
  buildCodexExecArgs,
  contentBlocksToCodexPrompt,
  normalizeCodexSandbox,
  normalizeCodexNetworkAccess,
} from '../lib/codex-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('Codex programmatic session', () => {
  it('builds initial and resume argv with explicit non-interactive safety settings', () => {
    expect(buildCodexExecArgs({ sandbox: 'workspace-write', model: 'gpt-test' })).toEqual([
      'exec', '--json', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="workspace-write"',
      '--model', 'gpt-test', '-',
    ]);
    expect(buildCodexExecArgs({ threadId: 'thread-1' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="workspace-write"',
      'thread-1', '-',
    ]);
  });

  it('falls back to workspace-write for an invalid sandbox', () => {
    expect(normalizeCodexSandbox('root-everything')).toBe('workspace-write');
  });

  it('inherits network policy unless explicitly configured', () => {
    expect(normalizeCodexNetworkAccess(undefined)).toBeNull();
    expect(normalizeCodexNetworkAccess('')).toBeNull();
    expect(normalizeCodexNetworkAccess('invalid')).toBeNull();
    expect(normalizeCodexNetworkAccess(' TRUE ')).toBe(true);
    expect(normalizeCodexNetworkAccess(false)).toBe(false);
    expect(buildCodexExecArgs().join(' ')).not.toContain('network_access');
  });

  it('sets network access on initial and resumed turns without widening the filesystem sandbox', () => {
    for (const threadId of [null, 'thread-1']) {
      for (const networkAccess of [true, false]) {
        const args = buildCodexExecArgs({ threadId, networkAccess });
        expect(args).toContain(`sandbox_workspace_write.network_access=${networkAccess}`);
        expect(args).toContain('sandbox_mode="workspace-write"');
        expect(args).toContain('approval_policy="never"');
      }
    }
    for (const sandbox of ['read-only', 'danger-full-access']) {
      expect(buildCodexExecArgs({ sandbox, networkAccess: true }).join(' ')).not.toContain('network_access');
    }
  });

  it('carries the network setting from the session adapter into each spawn', () => {
    const child = fakeChild();
    const children = [child, fakeChild()];
    const spawnImpl = vi.fn(() => children.shift());
    const session = new CodexExecSession({ cwd: '/repo', networkAccess: true, spawnImpl });
    session.send([{ type: 'text', text: 'first turn' }]);
    child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
    child.emit('close', 0, null);
    session.send([{ type: 'text', text: 'resumed turn' }]);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    for (const [, args] of spawnImpl.mock.calls) {
      expect(args).toContain('sandbox_workspace_write.network_access=true');
    }
    expect(spawnImpl.mock.calls[1][1]).toContain('resume');
  });

  it('turns only text blocks into the stdin prompt', () => {
    expect(contentBlocksToCodexPrompt([
      { type: 'text', text: 'Image saved to /tmp/a.png' },
      { type: 'image', source: { data: 'base64' } },
      { type: 'text', text: 'describe it' },
    ])).toBe('Image saved to /tmp/a.png\n\ndescribe it');
  });

  it('streams JSONL events, captures the thread id, and resumes on the next turn', async () => {
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const children = [firstChild, secondChild];
    const spawnImpl = vi.fn(() => children.shift());
    const session = new CodexExecSession({ cwd: '/repo', spawnImpl });
    const events = [];
    session.on('event', event => events.push(event));

    let firstPrompt = '';
    firstChild.stdin.on('data', chunk => { firstPrompt += chunk; });
    expect(session.send([{ type: 'text', text: 'first turn' }])).toBe(true);
    firstChild.stdout.write('{"type":"thread.started","thread_id":"abc-123"}\n');
    firstChild.stdout.write('{"type":"turn.completed","usage":{"input_tokens":2}}\n');
    firstChild.emit('close', 0, null);
    await new Promise(resolve => setImmediate(resolve));

    expect(firstPrompt).toBe('first turn');
    expect(session.threadId).toBe('abc-123');
    expect(events.map(event => event.type)).toEqual(['thread.started', 'turn.completed']);

    expect(session.send([{ type: 'text', text: 'second turn' }])).toBe(true);
    expect(spawnImpl.mock.calls[1][1]).toContain('resume');
    expect(spawnImpl.mock.calls[1][1]).toContain('abc-123');
  });

  it('refuses concurrent turns and interrupts the active child', () => {
    const child = fakeChild();
    const session = new CodexExecSession({ cwd: '/repo', spawnImpl: () => child });
    expect(session.send([{ type: 'text', text: 'go' }])).toBe(true);
    expect(session.send([{ type: 'text', text: 'too soon' }])).toBe(false);
    expect(session.interrupt()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('preserves UTF-8 characters split across pipe reads, including the final line', () => {
    const child = fakeChild();
    const session = new CodexExecSession({ spawnImpl: () => child });
    const events = [];
    const exits = [];
    session.on('event', event => events.push(event));
    session.on('turn-exit', event => exits.push(event));
    session.send([{ type: 'text', text: 'go' }]);
    const text = 'Checking café — 日本語 🔧';
    const event = { type: 'item.completed', item: { type: 'agent_message', text } };
    const bytes = Buffer.from(JSON.stringify(event) + '\n{"type":"turn.completed"}');
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    for (const byte of Buffer.from(text)) child.stderr.write(Buffer.from([byte]));
    expect(events).toEqual([event]);
    child.emit('close', 0, null);
    expect(events).toEqual([event, { type: 'turn.completed' }]);
    expect(exits[0]).toMatchObject({ stderr: text, sawTurnCompleted: true });
  });

  it('recovers after malformed JSON and holds the process slot until close', () => {
    const child = fakeChild();
    const session = new CodexExecSession({ spawnImpl: () => child });
    const errors = vi.fn();
    const events = vi.fn();
    session.on('parse-error', errors);
    session.on('event', events);
    session.send([{ type: 'text', text: 'go' }]);
    child.stdout.write('not json\n{"type":"turn.completed"}\n');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({ type: 'turn.completed' });
    expect(session.busy).toBe(true);
    expect(session.send([{ type: 'text', text: 'next' }])).toBe(false);
    child.emit('close', 0, null);
    expect(session.busy).toBe(false);
  });

  it('contains a closed input pipe and allows the next turn after child exit', () => {
    const child = fakeChild();
    const nextChild = fakeChild();
    const spawnImpl = vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(nextChild);
    const session = new CodexExecSession({ spawnImpl });
    const errors = vi.fn();
    session.on('spawn-error', errors);
    session.send([{ type: 'text', text: 'go' }]);
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => child.stdin.emit('error', error)).not.toThrow();
    expect(errors).toHaveBeenCalledWith(error);
    expect(session.lastError).toBe(error);
    expect(session.busy).toBe(true);
    child.emit('close', 1, null);
    expect(session.send([{ type: 'text', text: 'retry' }])).toBe(true);
    expect(session.lastError).toBeNull();
    child.stdin.emit('error', error);
    expect(session.lastError).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('terminates a child if writing the prompt throws synchronously', () => {
    const child = fakeChild();
    const error = new Error('stdin is closed');
    child.stdin.end = () => { throw error; };
    const session = new CodexExecSession({ spawnImpl: () => child });
    const errors = vi.fn();
    session.on('spawn-error', errors);
    expect(session.send([{ type: 'text', text: 'go' }])).toBe(true);
    expect(errors).toHaveBeenCalledWith(error);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.busy).toBe(true);
    child.emit('close', null, 'SIGTERM');
    expect(session.busy).toBe(false);
  });

  it('bounds diagnostics while retaining the final error', () => {
    const child = fakeChild();
    const session = new CodexExecSession({ spawnImpl: () => child });
    const exits = vi.fn();
    session.on('turn-exit', exits);
    session.send([{ type: 'text', text: 'go' }]);
    child.stderr.write('x'.repeat(128 * 1024));
    child.stderr.write('\nCould not authenticate');
    child.emit('close', 1, null);
    expect(exits.mock.calls[0][0].stderr).toHaveLength(64 * 1024);
    expect(exits.mock.calls[0][0].stderr).toMatch(/Could not authenticate$/);
  });

  it('exposes a synchronous spawn failure before returning false', async () => {
    const error = new Error('spawn codex ENOENT');
    const session = new CodexExecSession({
      cwd: '/repo',
      spawnImpl: () => { throw error; },
    });
    const onSpawnError = vi.fn();
    session.on('spawn-error', onSpawnError);

    expect(session.send([{ type: 'text', text: 'go' }])).toBe(false);
    expect(session.lastError).toBe(error);

    await Promise.resolve();
    expect(onSpawnError).toHaveBeenCalledWith(error);
  });
});

describe('Codex bridge wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('reports rejected dispatches as failures and gates downstream work', () => {
    const start = src.indexOf('function sendToSession(');
    const end = src.indexOf('\nfunction sendTextToSession(', start);
    const body = src.slice(start, end);

    expect(body).toMatch(
      /session\.agent === AGENT_CODEX[\s\S]*return reportSessionSendFailure\([\s\S]*const sent = [^\n]*session\.codex\?\.send/,
    );
    expect(body).toMatch(/if \(sent\) \{[\s\S]*commitDispatchedUserTurn/);
    expect(body).toMatch(/if \(!sent\) \{[\s\S]*return reportSessionSendFailure/);

    const reportStart = src.indexOf('function reportSessionSendFailure(');
    const reportEnd = src.indexOf('\nfunction flushResponse(', reportStart);
    const reporter = src.slice(reportStart, reportEnd);
    expect(reporter).toMatch(/session\.sendHtml[\s\S]*session\.sendCallback/);
    expect(reporter).toContain('return false');
    expect(reporter).not.toContain('_sendFailureReported');
  });

  it('refreshes the persisted native thread ID without replacing a stable journal ID', () => {
    const start = src.indexOf('function handleCodexEvent(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);

    expect(body).toContain('session.claudeSessionId !== event.thread_id');
    expect(body).toContain('session.claudeSessionId = event.thread_id');
    expect(body).toContain('if (!session.journalConvoId) session.journalConvoId = event.thread_id');
    expect(body).toContain('persistSession(session.roomId, event.thread_id');
  });

  it('rejects media-only interactive turns before buffering or applying a handoff', () => {
    const start = src.indexOf('function sendToSession(');
    const end = src.indexOf('\nfunction sendTextToSession(', start);
    const body = src.slice(start, end);
    const validation = body.indexOf('if (session.iv && !historyText)');
    const resumeHold = body.indexOf('if (session._awaitingInputReady)');
    const handoff = body.indexOf('applyPendingAgentHandoff(session, contentBlocks)');

    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(resumeHold);
    expect(validation).toBeLessThan(handoff);
    expect(body.slice(validation, resumeHold)).toContain('return reportSessionSendFailure');
  });

  it('finishes killed Codex turns without flushing partial output or queued work', () => {
    const exitStart = src.indexOf("codex.on('turn-exit'");
    const exitEnd = src.indexOf('\n  });', exitStart) + 6;
    const exitBody = src.slice(exitStart, exitEnd);
    expect(exitBody).not.toContain('!session.alive || session._codexTurnFinished');
    expect(exitBody).toContain('discardOutput: true');

    const killStart = src.indexOf('function killSession(');
    const killEnd = src.indexOf('\nfunction ', killStart + 1);
    const killBody = src.slice(killStart, killEnd);
    expect(killBody).toContain('finishCodexTurn(session');
    expect(killBody).toContain('preserveQueue');
    expect(killBody.indexOf('finishCodexTurn(session')).toBeLessThan(killBody.indexOf('session.codex.kill(signal)'));

    const recreateStart = src.indexOf('function recreateSession(');
    const recreateEnd = src.indexOf('\nfunction ', recreateStart + 1);
    const recreateBody = src.slice(recreateStart, recreateEnd);
    expect(recreateBody).toContain("killSession(existing, 'SIGTERM', { preserveQueue: true })");
    expect(recreateBody).toContain('flushPendingSessionQueue(next)');
  });

  it('keeps Codex model defaults provider-local across recreation', () => {
    const createStart = src.indexOf('function createCodexSessionForRoom(');
    const createEnd = src.indexOf('\nfunction ', createStart + 1);
    const createBody = src.slice(createStart, createEnd);
    expect(createBody).toContain('getPersistedAgentState(persisted, AGENT_CODEX');
    expect(createBody).toContain('persistedCodexState.model');
    expect(createBody).not.toContain('persisted?.model');

    const recreateStart = src.indexOf('function recreateSession(');
    const recreateEnd = src.indexOf('\nfunction ', recreateStart + 1);
    const recreateBody = src.slice(recreateStart, recreateEnd);
    expect(recreateBody).toMatch(
      /model: existing\.agent === AGENT_CODEX[\s\S]*\? existing\.currentModel[\s\S]*: \(existing\.currentModel \|\| undefined\)/,
    );
  });

  it('does not overwrite an established same-provider ID with a pre-init null', () => {
    const start = src.indexOf('function persistSession(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);

    expect(body).toContain('resolveNativeSessionIdForPersistence');
    expect(body).toContain('state = { ...state, sessionId: effectiveSessionId }');
    expect(body).toContain('sessionId: effectiveSessionId');
  });
});
