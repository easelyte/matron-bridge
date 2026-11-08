// /design-login from chat. Claude Code's /design-login (design-system access
// for /design-sync and /design consent) only runs in the interactive TUI: a
// print session answers "/design-login isn't available in this environment".
// The bridge runs it the way it runs /login: borrow interactive mode, type the
// command once the TUI is ready, relay its OAuth screen (the generic
// screen-update relay already does that, the screen is /login's), and switch
// back to print once the flow ends.
//
// Unlike /login there is no "Press Enter to continue" success screen to key
// the return on: /design-login closes with one result line under the command
// (`⎿ Design-system access authorized.`, `⎿ Design login cancelled.`, …) and
// the idle prompt. This module classifies the PTY output written AFTER the
// bridge typed the command (so a result line repainted from an earlier
// attempt cannot end the flow) into those outcomes. All matching runs on the
// compact form (lowercased, whitespace and apostrophes removed; see
// compactScreenText in lib/prompt-detector.js) because the TUI can arrive
// letter-spaced after ANSI stripping.

import { compactScreenText } from './prompt-detector.js';

export const DESIGN_LOGIN_COMMAND = '/design-login';

// Result-line tokens, checked in order. The success line comes first: it is
// the one outcome the user is waiting for.
const OUTCOME_TOKENS = [
  ['authorized', ['design-systemaccessauthorized']],
  ['cancelled', ['designlogincancelled']],
  ['failed', [
    'designloginfailed',
    'designloginwasinterrupted',
    'browserauthorizationtimedout',
    'couldnotsavethedesigncredential',
    'design-loginisntavailable',
  ]],
];

// The pasted code was refused: the TUI waits on "Press Enter to retry, or
// any other key to cancel." with no URL on screen, so the generic relay
// stays silent and the user would not know what the TUI wants.
// A code pasted without its `#state` half gets "Invalid code. Please make
// sure the full code was copied" and the same retry prompt.
const CODE_REFUSED_TOKENS = ['thatcodewasntaccepted', 'makesurethefullcodewascopied'];

// Phrases of the live sign-in screen. A result counts only when it comes
// AFTER the last of these: a TUI repaint can carry an earlier attempt's
// result line above the current, still-waiting sign-in screen, and that old
// line must not end this attempt.
const SIGN_IN_SCREEN_TOKENS = ['waitingforbrowserauthorization', 'pastecodehere', 'browserdidntopen'];

function afterLastSignInScreen(compact) {
  let cut = 0;
  for (const t of SIGN_IN_SCREEN_TOKENS) {
    const i = compact.lastIndexOf(t);
    if (i >= 0) cut = Math.max(cut, i + t.length);
  }
  return compact.slice(cut);
}

// The outcome the output shows, or null while the flow is still running.
export function classifyDesignLoginOutput(text) {
  const compact = afterLastSignInScreen(compactScreenText(text));
  for (const [outcome, tokens] of OUTCOME_TOKENS) {
    if (tokens.some(t => compact.includes(t))) return outcome;
  }
  return null;
}

export function designLoginCodeRefused(text) {
  const compact = afterLastSignInScreen(compactScreenText(text));
  return CODE_REFUSED_TOKENS.some(t => compact.includes(t));
}

// The announcement for the return to print mode, per outcome. `returning`
// is false for a session the user put in interactive mode themselves: it
// stays interactive, so the line only reports the result.
export function designLoginOutcomeMessage(outcome, { returning = true } = {}) {
  const tail = returning ? ' — back to normal mode.' : '.';
  switch (outcome) {
    case 'authorized':
      return `✅ Claude Design access authorized${tail}`;
    case 'cancelled':
      return `Design login cancelled${tail}`;
    case 'failed':
      return `Design login didn't complete${tail} Send /design-login to try again.`;
    default:
      return `Design login didn't finish in time${tail} Send /design-login to try again.`;
  }
}

// Whether a pending finish still owns the room: the session there must be
// alive and hold the same attempt token. A retry, an abandoned flow and a
// /login started meanwhile all replace or clear the token.
export function ownsDesignLoginFinish(current, flow) {
  return !!(flow && current && current.alive && current._designLoginFlow === flow);
}

// Bridge-generated input (a restart note, a carry-on) must not be typed into
// an open sign-in dialog: the TUI takes it as the pasted code and refuses it.
// Open means a /design-login watch is running, or a /login borrowed this TUI
// and has not returned to print yet. The user's own messages still go
// through: they ARE the code.
export function signInDialogHoldsInput(session) {
  return !!(session && session.iv && (session._designLoginWatch || session._accountFlowReturnToPrint));
}

export const DESIGN_LOGIN_CODE_REFUSED_MESSAGE =
  'That code wasn\'t accepted. Send !enter for a new sign-in link, or !esc to cancel.';
