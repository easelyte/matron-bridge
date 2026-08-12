import { describe, it, expect, vi } from 'vitest';
import { createSummaryModel } from '../lib/summary-model.js';

const okFetch = (text) => vi.fn(async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }] }),
}));

describe('createSummaryModel', () => {
  it('returns null when no provider is configured', () => {
    expect(createSummaryModel({})).toBeNull();
  });

  it('prefers OpenAI when a key is set, defaulting to gpt-5.6-luna', async () => {
    const fetchImpl = okFetch('TITLE: t');
    const m = createSummaryModel({ openaiApiKey: 'sk-x', geminiClient: {}, fetchImpl });
    expect(m.model).toBe('gpt-5.6-luna');
    await expect(m.generate('hello')).resolves.toBe('TITLE: t');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(opts.headers.Authorization).toBe('Bearer sk-x');
  });

  it('SUMMARY_MODEL override applies to whichever provider is active', () => {
    const m = createSummaryModel({ openaiApiKey: 'sk-x', modelOverride: 'gpt-5.7-terra', fetchImpl: okFetch('x') });
    expect(m.model).toBe('gpt-5.7-terra');
  });

  it('throws a descriptive error on non-2xx and on an empty completion', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    const m1 = createSummaryModel({ openaiApiKey: 'sk-x', fetchImpl: bad });
    await expect(m1.generate('p')).rejects.toThrow(/openai 429/);
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    const m2 = createSummaryModel({ openaiApiKey: 'sk-x', fetchImpl: empty });
    await expect(m2.generate('p')).rejects.toThrow(/empty/);
  });

  it('falls back to the Gemini client, defaulting to gemini-3-flash-preview', async () => {
    const generateContent = vi.fn(async () => ({ response: { text: () => ' out ' } }));
    const getGenerativeModel = vi.fn(() => ({ generateContent }));
    const m = createSummaryModel({ geminiClient: { getGenerativeModel } });
    expect(m.model).toBe('gemini-3-flash-preview');
    await expect(m.generate('p')).resolves.toBe('out');
    expect(getGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-3-flash-preview' });
  });
});
