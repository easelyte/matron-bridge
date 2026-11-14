import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createJournalMediaRouter } from '../lib/journal-media.js';
import { canSwitchAgent } from '../lib/agent-handoff.js';
import { planModeSwitch } from '../lib/session-mode.js';
import { planPrintModelSwitch } from '../lib/model-command.js';
import { INFLIGHT_MEDIA_REPLACE_REFUSAL } from '../lib/session-replace-guard.js';

const blocks = [{ type: 'text', text: 'saved attachment' }];
const media = { type: 'file', blobRef: 'upload', name: 'report.pdf' };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function harness(overrides = {}) {
  const session = { alive: true, agent: 'claude', claudeSessionId: 'provider', journalConvoId: 'conversation', _sessionConfirmed: true };
  const deps = {
    isCanonicalSession: s => s === session && s.alive,
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes') })),
    buildSavedBlocks: vi.fn(async () => blocks),
    injectBlocks: vi.fn(() => true), injectText: vi.fn(() => true),
    queueMedia: vi.fn(async () => {}), echoToRoom: vi.fn(), publishNotice: vi.fn(),
    log: { warn: vi.fn() }, ...overrides,
  };
  return { session, deps, route: createJournalMediaRouter(deps) };
}
afterEach(() => vi.useRealTimers());

describe('attachment preparation and delivery', () => {
  it('requires an explicit live-session predicate', () => {
    expect(() => createJournalMediaRouter()).toThrow('isCanonicalSession');
  });

  it('gates immediately, includes waiting frames, refreshes the window, and expires', async () => {
    let now = 0;
    const pending = deferred();
    const h = harness({ now: () => now, fetchMedia: () => pending.promise });
    const first = h.route(h.session, media);
    expect(h.route.hasInflightMedia(h.session)).toBe(true);
    now = 29_999;
    const second = h.route(h.session, media);
    now = 30_001;
    expect(h.route.hasInflightMedia(h.session)).toBe(true);
    now = 60_000;
    expect(h.route.hasInflightMedia(h.session)).toBe(false);
    pending.resolve({ buffer: Buffer.from('bytes') });
    await Promise.all([first, second]);
    expect(h.route.hasInflightMedia(h.session)).toBe(false);
    expect(h.deps.injectBlocks).toHaveBeenCalledTimes(2);
  });

  it('skips preparation when the session ended during download', async () => {
    const pending = deferred();
    const h = harness({ fetchMedia: () => pending.promise });
    const run = h.route(h.session, media);
    await Promise.resolve();
    h.session.alive = false;
    pending.resolve({ buffer: Buffer.from('bytes') });
    await run;
    expect(h.deps.buildSavedBlocks).not.toHaveBeenCalled();
    expect(h.deps.publishNotice).toHaveBeenCalledWith('conversation', expect.stringContaining('session ended'));
    expect(h.route.hasInflightMedia(h.session)).toBe(false);
  });

  it.each([false, true])('drops a transcript after replacement, with caption=%s', async caption => {
    const pending = deferred();
    const h = harness({ fetchTranscript: () => pending.promise });
    const run = h.route(h.session, { ...media, contentType: 'audio/mp4', caption: caption ? 'listen' : null });
    await Promise.resolve();
    h.session.alive = false;
    pending.resolve({ status: 'done', transcript: 'words' });
    await run;
    expect(h.deps.injectText).not.toHaveBeenCalled();
    expect(h.deps.injectBlocks).not.toHaveBeenCalled();
    expect(h.deps.queueMedia).not.toHaveBeenCalled();
    expect(h.deps.echoToRoom).toHaveBeenCalledTimes(1);
  });

  it('does not deliver blocks prepared for a session that ended meanwhile', async () => {
    const h = harness({ buildSavedBlocks: async () => { h.session.alive = false; return blocks; } });
    await h.route(h.session, media);
    expect(h.deps.injectBlocks).not.toHaveBeenCalled();
    expect(h.deps.queueMedia).not.toHaveBeenCalled();
    expect(h.deps.publishNotice).toHaveBeenCalledWith('conversation', expect.stringContaining('session ended'));
  });

  it('keeps an incomplete batch gated, then releases the gate when a stale partial batch is dropped', async () => {
    vi.useFakeTimers();
    const h = harness({ batchQuietMs: 100 });
    await h.route(h.session, { ...media, batch: { id: 'batch', index: 1, total: 2 } });
    expect(h.route.hasInflightMedia(h.session)).toBe(true);
    h.session.alive = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.deps.injectBlocks).not.toHaveBeenCalled();
    expect(h.route.hasInflightMedia(h.session)).toBe(false);
  });
});

describe('session replacement', () => {
  it('refuses provider, model, and mode replacement during preparation', () => {
    const { session } = harness();
    const options = { hasInflightMedia: true };
    for (const decision of [canSwitchAgent(session, 'codex', options), planPrintModelSwitch(session, 'sonnet', options), planModeSwitch(session, true, options)]) {
      expect(decision).toMatchObject({ ok: false, message: INFLIGHT_MEDIA_REPLACE_REFUSAL });
    }
    expect(planPrintModelSwitch({ ...session, busy: true }, 'sonnet', options).defer).toBe(true);
  });

  it('rechecks preparation at the shared teardown boundary', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('function recreateSession(');
    const end = source.indexOf('\n}', start) + 2;
    const sendReply = vi.fn();
    const context = vm.createContext({ sessions: new Map([['room', {}]]), mediaGateActive: () => true, INFLIGHT_MEDIA_REPLACE_REFUSAL });
    vm.runInContext(source.slice(start, end), context);
    expect(context.recreateSession('room', {}, { sendReply })).toBeNull();
    expect(sendReply).toHaveBeenCalledWith(INFLIGHT_MEDIA_REPLACE_REFUSAL);
  });

  const slice = (name, next) => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf(name);
    if (start < 0) return '';
    return source.slice(start, source.indexOf(next, start));
  };

  it('does not gate a replay of an already accepted deferred command', () => {
    const src = slice('function mediaGateActive(', 'function dispatchDeferredCommand(');
    let inflight = true;
    const context = vm.createContext({ journalMediaRouter: { hasInflightMedia: () => inflight } });
    vm.runInContext(src, context);
    expect(context.mediaGateActive({})).toBe(true);
    expect(context.mediaGateActive({ _replayingDeferred: true })).toBe(false);
    inflight = false;
    expect(context.mediaGateActive({})).toBe(false);
  });

  it('marks the replay for its whole duration and clears it afterwards', async () => {
    const src = slice('function dispatchDeferredCommand(', 'function finishCodexTurn(');
    const session = { alive: true, roomId: 'room', _deferredCommandText: '!restart --force' };
    let seen;
    const done = deferred();
    const context = vm.createContext({
      sessions: new Map([['room', session]]),
      journalSessionCommandCtx: () => ({ sendReply: () => {}, sendHtml: () => {}, sender: 's' }),
      handleCommand: () => { seen = session._replayingDeferred; return done.promise; },
    });
    vm.runInContext(src, context);
    expect(context.dispatchDeferredCommand(session)).toBe(true);
    expect(seen).toBe(true);
    done.resolve();
    await done.promise; await Promise.resolve(); await Promise.resolve();
    expect(session._replayingDeferred).toBe(false);
  });

  it('the restart command returns without a summary when recreateSession refuses', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(source).toContain('if (!restarted) return;\n      // Persist AFTER the recreate');
  });

  it('counts in-flight media as occupied in the Coordinator transition', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(source).toContain('occupied: sessionOccupiedForRoomDelivery(session) || mediaGateActive(session),');
  });
});
