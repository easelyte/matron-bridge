// Helpers for injecting input into a claude PTY.
//
// Phase 0.4 finding (2026-05-14): the trailing Enter that submits a pasted
// message MUST be sent as a separate write after a short delay. If `\r` is
// concatenated immediately after the bracketed-paste close sequence the TUI
// silently drops it, because the TUI buffers paste content and uses extended
// keyboard protocols (modifyOtherKeys, kitty) that re-encode keystrokes mid-
// way through paste handling.
//
// Callers should do:
//
//   pty.write(bracketedPaste(text));
//   setTimeout(() => pty.write(keystroke('enter')), SUBMIT_DELAY_MS);

export const SUBMIT_DELAY_MS = 500;

// C0 and C1 control characters other than tab, newline and carriage return.
// ESC is among them, so no escape sequence (the paste terminator included)
// can survive in pasted content.
// eslint-disable-next-line no-control-regex -- the control range is the point
const PASTE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g;

export function bracketedPaste(text) {
  // Strip control characters so message content can never close the paste
  // early and have its remainder interpreted by the TUI as raw keystrokes /
  // escape sequences. Removing the terminator text alone is not enough: a
  // nested copy ("\x1b[20" + terminator + "1~") reassembles one.
  return `\x1b[200~${String(text).replace(PASTE_CONTROLS, '')}\x1b[201~`;
}

const KEYS = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  backspace: '\x7f',
};

export function keystroke(name) {
  if (KEYS[name] !== undefined) return KEYS[name];
  if (typeof name === 'string' && /^[\x20-\x7e]$/.test(name)) return name;
  throw new Error(`unknown key: ${JSON.stringify(name)}`);
}
