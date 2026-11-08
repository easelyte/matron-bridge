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

  it('leaves /design to Claude Code (consent and revoke run in print mode)', () => {
    expect(classifyBridgeCommand('/design consent')).toBe(null);
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
