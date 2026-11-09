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
  'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code',
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

describe('/design-login wiring (source inspection)', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
  const caseStart = src.indexOf("case '!design-login': {");
  const caseBody = src.slice(caseStart, src.indexOf("case '!effort': {", caseStart));

  it('the print branch parks the command and borrows interactive mode on the replacement', () => {
    expect(caseStart).toBeGreaterThan(0);
    expect(caseBody).toMatch(/next\._postReadySlashCommand = DESIGN_LOGIN_COMMAND;/);
    expect(caseBody).toMatch(/next\._accountFlowReturnToPrint = true;/);
    expect(caseBody).not.toMatch(/session\._accountFlowReturnToPrint = true;/);
  });

  it('the interactive branch arms the result watch after typing', () => {
    expect(caseBody).toMatch(/session\.iv\.sendText\(DESIGN_LOGIN_COMMAND\)[\s\S]*armDesignLoginWatch\(session\);/);
  });

  it('/login supersedes a pending design-login finish, and /design-login waits out a /login return', () => {
    const loginStart = src.indexOf("case '!login':");
    const loginBody = src.slice(loginStart, src.indexOf("case '!design-login': {", loginStart));
    expect(loginBody).toMatch(/session\._designLoginFlow = null;/);
    expect(caseBody).toMatch(/if \(session\._accountFlowReturnScheduled\) \{/);
  });

  it('the iv crash-restart carries the attempt token to the replacement', () => {
    expect(src).toMatch(/restarted\._designLoginFlow = session\._designLoginFlow;/);
  });

  it('the readiness watcher arms the result watch when it types a parked /design-login', () => {
    expect(src).toMatch(/if \(parkedSlash === DESIGN_LOGIN_COMMAND\) armDesignLoginWatch\(session\);/);
  });

  it('the return clears the borrow flag only on an actual switch', () => {
    const fnStart = src.indexOf('function scheduleDesignLoginFinish(');
    const fn = src.slice(fnStart, src.indexOf('// --- Structured Question Handling ---', fnStart));
    expect(fn).toMatch(/if \(switched\) current\._accountFlowReturnToPrint = false;/);
    expect(fn).toMatch(/shouldRunAccountFlowReturn\(current\)/);
    // An abandoned flow's timer must not end a newer flow in the same room.
    expect(fn).toMatch(/if \(!ownsDesignLoginFinish\(current, flow\)\) return;/);
  });
});

describe('sign-in relay fixes', async () => {
  const { signInUrl } = await import('../lib/tui-cue-message.js');
  const { signInDialogHoldsInput } = await import('../lib/design-login-flow.js');

  it('picks the OAuth URL over the support link /design-login shows above it', () => {
    const help = 'https://support.claude.com/en/articles/17440474';
    const oauth = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=a';
    expect(signInUrl([help, oauth])).toBe(oauth);
    expect(signInUrl([help])).toBe(help);
  });

  it('holds bridge-generated input while a sign-in dialog is open', () => {
    expect(signInDialogHoldsInput({ iv: {}, _designLoginWatch: { stop() {} } })).toBe(true);
    // A /login borrow flag alone is not an open dialog: a cancelled /login
    // keeps it, and notes must not wait on that.
    expect(signInDialogHoldsInput({ iv: {}, _accountFlowReturnToPrint: true })).toBe(false);
    expect(signInDialogHoldsInput({ iv: {} })).toBe(false);
    expect(signInDialogHoldsInput({ iv: null, _designLoginWatch: {} })).toBe(false);
  });

  it('the held-note delivery defers on an open sign-in dialog', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
    const start = src.indexOf('async function deliverRes' + 'tartNote(');
    const fn = src.slice(start, start + 800);
    expect(fn).toMatch(/signInDialogHoldsInput\(session\)\) return \{ deferred: true \};/);
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
    const end = src.indexOf('// Report the outcome and, for a borrowed session, switch back to print.');
    const flushed = [];
    const finishes = [];
    const ended = [];
    const ctx = {
      ...flowLib, stripAnsi: prompt.stripAnsi, findInputCue: prompt.findInputCue,
      setTimeout, clearTimeout, debug: () => {},
      DESIGN_LOGIN_WATCH_CAP_MS: 60000, DESIGN_LOGIN_SETTLE_MS: 5, DESIGN_LOGIN_BUFFER_LIMIT: 65536,
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
    const screen = 'Paste code here if prompted >\nDesign login cancelled.\nMerged as https://github.com/acme/repo/pull/17';
    expect(formatTuiCueMessage(screen, ['https://github.com/acme/repo/pull/17'])).toBe(null);
  });
  it('a live sign-in screen still gets the card with its OAuth URL', () => {
    const oauth = 'https://claude.com/cai/oauth/authorize?code=true&state=a';
    const screen = `Browser didn't open? Use the url below\n${oauth}\nPaste code here if prompted >`;
    const msg = formatTuiCueMessage(screen, ['https://support.claude.com/en/articles/1', oauth]);
    expect(msg.parts.map(p => p.plain)).toContain(oauth);
  });
});

describe('designNeedsInteractive', async () => {
  const { designNeedsInteractive } = await import('../lib/design-login-flow.js');
  const print = { agent: 'claude', iv: null };
  it('a brief or bare /design on a Claude print session switches', () => {
    expect(designNeedsInteractive('/design A sign-in screen', print)).toBe(true);
    expect(designNeedsInteractive('/design', print)).toBe(true);
  });
  it('only the /design word itself', () => {
    expect(designNeedsInteractive('/design-sync', print)).toBe(false);
    expect(designNeedsInteractive('please /design this', print)).toBe(false);
  });
  it('consent and revoke stay in print', () => {
    expect(designNeedsInteractive('/design consent', print)).toBe(false);
    expect(designNeedsInteractive('/design REVOKE', print)).toBe(false);
  });
  it('interactive and Codex sessions take it as typed', () => {
    expect(designNeedsInteractive('/design A screen', { agent: 'claude', iv: {} })).toBe(false);
    expect(designNeedsInteractive('/design A screen', { agent: 'codex', iv: null })).toBe(false);
  });
});

describe('/design wiring (source inspection)', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');
  const start = src.indexOf('if (designNeedsInteractive(trimmed, session)');
  const body = src.slice(start, src.indexOf('if (session.codexPrompts?.active', start));
  it('switches only an idle, unheld print session and keeps the ordinary route otherwise', () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/!sessionOccupied\(session\)/);
    expect(body).toMatch(/!effortFlowHoldsInput\(session\)/);
    expect(body).not.toMatch(/_accountFlowReturnToPrint/);
    expect(body).toMatch(/sendToSession\(next, \[\{ type: 'text', text: trimmed \}\], \{ skipJournalMirror: true, causes \}\)/);
  });
  it('/mode interactive announces readiness', () => {
    expect(src).toMatch(/if \(switched && wantInteractive\) switched\._announceInteractiveReady = true;/);
    expect(src).toMatch(/session\.sendCallback\(INTERACTIVE_READY_MESSAGE\)/);
  });
});
