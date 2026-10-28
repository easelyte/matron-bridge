import { describe, it, expect, vi } from 'vitest';
import { createSummaryModel, parseSummaryProviders, DEFAULT_SUMMARY_PROVIDERS } from '../lib/summary-model.js';

const okFetch = (text) => vi.fn(async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }] }),
}));

describe('createSummaryModel', () => {
  it('returns null when no provider is configured', () => {
    expect(createSummaryModel({})).toBeNull();
  });

  it('prefers OpenAI when a key is set, defaulting to gpt-6-luna', async () => {
    const fetchImpl = okFetch('TITLE: t');
    const m = createSummaryModel({ openaiApiKey: 'sk-x', geminiClient: {}, fetchImpl });
    expect(m.model).toBe('gpt-6-luna');
    await expect(m.generate('hello')).resolves.toBe('TITLE: t');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-6-luna');
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


describe('Claude summaries and the SUMMARY_PROVIDERS order', () => {
  const claudeFetch = (data = {}) => vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'TITLE: done' }], stop_reason: 'end_turn', ...data }),
  }));
  const gemini = (text = 'Gemini') => ({ getGenerativeModel: () => ({ generateContent: async () => ({ response: { text: () => text } }) }) });

  it('prefers Claude by default only when its key is present', () => {
    expect(createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test' }).model).toBe('claude-haiku-5-5');
    expect(createSummaryModel({ openaiApiKey: 'test' }).model).toBe('gpt-6-luna');
    expect(createSummaryModel({ anthropicApiKey: 'test' }).model).toBe('claude-haiku-5-5');
  });

  it('follows an explicit order and skips providers without keys', () => {
    expect(createSummaryModel({ providers: 'openai,gemini', anthropicApiKey: 'test', openaiApiKey: 'test' }).model).toBe('gpt-6-luna');
    expect(createSummaryModel({ providers: ' Gemini , anthropic ', anthropicApiKey: 'test', geminiClient: gemini() }).model).toBe('gemini-3-flash-preview');
    expect(createSummaryModel({ providers: 'gemini', anthropicApiKey: 'test' })).toBeNull();
  });

  it.each(['', 'claude', 'openai,openai', 'legacy'])('rejects the invalid order %j', (providers) => {
    expect(() => createSummaryModel({ providers })).toThrow('Invalid SUMMARY_PROVIDERS');
  });

  it('sends fixed instructions at a cache breakpoint and reports only numeric usage', async () => {
    const fetchImpl = claudeFetch({ usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 600 } });
    const onUsage = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', fetchImpl, onUsage });
    await expect(model.generate({ system: 'fixed format', prompt: 'changing transcript' })).resolves.toBe('TITLE: done');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers).toMatchObject({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1024, thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'fixed format', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'changing transcript' }],
    });
    expect(onUsage).toHaveBeenCalledWith({ model: 'claude-haiku-5-5', inputTokens: 50, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it('accepts compaction strings without caching their changing content', async () => {
    const fetchImpl = claudeFetch();
    await createSummaryModel({ anthropicApiKey: 'test', fetchImpl }).generate('compact this');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('system');
  });

  it('flattens the structured prompt for OpenAI and Gemini', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    await createSummaryModel({ openaiApiKey: 'test', fetchImpl }).generate({ system: 'rules', prompt: 'messages' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content).toBe('rules\n\nmessages');
    const generateContent = vi.fn(async () => ({ response: { text: () => 'g' } }));
    await createSummaryModel({ geminiClient: { getGenerativeModel: () => ({ generateContent }) } }).generate({ system: 'rules', prompt: 'messages' });
    expect(generateContent).toHaveBeenCalledWith('rules\n\nmessages');
  });

  it.each(['max_tokens', 'refusal', 'pause_turn'])('falls back on %s without accepting partial output', async (stop_reason) => {
    const fetchImpl = claudeFetch({ stop_reason });
    fetchImpl.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'partial' }], stop_reason }) }));
    fetchImpl.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'legacy' } }] }) }));
    const onFallback = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test', modelOverride: 'legacy-custom', fetchImpl, onFallback });
    await expect(model.generate({ system: 'rules', prompt: 'messages' })).resolves.toBe('legacy');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ model: 'legacy-custom', messages: [{ role: 'user', content: 'rules\n\nmessages' }] });
    expect(onFallback).toHaveBeenCalledWith({ provider: 'anthropic', fallbackModel: 'legacy-custom' });
  });

  it('falls through every provider in order, without exposing error details', async () => {
    const onFallback = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test',
      fetchImpl: vi.fn(async () => { throw new Error('sensitive transport detail'); }), onFallback, geminiClient: gemini(),
    });
    await expect(model.generate('prompt')).resolves.toBe('Gemini');
    expect(onFallback.mock.calls.map(([e]) => e.provider)).toEqual(['anthropic', 'openai']);
    expect(JSON.stringify(onFallback.mock.calls)).not.toContain('sensitive');
  });

  it('rejects HTTP errors and empty completions when no fallback is available', async () => {
    const bad = createSummaryModel({ anthropicApiKey: 'test', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'private' }) });
    await expect(bad.generate('p')).rejects.toThrow('anthropic HTTP 429');
    const empty = createSummaryModel({ anthropicApiKey: 'test', fetchImpl: claudeFetch({ content: [] }) });
    await expect(empty.generate('p')).rejects.toThrow('empty completion');
  });

  it('gives OpenAI a deadline and moves past a hung Gemini call', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    await createSummaryModel({ providers: 'openai', openaiApiKey: 'test', fetchImpl }).generate('p');
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    vi.useFakeTimers();
    try {
      const hung = { getGenerativeModel: () => ({ generateContent: () => new Promise(() => {}) }) };
      const result = createSummaryModel({ providers: 'gemini', geminiClient: hung }).generate('p');
      const assertion = expect(result).rejects.toThrow('gemini: timed out');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the journal summariser', () => {
  const BASE = 'https://journal.example.com';
  const SUMMARISE_URL = `${BASE}/summarise`;
  const usage = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 300, cacheWriteTokens: 5 };
  const ok = (text = 'TITLE: from journal', model = 'claude-haiku-5-5') => ({
    ok: true, status: 200, headers: new Headers(), json: async () => ({ text, model, usage }),
  });
  const fail = (status, headers = {}) => ({
    ok: false, status, headers: new Headers(headers), json: async () => ({ error: 'private detail' }),
  });
  const openaiOk = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from openai' } }] }) };
  const journal = (extra = {}) => ({ journalBaseUrl: `${BASE}/`, journalToken: 'jt-test', ...extra });

  it('is first in the default order and needs only a journal URL and token', () => {
    expect(parseSummaryProviders()).toEqual(['journal', 'anthropic', 'openai', 'gemini']);
    expect(DEFAULT_SUMMARY_PROVIDERS).toBe('journal,anthropic,openai,gemini');
    expect(createSummaryModel(journal()).model).toBe('journal');
    expect(createSummaryModel({ ...journal(), anthropicApiKey: 'test', openaiApiKey: 'test' }).model).toBe('journal');
    expect(createSummaryModel({ journalBaseUrl: BASE })).toBeNull();
    expect(createSummaryModel({ journalToken: 'jt-test' })).toBeNull();
  });

  it('gives a journal-only bridge a summary model, so it is not nagged as having none', () => {
    // index.js files the "no summary model" notice only when this is null.
    expect(createSummaryModel({ ...journal(), anthropicApiKey: '', openaiApiKey: '', geminiClient: null })).not.toBeNull();
  });

  it('still accepts an explicit order that leaves the journal out', () => {
    const m = createSummaryModel({ ...journal(), providers: 'anthropic,openai,gemini', openaiApiKey: 'test' });
    expect(m.model).toBe('gpt-6-luna');
    expect(createSummaryModel({ ...journal(), providers: 'gemini' })).toBeNull();
    expect(parseSummaryProviders(' Journal ,openai')).toEqual(['journal', 'openai']);
  });

  it('posts a structured prompt to /summarise with the bridge bearer token', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const m = createSummaryModel({ ...journal(), fetchImpl });
    await expect(m.generate({ system: 'fixed format', prompt: 'changing transcript' })).resolves.toBe('TITLE: from journal');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/summarise`);
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer jt-test' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(opts.body)).toEqual({ system: 'fixed format', prompt: 'changing transcript' });
  });

  it('sends a plain string prompt as {prompt}', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await createSummaryModel({ ...journal(), fetchImpl }).generate('compact this');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ prompt: 'compact this' });
  });

  it('reports usage and returns the model the journal used with the text', async () => {
    const onUsage = vi.fn();
    const m = createSummaryModel({ ...journal(), fetchImpl: vi.fn(async () => ok(' text ', 'some-model')), onUsage });
    await expect(m.generateWithModel('p')).resolves.toEqual({ text: 'text', model: 'some-model' });
    await expect(m.generate('p')).resolves.toBe('text');
    expect(onUsage).toHaveBeenCalledWith({ model: 'some-model', ...usage });
    expect(m.model).toBe('journal');
  });

  it('keeps each concurrent call paired with its own model', async () => {
    // Call A asks first and is answered last, by a different model than B;
    // B falls through to OpenAI. Nothing shared may leak between them.
    const releases = [];
    const fetchImpl = vi.fn((url, opts) => {
      if (url !== SUMMARISE_URL) return Promise.resolve(openaiOk);
      const { prompt } = JSON.parse(opts.body);
      return new Promise((resolve) => releases.push({ prompt, resolve }));
    });
    const m = createSummaryModel({ ...journal(), openaiApiKey: 'test', fetchImpl });
    const a = m.generateWithModel('first');
    const b = m.generateWithModel('second');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.find((r) => r.prompt === 'second').resolve(fail(502));
    await expect(b).resolves.toEqual({ text: 'from openai', model: 'gpt-6-luna' });
    releases.find((r) => r.prompt === 'first').resolve(ok('from journal', 'model-a'));
    await expect(a).resolves.toEqual({ text: 'from journal', model: 'model-a' });
    expect(m.model).toBe('journal');
  });

  it('treats an empty text as a failure', async () => {
    const m = createSummaryModel({ ...journal(), providers: 'journal', fetchImpl: vi.fn(async () => ok('  ')) });
    await expect(m.generate('p')).rejects.toThrow('journal: empty completion');
  });

  it.each([
    ['503', () => fail(503)],
    ['429', () => fail(429, { 'Retry-After': '30' })],
    ['502', () => fail(502)],
    ['404', () => fail(404)],
    ['401', () => fail(401)],
    ['a network error', () => { throw new Error('sensitive transport detail'); }],
  ])('falls through to the next provider on %s', async (_label, journalResponse) => {
    const fetchImpl = vi.fn(async (url) => (url === SUMMARISE_URL ? journalResponse() : openaiOk));
    const onFallback = vi.fn();
    const m = createSummaryModel({ ...journal(), openaiApiKey: 'test', fetchImpl, onFallback });
    await expect(m.generateWithModel({ system: 's', prompt: 'p' })).resolves.toEqual({ text: 'from openai', model: 'gpt-6-luna' });
    expect(onFallback).toHaveBeenCalledWith({ provider: 'journal', fallbackModel: 'gpt-6-luna' });
    expect(JSON.stringify(onFallback.mock.calls)).not.toContain('private');
  });

  it('rejects with the status only, never the body', async () => {
    const m = createSummaryModel({ ...journal(), fetchImpl: vi.fn(async () => fail(502)) });
    const err = await m.generate('p').catch((e) => e);
    expect(err.message).toBe('journal HTTP 502');
  });

  describe('back-off', () => {
    let clock;
    const now = () => clock;
    const setup = (journalResponse) => {
      const fetchImpl = vi.fn(async (url) => (url === SUMMARISE_URL ? journalResponse() : openaiOk));
      const m = createSummaryModel({ ...journal({ now }), openaiApiKey: 'test', fetchImpl });
      const journalCalls = () => fetchImpl.mock.calls.filter(([u]) => u === SUMMARISE_URL).length;
      return { m, journalCalls };
    };

    it.each([404, 503])('skips the journal for 10 minutes after a %i', async (status) => {
      clock = 1_000_000;
      const { m, journalCalls } = setup(() => fail(status));
      await m.generate('p');
      expect(journalCalls()).toBe(1);
      clock += 9 * 60_000;
      await expect(m.generate('p')).resolves.toBe('from openai');
      expect(journalCalls()).toBe(1);
      clock += 60_000;
      await m.generate('p');
      expect(journalCalls()).toBe(2);
    });

    it('honours Retry-After seconds after a 429', async () => {
      clock = 1_000_000;
      const { m, journalCalls } = setup(() => fail(429, { 'Retry-After': '120' }));
      await m.generate('p');
      clock += 119_000;
      await m.generate('p');
      expect(journalCalls()).toBe(1);
      clock += 1_000;
      await m.generate('p');
      expect(journalCalls()).toBe(2);
    });

    it('honours an HTTP-date Retry-After and falls back to a minute without one', async () => {
      clock = Date.parse('2026-01-01T00:00:00Z');
      const dated = setup(() => fail(429, { 'Retry-After': 'Thu, 01 Jan 2026 00:05:00 GMT' }));
      await dated.m.generate('p');
      clock += 4 * 60_000;
      await dated.m.generate('p');
      expect(dated.journalCalls()).toBe(1);
      clock += 60_000;
      await dated.m.generate('p');
      expect(dated.journalCalls()).toBe(2);

      clock = 0;
      const bare = setup(() => fail(429));
      await bare.m.generate('p');
      clock += 59_000;
      await bare.m.generate('p');
      expect(bare.journalCalls()).toBe(1);
      clock += 1_000;
      await bare.m.generate('p');
      expect(bare.journalCalls()).toBe(2);
    });

    it('does not back off after a 502 or a network error', async () => {
      clock = 0;
      const { m, journalCalls } = setup(() => fail(502));
      await m.generate('p');
      await m.generate('p');
      expect(journalCalls()).toBe(2);
      const net = setup(() => { throw new Error('down'); });
      await net.m.generate('p');
      await net.m.generate('p');
      expect(net.journalCalls()).toBe(2);
    });

    it('rejects quickly while backing off when the journal is the only provider', async () => {
      clock = 0;
      const fetchImpl = vi.fn(async () => fail(503));
      const m = createSummaryModel({ ...journal({ now }), fetchImpl });
      await expect(m.generate('p')).rejects.toThrow('journal HTTP 503');
      await expect(m.generate('p')).rejects.toThrow('journal: backing off');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
