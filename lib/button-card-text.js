// Question text for the bridge's button cards. A card reaches the apps as a
// journal prompt: the question line plus one label per button. Anything a
// card needs to say beyond that (the current value, an error, what each
// option means) has to be in the question, because nothing else on the
// card is shown.

// An interactive Claude Code prompt. When the detector captured option
// descriptions (AskUserQuestion menus), the question lists them so the user
// sees each option's detail before choosing; the buttons carry labels only.
export function promptCardQuestion(prompt, buttons) {
  const header = prompt?.question || 'Claude is asking';
  const descOf = (i) => (prompt?.options?.[i]?.description || '').trim();
  if (!buttons.some((_, i) => descOf(i))) return header;
  const lines = buttons.map((b, i) => {
    const d = descOf(i);
    return d ? `${i + 1}. ${b.label}: ${d}` : `${i + 1}. ${b.label}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

// Codex /model with no argument: the current model, and why the list may
// be short when the model list could not be read.
export function codexModelCardQuestion({ model = null } = {}, { modelsError = null } = {}) {
  const current = `Current Codex model: ${model || 'Codex config default'}`;
  return modelsError ? `${current}\n\n${modelsError}\nYou can still type /model <model-id>.` : current;
}

// Codex /effort with no argument: the current effort.
export function codexEffortCardQuestion({ effort = null } = {}) {
  return `Codex effort: ${effort || 'config default'}`;
}
