// Behavioural tests for the /design auto-switch in journalRouteTextToSession.
// The real route and sendToSession are lifted out of index.js and run in a vm
// context; the mode switch itself (applyModeSwitch) and the other
// collaborators are fakes. design-login-flow.test.js pins the same branch by
// source text and the predicates by unit test; these drive the guards.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { designNeedsInteractive, DESIGN_SWITCH_ANNOUNCEMENT } from '../lib/design-login-flow.js';
import { sessionOccupied } from '../lib/restart-quiet.js';
import { effortFlowHoldsInput } from '../lib/session-mode.js';
import { markJournalOrigin } from '../lib/queue-flush.js';
import { cause, tagCauses, queueCauses } from '../lib/turn-cause.js';
import { hasQueuedCompact, isCompactCommand } from '../lib/compact-priority.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start === -1) start = source.indexOf(`\nasync function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.js`);
  start += 1;
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const LIFTED = ['journalRouteTextToSession', 'sendToSession', 'reportSessionSendFailure'];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'super']);
const BRIEF = '/design A sign-in screen for the mobile app';
const CAUSES = [cause('user_message', 'convo:7')];

function setup({ session: overrides = {} } = {}) {
  const lifted = LIFTED.map(sourceOf).join('\n');
  const session = {
    agent: 'claude', alive: true, busy: false, roomId: 'room', iv: null,
    proc: { stdin: { write: vi.fn(), writable: true } }, queuedMessages: null, queueNotifications: [],
    ...overrides,
  };
  const replies = [];
  const ctxObj = { sendReply: vi.fn(async (m) => { replies.push(m); }), sendHtml: vi.fn(), sender: 'user' };
  const sessions = new Map([[session.roomId, session]]);
  const explicit = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Map, Set, Promise, Math, Number, String, Object, Array, Boolean, Error,
    designNeedsInteractive, DESIGN_SWITCH_ANNOUNCEMENT, sessionOccupied, effortFlowHoldsInput,
    markJournalOrigin, tagCauses, queueCauses, hasQueuedCompact, isCompactCommand,
    AGENT_CLAUDE: 'claude', AGENT_CODEX: 'codex', CLAUDE_STEER_ENABLED: false,
    restartLatch: undefined, sessions,
    journalPublisher: { flushCursor: vi.fn() },
    journalSessionCommandCtx: () => ctxObj,
    journalConvoIdFor: () => 'convo',
    journalInputConsumer: Object.assign(vi.fn(), { queueRelease: null }),
    inflightMarker: { touch: vi.fn(), noteTurnStart: vi.fn(), noteTurnEnd: vi.fn() },
    dispatchJournalBridgeCommand: vi.fn(async () => false),
    dispatchPlanBuild: vi.fn(async () => false),
    dispatchJournalRescueKeystroke: vi.fn(async () => false),
    dispatchBusyQueueMagicWord: vi.fn(async () => false),
    runCodexControl: vi.fn(async () => false),
    isIvSlashPassthrough: () => false,
    trySteerEntry: vi.fn(() => false),
    notifyQueuedMessage: vi.fn(async () => {}),
    maybeResolveInteractivePrompt: vi.fn(() => false),
    sendTextToSession: vi.fn(() => true),
    // Passed by reference (not called) in the busy branch.
    formatQueueSummary: vi.fn(), clearQueueNotifications: vi.fn(), flushQueue: vi.fn(), emitRelease: vi.fn(),
    escapeHtml: (t) => t,
    applyModeSwitch: vi.fn(() => null),
  };
  // Every other collaborator is an inert stub: output and journal side
  // effects these tests do not assert on.
  const context = { ...explicit };
  for (const [, name] of lifted.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (KEYWORDS.has(name) || name in context || LIFTED.includes(name)) continue;
    context[name] = vi.fn();
  }
  for (const [name] of lifted.matchAll(/(?<![.\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g)) {
    if (!(name in context)) context[name] = null;
  }
  vm.createContext(context);
  vm.runInContext(lifted, context);
  return { session, sessions, context, replies, route: (text, opts) => context.journalRouteTextToSession(session, text, opts) };
}

// The route also guards on !effortFlowHoldsInput, but that hold needs a live
// iv while designNeedsInteractive needs none, so no real session reaches the
// switch with the hold set: the clause is defensive and cannot be driven here.
describe('/design auto-switch through journalRouteTextToSession', () => {
  it('leaves a busy session alone and queues the brief', async () => {
    const h = setup({ session: { busy: true } });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.context.applyModeSwitch).not.toHaveBeenCalled();
    expect(h.sessions.get('room')).toBe(h.session);
    expect(h.replies).toEqual([]);
    expect(h.session.queuedMessages).toHaveLength(1);
    expect(h.session.queuedMessages[0]).toEqual([{ type: 'text', text: BRIEF }]);
    expect(h.session.queuedMessages[0].cause).toEqual(CAUSES);
  });

  it.each([
    ['waiting on an answer', { waitingForAnswer: true }],
    ['an open prompt', { pendingInteractivePrompt: { kind: 'menu' } }],
    ['an unclassified menu', { pendingUnclassifiedPrompt: true }],
  ])('does not switch a print session with %s', async (_label, overrides) => {
    const h = setup({ session: overrides });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.context.applyModeSwitch).not.toHaveBeenCalled();
    expect(h.sessions.get('room')).toBe(h.session);
  });

  it('hands the brief to the new session\'s resume outbox with its causes', async () => {
    const h = setup();
    // The new interactive session as applyModeSwitch leaves it: alive,
    // registered in its room, and holding input until the TUI is ready.
    h.context.applyModeSwitch.mockImplementation((roomId, from, wantInteractive, { sendReply, announcement }) => {
      const next = { agent: 'claude', alive: true, roomId, iv: { alive: true }, _awaitingInputReady: true, _resumeOutbox: [] };
      h.sessions.set(roomId, next);
      sendReply(announcement);
      return next;
    });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.context.applyModeSwitch).toHaveBeenCalledOnce();
    expect(h.context.applyModeSwitch.mock.calls[0].slice(0, 3)).toEqual(['room', h.session, true]);
    expect(h.replies).toEqual([DESIGN_SWITCH_ANNOUNCEMENT]);
    const next = h.sessions.get('room');
    expect(next).not.toBe(h.session);
    expect(next._resumeOutbox).toHaveLength(1);
    expect(next._resumeOutbox[0]).toEqual([{ type: 'text', text: BRIEF }]);
    expect(next._resumeOutbox[0].cause).toEqual(CAUSES);
    // The old print session never saw the brief.
    expect(h.session.queuedMessages).toBe(null);
    expect(h.session.proc.stdin.write).not.toHaveBeenCalled();
  });

  it('says so when the switched session cannot take the brief', async () => {
    const h = setup();
    h.context.applyModeSwitch.mockImplementation((roomId, from, wantInteractive, { sendReply, announcement }) => {
      const next = { agent: 'claude', alive: false, roomId, iv: { alive: false }, _awaitingInputReady: true };
      h.sessions.set(roomId, next);
      sendReply(announcement);
      return next;
    });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.replies.at(-1)).toMatch(/couldn't hand it the brief — send \/design again/);
    expect(h.sessions.get('room')._resumeOutbox).toBeUndefined();
  });

  it('on a failed spawn replies and routes nothing to the dead session', async () => {
    const h = setup();
    const fallback = { agent: 'claude', alive: true, roomId: 'room', iv: null, queuedMessages: null, proc: { stdin: { write: vi.fn(), writable: true } } };
    h.context.applyModeSwitch.mockImplementation((roomId, from, wantInteractive, { sendReply }) => {
      // applyModeSwitch has already replaced the room's session with a print
      // fallback and told the user the spawn failed; it returns null.
      h.sessions.set(roomId, fallback);
      from.alive = false;
      sendReply('Could not start interactive mode; staying in print mode.');
      return null;
    });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.replies.at(-1)).toMatch(/Your design brief was not run\. Send \/design again/);
    // Nothing reached the dead session or its replacement.
    for (const s of [h.session, fallback]) {
      expect(s.queuedMessages).toBe(null);
      expect(s.proc.stdin.write).not.toHaveBeenCalled();
      expect(s._resumeOutbox).toBeUndefined();
    }
    expect(h.context.sendTextToSession).not.toHaveBeenCalled();
  });

  it('routes the text the ordinary way when the switch is refused', async () => {
    const h = setup();
    h.context.applyModeSwitch.mockImplementation((roomId, from, wantInteractive, { sendReply }) => {
      sendReply('Cannot switch right now.');
      return null;
    });
    await h.route(BRIEF, { causes: CAUSES });
    expect(h.replies).toEqual(['Cannot switch right now.']);
    expect(h.sessions.get('room')).toBe(h.session);
    // The brief still goes to the session as ordinary text, exactly once.
    expect(h.context.sendTextToSession).toHaveBeenCalledOnce();
    expect(h.context.sendTextToSession).toHaveBeenCalledWith(h.session, BRIEF, { skipJournalMirror: true, causes: CAUSES });
  });
});
