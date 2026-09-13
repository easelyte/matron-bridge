import { describe, it, expect } from 'vitest';
import { extractModelFlag } from '../lib/model-aliases.js';

describe('extractModelFlag', () => {
  it('returns nothing when no --model flag is present', () => {
    const out = extractModelFlag(['/tmp/repo', '--browser']);
    expect(out).toEqual({ model: null, present: false, rest: ['/tmp/repo', '--browser'], error: null });
  });

  it('parses the spaced form and leaves positionals untouched', () => {
    const out = extractModelFlag(['--model', 'opus', '/tmp/repo']);
    expect(out.model).toBe('opus');
    expect(out.present).toBe(true);
    expect(out.error).toBe(null);
    expect(out.rest).toEqual(['/tmp/repo']);
  });

  it('parses the = form', () => {
    const out = extractModelFlag(['--model=sonnet', '/tmp/repo']);
    expect(out.model).toBe('sonnet');
    expect(out.rest).toEqual(['/tmp/repo']);
  });

  it('normalizes the value case', () => {
    expect(extractModelFlag(['--model', 'Opus[1M]']).model).toBe('opus[1m]');
    expect(extractModelFlag(['--model=Haiku']).model).toBe('haiku');
  });

  it('accepts a full claude-* model name', () => {
    const out = extractModelFlag(['--model', 'claude-opus-4-8[1m]']);
    expect(out.model).toBe('claude-opus-4-8[1m]');
    expect(out.error).toBe(null);
  });

  // Matrix / iPhone clients auto-correct a leading `--` into an em/en dash —
  // the same sieve extractMcpExtraFlags and extractAgentFlag apply.
  it('normalizes leading unicode dashes in both forms', () => {
    expect(extractModelFlag(['—model', 'fable']).model).toBe('fable');
    expect(extractModelFlag(['–model=fable']).model).toBe('fable');
    expect(extractModelFlag(['―model', 'fable']).model).toBe('fable');
  });

  it('does not swallow a unicode-dashed flag as the --model value', () => {
    const out = extractModelFlag(['--model', '—browser']);
    expect(out.model).toBe(null);
    expect(out.present).toBe(true);
    expect(out.error).toMatch(/needs a model/i);
    expect(out.rest).toEqual(['—browser']);
  });

  it('a missing value is an error, not a silent no-op', () => {
    const out = extractModelFlag(['--model']);
    expect(out.present).toBe(true);
    expect(out.model).toBe(null);
    expect(out.error).toMatch(/needs a model/i);
    expect(out.error).toMatch(/sonnet/);
  });

  it('an empty = value is an error', () => {
    const out = extractModelFlag(['--model=']);
    expect(out.error).toMatch(/needs a model/i);
  });

  it('does not consume the next flag as a value', () => {
    const out = extractModelFlag(['--model', '--browser', '/tmp/repo']);
    expect(out.model).toBe(null);
    expect(out.error).toMatch(/needs a model/i);
    expect(out.rest).toEqual(['--browser', '/tmp/repo']);
  });

  it('an unknown alias is an error listing the valid ones', () => {
    const out = extractModelFlag(['--model', 'gpt-5']);
    expect(out.model).toBe(null);
    expect(out.present).toBe(true);
    expect(out.error).toMatch(/Unknown model "gpt-5"/);
    expect(out.error).toMatch(/opus/);
    expect(out.error).toMatch(/claude-\*/);
  });

  it('rejects two different models', () => {
    const out = extractModelFlag(['--model', 'opus', '--model=sonnet']);
    expect(out.error).toMatch(/only one model/i);
  });

  it('accepts the same model twice', () => {
    const out = extractModelFlag(['--model', 'opus', '--model=OPUS']);
    expect(out.model).toBe('opus');
    expect(out.error).toBe(null);
  });

  it('is safe on an empty/absent token list', () => {
    expect(extractModelFlag()).toEqual({ model: null, present: false, rest: [], error: null });
    expect(extractModelFlag([])).toEqual({ model: null, present: false, rest: [], error: null });
  });

  it('leaves a positional that merely starts with the flag name alone', () => {
    const out = extractModelFlag(['--modelling', '/tmp/repo']);
    expect(out.present).toBe(false);
    expect(out.rest).toEqual(['--modelling', '/tmp/repo']);
  });
});
