// Providers are tried in SUMMARY_PROVIDERS order. One without its key (or
// client) is skipped, and a failed request falls through to the next one.
// The journal comes first by default: it summarises with a key it holds
// server-side, so a box needs no provider key of its own. Local keys, where a
// box has them, are fallbacks for a journal that cannot summarise.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
export const SUMMARY_PROVIDER_NAMES = ['journal', 'anthropic', 'openai', 'gemini'];
export const DEFAULT_SUMMARY_PROVIDERS = SUMMARY_PROVIDER_NAMES.join(',');

export function parseSummaryProviders(value = DEFAULT_SUMMARY_PROVIDERS) {
  const names = (Array.isArray(value) ? value : String(value).split(','))
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);
  if (!names.length || names.some((name) => !SUMMARY_PROVIDER_NAMES.includes(name)) || new Set(names).size !== names.length) {
    throw new Error(`Invalid SUMMARY_PROVIDERS: use a comma-separated order of ${DEFAULT_SUMMARY_PROVIDERS}`);
  }
  return names;
}

export function createSummaryModel({
  providers = DEFAULT_SUMMARY_PROVIDERS,
  journalBaseUrl = '',
  journalToken = '',
  anthropicApiKey = '',
  anthropicModel = DEFAULT_ANTHROPIC_MODEL,
  openaiApiKey = '',
  geminiClient = null,
  modelOverride = '',
  fetchImpl = fetch,
  onFallback = () => {},
  onUsage = () => {},
  now = Date.now,
} = {}) {
  const builders = {
    journal: () => journalBaseUrl && journalToken && createJournalModel({ baseUrl: journalBaseUrl, token: journalToken, fetchImpl, onUsage, now }),
    anthropic: () => anthropicApiKey && createAnthropicModel({ apiKey: anthropicApiKey, model: anthropicModel, fetchImpl, onUsage }),
    openai: () => openaiApiKey && createOpenAiModel({ apiKey: openaiApiKey, model: modelOverride || DEFAULT_OPENAI_MODEL, fetchImpl }),
    gemini: () => geminiClient && createGeminiModel({ client: geminiClient, model: modelOverride || DEFAULT_GEMINI_MODEL }),
  };
  const chain = parseSummaryProviders(providers)
    .map((name) => { const m = builders[name](); return m && { name, ...m }; })
    .filter(Boolean);
  if (!chain.length) return null;
  // Each call reports the model that actually wrote its text, so concurrent
  // passes (several sessions summarising at once) never read each other's.
  async function generateWithModel(prompt) {
    for (let i = 0; ; i++) {
      try {
        return await chain[i].generate(prompt);
      } catch (error) {
        const next = chain[i + 1];
        if (!next) throw error;
        // Deliberately omit the exception: transport errors can contain data.
        onFallback({ provider: chain[i].name, fallbackModel: next.model });
      }
    }
  }
  return {
    // The first provider's model: a label for the configuration, not for any
    // one summary — use generateWithModel for that.
    model: chain[0].model,
    generateWithModel,
    async generate(prompt) {
      return (await generateWithModel(prompt)).text;
    },
  };
}

// Only Claude takes the structured { system, prompt } form (the fixed system
// part is its cache prefix); the others get it flattened back to one string.
const flatten = (prompt) => typeof prompt === 'string' ? prompt : `${prompt.system}\n\n${prompt.prompt}`;

// A hung provider must not stall the chain: every call gets the same deadline.
const PROVIDER_TIMEOUT_MS = 30_000;

// POST /summarise on the journal, under the bridge's own journal token.
// Every failure throws so the chain moves on. A journal without the route
// (404) or without a key of its own (503) is skipped for a while rather than
// asked on every turn; a 429 is skipped for as long as Retry-After says.
export const JOURNAL_SKIP_MS = 10 * 60_000;
const JOURNAL_RETRY_AFTER_DEFAULT_MS = 60_000;

function retryAfterMs(header, nowMs) {
  if (!header) return JOURNAL_RETRY_AFTER_DEFAULT_MS;
  const trimmed = String(header).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? JOURNAL_RETRY_AFTER_DEFAULT_MS : Math.max(0, at - nowMs);
}

function createJournalModel({ baseUrl, token, fetchImpl, onUsage, now }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/summarise`;
  let skipUntil = 0;
  return {
    model: 'journal',
    async generate(prompt) {
      if (now() < skipUntil) throw new Error('journal: backing off');
      const body = typeof prompt === 'string' ? { prompt } : { system: prompt.system, prompt: prompt.prompt };
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      // Never log the body: an error may echo prompt content.
      if (!res.ok) {
        if (res.status === 404 || res.status === 503) skipUntil = now() + JOURNAL_SKIP_MS;
        else if (res.status === 429) skipUntil = now() + retryAfterMs(res.headers?.get?.('retry-after'), now());
        throw new Error(`journal HTTP ${res.status}`);
      }
      const data = await res.json();
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) throw new Error('journal: empty completion');
      const model = typeof data.model === 'string' && data.model ? data.model : 'journal';
      const u = data.usage || {};
      onUsage({
        model,
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        cacheReadTokens: u.cacheReadTokens || 0,
        cacheWriteTokens: u.cacheWriteTokens || 0,
      });
      return { text, model };
    },
  };
}

function createAnthropicModel({ apiKey, model, fetchImpl, onUsage }) {
  return {
    model,
    async generate(prompt) {
      const structured = typeof prompt !== 'string';
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          thinking: { type: 'disabled' },
          ...(structured ? { system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }] } : {}),
          messages: [{ role: 'user', content: structured ? prompt.prompt : prompt }],
        }),
      });
      // Never log provider response bodies: they may echo prompt content.
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const data = await res.json();
      if (data.stop_reason !== 'end_turn') throw new Error('anthropic: incomplete completion');
      const result = data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!result) throw new Error('anthropic: empty completion');
      onUsage({
        model,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
      });
      return { text: result, model };
    },
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

function createOpenAiModel({ apiKey, model, fetchImpl }) {
  return {
    model,
    async generate(prompt) {
      const res = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: flatten(prompt) }] }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('openai: empty completion');
      return { text: text.trim(), model };
    },
  };
}

function createGeminiModel({ client, model }) {
  return {
    model,
    async generate(prompt) {
      const m = client.getGenerativeModel({ model });
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('gemini: timed out')), PROVIDER_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([m.generateContent(flatten(prompt)), deadline]);
        return { text: result.response.text().trim(), model };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
