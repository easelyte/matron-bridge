// Turn a PromptDetector-classified prompt (see lib/prompt-detector.js) into
// Matrix buttons, and map a button tap back to the keystroke response that
// InteractiveSession.respondToPrompt expects. Pure + unit-testable; the bridge
// wires these into handleInteractivePrompt and the button-response handler.
//
// promptButtons returns null when the prompt can't be cleanly turned into a
// single-select button set — the caller then falls back to the text rendering.
// A free-text slot (freeTextIdx set, e.g. plan-mode's "Tell Claude what to
// change") falls back to text so the user can still type a freeform reply.

export function promptButtons(prompt) {
  if (!prompt || !Array.isArray(prompt.options) || prompt.options.length === 0) return null;
  if (prompt.freeTextIdx != null) return null;
  if (prompt.multiSelect) return null;
  const buttons = [];
  for (let i = 0; i < prompt.options.length; i++) {
    const label = ((prompt.options[i] && prompt.options[i].label) || '').trim();
    if (!label) return null; // can't label a button — fall back to text
    buttons.push({ id: `prompt-opt-${i}`, label, value: `prompt-opt:${i}` });
  }
  return { buttons, mode: 'pick_one' };
}

export function promptResponseForButton(prompt, index) {
  if (!prompt || !Array.isArray(prompt.options)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= prompt.options.length) return null;
  if (prompt.kind === 'arrow-menu') return { kind: 'arrow-menu', key: String(index) };
  // yes-no / numbered / lettered: the detector stores the keystroke key on the
  // option (e.g. 'y'/'n', '1'/'2', 'a'/'b').
  const key = prompt.options[index].key;
  if (key === undefined || key === null) return null;
  return { kind: prompt.kind, key: String(key) };
}
