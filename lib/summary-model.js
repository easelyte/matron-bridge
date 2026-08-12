// Provider-selectable LLM client for the title/summary pass. OpenAI (plain
// fetch, no SDK dependency) wins when a key is configured — GPT-5.6 Luna is
// ~2.5x cheaper per token than Gemini 3 Flash Preview as of 2026-08 — with
// the existing Gemini client as fallback so a Gemini-only .env keeps working.
// Returns null when neither provider is configured; callers treat that as
// "summarization off" (fallback titling still runs elsewhere).

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

export function createSummaryModel({
  openaiApiKey = '',
  geminiClient = null,
  modelOverride = '',
  fetchImpl = fetch,
} = {}) {
  if (openaiApiKey) {
    const model = modelOverride || DEFAULT_OPENAI_MODEL;
    return {
      model,
      async generate(prompt) {
        const res = await fetchImpl(OPENAI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('openai: empty completion');
        return text.trim();
      },
    };
  }
  if (geminiClient) {
    const model = modelOverride || DEFAULT_GEMINI_MODEL;
    return {
      model,
      async generate(prompt) {
        const m = geminiClient.getGenerativeModel({ model });
        const result = await m.generateContent(prompt);
        return result.response.text().trim();
      },
    };
  }
  return null;
}
