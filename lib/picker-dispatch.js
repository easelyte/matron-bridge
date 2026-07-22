// Picker-button dispatch for the journal prompt_reply return path.
//
// The no-arg /model, /effort and /mode commands publish button messages whose
// option VALUES are namespaced `model:<alias>`, `effort:<level>` and
// `mode:<target>` (lib/model-command.js modelButtons, lib/effort-command.js
// effortButtons, lib/session-mode.js modeButtons). A Matron tap arrives back at
// the bridge as a journal prompt_reply whose `choice` carries that value — the
// same wire shape a Matrix button_response once carried. Upstream (issue #98)
// only ever wired these three through the deleted Matrix button path, so the
// journal prompt_reply path never dispatched them: a tap fell through to
// pending-prompt routing, matched nothing, and no-op'd ("Nothing to answer
// right now"). This module is the missing dispatch, extracted pure (injected
// switch fns, no I/O) so it's unit-testable without a live session — the same
// shape as lib/busy-queue.js isQueueActionValue / handleQueueActionValue.
//
// Classified by value shape, exactly like isQueueActionValue: the values are
// bridge-controlled constants (never user or model text) namespaced with a
// `<kind>:` prefix, which is what makes shape-matching safe. Disjoint from the
// other reply shapes — queue actions (`interrupt` / `cancel:<n>`),
// pending-prompt answers (`prompt-opt:<n>`) — so ordering the branches doesn't
// matter for correctness.

const PICKER_VALUE = /^(model|effort|mode):(.+)$/;

export function isPickerValue(value) {
  return typeof value === 'string' && PICKER_VALUE.test(value);
}

// Dispatch a picker tap to the matching switch implementation. Returns true if
// `value` was a picker value and has been handled, false otherwise (nothing
// touched — the caller continues to pending-prompt routing). Mirrors the
// explicit-arg !model/!effort/!mode command handlers in index.js: model and
// mode take (roomId, session, arg, { sendReply, sendHtml }); effort takes
// (session, level, sendReply). The `mode:<target>` value is `interactive` or
// `print` (session-mode.js modeButtons), so `target === 'interactive'` is the
// wantInteractive boolean applyModeSwitch expects.
export function handlePickerValue(value, roomId, session, {
  applyModelSwitch,
  switchEffortInSession,
  applyModeSwitch,
  sendReply,
  sendHtml,
} = {}) {
  const m = typeof value === 'string' ? value.match(PICKER_VALUE) : null;
  if (!m) return false;
  const [, kind, arg] = m;
  if (kind === 'model') {
    applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
    return true;
  }
  if (kind === 'effort') {
    switchEffortInSession(session, arg, sendReply);
    return true;
  }
  // kind === 'mode'
  applyModeSwitch(roomId, session, arg === 'interactive', { sendReply, sendHtml });
  return true;
}
