// Summary-model provider backed by a contained Codex one-shot (lib/codex-oneshot.js).
// Same { model, generate(prompt) } shape as lib/summary-model.js, so the
// title/summary pass needs no OpenAI or Gemini key on a box that has Codex.
// generate() throws on a failed run; the pass logs the failure and the
// fallback title still applies.
export function parseMaxConcurrent(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 2;
}

export function createCodexSummaryModel({ codexOneShot, available = () => true, env = process.env, model = null } = {}) {
  if (typeof codexOneShot !== 'function') return null;
  // No Codex binary on this box: leave the provider chain to OpenAI/Gemini.
  try { if (!available()) return null; } catch { return null; }
  if ((env.SUMMARY_CODEX_ENABLED ?? '1') === '0') return null;
  const label = model || env.SUMMARY_CODEX_MODEL || 'codex';
  const maxConcurrent = parseMaxConcurrent(env.SUMMARY_CODEX_MAX_CONCURRENT);
  let active = 0;
  return {
    model: label,
    async generate(prompt) {
      // Global cap across sessions: a saturated pass is skipped and retried at
      // the session's next turn end (the cursor only advances on success).
      if (active >= maxConcurrent) throw new Error('codex summary at capacity');
      active++;
      let result;
      try { result = await codexOneShot(prompt); } finally { active--; }
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      if (!text) throw new Error(`codex one-shot produced no text (${result?.reason || 'empty'})`);
      return text;
    },
  };
}
