import { describe, expect, it, vi } from 'vitest';
import { createCodexSummaryModel, parseMaxConcurrent } from '../lib/codex-summary-model.js';

describe('createCodexSummaryModel', () => {
  it('is null without a one-shot runner or when disabled', () => {
    expect(createCodexSummaryModel({})).toBeNull();
    expect(createCodexSummaryModel({ codexOneShot: vi.fn(), env: { SUMMARY_CODEX_ENABLED: '0' } })).toBeNull();
  });

  it('returns trimmed text and labels the model', async () => {
    const m = createCodexSummaryModel({ codexOneShot: async () => ({ text: '  TITLE: x  ' }), env: { SUMMARY_CODEX_MODEL: 'm1' } });
    expect(m.model).toBe('m1');
    await expect(m.generate('p')).resolves.toBe('TITLE: x');
  });

  it('throws when the run produced no text', async () => {
    const m = createCodexSummaryModel({ codexOneShot: async () => ({ text: null, reason: 'timeout' }), env: {} });
    await expect(m.generate('p')).rejects.toThrow(/timeout/);
  });

  it('caps concurrent calls and releases the slot afterwards', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = createCodexSummaryModel({
      codexOneShot: async () => { await gate; return { text: 'ok' }; },
      env: { SUMMARY_CODEX_MAX_CONCURRENT: '1' },
    });
    const first = m.generate('a');
    await expect(m.generate('b')).rejects.toThrow(/capacity/);
    release();
    await expect(first).resolves.toBe('ok');
    await expect(m.generate('c')).resolves.toBe('ok');
  });

  it('parseMaxConcurrent falls back to 2 outside 1..32', () => {
    expect(parseMaxConcurrent('4')).toBe(4);
    expect(parseMaxConcurrent('0')).toBe(2);
    expect(parseMaxConcurrent('x')).toBe(2);
  });
});

describe('availability gate', () => {
  it('is null when no Codex binary is detected', () => {
    expect(createCodexSummaryModel({ codexOneShot: vi.fn(), available: () => false, env: {} })).toBeNull();
    expect(createCodexSummaryModel({ codexOneShot: vi.fn(), available: () => { throw new Error('x'); }, env: {} })).toBeNull();
  });
});
