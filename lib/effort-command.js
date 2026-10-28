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
// the bridge's iv.on('prompt') handler surfaces it to the user as numbered
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

// The effort levels as status-frame `effort_levels` — {value,label} pairs the
// composer offers as arguments to /effort, mirroring modelOptions().
export function effortOptions() {
  return EFFORT_LEVELS.map(e => ({ value: e.level, label: e.label }));
}

// The levels Claude Code's `--effort` spawn flag accepts. `auto` and
// `ultracode` are /effort-only: the flag warns and ignores the first, and
// the second is a mode rather than a level, so neither is offered for a
// session start. Spawns, the Coordinator's session_set_model and
// MATRON_DEFAULT_EFFORT all validate against this list.
export const SPAWN_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SPAWN_LEVELS = new Set(SPAWN_EFFORT_LEVELS);

export const VALID_SPAWN_EFFORT_HINT = SPAWN_EFFORT_LEVELS.join(', ');

export function isSpawnEffortArg(arg) {
  return SPAWN_LEVELS.has(normalizeEffortArg(arg));
}

// The spawn-time levels as {value,label} pairs, for the New Chat picker
// (journal-rpc `targets` → `effort_options`).
export function spawnEffortOptions() {
  return EFFORT_LEVELS.filter(e => SPAWN_LEVELS.has(e.level)).map(e => ({ value: e.level, label: e.label }));
}

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
  // level?" confirmation (surfaced to the user via the prompt detector), so we
  // can't claim it's applied yet. On a fresh/uncached session it applies with
  // no prompt and this reads fine as the only feedback.
  send(`Switching effort to ${effortLabel(arg)}… (Claude may ask you to confirm.)`);
  return true;
}

// A print-mode session has no TUI to type `/effort` into, so a person's
// `/effort <level>` takes the /login route: borrow interactive mode, let the
// resumed TUI take `/effort <level>` (parked on _postReadySlashCommand), then
// switch back to print once the write settles — the return recreate carries
// the committed level as --effort. Pure decision; the caller drives the
// mode switch (applyPrintEffortSwitch in index.js).
//   { ok: true, normalized, message }               switch to interactive now
//   { ok: false, defer: true, normalized, message } mid-turn: park and replay
//   { ok: false, message }                          refused
export function planPrintEffortSwitch(session, arg) {
  const normalized = normalizeEffortArg(arg);
  if (!isSpawnEffortArg(normalized)) {
    // auto and ultracode exist only as TUI /effort settings: the trip back to
    // print mode passes the level as --effort, which cannot carry them.
    const tuiOnly = isValidEffortArg(normalized)
      ? ` ${effortLabel(normalized)} needs interactive mode (/mode interactive).`
      : '';
    return { ok: false, message: `Unknown effort level "${arg}" for this session. Try: ${VALID_SPAWN_EFFORT_HINT}.${tuiOnly}` };
  }
  if (session.busy) {
    // planModeSwitch would refuse with "before switching modes", which reads
    // oddly to someone who typed /effort; park the command for turn end.
    return {
      ok: false,
      defer: true,
      normalized,
      message: `🎚️ Queued /effort ${normalized}: it applies as soon as this turn finishes.`,
    };
  }
  return {
    ok: true,
    normalized,
    message: `Setting effort to ${effortLabel(normalized)} — switching to interactive mode to apply…`,
  };
}

// One picker button per effort level. value is namespaced `effort:<level>` so
// the button-response handler can dispatch it explicitly.
export function effortButtons() {
  return EFFORT_LEVELS.map(e => ({
    id: `effort-${e.level}`,
    label: e.label,
    value: `effort:${e.level}`,
  }));
}
