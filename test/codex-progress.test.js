import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CodexExecSession } from '../lib/codex-session.js';

// Exercise the real bridge handlers without importing index.js, whose
// top-level code connects to the journal and starts the production bridge.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  if (start < 0 || end < start) throw new Error(`Missing ${name}`);
  return source.slice(start, end);
}

function harness() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  const codex = new CodexExecSession({ spawnImpl: () => child });
  const received = [];
  const session = {
    alive: true, busy: true, codex, responseBuffer: '', toolCalls: [], chatHistory: [],
    queuedMessages: [{ text: 'follow up' }],
    sendCallback: text => received.push(text),
  };
  const activity = vi.fn((s, state) => { s._journalActivityState = state; });
  const context = vm.createContext({
    inflightMarker: { touch: vi.fn() },
    journalConvoIdFor: () => 'convo',
    journalActivity: activity,
    truncateActivityDetail: text => text,
    briefContextReport: () => null,
    recordConversationMessage: (s, role, text) => s.chatHistory.push({ role, text }),
    applyFallbackTitle: vi.fn(), SERVER_LABEL: 'bridge', updateRoomName: vi.fn(),
    splitMessage: text => [text],
    // Fork additions: flushResponse's fallback-title call passes the
    // activity-inferred repo (lib/repo-infer.js) + the default workdir.
    dominantRepo: () => null, DEFAULT_WORKDIR: '/workspace',
  });
  vm.runInContext(['codexToolIndicator', 'handleCodexEvent', 'flushResponse'].map(functionSource).join('\n'), context);
  codex.on('event', event => context.handleCodexEvent(session, event));
  const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
  codex.send([{ type: 'text', text: 'do the work' }]);
  return { child, codex, session, received, activity, emit, flush: () => context.flushResponse(session) };
}

const message = text => ({ type: 'item.completed', item: { type: 'agent_message', text } });

describe('Codex progress delivery', () => {
  it('delivers progress before tools finish without releasing the queued message', () => {
    const h = harness();
    h.emit(message('I am checking the bridge.'));
    expect(h.received).toEqual(['I am checking the bridge.']);
    h.emit({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } });
    expect(h.activity).toHaveBeenCalledWith(h.session, 'tool', '🔧 npm test');
    expect(h.session.busy).toBe(true);
    expect(h.codex.busy).toBe(true);
    expect(h.session.queuedMessages).toEqual([{ text: 'follow up' }]);
    expect(h.session.chatHistory).toEqual([{ role: 'assistant', text: 'I am checking the bridge.' }]);
  });

  it('delivers each complete message once, with no repeated output at turn end', () => {
    const h = harness();
    h.emit(message('Checking…'));
    h.emit(message('The fix is ready.'));
    h.emit({ type: 'turn.completed', usage: { input_tokens: 12 } });
    expect(h.received).toEqual(['Checking…', 'The fix is ready.']);
    expect(h.session._codexCompletedUsage).toEqual({ input_tokens: 12 });
    expect(h.codex.busy).toBe(true);
    h.child.emit('close', 0, null);
    h.flush();
    expect(h.received).toEqual(['Checking…', 'The fix is ready.']);
    expect(h.session.responseBuffer).toBe('');
  });

  it('does not publish buffered output from a stopped session', () => {
    const h = harness();
    h.session.alive = false;
    h.emit(message('Late output from the old child'));
    expect(h.received).toEqual([]);
    expect(h.session.chatHistory).toEqual([]);
    expect(h.session.responseBuffer).toBe('');
  });
});
