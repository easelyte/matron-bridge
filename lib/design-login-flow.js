// Claude Design result detection and print-to-interactive routing.
import { compactScreenText } from './prompt-detector.js';

export const DESIGN_LOGIN_COMMAND = '/design-login';

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

const CODE_REFUSED_TOKENS = ['thatcodewasntaccepted', 'makesurethefullcodewascopied'];

const SIGN_IN_SCREEN_TOKENS = ['waitingforbrowserauthorization', 'pastecodehere', 'browserdidntopen'];

// Ignore results repainted above the current sign-in dialog.
function afterLastSignInScreen(compact) {
  let cut = 0;
  for (const t of SIGN_IN_SCREEN_TOKENS) {
    const i = compact.lastIndexOf(t);
    if (i >= 0) cut = Math.max(cut, i + t.length);
  }
  return compact.slice(cut);
}

export function showsSignInScreen(text) {
  const compact = compactScreenText(text);
  return SIGN_IN_SCREEN_TOKENS.some(t => compact.includes(t));
}

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

export function designLoginOutcomeMessage(outcome, { returning = true } = {}) {
  const tail = returning ? ' — back to normal mode.' : '.';
  switch (outcome) {
    case 'authorized':
      return `✅ Claude Design access authorized${tail}`;
    case 'cancelled':
      return `Design login cancelled${tail}`;
    case 'failed':
      return `Design login didn't complete${tail} Send /design-login to try again.`;
    case 'unrecognised':
      return `Claude Code didn't open a sign-in screen${tail} This version may not support /design-login.`;
    default:
      return `Design login didn't finish in time${tail} Send /design-login to try again.`;
  }
}

export function ownsDesignLoginFinish(current, flow) {
  return !!(flow && current && current.alive && current._designLoginFlow === flow);
}

export function signInDialogHoldsInput(session) {
  return !!(session && session.iv && session._designLoginWatch);
}

export function designLoginEndsPhantomTurn(session, flow) {
  return !!(session && session.alive && session.iv && (session.busy || session.currentTurn)
    && !(flow?.turnAtArm && session.currentTurn === flow.turnAtArm)
    && !session.pendingInteractivePrompt && !session.waitingForAnswer);
}

export const DESIGN_LOGIN_CODE_REFUSED_MESSAGE =
  'That code wasn\'t accepted. Send !enter for a new sign-in link, or !esc to cancel.';
