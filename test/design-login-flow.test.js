import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DESIGN_LOGIN_COMMAND,
  classifyDesignLoginOutput,
  designLoginCodeRefused,
  designLoginOutcomeMessage,
  ownsDesignLoginFinish,
} from '../lib/design-login-flow.js';
import { BRIDGE_COMMAND_NAMES, classifyBridgeCommand } from '../lib/command-dispatch.js';

// Screens as Claude Code's /design-login renders them (ANSI already stripped).
const SIGN_IN_SCREEN = [
  '❯ /design-login',
  'Design login',
  'Authorize design-system access (read and write your organization\'s claude.ai/design projects) with your claude.ai',
  ' Browser didn\'t open? Use the url below to sign in (c to copy)',
  'https://auth.example.test/oauth/authorize?code=true&client_id=x&response_type=code',
  ' ·  Waiting for browser authorization…',
  ' Paste code here if prompted >',
  ' Esc to cancel',
].join('\n');

describe('classifyDesignLoginOutput', () => {
  it('is null while the sign-in screen waits', () => {
    expect(classifyDesignLoginOutput(SIGN_IN_SCREEN)).toBe(null);
  });

  it('reads the success result line', () => {
    expect(classifyDesignLoginOutput(`${SIGN_IN_SCREEN}\n  ⎿  Design-system access authorized. /design-sync can now reach your claude.ai/design projects.\n❯ `))
      .toBe('authorized');
  });

  it('reads cancel and failure lines', () => {
    expect(classifyDesignLoginOutput('❯ /design-login\n  ⎿  Design login cancelled.\n❯')).toBe('cancelled');
    expect(classifyDesignLoginOutput('  ⎿  Design login failed: network error')).toBe('failed');
    expect(classifyDesignLoginOutput('Design login was interrupted.')).toBe('failed');
    expect(classifyDesignLoginOutput('The browser authorization timed out after 5 minutes. Retry, or run /design-login for the manual flow.'))
      .toBe('failed');
    expect(classifyDesignLoginOutput('/design-login isn\'t available in this environment.')).toBe('failed');
  });

  it('matches letter-spaced shimmer output', () => {
    expect(classifyDesignLoginOutput('D e s i g n - s y s t e m   a c c e s s   a u t h o r i z e d .')).toBe('authorized');
  });

  it('ignores an earlier attempt\'s result repainted above the live sign-in screen', () => {
    const repaint = `❯ /design-login\n  ⎿  Design-system access authorized.\n${SIGN_IN_SCREEN}`;
    expect(classifyDesignLoginOutput(repaint)).toBe(null);
    expect(classifyDesignLoginOutput(`${repaint}\n  ⎿  Design login cancelled.`)).toBe('cancelled');
  });

  it('does not treat the /design-sync hint as a result', () => {
    expect(classifyDesignLoginOutput('Authorize design-system access for /design-sync with your claude.ai account')).toBe(null);
  });
});

describe('designLoginCodeRefused', () => {
  it('spots the refused-code screen', () => {
    expect(designLoginCodeRefused(' That code wasn\'t accepted. It may be incomplete, expired, already used.\n Press Enter to retry, or any other key to cancel.'))
      .toBe(true);
    expect(designLoginCodeRefused(SIGN_IN_SCREEN)).toBe(false);
  });

  it('spots a code pasted without its state half', () => {
    expect(designLoginCodeRefused(`${SIGN_IN_SCREEN}\n Invalid code. Please make sure the full code was copied.\n Press Enter to retry.`))
      .toBe(true);
  });

  it('ignores a refusal repainted above a fresh sign-in screen', () => {
    expect(designLoginCodeRefused(` That code wasn't accepted.\n${SIGN_IN_SCREEN}`)).toBe(false);
  });
});

describe('designLoginOutcomeMessage', () => {
  it('says the mode returns only for a borrowed session', () => {
    expect(designLoginOutcomeMessage('authorized')).toMatch(/authorized — back to normal mode\.$/);
    expect(designLoginOutcomeMessage('authorized', { returning: false })).toBe('✅ Claude Design access authorized.');
  });

  it('points a failure or timeout at a retry', () => {
    expect(designLoginOutcomeMessage('failed')).toMatch(/Send \/design-login to try again\./);
    expect(designLoginOutcomeMessage(null)).toMatch(/didn't finish in time/);
  });
});

describe('ownsDesignLoginFinish', () => {
  const flow = {};
  it('owns the room while the live session holds the same attempt token', () => {
    expect(ownsDesignLoginFinish({ alive: true, _designLoginFlow: flow }, flow)).toBe(true);
  });
  it('a retry on the same TUI replaces the token, so the older finish lets go', () => {
    expect(ownsDesignLoginFinish({ alive: true, _designLoginFlow: {} }, flow)).toBe(false);
  });
  it('an abandoned flow or a /login meanwhile leaves no token', () => {
    expect(ownsDesignLoginFinish({ alive: true, _designLoginFlow: null }, flow)).toBe(false);
    expect(ownsDesignLoginFinish({ alive: true }, flow)).toBe(false);
  });
  it('a dead or missing session is never owned', () => {
    expect(ownsDesignLoginFinish({ alive: false, _designLoginFlow: flow }, flow)).toBe(false);
    expect(ownsDesignLoginFinish(undefined, flow)).toBe(false);
    expect(ownsDesignLoginFinish({ alive: true, _designLoginFlow: undefined }, undefined)).toBe(false);
  });
  it('a replacement that carried the token over still owns it', () => {
    const replacement = { alive: true, _designLoginFlow: flow, iv: {} };
    expect(ownsDesignLoginFinish(replacement, flow)).toBe(true);
  });
});

describe('/design-login routing', () => {
  it('is a bridge command', () => {
    expect(BRIDGE_COMMAND_NAMES.has('design-login')).toBe(true);
    expect(classifyBridgeCommand('/design-login')).toBe('!design-login');
    expect(DESIGN_LOGIN_COMMAND).toBe('/design-login');
  });

  it('leaves /design and /design-sync to the ordinary route', () => {
    expect(classifyBridgeCommand('/design a sign-in screen')).toBe(null);
    expect(classifyBridgeCommand('/design-sync')).toBe(null);
  });
});

describe('sign-in relay fixes', async () => {
  const { signInDialogHoldsInput } = await import('../lib/design-login-flow.js');

  it('holds bridge-generated input while a sign-in dialog is open', () => {
    expect(signInDialogHoldsInput({ iv: {}, _designLoginWatch: { stop() {} } })).toBe(true);
    // A /login borrow flag alone is not an open dialog: a cancelled /login
    // keeps it, and notes must not wait on that.
    expect(signInDialogHoldsInput({ iv: {}, _accountFlowReturnToPrint: true })).toBe(false);
    expect(signInDialogHoldsInput({ iv: {} })).toBe(false);
    expect(signInDialogHoldsInput({ iv: null, _designLoginWatch: {} })).toBe(false);
  });
});

describe('designLoginEndsPhantomTurn', async () => {
  const { designLoginEndsPhantomTurn } = await import('../lib/design-login-flow.js');
  const busy = { alive: true, iv: {}, busy: true };
  it('clears the busy mark the pasted code left', () => {
    expect(designLoginEndsPhantomTurn(busy)).toBe(true);
  });
  it('leaves a real wait alone', () => {
    expect(designLoginEndsPhantomTurn({ ...busy, pendingInteractivePrompt: {} })).toBe(false);
    expect(designLoginEndsPhantomTurn({ ...busy, waitingForAnswer: true })).toBe(false);
    expect(designLoginEndsPhantomTurn({ ...busy, busy: false })).toBe(false);
    expect(designLoginEndsPhantomTurn({ ...busy, iv: null })).toBe(false);
  });
  // Runs the real watch + release functions from index.js on a fake PTY.
  it('ends the phantom turn on a result, and holds room input on a refusal', async () => {
    const { runInNewContext } = await import('node:vm');
    const { EventEmitter } = await import('node:events');
    const prompt = await import('../lib/prompt-detector.js');
    const flowLib = await import('../lib/design-login-flow.js');
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    const start = src.indexOf('function armDesignLoginWatch(');
    const end = src.indexOf('function scheduleDesignLoginFinish(');
    const flushed = [];
    const finishes = [];
    const ended = [];
    const ctx = {
      ...flowLib, stripAnsi: prompt.stripAnsi, findInputCue: prompt.findInputCue,
      setTimeout, clearTimeout, debug: () => {},
      DESIGN_LOGIN_WATCH_CAP_MS: 60000, DESIGN_LOGIN_NO_SCREEN_MS: 60000, DESIGN_LOGIN_SETTLE_MS: 5, DESIGN_LOGIN_BUFFER_LIMIT: 65536,
      LOGIN_RETURN_TO_PRINT_DELAY_MS: 1,
      scheduleDesignLoginFinish: (...a) => finishes.push(a),
      endTurn: s => { s.currentTurn = null; },
      inflightMarker: { noteTurnEnd: id => ended.push(id) },
      journalConvoIdFor: () => 'c1', journalSessionState: () => {}, journalActivity: () => {},
      maybeFlushRoomDelivery: s => flushed.push(s),
      flushPendingSessionQueue: s => { queueFlushes.push(s); return false; },
    };
    const queueFlushes = [];
    const { arm } = runInNewContext(`${src.slice(start, end)}\n({ arm: armDesignLoginWatch })`, ctx);
    const iv = new EventEmitter();
    const session = { roomId: 'r', alive: true, iv, sendCallback: () => {} };
    arm(session);
    const wait = () => new Promise(r => setTimeout(r, 30));
    // The user pastes a wrong code: the paste began a turn.
    session.busy = true; session.currentTurn = { causes: [] };
    iv.emit('pty-data', " That code wasn't accepted.\n Press Enter to retry, or any other key to cancel.");
    await wait();
    expect(session.busy).toBe(false);
    expect(session.currentTurn).toBe(null);
    expect(flushed).toEqual([]);
    // The retry's code is right.
    session.busy = true; session.currentTurn = { causes: [] };
    iv.emit('pty-data', '\n Browser didn\'t open? Paste code here if prompted >\n  ⎿  Design-system access authorized.');
    await wait();
    expect(session.busy).toBe(false);
    expect(session.currentTurn).toBe(null);
    // Dialog closed: the user queue drains first, then room input.
    expect(queueFlushes[0]).toBe(session);
    expect(flushed[0]).toBe(session);
    expect(ended.length).toBe(2);
    expect(finishes.length).toBe(1);
  });

  // A CLI build without /design-login never paints a sign-in screen.
  it.each([
    ['no sign-in screen shows', null, 'unrecognised'],
    ['a sign-in screen showed', 'Waiting for browser authorization…', null],
  ])('releases the watch when %s within the window', async (_name, screen, expected) => {
    const { runInNewContext } = await import('node:vm');
    const { EventEmitter } = await import('node:events');
    const prompt = await import('../lib/prompt-detector.js');
    const flowLib = await import('../lib/design-login-flow.js');
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    const start = src.indexOf('function armDesignLoginWatch(');
    const end = src.indexOf('function scheduleDesignLoginFinish(');
    const finishes = [];
    const flushed = [];
    const ctx = {
      ...flowLib, stripAnsi: prompt.stripAnsi, findInputCue: prompt.findInputCue,
      setTimeout, clearTimeout, debug: () => {},
      DESIGN_LOGIN_WATCH_CAP_MS: 60000, DESIGN_LOGIN_NO_SCREEN_MS: 60, DESIGN_LOGIN_SETTLE_MS: 5, DESIGN_LOGIN_BUFFER_LIMIT: 65536,
      scheduleDesignLoginFinish: (...a) => finishes.push(a),
      endTurn: () => {}, inflightMarker: { noteTurnEnd: () => {} },
      journalConvoIdFor: () => 'c1', journalSessionState: () => {}, journalActivity: () => {},
      maybeFlushRoomDelivery: s => flushed.push(s), flushPendingSessionQueue: () => false,
    };
    const { arm } = runInNewContext(`${src.slice(start, end)}\n({ arm: armDesignLoginWatch })`, ctx);
    const iv = new EventEmitter();
    const session = { roomId: 'r', alive: true, iv, sendCallback: () => {} };
    arm(session);
    iv.emit('pty-data', screen ? `Design login\n${screen}` : 'Unknown command: /design-login');
    await new Promise(r => setTimeout(r, 120));
    if (expected) {
      expect(session._designLoginWatch).toBe(null);
      expect(iv.listenerCount('pty-data')).toBe(0);
      expect(flushed).toEqual([session]);
      expect(finishes).toHaveLength(1);
      expect(finishes[0][2]).toBe(expected);
      expect(flowLib.designLoginOutcomeMessage('unrecognised')).toMatch(/may not support/);
    } else {
      expect(session._designLoginWatch).not.toBe(null);
      expect(finishes).toHaveLength(0);
      session._designLoginWatch.stop();
    }
  });

  it('does not type /design-login into a busy session', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    const at = src.indexOf("case '!design-login':");
    const body = src.slice(at, src.indexOf("case '!logout'", at) + 6000);
    const guard = body.indexOf('isDesign && session.busy && !session._designLoginWatch');
    expect(guard).toBeGreaterThan(-1);
    expect(body.slice(guard, guard + 300)).toMatch(/send \/design-login again when it finishes[\s\S]*?break;/);
    // The guard sits before the watch reset and before anything is typed.
    expect(guard).toBeLessThan(body.indexOf('session._designLoginWatch?.stop()'));
    expect(guard).toBeLessThan(body.indexOf('iv.sendText('));
  });

  it('room delivery waits while the dialog is open', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    const fn = src.slice(src.indexOf('function sessionOccupiedForRoomDelivery('), src.indexOf('function sessionOccupiedForRoomDelivery(') + 400);
    expect(fn).toMatch(/signInDialogHoldsInput\(session\);/);
  });

  it('a pending prompt keeps its wait', async () => {
    const { designLoginEndsPhantomTurn: ends } = await import('../lib/design-login-flow.js');
    expect(ends({ alive: true, iv: {}, busy: true, pendingInteractivePrompt: { kind: 'menu' } })).toBe(false);
  });
});

describe('sign-in card needs an OAuth URL', async () => {
  const { formatTuiCueMessage } = await import('../lib/tui-cue-message.js');
  it('a repainted old sign-in screen next to a PR link is not a sign-in', () => {
    const screen = 'Paste code here if prompted >\nDesign login cancelled.\nMerged as https://example.test/pr/17';
    expect(formatTuiCueMessage(screen, ['https://example.test/pr/17'])).toBe(null);
  });
  it('a repaint with no new URLs says nothing', () => {
    const oauth = 'https://claude.com/cai/oauth/authorize?code=true&state=a';
    const screen = `Paste code here if prompted >\n${oauth}`;
    expect(formatTuiCueMessage(screen, [oauth], { hasNewUrls: false })).toBe(null);
  });
  it('an old OAuth URL repainted beside a new unrelated link is not a new sign-in', () => {
    const oauth = 'https://claude.com/cai/oauth/authorize?code=true&state=a';
    const pr = 'https://example.test/pr/17';
    const screen = `Paste code here if prompted >\n${oauth}\nMerged as ${pr}`;
    expect(formatTuiCueMessage(screen, [pr, oauth], { hasNewUrls: true, newUrls: [pr] })).toBe(null);
    // The same screen with the OAuth URL itself new still gets the card.
    const msg = formatTuiCueMessage(screen, [oauth, pr], { hasNewUrls: true, newUrls: [oauth, pr] });
    expect(msg.parts.map(p => p.plain)).toContain(oauth);
  });
  it('a live sign-in screen still gets the card with its OAuth URL', () => {
    const oauth = 'https://claude.com/cai/oauth/authorize?code=true&state=a';
    const screen = `Browser didn't open? Use the url below\n${oauth}\nPaste code here if prompted >`;
    const msg = formatTuiCueMessage(screen, ['https://support.claude.com/en/articles/1', oauth]);
    expect(msg.parts.map(p => p.plain)).toContain(oauth);
  });
});

describe('Design login lifecycle', async () => {
  const { runInNewContext } = await import('node:vm');
  const { vi, afterEach } = await import('vitest');
  const flowLib = await import('../lib/design-login-flow.js');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const functionSource = name => {
    const start = source.indexOf(`\nfunction ${name}(`) + 1;
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  };
  afterEach(() => vi.useRealTimers());

  function finishSetup({ borrowed = true } = {}) {
    vi.useFakeTimers();
    const flow = {};
    const session = { alive: true, iv: {}, _designLoginFlow: flow, _accountFlowReturnToPrint: borrowed, sendCallback: vi.fn() };
    const context = {
      ...flowLib, sessions: new Map([['room', session]]),
      setTimeout, DESIGN_LOGIN_RETRY_MS: 10, DESIGN_LOGIN_RETRY_LIMIT: 2,
      shouldRunAccountFlowReturn: s => !!s._accountFlowReturnToPrint,
      planModeSwitch: vi.fn(() => ({ ok: true })),
      applyModeSwitch: vi.fn(() => ({})), maybeFlushRoomDelivery: vi.fn(),
    };
    const finish = runInNewContext(`(${functionSource('scheduleDesignLoginFinish')})`, context);
    return { session, flow, context, finish: outcome => finish('room', flow, outcome, 1) };
  }

  it('returns borrowed interactive mode after a result', () => {
    const h = finishSetup();
    h.finish('authorized');
    vi.advanceTimersByTime(1);
    expect(h.context.applyModeSwitch).toHaveBeenCalledWith('room', h.session, false, expect.objectContaining({
      announcement: '✅ Claude Design access authorized — back to normal mode.',
    }));
    expect(h.session._accountFlowReturnToPrint).toBe(false);
  });

  it.each(['cancelled', 'failed', null])('reports %s and preserves user-selected interactive mode', outcome => {
    const h = finishSetup({ borrowed: false });
    h.finish(outcome);
    vi.advanceTimersByTime(1);
    expect(h.context.applyModeSwitch).not.toHaveBeenCalled();
    expect(h.session.sendCallback).toHaveBeenCalledWith(flowLib.designLoginOutcomeMessage(outcome, { returning: false }));
  });

  it('ignores a finish superseded by another login attempt', () => {
    const h = finishSetup();
    h.finish('authorized');
    h.session._designLoginFlow = {};
    vi.advanceTimersByTime(1);
    expect(h.context.applyModeSwitch).not.toHaveBeenCalled();
    expect(h.session.sendCallback).not.toHaveBeenCalled();
  });

  it('retries a blocked return and retains the borrow mark if the switch fails', () => {
    const h = finishSetup();
    h.context.planModeSwitch.mockReturnValue({ ok: false });
    h.context.applyModeSwitch.mockReturnValue(null);
    h.finish('failed');
    vi.advanceTimersByTime(21);
    expect(h.context.planModeSwitch).toHaveBeenCalledTimes(3);
    expect(h.context.applyModeSwitch).toHaveBeenCalledOnce();
    expect(h.context.applyModeSwitch.mock.calls[0][3].refusalAnnouncement).toContain('/mode print');
    expect(h.session._accountFlowReturnToPrint).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not end a turn that was running before the dialog opened', () => {
    const turn = {};
    expect(flowLib.designLoginEndsPhantomTurn({ alive: true, iv: {}, busy: true, currentTurn: turn }, { turnAtArm: turn })).toBe(false);
    expect(flowLib.designLoginEndsPhantomTurn({ alive: true, iv: {}, busy: false, currentTurn: {} }, { turnAtArm: null })).toBe(true);
  });

  it('stops listening at the watch timeout and reports an unfinished flow', async () => {
    vi.useFakeTimers();
    const { EventEmitter } = await import('node:events');
    const iv = new EventEmitter();
    const session = { iv, roomId: 'room', alive: true };
    const finish = vi.fn();
    const arm = runInNewContext(`(${functionSource('armDesignLoginWatch')})`, {
      setTimeout, clearTimeout, debug: () => {}, scheduleDesignLoginFinish: finish,
      DESIGN_LOGIN_WATCH_CAP_MS: 100, DESIGN_LOGIN_SETTLE_MS: 5, DESIGN_LOGIN_NO_SCREEN_MS: 1000,
    });
    arm(session);
    expect(iv.listenerCount('pty-data')).toBe(1);
    vi.advanceTimersByTime(100);
    expect(iv.listenerCount('pty-data')).toBe(0);
    expect(session._designLoginWatch).toBeNull();
    expect(finish).toHaveBeenCalledWith('room', session._designLoginFlow, null, 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('relays the fresh OAuth URL on retry and deduplicates wrapped URLs', async () => {
    const prompt = await import('../lib/prompt-detector.js');
    const { formatTuiCueMessage } = await import('../lib/tui-cue-message.js');
    const update = runInNewContext(`(${functionSource('handleInteractiveScreenUpdate')})`, {
      ...prompt, formatTuiCueMessage,
      console: { log() {} }, journalSessionState() {}, journalActivity() {},
    });
    const send = vi.fn();
    const session = { sendCallback: send };
    const oldUrl = 'https://auth.example.test/oauth/authorize?state=old';
    const newUrl = 'https://auth.example.test/oauth/authorize?state=new';
    const show = screen => update(session, { screen, urls: prompt.extractUrls(screen), hasInputCue: true });
    show(`Paste code here >\n${oldUrl}`);
    expect(send.mock.calls[1][0]).toBe(oldUrl);
    send.mockClear();
    const retryScreen = `Paste code here >\n${oldUrl}\n${newUrl.replace('?state', '?st\nate')}`;
    show(retryScreen);
    expect(send.mock.calls[1][0]).toBe(newUrl);
    send.mockClear();
    show(retryScreen);
    expect(send).not.toHaveBeenCalled();
  });

  function commandSetup(sessionOverrides = {}) {
    const session = { alive: true, roomId: 'room', agent: 'claude', ...sessionOverrides };
    const context = {
      ...flowLib, sessions: new Map([['room', session]]), AGENT_CODEX: 'codex',
      applyModeSwitch: vi.fn(() => ({})), armDesignLoginWatch: vi.fn(),
    };
    const start = source.indexOf("    case '!design-login':");
    const end = source.indexOf("    case '!effort':", start);
    // The production switch uses a canonical internal command key.
    const run = runInNewContext(`(async function(roomId, sendReply) {
      const cmd = '!design-login';
      switch (cmd) { ${source.slice(start, end)} }
    })`, context);
    return { session, context, run: () => run('room', vi.fn()) };
  }

  it('parks design login on the replacement print session using the account flow', async () => {
    const h = commandSetup();
    await h.run();
    const next = h.context.applyModeSwitch.mock.results[0].value;
    expect(next._postReadySlashCommand).toBe('/design-login');
    expect(next._accountFlowReturnToPrint).toBe(true);
    expect(h.session._accountFlowReturnToPrint).toBeUndefined();
  });

  it('waits for a resuming TUI before typing the command', async () => {
    const sendText = vi.fn();
    const h = commandSetup({ iv: { alive: true, sendText }, _awaitingInputReady: true });
    await h.run();
    expect(sendText).not.toHaveBeenCalled();
    expect(h.session._postReadySlashCommand).toBe('/design-login');
  });

  it('types directly into a ready TUI and arms the result watch', async () => {
    const sendText = vi.fn();
    const h = commandSetup({ iv: { alive: true, sendText } });
    await h.run();
    expect(sendText).toHaveBeenCalledWith('/design-login');
    expect(h.context.armDesignLoginWatch).toHaveBeenCalledWith(h.session);
  });

  it('does not start design login while an account return is scheduled', async () => {
    const h = commandSetup({ _accountFlowReturnScheduled: true });
    await h.run();
    expect(h.context.applyModeSwitch).not.toHaveBeenCalled();
    expect(h.context.armDesignLoginWatch).not.toHaveBeenCalled();
  });
});
