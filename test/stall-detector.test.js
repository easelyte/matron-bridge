import { describe, it, expect } from 'vitest';
import { stallFromAssistantEvent, stallResetsAt } from '../lib/stall-detector.js';
import { buildSessionStatus, contextGaugeText } from '../lib/session-status.js';
import { modelFromEvent } from '../lib/model-aliases.js';

// The record observed on ang (print mode, sdk-cli transcript, Sept 2026).
const REAL_STALL = {
  type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
  message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue." }], usage: { input_tokens: 0, output_tokens: 0 } },
};

const LIMIT_TEXT = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
const ev = (text, extra = {}) => ({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text }] }, ...extra });

describe('stallFromAssistantEvent', () => {
  it('recognises the limit message as the sole text block', () => {
    expect(stallFromAssistantEvent(ev(LIMIT_TEXT))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent(ev(`Error during compaction: ${LIMIT_TEXT}`))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent(ev("You've reached your Opus limit. Run /usage-credits to continue."))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
  });
  it('recognises the real record by its structured fields and never adopts its placeholder model', () => {
    expect(stallFromAssistantEvent(REAL_STALL)).toEqual({ kind: 'usage_limit' });
    expect(stallFromAssistantEvent({ ...REAL_STALL, message: { ...REAL_STALL.message, content: [{ type: 'text', text: 'Some new wording we have not seen.' }] } })).toEqual({ kind: 'usage_limit' });
    expect(stallFromAssistantEvent({ ...REAL_STALL, error: undefined, apiErrorStatus: undefined })).toEqual({ kind: 'usage_limit' }, 'wording alone still matches');
    expect(modelFromEvent(REAL_STALL)).toBeNull();
    expect(modelFromEvent({ type: 'assistant', message: { model: '<synthetic>' } })).toBeNull();
    expect(modelFromEvent({ type: 'assistant', message: { model: 'claude-opus-5-5' } })).toBe('claude-opus-5-5');
  });
  it('recognises the raw API-error form, and a string content body', () => {
    expect(stallFromAssistantEvent(ev('Claude AI usage limit reached|1790700000', { isApiErrorMessage: true }))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent({ type: 'assistant', message: { content: LIMIT_TEXT } })).toEqual({ kind: 'usage_limit' });
  });
  it('does not fire on a message that merely quotes the text, on tool_use, on subagents or on other errors', () => {
    expect(stallFromAssistantEvent(ev(`The spec says the bridge sees "${LIMIT_TEXT}" and reports it.`))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'assistant', message: { content: [{ type: 'text', text: LIMIT_TEXT }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })).toBeNull();
    expect(stallFromAssistantEvent({ ...ev(LIMIT_TEXT), isSidechain: true })).toBeNull();
    expect(stallFromAssistantEvent({ ...ev(LIMIT_TEXT), parent_tool_use_id: 'toolu_1' })).toBeNull();
    expect(stallFromAssistantEvent(ev('API Error: 500 overloaded', { isApiErrorMessage: true }))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'user', message: { content: LIMIT_TEXT } })).toBeNull();
    expect(stallFromAssistantEvent(null)).toBeNull();
  });
});

describe('stallResetsAt', () => {
  it('prefers the fullest meter with a reset, then the session meter, then any line with a reset time', () => {
    expect(stallResetsAt([{ id: 'week_all', label: 'Week (all models)', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }, { id: 'session', label: 'Current session', percent: 100, resets_at: '2026-09-29T15:00:00.000Z' }])).toBe('2026-09-29T15:00:00.000Z');
    // A per-model weekly meter is the one that filled: its reset wins over a
    // half-empty session meter.
    expect(stallResetsAt([{ id: 'session', label: 'Current session', percent: 30, resets_at: '2026-09-29T15:00:00.000Z' }, { id: 'week_fable', label: 'Week (Fable)', percent: 100, resets_at: '2026-10-02T00:00:00.000Z' }])).toBe('2026-10-02T00:00:00.000Z');
    expect(stallResetsAt([{ id: 'session', label: 'Current session', percent: 30, resets_at: '2026-09-29T15:00:00.000Z' }, { id: 'week_fable', label: 'Week (Fable)', percent: 100 }])).toBe('2026-09-29T15:00:00.000Z', 'a full meter without a reset time cannot answer');
    expect(stallResetsAt([{ id: 'week_all', label: 'Week (all models)', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }])).toBe('2026-10-02T00:00:00.000Z');
    expect(stallResetsAt([{ id: 'session', label: 'Current session', percent: 100 }])).toBeUndefined();
    expect(stallResetsAt(undefined)).toBeUndefined();
  });
});

describe('buildSessionStatus stall', () => {
  it('passes a stall object through and omits the key otherwise', () => {
    const stall = { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1 };
    expect(buildSessionStatus({ model: 'claude-fable-5-1', stall }).stall).toEqual(stall);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1' })).toBe(false);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1', stall: null })).toBe(false);
  });
});

describe('contextGaugeText window override', () => {
  it('uses an explicit window over the model-derived one, and ignores a bad one', () => {
    expect(contextGaugeText(87000, 'claude-sonnet-4-6', 1000000)).toBe('87k/1m');
    expect(contextGaugeText(87000, 'claude-sonnet-4-6', 0)).toBe('87k/200k');
    expect(contextGaugeText(87000, 'claude-sonnet-4-6')).toBe('87k/200k');
  });
});
