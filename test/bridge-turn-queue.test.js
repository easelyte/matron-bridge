// Bridge-originated turns (timers, reminders, carry-ons, auto-resume, wake,
// pre-reap compact, control compact) that land while a session is busy join
// the queue like any other message, but must never raise the "Send this
// queued message now?" card: that card is only for text a person typed.
//
// The real functions are lifted out of index.js and run in a vm context with
// stubbed collaborators, the same idiom as test/claude-steer-wiring.test.js.
// notifyQueuedMessage is the REAL one, so "no card" means the session's
// sendButtonMessage / sendReply were never called and the release registry
// was never told about a card.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { notifyQueuedMessage } from '../lib/busy-queue.js';
import { isBridgeOrigin, markBridgeOrigin, markJournalOrigin } from '../lib/queue-flush.js';
import { tagCauses, mergeCauses, plainCause } from '../lib/turn-cause.js';
import { hasQueuedCompact, isCompactCommand } from '../lib/compact-priority.js';
import { createWakeHandler } from '../lib/wake-route.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start === -1) start = source.indexOf(`\nasync function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.js`);
  start += 1;
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const LIFTED = [
  'journalRouteTextToSession', 'fireTimer', 'carryOnConvo', 'fireAutoResume',
  'drainPreReapCompact', 'requeueSteeredMessages', 'journalQueueMedia', 'deliverCoordinatorTurn',
  'queueSecretTurn', 'makeWakeHandler', 'applyControlSteps',
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'super']);

function setup({ busy = true } = {}) {
  const lifted = LIFTED.map(sourceOf).join('\n');
  const session = {
    agent: 'claude', alive: true, busy, roomId: 'room', queuedMessages: null, queueNotifications: [],
    sendButtonMessage: vi.fn(async () => 'event-id'),
  };
  const sendReply = vi.fn(async () => 'event-id');
  const queueRelease = { noteQueued: vi.fn() };
  const explicit = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Map, Set, Promise, Math, Number, String, Object, Array, Boolean, Error,
    setTimeout, clearTimeout,
    restartLatch: undefined,
    shuttingDown: false,
    plannedRestartRuntime: { stamped: false },
    AGENT_CODEX: 'codex',
    randomUUID: undefined,
    sessions: new Map([['room', session]]),
    notifyQueuedMessage, createWakeHandler,
    attachQueuedCleanup: vi.fn(),
    sessionOccupiedForRoomDelivery: (s) => !!s.busy,
    markJournalOrigin, markBridgeOrigin, isBridgeOrigin, tagCauses, mergeCauses, plainCause, hasQueuedCompact, isCompactCommand,
    requeuedSteerAt: new WeakMap(),
    journalInputConsumer: { queueRelease },
    journalConvoIdFor: () => 'convo',
    journalSessionCommandCtx: () => ({ sendReply, sendHtml: vi.fn(), sender: 'user' }),
    findSessionByClaudeSessionId: (id) => (id === 'convo' ? session : null),
    journalResumeConvo: () => null,
    accountLock: { hold: () => false },
    dispatchJournalBridgeCommand: vi.fn(async () => false),
    dispatchPlanBuild: vi.fn(async () => false),
    dispatchJournalRescueKeystroke: vi.fn(async () => false),
    dispatchBusyQueueMagicWord: vi.fn(async () => false),
    runCodexControl: vi.fn(async () => false),
    effortFlowHoldsInput: () => false,
    isIvSlashPassthrough: () => false,
    trySteerEntry: vi.fn(() => false),
    // Idle delivery: the turn starts, so the session is busy afterwards.
    sendTextToSession: vi.fn((s) => { s.busy = true; return true; }),
    formatTimerDuration: () => '1m',
    frameSafeBody: (t) => t,
    noticeMeta: () => null,
    controlOccupied: () => false,
    shouldCompactBefore: () => false,
    contextWindowForSession: () => 200000,
    preReapCompactCommand: () => '/compact',
    carryOnCause: () => plainCause('other'),
    AUTO_RESUME_TEXT: 'carry on',
    BAD_MODEL_RECOVERY_TEXT: 'recover',
    CLAUDE_STEER_ENABLED: false,
    escapeHtml: (t) => t, formatQueueSummary: vi.fn(), clearQueueNotifications: vi.fn(), emitRelease: vi.fn(), pendingFlushBatch: () => [], queueReleaseForBatch: () => null,
    QUEUE_EDIT_HOLD_MS: 60000,
    debug: () => {},
  };
  const context = { ...explicit };
  for (const [, name] of lifted.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (KEYWORDS.has(name) || name in context || LIFTED.includes(name)) continue;
    context[name] = vi.fn();
  }
  vm.createContext(context);
  vm.runInContext(lifted, context);
  return { session, context, sendReply, queueRelease };
}

// The card is a journal prompt (sendButtonMessage, the queued_release
// payload) or, without one, a plain reply; either way the registry hears of it.
function expectNoCard(h) {
  expect(h.session.sendButtonMessage).not.toHaveBeenCalled();
  expect(h.sendReply).not.toHaveBeenCalled();
  expect(h.queueRelease.noteQueued).not.toHaveBeenCalled();
}

// Queue and notification arrays move in lockstep, card or not: cancel and
// send_one address the queue by notification index.
function expectLockstep(h, expectedLength) {
  expect(h.session.queuedMessages).toHaveLength(expectedLength);
  expect(h.session.queueNotifications).toHaveLength(expectedLength);
}

const texts = (session) => session.queuedMessages.map((blocks) => blocks.map((b) => b.text).join(''));

describe('user-typed text still raises the card', () => {
  it('queues a typed message on a busy session with a queued_release card', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'please also check the logs');
    expect(texts(h.session)).toEqual(['please also check the logs']);
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    const payload = h.session.sendButtonMessage.mock.calls[0][5];
    expect(payload.kind).toBe('queued_release');
    expect(payload.question).toBe('Send this queued message now, or cancel it?');
    expectLockstep(h, 1);
  });

  it('still raises it for a typed message that follows a bridge turn', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'carry on', { bridgeOrigin: true });
    await h.context.journalRouteTextToSession(h.session, 'typed by a person');
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expect(h.session.sendButtonMessage.mock.calls[0][5].body).toContain('typed by a person');
    expectLockstep(h, 2);
  });
});

describe('bridge-originated injection paths raise no card', () => {
  it('journalRouteTextToSession with bridgeOrigin', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'ping', { bridgeOrigin: true });
    expect(texts(h.session)).toEqual(['ping']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a bridge text that spells a queue magic word is queued, not run as one', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'cancel', { bridgeOrigin: true });
    expect(h.context.dispatchBusyQueueMagicWord).not.toHaveBeenCalled();
    expect(texts(h.session)).toEqual(['cancel']);
  });

  it('a bridge /compact queued behind a typed message jumps the queue silently', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'typed');
    h.session.sendButtonMessage.mockClear();
    await h.context.journalRouteTextToSession(h.session, '/compact', { bridgeOrigin: true });
    expect(texts(h.session)).toEqual(['/compact', 'typed']);
    expect(h.session.sendButtonMessage).not.toHaveBeenCalled();
    expectLockstep(h, 2);
  });

  it('/timer fire', async () => {
    const h = setup();
    await h.context.fireTimer({ id: 1, convoId: 'convo', text: 'stand-up notes', createdAt: Date.now() });
    expect(texts(h.session)).toEqual(['stand-up notes']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('agent reminder fire', async () => {
    const h = setup();
    await h.context.fireTimer({ id: 2, convoId: 'convo', text: 'check the build', source: 'agent', createdAt: Date.now() });
    expect(h.session.queuedMessages).toHaveLength(1);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('crash-recovery and code-update carry-on (carryOnConvo)', async () => {
    const h = setup();
    await h.context.carryOnConvo('convo', h.session, null, 'carry on');
    expect(texts(h.session)).toEqual(['carry on']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('after-limit-reset carry-on whose preceding /compact started a turn', async () => {
    const h = setup({ busy: false });
    h.context.shouldCompactBefore = () => true;
    await h.context.fireAutoResume('room', 'convo', { kind: 'limit', text: 'carry on', source: 'coordinator' });
    // /compact went to the idle session and started a turn; the carry-on then
    // arrived while it was busy.
    expect(texts(h.session)).toEqual(['carry on']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('pre-reap handoff compact', async () => {
    const h = setup();
    h.session._preReapHandoff = { compactPending: true };
    h.context.drainPreReapCompact(h.session);
    await new Promise((r) => setTimeout(r, 0));
    expect(texts(h.session)).toEqual(['/compact']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a steered bridge message restored to the queue', async () => {
    const h = setup();
    const blocks = [{ type: 'text', text: 'Reminder: check progress' }];
    markBridgeOrigin(blocks);
    h.context.requeueSteeredMessages(h.session, [{ queuedEntries: [blocks], at: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.queuedMessages).toHaveLength(1);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a steered typed message restored to the queue keeps its card', async () => {
    const h = setup();
    h.context.requeueSteeredMessages(h.session, [{ queuedEntries: [[{ type: 'text', text: 'typed' }]], at: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expectLockstep(h, 1);
  });
});

describe('more bridge-originated paths raise no card', () => {
  it('Coordinator assign/release turn on a busy session (deliverCoordinatorTurn)', async () => {
    const h = setup();
    await h.context.deliverCoordinatorTurn(h.session, 'You are now the Coordinator.\nDetails follow.');
    expect(texts(h.session)).toEqual(['You are now the Coordinator.\nDetails follow.']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it.each([
    ['secret submitted', 'The secret was saved to a file.'],
    ['request expired', 'The secret request expired.'],
  ])('secret-request turn: %s', async (_name, text) => {
    const h = setup();
    await h.context.queueSecretTurn(h.session, { text, preview: text });
    expect(texts(h.session)).toEqual([text]);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('wake route', async () => {
    const h = setup();
    const handle = h.context.makeWakeHandler('convo', 'wake up');
    const res = await handle();
    expect(res.status).toBe(200);
    expect(texts(h.session)).toEqual(['wake up']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('control-plane compact step', async () => {
    const h = setup();
    const res = await h.context.applyControlSteps(h.session, [{ op: 'compact', command: '/compact keep the summary' }]);
    expect(res.ok).toBe(true);
    expect(texts(h.session)).toEqual(['/compact keep the summary']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('after-limit-reset /compact and carry-on both queued on a busy session', async () => {
    const h = setup();
    h.context.shouldCompactBefore = () => true;
    await h.context.fireAutoResume('room', 'convo', { kind: 'limit', text: 'carry on' });
    expect(texts(h.session)).toEqual(['/compact', 'carry on']);
    expectNoCard(h);
    expectLockstep(h, 2);
  });
});

describe('user-authored queue callers keep the card', () => {
  const media = [{ type: 'text', text: 'transcribed voice note' }];

  it('media and voice notes (queueMedia)', async () => {
    const h = setup();
    await h.context.journalQueueMedia(h.session, { blocks: media, mirrorToJournal: true, preview: 'voice note', fullText: 'voice note' });
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expect(h.session.sendButtonMessage.mock.calls[0][5].kind).toBe('queued_release');
    expectLockstep(h, 1);
  });

  it('tracker replies (queueText) keep the card and its resend edit', async () => {
    const h = setup();
    await h.context.journalQueueMedia(h.session, {
      blocks: media, mirrorToJournal: false, preview: 'reply', fullText: 'reply',
      source: { item_id: 'it_1', comment_id: 'c_1' },
    });
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expect(h.session.sendButtonMessage.mock.calls[0][5].edit.mode).toBe('resend');
    expectLockstep(h, 1);
  });
});
