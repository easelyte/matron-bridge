import { describe, it, expect } from 'vitest';
import { formatConvoStatus, shortModel, agoText } from '../lib/convo-status-format.js';

const NOW = Date.parse('2026-09-29T14:00:00Z');

describe('formatConvoStatus', () => {
  it('renders model, gauge and age', () => {
    expect(formatConvoStatus({ model: 'claude-opus-5-5[1m]', context: { tokens: 87000, window: 1000000, pct: 9 }, reported_at: NOW - 120000 }, NOW))
      .toBe('opus-5-5[1m] · 87k/1m 9% · reported 2 min ago');
  });
  it('uses the persisted window, not the model-derived one', () => {
    expect(formatConvoStatus({ model: 'gpt-5-codex', context: { tokens: 50000, window: 272000, pct: 18 }, reported_at: NOW }, NOW))
      .toBe('gpt-5-codex · 50k/272k 18% · reported just now');
  });
  it('says context unknown when there is no gauge (old bridge, Codex before its first turn)', () => {
    expect(formatConvoStatus({ model: 'gpt-5-codex', reported_at: NOW - 5000 }, NOW)).toBe('gpt-5-codex · context unknown · reported just now');
  });
  it('renders a usage-limit stall with its reset time, and without one', () => {
    expect(formatConvoStatus({ model: 'claude-fable-5-1', context: { tokens: 400000, window: 1000000, pct: 40 }, stall: { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00Z' }, reported_at: NOW }, NOW))
      .toBe('fable-5-1 · 400k/1m 40% · stalled: usage limit, resets 15:00 UTC · reported just now');
    expect(formatConvoStatus({ stall: { kind: 'usage_limit' }, reported_at: NOW }, NOW)).toBe('context unknown · stalled: usage limit · reported just now');
    expect(formatConvoStatus({ model: 'x', stall: { kind: 'other' }, reported_at: NOW }, NOW)).toBe('x · context unknown · reported just now');
  });
  it('returns an empty string for a missing or malformed status', () => {
    expect(formatConvoStatus(undefined)).toBe('');
    expect(formatConvoStatus(null)).toBe('');
    expect(formatConvoStatus({})).toBe('');
    expect(formatConvoStatus({ context: { tokens: 'x' } })).toBe('');
    expect(formatConvoStatus('opus')).toBe('');
  });
});

describe('helpers', () => {
  it('shortModel strips the claude- prefix only', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5');
    expect(shortModel('opus[1m]')).toBe('opus[1m]');
    expect(shortModel(undefined)).toBe('');
  });
  it('agoText buckets', () => {
    expect(agoText(NOW - 5000, NOW)).toBe('just now');
    expect(agoText(NOW - 90000, NOW)).toBe('2 min ago');
    expect(agoText(NOW - 3 * 3600000, NOW)).toBe('3 h ago');
    expect(agoText(NOW - 2 * 86400000, NOW)).toBe('2 d ago');
    expect(agoText(NOW + 5000, NOW)).toBe('just now');
    expect(agoText(undefined, NOW)).toBe('');
  });
});
