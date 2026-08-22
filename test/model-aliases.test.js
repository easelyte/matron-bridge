import { describe, it, expect } from 'vitest';
import {
  SWITCHABLE_ALIASES,
  VALID_ALIAS_HINT,
  isValidModelArg,
  normalizeModelArg,
  aliasLabel,
  modelFromEvent,
  modelOptions,
} from '../lib/model-aliases.js';

describe('SWITCHABLE_ALIASES', () => {
  it('lists the eight switchable models with labels', () => {
    expect(SWITCHABLE_ALIASES.map(m => m.alias)).toEqual([
      'default', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'opusplan', 'fable',
    ]);
    for (const m of SWITCHABLE_ALIASES) expect(typeof m.label).toBe('string');
  });
});

describe('modelOptions', () => {
  it('offers the switchable aliases as {value,label} pairs for the status frame', () => {
    const options = modelOptions();
    expect(options).toHaveLength(SWITCHABLE_ALIASES.length);
    expect(options[0]).toEqual({ value: 'default', label: 'Default' });
    expect(options.find(o => o.value === 'opus[1m]')).toEqual({ value: 'opus[1m]', label: 'Opus 1M' });
    expect(options.every(o => Object.keys(o).sort().join(',') === 'label,value')).toBe(true);
  });

  it("omits 'best' — valid to type, never offered (matches the buttons)", () => {
    expect(modelOptions().some(o => o.value === 'best')).toBe(false);
    expect(isValidModelArg('best')).toBe(true);
  });
});

describe('isValidModelArg', () => {
  it('accepts known aliases case-insensitively', () => {
    expect(isValidModelArg('sonnet')).toBe(true);
    expect(isValidModelArg('OPUS')).toBe(true);
    expect(isValidModelArg('opusplan')).toBe(true);
    expect(isValidModelArg('best')).toBe(true);
  });
  it('accepts [1m] long-context variants', () => {
    expect(isValidModelArg('opus[1m]')).toBe(true);
    expect(isValidModelArg('sonnet[1m]')).toBe(true);
  });
  it('accepts full claude-* model names (with optional [1m])', () => {
    expect(isValidModelArg('claude-opus-4-8')).toBe(true);
    expect(isValidModelArg('claude-opus-4-8[1m]')).toBe(true);
  });
  it('rejects unknown garbage', () => {
    expect(isValidModelArg('banana')).toBe(false);
    expect(isValidModelArg('')).toBe(false);
    expect(isValidModelArg(undefined)).toBe(false);
  });
});

describe('normalizeModelArg', () => {
  it('trims and lower-cases', () => {
    expect(normalizeModelArg('  Sonnet ')).toBe('sonnet');
    expect(normalizeModelArg('OPUS[1M]')).toBe('opus[1m]');
  });
});

describe('aliasLabel', () => {
  it('returns the pretty label for a known alias', () => {
    expect(aliasLabel('opusplan')).toBe('Opus Plan');
    expect(aliasLabel('opus[1m]')).toBe('Opus 1M');
  });
  it('falls back to the raw arg for full names', () => {
    expect(aliasLabel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('VALID_ALIAS_HINT', () => {
  it('is a comma-separated hint of switchable aliases', () => {
    expect(VALID_ALIAS_HINT).toContain('sonnet');
    expect(VALID_ALIAS_HINT).toContain('opusplan');
  });
});

describe('modelFromEvent', () => {
  it('reads message.model from an assistant-shaped event', () => {
    expect(modelFromEvent({ message: { model: 'claude-opus-4-8' } })).toBe('claude-opus-4-8');
  });
  it('returns null when there is no model', () => {
    expect(modelFromEvent({ type: 'system', subtype: 'init' })).toBe(null);
    expect(modelFromEvent(null)).toBe(null);
    expect(modelFromEvent({ message: {} })).toBe(null);
  });
  it('skips subagent events — their model must not clobber the parent meter', () => {
    // Print mode tags subagent events with parent_tool_use_id; older inline
    // transcripts use isSidechain. contextWindowFor() derives the gauge
    // window from the model, so one leaked subagent event corrupts both the
    // header's model label and the context percentage.
    expect(modelFromEvent({ parent_tool_use_id: 'tu_1', message: { model: 'claude-haiku-4-5' } })).toBe(null);
    expect(modelFromEvent({ isSidechain: true, message: { model: 'claude-haiku-4-5' } })).toBe(null);
  });
});
