// /effort command handling, mirroring lib/model-command.js. Passing the level
// inline (`/effort <level>`) skips the arrow-menu PICKER that bare `/effort`
// opens — that picker can't be driven through the bridge's paste+Enter, so it
// just hangs. The bridge validates the level here, then drives it into the PTY
// via sendText — deliberately NOT through sendToSession, which would set
// session.busy=true and wait for a Stop hook. /effort changes a session
// setting and produces no assistant turn, so no Stop hook fires; routing it
// through the normal send path would wedge the session busy forever (the same
// failure class /compact works around). sendText sidesteps that.
//
// Mid-conversation, an inline `/effort <level>` does NOT apply silently:
// changing effort invalidates the prompt cache, so the TUI shows a
// "Change effort level?" confirmation (`Yes, switch to <X>` / `No, go back`,
// + a "slower / more tokens" warning) before applying. We do NOT special-case
// that — the PTY-output PromptDetector already classifies it (same shape as
// the bypass-permissions confirm menu, see test/prompt-detector.test.js) and
// the bridge's iv.on('prompt') handler surfaces it to Matrix as numbered
// options the user answers with "1"/"2"/"y"/"n", independent of busy state.
// The only thing switchEffortInSession must avoid is claiming the change is
// already done while that confirmation is still pending — hence the hedged
// status string below.

// Selectable effort levels (shown as buttons for no-arg /effort) plus their
// human labels. Order is low→high then the meta levels.
export const EFFORT_LEVELS = [
  { level: 'low',       label: 'Low' },
  { level: 'medium',    label: 'Medium' },
  { level: 'high',      label: 'High' },
  { level: 'xhigh',     label: 'X-High' },
  { level: 'max',       label: 'Max' },
  { level: 'auto',      label: 'Auto' },
  { level: 'ultracode', label: 'Ultracode' },
];

const KNOWN_LEVELS = new Set(EFFORT_LEVELS.map(e => e.level));

export const VALID_EFFORT_HINT = EFFORT_LEVELS.map(e => e.level).join(', ');

export function normalizeEffortArg(arg) {
  return String(arg ?? '').trim().toLowerCase();
}

export function isValidEffortArg(arg) {
  return KNOWN_LEVELS.has(normalizeEffortArg(arg));
}

export function effortLabel(arg) {
  const a = normalizeEffortArg(arg);
  const found = EFFORT_LEVELS.find(e => e.level === a);
  return found ? found.label : a;
}

// Validate, then write `/effort <level>` into the live PTY. Returns true when a
// change was driven. `send` is called with a human-readable status string.
export function switchEffortInSession(session, arg, send) {
  if (!isValidEffortArg(arg)) {
    send(`Unknown effort level "${arg}". Try: ${VALID_EFFORT_HINT}.`);
    return false;
  }
  if (!session.iv || typeof session.iv.sendText !== 'function') {
    send('Changing effort needs interactive mode.');
    return false;
  }
  if (session._awaitingInputReady) {
    // Mid auto-resume: typing /effort now would land in the still-loading TUI
    // (dropped or misplaced) and could cancel a held message's pending Enter.
    // Ask the user to retry once it's ready (mirrors switchModelInSession).
    send('The session is still resuming — try /effort again in a moment.');
    return false;
  }
  const normalized = normalizeEffortArg(arg);
  // sendText returns false when the PTY/session is no longer alive (and writes
  // nothing) — don't claim success the TUI never saw.
  if (session.iv.sendText(`/effort ${normalized}`) === false) {
    send("Couldn't change effort — the session isn't accepting input right now. Try again in a moment.");
    return false;
  }
  // Hedged on purpose: mid-conversation the TUI will pop a "Change effort
  // level?" confirmation (surfaced to Matrix via the prompt detector), so we
  // can't claim it's applied yet. On a fresh/uncached session it applies with
  // no prompt and this reads fine as the only feedback.
  send(`Switching effort to ${effortLabel(arg)}… (Claude may ask you to confirm.)`);
  return true;
}

// One Matrix button per effort level. value is namespaced `effort:<level>` so
// the button-response handler can dispatch it explicitly.
export function effortButtons() {
  return EFFORT_LEVELS.map(e => ({
    id: `effort-${e.level}`,
    label: e.label,
    value: `effort:${e.level}`,
  }));
}
