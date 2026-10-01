import { describe, it, expect } from 'vitest';
import { armFromStall, autoResumeDue, shouldCompactBefore, dueResumes, AUTO_RESUME_TEXT, RESUME_GRACE_MS, RESUME_RETRY_MS, RESUME_MAX_RETRIES } from '../lib/auto-resume.js';
import { stallFromAssistantEvent } from '../lib/stall-detector.js';

const AT = '2026-09-29T15:00:00.000Z';
const T = Date.parse(AT);

describe('armFromStall', () => {
  it('arms the default carry-on from a usage-limit stall with a reset time', () => {
    expect(armFromStall({ kind: 'usage_limit', resets_at: AT }, null, T - 1000)).toEqual({ at: AT, kind: 'usage_limit', text: AUTO_RESUME_TEXT });
    // A reset already past arms a bounded retry instead of firing at once.
    const r1 = armFromStall({ kind: 'usage_limit', resets_at: AT }, null, T);
    expect(r1).toEqual({ at: new Date(T + RESUME_RETRY_MS).toISOString(), kind: 'usage_limit', text: AUTO_RESUME_TEXT, retry: 1 });
    const r2 = armFromStall({ kind: 'usage_limit', resets_at: AT }, r1, T + RESUME_RETRY_MS + 1);
    expect(r2.retry).toBe(2);
    let last = r2;
    for (let i = 0; i < 5; i++) last = armFromStall({ kind: 'usage_limit', resets_at: AT }, last, T + 1e9);
    expect(last.retry).toBe(RESUME_MAX_RETRIES);
    // The bound holds across fire/stall cycles: a fired slot is gone, but the
    // session's count carries into the next arm.
    expect(armFromStall({ kind: 'usage_limit', resets_at: AT }, null, T, 2).retry).toBe(3);
    expect(armFromStall({ kind: 'usage_limit', resets_at: AT }, null, T, RESUME_MAX_RETRIES)).toBeNull();
    expect(armFromStall({ kind: 'usage_limit' })).toBeNull();
    expect(armFromStall({ kind: 'usage_limit', resets_at: 'soon' })).toBeNull();
    expect(armFromStall({ kind: 'bad_model', model: 'x' })).toBeNull();
  });
  it("keeps a Coordinator's message for the same stall, re-arms on a new reset time", () => {
    const coord = { at: AT, kind: 'usage_limit', text: '[from the Coordinator] finish the PR', source: 'coordinator' };
    expect(armFromStall({ kind: 'usage_limit', resets_at: AT }, coord, T - 1000)).toBe(coord);
    expect(armFromStall({ kind: 'usage_limit', resets_at: '2026-09-29T20:00:00.000Z' }, coord, T)).toEqual({ at: '2026-09-29T20:00:00.000Z', kind: 'usage_limit', text: '[from the Coordinator] finish the PR', source: 'coordinator' });
    expect(armFromStall({ kind: 'usage_limit' }, coord)).toBe(coord);
  });
});

describe('autoResumeDue / dueResumes', () => {
  it('is due after the reset time plus the grace window', () => {
    expect(autoResumeDue({ at: AT }, T)).toBe(false);
    expect(autoResumeDue({ at: AT }, T + RESUME_GRACE_MS)).toBe(true);
    expect(autoResumeDue(null, T + 1e9)).toBe(false);
    expect(autoResumeDue({ at: 'x' }, T + 1e9)).toBe(false);
  });
  it('lists persisted records with a due slot', () => {
    const records = {
      '!a': { journalConvoId: 'ca', _autoResume: { at: AT, kind: 'usage_limit', text: 't' } },
      '!b': { sessionId: 'sb', _autoResume: { at: '2026-09-30T00:00:00.000Z', kind: 'usage_limit', text: 't' } },
      '!c': { journalConvoId: 'cc' },
      '!d': null,
    };
    expect(dueResumes(records, T + RESUME_GRACE_MS)).toEqual([{ roomId: '!a', convoId: 'ca', slot: { at: AT, kind: 'usage_limit', text: 't' } }]);
    expect(dueResumes(records, T)).toEqual([]);
    expect(dueResumes(undefined, T)).toEqual([]);
  });
});

describe('shouldCompactBefore', () => {
  it('compacts at 80% of the window and above', () => {
    expect(shouldCompactBefore(800000, 1000000)).toBe(true);
    expect(shouldCompactBefore(799999, 1000000)).toBe(false);
    expect(shouldCompactBefore(undefined, 1000000)).toBe(false);
    expect(shouldCompactBefore(1, 0)).toBe(false);
  });
});

describe('bad-model detection', () => {
  const ev = (text, extra = {}) => ({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...extra });
  it('recognises the not-available and issue-with-model records, structurally and by wording', () => {
    expect(stallFromAssistantEvent(ev('The model claude-fable-5-1 is not available on your Claude.ai deployment. Try /model opus to switch to Opus, or ask your admin to enable this model.', { isApiErrorMessage: true, error: 'model_not_found', apiErrorStatus: 404 }))).toEqual({ kind: 'bad_model' });
    expect(stallFromAssistantEvent(ev("There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it."))).toEqual({ kind: 'bad_model' });
    expect(stallFromAssistantEvent(ev('Some new wording', { isApiErrorMessage: true, apiErrorStatus: 404 }))).toEqual({ kind: 'bad_model' });
    // a limit record is still a usage_limit, never a bad_model
    expect(stallFromAssistantEvent(ev("You've reached your Fable limit. Switch to another model.", { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 }))).toEqual({ kind: 'usage_limit' });
    expect(stallFromAssistantEvent({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The model X is not available on your deployment, said the docs I am summarising, which is fine.' }] } })).toBeNull();
    expect(stallFromAssistantEvent(ev('API Error: 500 overloaded', { isApiErrorMessage: true, apiErrorStatus: 500 }))).toBeNull();
  });
});
