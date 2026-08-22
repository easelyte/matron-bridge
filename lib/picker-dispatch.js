// Picker-button dispatch for the journal prompt_reply return path.
//
// The no-arg /model, /effort and /mode commands publish button messages whose
// option VALUES are namespaced `model:<alias>`, `effort:<level>` and
// `mode:<target>` (lib/model-command.js modelButtons, lib/effort-command.js
// effortButtons, lib/session-mode.js modeButtons); the /timer set-confirmation
// card's Cancel button carries `timer:cancel:<id>` (lib/timer-command.js
// timerCancelButton) and rides the same path. The print-mode permission
// card's Allow/Always/Deny buttons carry `perm:<requestId>:<verdict>`
// (lib/permission-prompt.js permissionButtons) and ride it too. A Matron tap
// arrives back at the bridge as a journal prompt_reply whose `choice` carries
// that value — the same wire shape a Matrix button_response once carried.
// Upstream (issue #98) only ever wired these three through the deleted
// Matrix button path, so the journal prompt_reply path never dispatched
// them: a tap fell through to pending-prompt routing, matched nothing, and
// no-op'd ("Nothing to answer right now"). This module is the missing
// dispatch, extracted pure (injected switch fns, no I/O) so it's
// unit-testable without a live session — the same shape as
// lib/busy-queue.js resolveQueueReleaseTap.
//
// Picker-vs-answer classification is the ROUTER's job: it verifies a reply's
// target_seq against the picker frame the bridge published and that frame's
// offered values, and only then flags the reply as a picker command. This
// module is reached only after that confirmation. handlePickerValue still
// validates the value against the exact closed set of values the pickers emit
// (below) as defense-in-depth, and rejects malformed/future values (e.g.
// `mode:bogus`) rather than acting on them.

import { SWITCHABLE_ALIASES } from './model-aliases.js';
import { EFFORT_LEVELS } from './effort-command.js';
import { parsePermTap } from './permission-prompt.js';

const MODEL_ALIASES = new Set(SWITCHABLE_ALIASES.map(m => m.alias));
const EFFORT_LEVEL_SET = new Set(EFFORT_LEVELS.map(e => e.level));
const MODE_TARGETS = new Set(['interactive', 'print']);

const ALLOWED = {
  model: MODEL_ALIASES,
  effort: EFFORT_LEVEL_SET,
  mode: MODE_TARGETS,
};

const PICKER_VALUE = /^(model|effort|mode|timer|perm|resume):(.+)$/;
// Timer values carry a dynamic record id (lib/timer-command.js
// timerCancelButton / timerSendNowButton emit `timer:cancel:<id>` /
// `timer:send:<id>`), so unlike the closed alias sets above they validate
// by shape: the verb must be one of the two the card's buttons emit and
// the id must be all digits.
const TIMER_ARG = /^(cancel|send):(\d+)$/;
// Restart carry-on values carry a convo id (a claude session UUID or a codex
// thread id), so they validate by shape for the same reason. Deliberately
// conservative — the authoritative check is frame provenance in
// lib/journal-input-router.js (the value must be one the frame itself
// offered); this is defence in depth against a malformed or crafted value.
const RESUME_CONVO_ID = /^[A-Za-z0-9_-]{8,128}$/;

// Publisher-side counterpart of the check below, exported so the restart
// carry-on card publisher (index.js publishRestartCarryOnCards) can refuse to
// offer a `resume:<convoId>` this module would then reject. Without it such a
// card is a button whose tap consumes the single-use picker frame and returns
// false from handlePickerValue, which the caller treats as a silent no-op —
// the user presses it and NOTHING happens, not even an error. Exported as a
// predicate rather than as the regex so this stays the one definition of the
// shape.
export function isResumeConvoId(convoId) {
  return typeof convoId === 'string' && RESUME_CONVO_ID.test(convoId);
}

// Parse a `<kind>:<arg>` value into { kind, arg } iff kind is a picker kind AND
// arg is one of the values that kind's picker actually emits; else null. For
// `timer`, the parse also yields the verb and arg is the parsed numeric
// record id.
function parsePickerValue(value) {
  const m = typeof value === 'string' ? value.match(PICKER_VALUE) : null;
  if (!m) return null;
  const kind = m[1];
  const arg = m[2];
  if (kind === 'timer') {
    const t = arg.match(TIMER_ARG);
    return t ? { kind, verb: t[1], arg: parseInt(t[2], 10) } : null;
  }
  if (kind === 'perm') {
    const p = parsePermTap(value);
    return p ? { kind, requestId: p.requestId, verdict: p.verdict } : null;
  }
  if (kind === 'resume') {
    return RESUME_CONVO_ID.test(arg) ? { kind, arg } : null;
  }
  return ALLOWED[kind].has(arg) ? { kind, arg } : null;
}

// Dispatch a picker tap to the matching switch implementation. Returns true if
// `value` was a valid picker value and has been handled, false otherwise
// (nothing touched). The caller has already classified the reply as a picker
// tap by frame provenance and returns unconditionally either way, so a false
// return is a silent no-op — unreachable for values a picker frame offered. Mirrors
// the explicit-arg !model/!effort/!mode command handlers in index.js: model and
// mode take (roomId, session, arg, { sendReply, sendHtml }); effort takes
// (session, level, sendReply). A validated `mode:<target>` is `interactive` or
// `print`, so `arg === 'interactive'` is the wantInteractive boolean.
export function handlePickerValue(value, roomId, session, {
  applyModelSwitch,
  switchEffortInSession,
  applyModeSwitch,
  cancelTimer,
  sendTimerNow,
  answerPermission,
  carryOnConvo,
  sendReply,
  sendHtml,
} = {}) {
  const parsed = parsePickerValue(value);
  if (!parsed) return false;
  const { kind, arg } = parsed;
  if (kind === 'model') {
    applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
    return true;
  }
  if (kind === 'effort') {
    switchEffortInSession(session, arg, sendReply);
    return true;
  }
  if (kind === 'timer') {
    if (parsed.verb === 'send') sendTimerNow(session, arg, sendReply);
    else cancelTimer(session, arg, sendReply);
    return true;
  }
  if (kind === 'perm') {
    answerPermission(session, parsed.requestId, parsed.verdict, sendReply);
    return true;
  }
  if (kind === 'resume') {
    carryOnConvo(arg, session, sendReply);
    return true;
  }
  // kind === 'mode'
  applyModeSwitch(roomId, session, arg === 'interactive', { sendReply, sendHtml });
  return true;
}
