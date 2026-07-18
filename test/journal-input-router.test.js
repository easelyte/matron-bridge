import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createJournalInputConsumer, resolvePromptChoice, promptExpectsReply } from '../lib/journal-input-router.js';

const silentLog = { warn: () => {}, error: () => {} };

function baseFrame(overrides = {}) {
  return {
    kind: 'journal', seq: 1, convo_id: 'convo-1', ts: Date.now(),
    sender: 'user:dan', type: 'text', payload: { body: 'hi' },
    ...overrides,
  };
}

describe('resolvePromptChoice', () => {
  const options = [
    { id: 'opt_a', label: 'Yes please' },
    { id: 'opt_b', label: 'No thanks' },
    { id: 'prompt-opt-2', label: 'Ask me later' },
  ];

  it('matches by option id', () => {
    expect(resolvePromptChoice(options, 'opt_b')).toEqual({ option: options[1], index: 1 });
  });

  it('matches by label, case-insensitively', () => {
    expect(resolvePromptChoice(options, 'no THANKS')).toEqual({ option: options[1], index: 1 });
  });

  it('matches by 1-based number', () => {
    expect(resolvePromptChoice(options, '1')).toEqual({ option: options[0], index: 0 });
    expect(resolvePromptChoice(options, 3)).toEqual({ option: options[2], index: 2 });
  });

  it('returns null for an out-of-range number', () => {
    expect(resolvePromptChoice(options, '0')).toBeNull();
    expect(resolvePromptChoice(options, '99')).toBeNull();
  });

  it('returns null for an unmatched id/label', () => {
    expect(resolvePromptChoice(options, 'nonsense')).toBeNull();
  });

  it('returns null for null/undefined/empty choice', () => {
    expect(resolvePromptChoice(options, null)).toBeNull();
    expect(resolvePromptChoice(options, undefined)).toBeNull();
    expect(resolvePromptChoice(options, '  ')).toBeNull();
  });

  it('never throws on a non-array options list', () => {
    expect(resolvePromptChoice(null, 'opt_a')).toBeNull();
    expect(resolvePromptChoice(undefined, '1')).toBeNull();
  });

  it('a numeric string prefers the numbered-position match over an id match, per option order', () => {
    // id '1' would collide with the 1-based-number reading of choice '1' —
    // number wins (documents the precedence, not just asserts it).
    const numericIdOptions = [{ id: '5', label: 'Five' }, { id: '1', label: 'One' }];
    expect(resolvePromptChoice(numericIdOptions, '1')).toEqual({ option: numericIdOptions[0], index: 0 });
  });
});

describe('createJournalInputConsumer', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: vi.fn((id) => id === 'control-1'),
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  it('ignores frames whose sender is not user:* (agent echoes — the loop-prevention filter)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ sender: 'agent:dev-2' }));
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('ignores journal event types other than text/prompt_reply', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    for (const type of ['prompt', 'tool_output', 'session_status', 'read_marker', 'convo_meta', 'file', 'image', 'diff']) {
      consumer(baseFrame({ type }));
    }
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('routes a text event for a known session to routeTextToSession with the trimmed body and username', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ payload: { body: '  hello there  ' } }));
    expect(deps.routeTextToSession).toHaveBeenCalledTimes(1);
    const [session, body, ctx] = deps.routeTextToSession.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(body).toBe('hello there');
    expect(ctx).toEqual({ username: 'dan' });
  });

  it('skips a text event with no usable body (missing/non-string), logs, never throws', () => {
    const deps = makeDeps();
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame({ payload: {} }))).not.toThrow();
    expect(() => consumer(baseFrame({ payload: { body: '   ' } }))).not.toThrow();
    expect(() => consumer(baseFrame({ payload: null }))).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('routes a prompt_reply event for a known session to routePromptReply with target_seq/choice/text', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'prompt_reply', payload: { target_seq: 5, choice: 'opt_a', text: null } }));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    const [session, answer, ctx] = deps.routePromptReply.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(answer).toEqual({ target_seq: 5, choice: 'opt_a', text: null });
    expect(ctx).toEqual({ username: 'dan' });
  });

  it('a prompt_reply with a missing payload still dispatches with null-ish fields rather than throwing', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame({ type: 'prompt_reply', payload: undefined }))).not.toThrow();
    expect(deps.routePromptReply).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' },
      { target_seq: undefined, choice: null, text: null },
      { username: 'dan' },
    );
  });

  it('unknown/dead session (convo_id has no live session): logs, notices, never throws, never routes', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null) });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame())).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'text', username: 'dan' });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('control convo: text is dispatched to handleControlCommand, not to session routing', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', payload: { body: '  new /tmp/foo  ' } }));
    expect(deps.handleControlCommand).toHaveBeenCalledWith('new /tmp/foo', { username: 'dan' });
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('control convo: prompt_reply is ignored (control convo only understands commands)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', type: 'prompt_reply', payload: { target_seq: 1, choice: 'a' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('control convo: an empty/whitespace-only command body is dropped silently', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', payload: { body: '   ' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
  });

  it('a non-control convo never has its text treated as a command, even if it looks like one', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'convo-1', payload: { body: 'new /tmp/foo' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' }, 'new /tmp/foo', { username: 'dan' },
    );
  });

  it('never throws even when every injected function throws', () => {
    const deps = makeDeps({
      findSessionByConvoId: vi.fn(() => { throw new Error('boom-lookup'); }),
    });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame())).not.toThrow();
    expect(warnings.some(w => /boom-lookup/.test(w))).toBe(true);
  });

  it('malformed frame (null, non-object, missing fields) is ignored, never throws', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(null)).not.toThrow();
    expect(() => consumer(undefined)).not.toThrow();
    expect(() => consumer({})).not.toThrow();
    expect(() => consumer('not-an-object')).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });
});

// Staleness guard: prompt_reply.target_seq must reference the LATEST prompt
// the bridge published into that convo, or the reply is refused — a delayed
// reply must never mis-answer a newer prompt that superseded the one the
// user was looking at. Prompt seqs are recorded from the bridge's own
// published `prompt` frames echoing back on the socket (sender agent:*),
// BEFORE the user:* input filter.
describe('createJournalInputConsumer — prompt_reply staleness (target_seq)', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  const promptFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: { question: 'Continue?', options: [{ id: 'opt-0', label: 'Yes' }] },
  });

  const replyFrame = (targetSeq, convoId = 'convo-1') => baseFrame({
    seq: 100, convo_id: convoId, type: 'prompt_reply',
    payload: { target_seq: targetSeq, choice: 'Yes', text: null },
  });

  it('a reply whose target_seq matches the latest recorded prompt seq is routed', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a stale target_seq (an older prompt was superseded) is refused with a notice, never routed', () => {
    const deps = makeDeps();
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(promptFrame(15)); // newer prompt supersedes seq 10
    consumer(replyFrame(10));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
      username: 'dan', targetSeq: 10, latestSeq: 15,
    });
    expect(warnings.some(w => /stale/i.test(w))).toBe(true);
  });

  it('no recorded prompt seq for the convo (e.g. bridge restarted live-only): reply is accepted as before', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a reply with no target_seq set is accepted (nothing to check against)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(baseFrame({ type: 'prompt_reply', payload: { target_seq: null, choice: 'Yes', text: null } }));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('prompt seqs are tracked per convo — a newer prompt in convo B does not staleness-refuse convo A', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })) });
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10, 'convo-a'));
    consumer(promptFrame(50, 'convo-b'));
    consumer(replyFrame(10, 'convo-a'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('recording happens before the user:* filter — an agent-sender prompt frame is still recorded', () => {
    // (This is the normal case: the bridge's own published prompts come back
    // as agent:<device>. The previous tests already exercise it implicitly;
    // this one pins it explicitly against a future "filter first" refactor.)
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ seq: 7, sender: 'agent:some-other-box', type: 'prompt', payload: { question: 'q' } }));
    consumer(replyFrame(3)); // stale vs the recorded 7
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalled();
  });

  it('works without a noticeStalePromptReply callback (optional dep): still refuses, still logs, never throws', () => {
    const deps = makeDeps({ noticeStalePromptReply: undefined });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    expect(() => consumer(replyFrame(5))).not.toThrow();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(warnings.some(w => /stale/i.test(w))).toBe(true);
  });
});

// Issue #98: the staleness guard used to record EVERY published prompt event
// — including the /model, /effort and /mode pickers and the queued-while-busy
// "📨 Queued" notification, none of which create pending-answer state the
// reply guard could meaningfully compare against. A picker mirrored between
// a real prompt and the user's reply made the guard falsely refuse the reply
// as "superseded". Only answerable prompts may advance the guard; a reply to
// a genuinely replaced answerable prompt must still be refused.
describe('createJournalInputConsumer — non-answerable prompts must not supersede replies (issue #98)', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  // AskUserQuestion set, exactly as sendAllQuestions journals it (option ids
  // opt_a, opt_b, …) — creates waitingForAnswer state: answerable.
  const questionFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Which approach?', mode: 'pick_one',
      options: [{ id: 'opt_a', label: 'Approach A', value: 'Approach A' }, { id: 'opt_b', label: 'Approach B', value: 'Approach B' }],
    },
  });

  // iv-mode TUI prompt, exactly as promptButtons() journals it — creates
  // pendingInteractivePrompt state: answerable.
  const ivPromptFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Proceed?', mode: 'pick_one',
      options: [{ id: 'prompt-opt-0', label: 'Yes', value: 'prompt-opt:0' }, { id: 'prompt-opt-1', label: 'No', value: 'prompt-opt:1' }],
    },
  });

  // No-arg /model picker (modelButtons() shape) — answered via Matrix button
  // values (model:<alias>), never via prompt_reply: NOT answerable.
  const modelPickerFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Current model: sonnet', mode: 'pick_one',
      options: [{ id: 'model-sonnet', label: 'Sonnet', value: 'model:sonnet' }, { id: 'model-opus', label: 'Opus', value: 'model:opus' }],
    },
  });

  const effortPickerFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Effort level', mode: 'pick_one',
      options: [{ id: 'effort-low', label: 'Low', value: 'effort:low' }, { id: 'effort-high', label: 'High', value: 'effort:high' }],
    },
  });

  const modeToggleFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Mode: interactive', mode: 'pick_one',
      options: [{ id: 'mode-print', label: 'Switch to non-interactive', value: 'mode:print' }],
    },
  });

  // Queued-while-busy notification (index.js's queue-action buttons) — NOT
  // answerable.
  const queueNotifFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: '📨 Queued (1): hello', mode: 'pick_one',
      options: [{ id: 'cancel', label: '✕ Cancel', value: 'cancel:0' }, { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' }],
    },
  });

  const replyFrame = (targetSeq, convoId = 'convo-1') => baseFrame({
    seq: 100, convo_id: convoId, type: 'prompt_reply',
    payload: { target_seq: targetSeq, choice: 'opt_a', text: null },
  });

  it('a model picker mirrored between a question and its reply does not supersede the question', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(questionFrame(10));
    consumer(modelPickerFrame(12)); // interleaved picker — unrelated to the pending question
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('effort and mode pickers do not supersede a pending iv TUI prompt', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(ivPromptFrame(20));
    consumer(effortPickerFrame(21));
    consumer(modeToggleFrame(22));
    consumer(replyFrame(20));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a queued-message notification does not supersede a pending question', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(questionFrame(10));
    consumer(queueNotifFrame(11)); // user queued a message while busy — still answering seq 10
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a genuinely superseded answerable prompt is still refused (question replaced by a newer question)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(questionFrame(10));
    consumer(questionFrame(15)); // a NEW question set replaced the one at 10
    consumer(replyFrame(10));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
      username: 'dan', targetSeq: 10, latestSeq: 15,
    });
  });

  it('an answerable prompt of a different shape still supersedes (iv prompt after a question)', () => {
    // Both shapes create pending-answer state, and journalRoutePromptReply
    // resolves iv prompts FIRST — accepting the old reply here would
    // mis-answer the newer TUI prompt, so refusal is the fail-safe outcome.
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(questionFrame(10));
    consumer(ivPromptFrame(15));
    consumer(replyFrame(10));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalled();
  });

  it('pickers alone never record a guard seq — a reply then fails open exactly like an unrecorded convo', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(modelPickerFrame(12));
    consumer(queueNotifFrame(13));
    consumer(replyFrame(5)); // nothing answerable was ever recorded
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('exposes evictConvo(convoId): teardown clears the guard for that convo only', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    expect(typeof consumer.evictConvo).toBe('function');
    consumer(questionFrame(10, 'convo-a'));
    consumer(questionFrame(20, 'convo-b'));
    consumer.evictConvo('convo-a');
    // convo-a: record evicted — a late reply fails open (accepted), the same
    // contract as a bridge restart.
    consumer(replyFrame(3, 'convo-a'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    // convo-b: untouched — its guard still refuses a stale reply.
    consumer(replyFrame(3, 'convo-b'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-b', {
      username: 'dan', targetSeq: 3, latestSeq: 20,
    });
  });

  it('evictConvo tolerates unknown convo ids and non-string input', () => {
    const consumer = createJournalInputConsumer(makeDeps());
    expect(() => consumer.evictConvo('never-seen')).not.toThrow();
    expect(() => consumer.evictConvo(null)).not.toThrow();
    expect(() => consumer.evictConvo(undefined)).not.toThrow();
  });
});

// Auto-resume seam: the idle reaper silently kills sessions assuming "the
// next user message auto-resumes" — true for Matrix room messages, but the
// journal path used to dead-end with "no longer active". A text or media
// (file/image) event for an unknown convo now gives the caller a chance to
// respawn the session (from persisted state) before declaring it dead.
// prompt_reply is NOT resumed: the pending prompt died with the process, so
// an answer has nothing valid to land on.
describe('createJournalInputConsumer — auto-resume of reaped sessions (resumeSessionForConvo)', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => null),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      resumeSessionForConvo: vi.fn(() => ({ claudeSessionId: 'convo-1', resumed: true })),
      log: silentLog,
      ...overrides,
    };
  }

  it('a text event for an unknown convo resumes the session and routes the text to it, with no unknown-convo notice', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ payload: { body: '  hello again  ' } }));
    expect(deps.resumeSessionForConvo).toHaveBeenCalledWith('convo-1', { username: 'dan' });
    expect(deps.routeTextToSession).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1', resumed: true }, 'hello again', { username: 'dan' },
    );
    expect(deps.noticeUnknownConvo).not.toHaveBeenCalled();
  });

  it('resume returning null falls back to the unknown-convo notice, never routes', () => {
    const deps = makeDeps({ resumeSessionForConvo: vi.fn(() => null) });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame());
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'text', username: 'dan' });
  });

  it('resume throwing is tolerated: logs, falls back to the unknown-convo notice, never crashes', () => {
    const deps = makeDeps({ resumeSessionForConvo: vi.fn(() => { throw new Error('boom-resume'); }) });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame())).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'text', username: 'dan' });
    expect(warnings.some(w => /boom-resume/.test(w))).toBe(true);
  });

  it('a prompt_reply for an unknown convo is never resumed — notice as before', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'prompt_reply', payload: { target_seq: 5, choice: 'opt_a', text: null } }));
    expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'prompt_reply', username: 'dan' });
  });

  it('a text event with no usable body never triggers a resume (no session spawned for a blank message)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ payload: { body: '   ' } }));
    consumer(baseFrame({ payload: {} }));
    expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('a known live session never triggers a resume', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })) });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame());
    expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).toHaveBeenCalledTimes(1);
  });

  it('without a resumeSessionForConvo dep, unknown-convo behavior is unchanged (notice, no route)', () => {
    const deps = makeDeps({ resumeSessionForConvo: undefined });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame());
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'text', username: 'dan' });
  });
});

// The wiring half of the auto-resume seam: index.js can't be imported
// in-process, so pin by source inspection that (a) the journal input
// consumer is actually handed a resumeSessionForConvo (the lib treats it as
// optional, so omitting it silently reverts to the "no longer active" dead
// end), and (b) the journal resume path (journalResumeConvo) routes through
// resumePersistedSession — the single shared respawn helper — instead of
// reimplementing resume inline, and suppresses the helper's own room-facing
// notice so a resume triggered from the journal produces exactly one
// journal message. (Matrix had its own room.message auto-resume branch
// through this same helper; it was removed in Task 4, leaving the journal
// path as the sole caller.)
describe('index.js journal input consumer — auto-resume wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('passes resumeSessionForConvo to createJournalInputConsumer', () => {
    const start = src.indexOf('createJournalInputConsumer({');
    expect(start).toBeGreaterThan(-1);
    // The deps object's last property is `log:` — a plain `});` search would
    // stop inside the handleControlCommand callback body.
    const end = src.indexOf('log: console,', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/\bresumeSessionForConvo\b/);
  });

  it('the journal resume path routes through the single shared respawn helper', () => {
    // Originally pinned "1 function declaration + at least 2 call sites
    // (Matrix handler, journal resume)" — the Matrix auto-resume branch was
    // removed in Task 4, so only the journal call site remains. The
    // surviving invariant: resume isn't reimplemented inline in the journal
    // path — journalResumeConvo still calls the one shared helper (1
    // declaration + at least 1 call site).
    const uses = src.match(/\bresumePersistedSession\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it('a journal-triggered resume produces ONE journal message, not two', () => {
    // journalResumeConvo posts its own "Session was idle" journal notice, so
    // it must tell the shared helper NOT to also mirror the room-facing
    // "Auto-resuming session…" notice into the journal — Matron users were
    // getting both.
    const start = src.indexOf('function journalResumeConvo(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toMatch(/resumePersistedSession\(roomId, prev, \{ skipJournalMirror: true \}\)/);

    // …and the helper threads that flag into the sendToRoom carrying the
    // notice (the session's own sendCallback/sendHtml stay mirrored). Bound
    // the slice at the next surviving section header (Local HTTP API, which
    // now immediately follows resumePersistedSession — the old anchor,
    // `// --- Matrix Message Handler ---`, was deleted in Task 4) so the
    // body stays scoped to resumePersistedSession itself; assert hEnd was
    // actually found so a future rename can't silently widen this slice to
    // near-EOF and pass by accident again.
    const hStart = src.indexOf('function resumePersistedSession(');
    const hEnd = src.indexOf('\n// --- Local HTTP API ---', hStart);
    expect(hEnd).toBeGreaterThan(hStart);
    const hBody = src.slice(hStart, hEnd);
    expect(hBody).toMatch(/skipJournalMirror = false/);
    expect(hBody).toMatch(/sendToRoom\(roomId, arNotice\.plain, arNotice\.html, \{ skipJournalMirror \}\)/);
  });

  it('resumes the active provider with its provider-specific native session ID', () => {
    const start = src.indexOf('function resumePersistedSession(');
    const end = src.indexOf('\n// --- Matrix Message Handler ---', start);
    const body = src.slice(start, end);

    expect(body).toContain('const resumeSessionId = activeState.sessionId;');
    expect(body).toMatch(/createSession\(roomId, prev\.workdir \|\| DEFAULT_WORKDIR, resumeSessionId,/);
    expect(body).toContain('if (resumeSessionId) enterResumeHold(newSession);');
    expect(body).not.toMatch(/createSession\([^\n]+prev\.sessionId/);
  });
});

// The payload classifier behind the issue #98 fix. Option IDs are
// bridge-controlled constants (never user/model text), which is what makes
// shape-matching on them safe.
describe('promptExpectsReply', () => {
  it('is true for AskUserQuestion option sets (opt_a, opt_b, …)', () => {
    expect(promptExpectsReply({ options: [{ id: 'opt_a', label: 'A' }, { id: 'opt_b', label: 'B' }] })).toBe(true);
  });

  it('is true for iv TUI prompt option sets (prompt-opt-<n>)', () => {
    expect(promptExpectsReply({ options: [{ id: 'prompt-opt-0', label: 'Yes' }, { id: 'prompt-opt-1', label: 'No' }] })).toBe(true);
  });

  it('is false for model/effort/mode pickers', () => {
    expect(promptExpectsReply({ options: [{ id: 'model-sonnet', label: 'Sonnet' }] })).toBe(false);
    expect(promptExpectsReply({ options: [{ id: 'effort-high', label: 'High' }] })).toBe(false);
    expect(promptExpectsReply({ options: [{ id: 'mode-print', label: 'Print' }] })).toBe(false);
  });

  it('is false for queue-notification action buttons (cancel/interrupt)', () => {
    expect(promptExpectsReply({ options: [{ id: 'cancel', label: '✕ Cancel' }, { id: 'interrupt', label: '⚡ Send now' }] })).toBe(false);
  });

  it('defaults to true (guard stays active) for unrecognized or missing option shapes', () => {
    // Fails safe: an unknown future prompt kind is guarded (worst case a
    // refusal notice), never silently unguarded.
    expect(promptExpectsReply({ options: [{ id: 'something-new', label: 'X' }] })).toBe(true);
    expect(promptExpectsReply({ options: [] })).toBe(true);
    expect(promptExpectsReply({})).toBe(true);
    expect(promptExpectsReply(null)).toBe(true);
    expect(promptExpectsReply({ options: 'not-an-array' })).toBe(true);
  });

  it('a mixed set with any answerable-looking option stays guarded', () => {
    expect(promptExpectsReply({ options: [{ id: 'model-sonnet' }, { id: 'opt_a' }] })).toBe(true);
  });
});

// Client-sent media (file/image/voice-note) events: a `type:'file'|'image'`
// frame from a user:* sender carries a blob_ref the caller fetches out of the
// journal blob store. The router only CLASSIFIES and resolves the frame into a
// {type, blobRef, contentType, name, size, dims} shape and hands it to the
// injected routeMediaToSession seam (the fetch + transcribe/save + inject
// lives in index.js/lib/journal-media.js, exercised separately). Media routing
// is gated on the seam being present, so a bridge without it keeps the old
// publish-only behavior for file/image frames.
describe('createJournalInputConsumer — media (file/image) routing', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: (id) => id === 'control-1',
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })),
      routeTextToSession: vi.fn(),
      routeMediaToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  const fileFrame = (overrides = {}) => baseFrame({
    type: 'file',
    payload: { blob_ref: 'blob-1', content_type: 'application/pdf', name: 'report.pdf', size: 1234 },
    ...overrides,
  });

  it('extracts and trims payload.caption into the media object (no length clamp — a caption is a prompt)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    const framed = (payload) => fileFrame({ payload: { ...fileFrame().payload, ...payload } });

    consumer(framed({ caption: '  look at this  ' }));
    expect(deps.routeMediaToSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ caption: 'look at this' }),
      expect.anything(),
    );

    // A long caption passes through unbounded (operator decision 2026-07-18):
    // the caption is a prompt that rides with the upload, not a label, so the
    // bridge does not truncate it. It is still trimmed at the edges.
    deps.routeMediaToSession.mockClear();
    consumer(framed({ caption: 'x'.repeat(5000) }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toHaveLength(5000);

    deps.routeMediaToSession.mockClear();
    consumer(framed({}));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBeNull();

    deps.routeMediaToSession.mockClear();
    consumer(framed({ caption: '   ' }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBeNull();
  });

  it('routes a user file event to routeMediaToSession with the resolved media shape', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame());
    expect(deps.routeMediaToSession).toHaveBeenCalledTimes(1);
    const [session, media, ctx] = deps.routeMediaToSession.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(media).toEqual({
      type: 'file', blobRef: 'blob-1', contentType: 'application/pdf',
      name: 'report.pdf', size: 1234, dims: null, caption: null,
    });
    expect(ctx).toEqual({ username: 'dan' });
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('carries the composer caption off the payload', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({
      type: 'image',
      payload: {
        blob_ref: 'img-9', content_type: 'image/png', name: 'shot.png',
        caption: 'why is this rotated?',
      },
    }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBe('why is this rotated?');
  });

  it('treats a blank or non-string caption as absent', () => {
    // A whitespace-only caption is what an "empty" composer can produce; it
    // must not reach claude as a blank line above the upload annotation.
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame({
      payload: { blob_ref: 'b1', content_type: 'application/pdf', name: 'r.pdf', caption: '   ' },
    }));
    consumer(fileFrame({
      payload: { blob_ref: 'b2', content_type: 'application/pdf', name: 'r.pdf', caption: 42 },
    }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBeNull();
    expect(deps.routeMediaToSession.mock.calls[1][1].caption).toBeNull();
  });

  it('routes a user image event and passes through image dims', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({
      type: 'image',
      payload: { blob_ref: 'img-9', content_type: 'image/png', name: 'shot.png', size: 55, dims: { w: 800, h: 600 } },
    }));
    expect(deps.routeMediaToSession).toHaveBeenCalledTimes(1);
    const [, media] = deps.routeMediaToSession.mock.calls[0];
    expect(media).toEqual({
      type: 'image', blobRef: 'img-9', contentType: 'image/png',
      name: 'shot.png', size: 55, dims: { w: 800, h: 600 }, caption: null,
    });
  });

  it('falls back to a top-level frame.blob_ref when the payload has none', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({
      type: 'file', blob_ref: 'top-level-blob',
      payload: { content_type: 'audio/ogg', name: 'voice.ogg' },
    }));
    expect(deps.routeMediaToSession).toHaveBeenCalledTimes(1);
    expect(deps.routeMediaToSession.mock.calls[0][1].blobRef).toBe('top-level-blob');
  });

  it('drops a media event with no blob_ref (nothing to fetch): warns, never routes, never throws', () => {
    const deps = makeDeps();
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame({ type: 'file', payload: { content_type: 'application/pdf', name: 'x.pdf' } }))).not.toThrow();
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
    expect(warnings.some(w => /blob_ref/.test(w))).toBe(true);
  });

  it('ignores agent-sender media events (loop prevention — same as text echoes)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame({ sender: 'agent:dev-2' }));
    consumer(baseFrame({ type: 'image', sender: 'agent:dev-2', payload: { blob_ref: 'b', content_type: 'image/png' } }));
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('media for an unknown convo auto-resumes the session and routes the media into it, with no unknown-convo notice', () => {
    // Same contract as text: a reaped-but-resumable convo must not dead-end
    // with "no longer active" just because the frame is a file/image —
    // delivery after the wake is safe (print mode's stdin buffers; iv mode's
    // resume hold parks input until the TUI is ready).
    const resumed = { claudeSessionId: 'convo-1', resumed: true };
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null), resumeSessionForConvo: vi.fn(() => resumed) });
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame());
    expect(deps.resumeSessionForConvo).toHaveBeenCalledWith('convo-1', { username: 'dan' });
    expect(deps.routeMediaToSession).toHaveBeenCalledTimes(1);
    const [session, media] = deps.routeMediaToSession.mock.calls[0];
    expect(session).toBe(resumed);
    expect(media.blobRef).toBe('blob-1');
    expect(deps.noticeUnknownConvo).not.toHaveBeenCalled();
  });

  it('an image frame for an unknown convo auto-resumes too (both MEDIA_TYPES, top-level blob_ref fallback included)', () => {
    const resumed = { claudeSessionId: 'convo-1', resumed: true };
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null), resumeSessionForConvo: vi.fn(() => resumed) });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'image', blob_ref: 'top-img', payload: { content_type: 'image/png', name: 'shot.png' } }));
    expect(deps.resumeSessionForConvo).toHaveBeenCalledTimes(1);
    expect(deps.routeMediaToSession).toHaveBeenCalledTimes(1);
    expect(deps.routeMediaToSession.mock.calls[0][1].blobRef).toBe('top-img');
  });

  it('a media frame with no blob_ref never triggers a resume (nothing to fetch, no session spawned)', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null), resumeSessionForConvo: vi.fn(() => ({ claudeSessionId: 'x' })) });
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'file', payload: { content_type: 'application/pdf', name: 'x.pdf' } }));
    expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
  });

  it('media resume returning null falls back to the unknown-convo notice, never routes', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null), resumeSessionForConvo: vi.fn(() => null) });
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame());
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'file', username: 'dan' });
  });

  it('media for an unknown convo without a resume seam notices and drops as before', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null) });
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame());
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'file', username: 'dan' });
  });

  it('media in the control convo is ignored (control understands only text commands)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame({ convo_id: 'control-1' }));
    expect(deps.routeMediaToSession).not.toHaveBeenCalled();
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
  });

  it('without a routeMediaToSession seam, file/image frames stay pass-through (never looked up or routed)', () => {
    const deps = makeDeps({ routeMediaToSession: undefined });
    const consumer = createJournalInputConsumer(deps);
    consumer(fileFrame());
    consumer(baseFrame({ type: 'image', payload: { blob_ref: 'b', content_type: 'image/png' } }));
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });
});

// Queue-tile taps from Matron arrive as prompt_reply frames whose `choice`
// carries the tile's option VALUE (`interrupt` / `cancel:<n>`). Their tile
// never advances the staleness guard (non-answerable, issue #98), so the
// guard's target_seq comparison would wrongly refuse them whenever ANY
// answerable prompt has been recorded — the consumer must classify them by
// value shape and route them around the guard.
describe('createJournalInputConsumer — queue-action replies bypass the staleness guard', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  const answerableFrame = (seq) => baseFrame({
    seq, sender: 'agent:dev-2', type: 'prompt',
    payload: {
      question: 'Which approach?', mode: 'pick_one',
      options: [{ id: 'opt_a', label: 'A' }, { id: 'opt_b', label: 'B' }],
    },
  });

  const queueReply = (targetSeq, choice) => baseFrame({
    seq: 100, type: 'prompt_reply',
    payload: { target_seq: targetSeq, choice, text: null },
  });

  it('an interrupt tap routes even when its target_seq mismatches the latest answerable prompt', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));           // guard now expects target_seq 10
    consumer(queueReply(12, 'interrupt'));   // tile at seq 12 — mismatch, but a queue action
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toEqual({
      target_seq: 12, choice: 'interrupt', text: null,
    });
  });

  it('an indexed cancel tap routes the same way', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));
    consumer(queueReply(12, 'cancel:0'));
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledWith(
      expect.anything(),
      { target_seq: 12, choice: 'cancel:0', text: null },
      { username: 'dan' },
    );
  });

  it('a NON-queue choice with a mismatched target_seq is still refused as stale', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));
    consumer(queueReply(12, 'opt_a'));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });
});
