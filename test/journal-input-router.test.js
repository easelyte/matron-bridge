import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createJournalInputConsumer, resolvePromptChoice, promptExpectsReply, isResumePickerTap, isPickerFrame } from '../lib/journal-input-router.js';

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

  it('matches by option value (Matron card taps send the button VALUE as choice)', () => {
    // iv TUI prompt buttons (lib/prompt-buttons.js) carry value `prompt-opt:<i>`
    // alongside id `prompt-opt-<i>` — a tap must resolve, not fall through to
    // "Nothing to answer right now".
    const ivOptions = [
      { id: 'prompt-opt-0', label: 'Claude account with subscription', value: 'prompt-opt:0' },
      { id: 'prompt-opt-1', label: 'Anthropic Console account', value: 'prompt-opt:1' },
    ];
    expect(resolvePromptChoice(ivOptions, 'prompt-opt:1')).toEqual({ option: ivOptions[1], index: 1 });
  });

  it('prefers an id match over a value match when both could apply', () => {
    const collide = [
      { id: 'a', label: 'First', value: 'b' },
      { id: 'b', label: 'Second', value: 'c' },
    ];
    expect(resolvePromptChoice(collide, 'b')).toEqual({ option: collide[1], index: 1 });
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

  it('evictConvo cancels live queue cards before clearing the queue and registry', () => {
    const order = [];
    const emitRelease = vi.fn((convoId, release) => {
      order.push(`release:${release.releasedIds[0]}`);
      expect(convoId).toBe('convo-1');
      return true; // durable emit — the fail-closed gate only clears on success
    });
    const consumer = createJournalInputConsumer(makeDeps({ emitRelease }));
    consumer.queueRelease.noteQueued('convo-1', {
      promptId: 'pr_1',
      itemId: 'pr_1::0',
    });
    consumer.queueRelease.noteQueued('convo-1', {
      promptId: 'pr_2',
      itemId: 'pr_2::0',
    });

    consumer.evictConvo('convo-1', {
      clearQueue: () => order.push('clear'),
    });

    expect(order).toEqual(['release:pr_1::0', 'release:pr_2::0', 'clear']);
    expect(emitRelease).toHaveBeenNthCalledWith(1, 'convo-1', {
      promptId: 'pr_1',
      action: 'cancel',
      releasedIds: ['pr_1::0'],
    });
    expect(emitRelease).toHaveBeenNthCalledWith(2, 'convo-1', {
      promptId: 'pr_2',
      action: 'cancel',
      releasedIds: ['pr_2::0'],
    });
    expect(consumer.queueRelease.listLive('convo-1')).toEqual([]);

    consumer.evictConvo('convo-1', {
      clearQueue: () => order.push('clear-again'),
    });
    expect(emitRelease).toHaveBeenCalledTimes(2);
    expect(order.at(-1)).toBe('clear-again');
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

  // Restart carry-on (Task 3 review, Finding 1): the isResumePickerTap unit
  // tests above only cover the pure predicate — they say nothing about
  // whether the GATE actually wires it in. These drive the gate through the
  // real onJournalEvent entry point (registering a picker frame, then
  // replying to it), the same way the picker-dispatch tests below do, so a
  // stubbed gate that trusts value shape alone (`choice.startsWith('resume:')`)
  // or that drops convo/frame scoping would fail them.
  describe('restart carry-on: verified resume taps', () => {
    const resumeCard = (seq, value, convoId = 'convo-1') => baseFrame({
      seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
      payload: { question: 'Carry on?', options: [{ id: 'resume-x', value }] },
    });

    const resumeReply = (targetSeq, choice, convoId = 'convo-1') => baseFrame({
      seq: 200, convo_id: convoId, type: 'prompt_reply',
      payload: { target_seq: targetSeq, choice, text: null },
    });

    it('a resume: choice whose target_seq names the frame that offered it DOES resume', () => {
      const deps = makeDeps();
      const consumer = createJournalInputConsumer(deps);
      consumer(resumeCard(12, 'resume:convo-1'));       // bridge-published carry-on card
      consumer(resumeReply(12, 'resume:convo-1'));       // matching verified tap
      expect(deps.resumeSessionForConvo).toHaveBeenCalledWith('convo-1', { username: 'dan' });
      expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
      expect(deps.routePromptReply.mock.calls[0][1]).toEqual({
        target_seq: 12, choice: 'resume:convo-1', text: null, picker: true,
      });
    });

    it('a resume: choice with NO registered frame does NOT resume — unknown-convo notice instead', () => {
      const deps = makeDeps();
      const consumer = createJournalInputConsumer(deps);
      consumer(resumeReply(12, 'resume:convo-1')); // no card was ever published at seq 12
      expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
      expect(deps.routePromptReply).not.toHaveBeenCalled();
      expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'prompt_reply', username: 'dan' });
    });

    it('a resume: choice whose target_seq names a frame that offered a DIFFERENT value does NOT resume', () => {
      const deps = makeDeps();
      const consumer = createJournalInputConsumer(deps);
      consumer(resumeCard(12, 'resume:other-convo'));
      consumer(resumeReply(12, 'resume:convo-1')); // not the value that frame offered
      expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
      expect(deps.routePromptReply).not.toHaveBeenCalled();
      expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'prompt_reply', username: 'dan' });
    });

    it('a resume: choice does not resume via a picker frame recorded for a DIFFERENT convo (convo scoping)', () => {
      const deps = makeDeps();
      const consumer = createJournalInputConsumer(deps);
      consumer(resumeCard(12, 'resume:convo-a', 'convo-a'));
      consumer(resumeReply(12, 'resume:convo-a', 'convo-b')); // same seq/value, different convo
      expect(deps.resumeSessionForConvo).not.toHaveBeenCalled();
      expect(deps.routePromptReply).not.toHaveBeenCalled();
      expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-b', { type: 'prompt_reply', username: 'dan' });
    });
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

  it('is false for model/effort/mode pickers and timer confirmation cards', () => {
    expect(promptExpectsReply({ options: [{ id: 'model-sonnet', label: 'Sonnet' }] })).toBe(false);
    expect(promptExpectsReply({ options: [{ id: 'effort-high', label: 'High' }] })).toBe(false);
    expect(promptExpectsReply({ options: [{ id: 'mode-print', label: 'Print' }] })).toBe(false);
    // Load-bearing for /timer: the set card must not advance the staleness
    // guard, or setting a timer would make the NEXT genuine reply "stale".
    expect(promptExpectsReply({ options: [{ id: 'timer-cancel-5', label: '🚫 Cancel timer' }] })).toBe(false);
  });

  it('is false for queue-notification action buttons (cancel/interrupt)', () => {
    expect(promptExpectsReply({ options: [{ id: 'cancel', label: '✕ Cancel' }, { id: 'interrupt', label: '⚡ Send now' }] })).toBe(false);
  });

  it('is false for a structured queued_release card (kind check, no options array)', () => {
    // Load-bearing: the queued_release card payload has NO `options` array, so
    // without the explicit kind short-circuit promptExpectsReply would default
    // to TRUE, advance the staleness guard on the card's own seq, and then
    // wrongly refuse the NEXT genuine prompt reply as stale. The kind check
    // keeps the card non-answerable regardless of its (absent) options.
    expect(promptExpectsReply({ kind: 'queued_release', prompt_id: 'pr_1', items: [{ id: 'pr_1::0', text: 'hi' }] })).toBe(false);
    // Even if a future card grows an answerable-looking options array, the kind
    // wins.
    expect(promptExpectsReply({ kind: 'queued_release', options: [{ id: 'opt_a', label: 'A' }] })).toBe(false);
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

  it('retains live queued-card seqs while bounding only resolved tombstones', () => {
    const consumer = createJournalInputConsumer(makeDeps());
    const registry = consumer.queueRelease;

    registry.noteQueued('convo-1', { promptId: 'live', itemId: 'live::0' });
    registry.annotateSeq('convo-1', 1, 'live');

    for (let seq = 2; seq <= 514; seq++) {
      const promptId = `resolved-${seq}`;
      const itemId = `${promptId}::0`;
      registry.noteQueued('convo-1', { promptId, itemId });
      registry.annotateSeq('convo-1', seq, promptId);
      registry.dropItem('convo-1', itemId);
    }

    expect(registry.classifyBySeq('convo-1', 1)).toMatchObject({
      state: 'live',
      entry: { prompt_id: 'live', itemIds: ['live::0'], seq: 1 },
    });
    expect(registry.classifyBySeq('convo-1', 2)).toEqual({ state: 'unknown' });
    expect(registry.classifyBySeq('convo-1', 3)).toEqual({ state: 'tombstoned' });
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

// Issue #165: value-shape classification of queue taps is RETIRED. A queue
// tap is now proven ONLY by target_seq membership in the queued-release
// registry (see the queued-release describe below). A prompt_reply whose
// `choice` merely LOOKS like a legacy queue action (`interrupt`, `cancel:2`)
// but whose target_seq is not a queued-release card is an ORDINARY answer and
// must be handled exactly like any other answer — delivered when it targets
// the current prompt, refused as stale when it targets a superseded one. This
// block is the #165 label-hijack regression for the router path.
describe('createJournalInputConsumer — queue-action-shaped labels are ordinary answers (#165)', () => {
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

  it('#165: a genuine answer labeled "interrupt" targeting the CURRENT prompt is delivered, not hijacked', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));            // latest answerable prompt: seq 10
    consumer(queueReply(10, 'interrupt'));    // genuine answer to THAT prompt
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toEqual({
      target_seq: 10, choice: 'interrupt', text: null,
    });
  });

  it('#165: a genuine answer labeled "cancel:2" targeting the CURRENT prompt is delivered', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));
    consumer(queueReply(10, 'cancel:2'));
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledWith(
      expect.anything(),
      { target_seq: 10, choice: 'cancel:2', text: null },
      { username: 'dan' },
    );
  });

  it('a queue-action-shaped label with a mismatched target_seq is refused as stale, like any answer', () => {
    // No value-shape route-around: `interrupt` with a superseded target_seq is
    // now treated exactly like `opt_a` below — refused as stale (a notice, not
    // a silent no-op), never routed around the guard.
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));
    consumer(queueReply(12, 'interrupt'));   // target_seq 12 != latest 10, not a queue card
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
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

// Picker taps (/model, /effort, /mode) arrive as prompt_reply frames whose
// `choice` carries the button VALUE (`model:<alias>` / `effort:<level>` /
// `mode:<target>`). Like queue-tile taps, their picker frame never advances
// the staleness guard (non-answerable, issue #98), so the guard's target_seq
// comparison would wrongly refuse the tap whenever ANY answerable prompt has
// been recorded for the convo. The consumer classifies them by frame
// provenance — target_seq must name a recorded picker frame and the choice
// must be among the values that frame offered — and routes them around the
// guard (the same seq-provenance principle the queued-release path uses).
describe('createJournalInputConsumer — picker replies bypass the staleness guard', () => {
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

  // A published picker frame (option ids model-* / effort-* / mode-*).
  const pickerFrame = (seq, opts, sender = 'agent:dev-2') => baseFrame({
    seq, sender, type: 'prompt',
    payload: { question: 'pick', mode: 'pick_one', options: opts },
  });

  const pickerReply = (targetSeq, choice) => baseFrame({
    seq: 100, type: 'prompt_reply',
    payload: { target_seq: targetSeq, choice, text: null },
  });

  it.each([
    ['model:sonnet', [{ id: 'model-sonnet', value: 'model:sonnet' }]],
    ['effort:high', [{ id: 'effort-high', value: 'effort:high' }]],
    ['mode:print', [{ id: 'mode-print', value: 'mode:print' }]],
    // The /timer set-confirmation card's Cancel button rides the same path.
    ['timer:cancel:5', [{ id: 'timer-cancel-5', value: 'timer:cancel:5' }]],
  ])(
    'a %s tap whose target_seq identifies its picker frame routes (flagged picker) even past a later answerable prompt',
    (choice, opts) => {
      const deps = makeDeps();
      const consumer = createJournalInputConsumer(deps);
      consumer(pickerFrame(12, opts));       // bridge published this picker at seq 12
      consumer(answerableFrame(10));          // a later answerable prompt sets the guard
      consumer(pickerReply(12, choice));      // reply targets the picker frame → dispatched
      expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
      expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
      // Explicit provenance flag — the receiver dispatches on this, not value shape.
      expect(deps.routePromptReply.mock.calls[0][1]).toEqual({
        target_seq: 12, choice, text: null, picker: true,
      });
    },
  );

  // PR review round 3 Major 2: a picker frame must not authorize a value it
  // never offered. A reply targeting a mode-picker frame but carrying a model
  // value (globally a valid picker value) is NOT dispatched.
  it('a picker frame does not authorize a value from a different picker (cross-namespace)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'mode-print', value: 'mode:print' }])); // a MODE picker
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'model:opus')); // a MODEL value the mode frame never offered
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  // PR review round 2 Blocker 1: a genuine answer whose label equals a valid
  // picker value must NOT be dispatched as a command. It targets an
  // answerable-prompt seq (not a picker frame), so it stays subject to the
  // staleness guard — a superseded one is refused, not turned into a switch.
  it('a picker-VALUED reply targeting an answerable prompt (not a picker frame) is NOT dispatched as a command', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));           // an AskUserQuestion whose option is labeled model:sonnet
    consumer(answerableFrame(15));           // superseded by a newer answerable prompt
    consumer(pickerReply(10, 'model:sonnet')); // delayed answer to the superseded prompt
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1); // refused as stale, not switched
  });

  it('a picker value whose target_seq matches no published picker frame is not bypassed', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'model:sonnet')); // seq 12 was never a picker frame
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  it('a NON-picker choice targeting a picker frame is still refused (not a picker value)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'model-sonnet', value: 'model:sonnet' }]));
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'opt_a')); // targets the picker frame but isn't a picker value
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  it('a namespaced-but-INVALID value (mode:bogus) targeting a picker frame is not dispatched', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'mode-print', value: 'mode:print' }]));
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'mode:bogus')); // not a real picker value → not bypassed
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  // Task 3 review, Finding 2: option ids/values are just strings on the wire
  // — nothing stops a client device from publishing a `type:'prompt'` frame
  // shaped exactly like a picker (id 'resume-x', value 'resume:x'). Frame
  // registration must be gated on sender, the same provenance stance the
  // sibling queued_release branch already takes, or a non-bridge sender
  // could get its lookalike frame recorded and later verified as if the
  // bridge had published it.
  it('a picker-shaped frame from a non-agent sender does NOT register — a later matching reply is refused as stale, not dispatched', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'model-sonnet', value: 'model:sonnet' }], 'user:dan')); // spoofed sender
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'model:sonnet'));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  it('evictConvo clears the picker-frame record for that convo', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'model-sonnet', value: 'model:sonnet' }]));
    consumer.evictConvo('convo-1');
    consumer(answerableFrame(10));
    consumer(pickerReply(12, 'model:sonnet')); // picker record gone → no longer bypassed
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });

  // PR review round 3 Major 3: the per-convo picker record is bounded — a very
  // old picker beyond the retention window is dropped, so the map can't grow
  // without limit in a long-lived conversation.
  it('drops the oldest picker frames past the retention window (bounded record)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    // Publish more picker frames than the retention window (16); seq 1 is oldest.
    for (let seq = 1; seq <= 20; seq++) {
      consumer(pickerFrame(seq, [{ id: 'model-sonnet', value: 'model:sonnet' }]));
    }
    consumer(answerableFrame(50)); // sets the staleness guard so a non-picker reply is refused
    consumer(pickerReply(1, 'model:sonnet'));  // oldest picker — evicted → not a picker → stale
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
    consumer(pickerReply(20, 'model:sonnet')); // most recent — still dispatchable as a picker
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toMatchObject({ target_seq: 20, picker: true });
  });

  // PR review round 4 Major: a pick_one picker is single-use. A double-tap or
  // client retry (a second prompt_reply for the same frame) must not fire the
  // switch twice (which would restart a print session twice / double-write PTY).
  it('a picker frame is single-use — a duplicate reply is not dispatched as a picker again', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(pickerFrame(12, [{ id: 'model-sonnet', value: 'model:sonnet' }]));
    consumer(answerableFrame(50)); // staleness guard, so the consumed duplicate is refused
    consumer(pickerReply(12, 'model:sonnet')); // first tap → picker dispatch, frame consumed
    consumer(pickerReply(12, 'model:sonnet')); // duplicate → no longer a picker → stale, refused
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toMatchObject({ target_seq: 12, picker: true });
    expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
  });
});

// Coverage gap (b): a full round-trip through onJournalEvent — the bridge's
// own queued_release card echoes back (agent sender) and records its seq, then
// user prompt_reply frames exercise the classify intercept: a valid action
// routes, an unknown action warns + notices, and a post-resolution (tombstoned)
// tap is dropped with a notice. No value-shape classification anywhere.
describe('createJournalInputConsumer — queued_release end-to-end', () => {
  const CONVO = 'convo-1';
  const PROMPT = 'pr_e2e';
  const ITEM = 'pr_e2e::0';
  const CARD_SEQ = 77;

  function makeDeps(overrides = {}) {
    const warnings = [];
    return {
      deps: {
        isControlConvo: () => false,
        handleControlCommand: vi.fn(),
        findSessionByConvoId: vi.fn(() => ({ claudeSessionId: CONVO })),
        routeTextToSession: vi.fn(),
        routePromptReply: vi.fn(),
        noticeUnknownConvo: vi.fn(),
        noticeStalePromptReply: vi.fn(),
        noticeQueuedReleaseIgnored: vi.fn(),
        log: { warn: (m) => warnings.push(m), error: () => {} },
        ...overrides,
      },
      warnings,
    };
  }

  // The bridge-authored card echoing back to the router (agent sender).
  const cardEcho = () => baseFrame({
    seq: CARD_SEQ, sender: 'agent:dev-2', type: 'prompt',
    convo_id: CONVO,
    payload: { kind: 'queued_release', prompt_id: PROMPT, items: [{ id: ITEM, text: 'hi' }] },
  });

  const tap = (choice) => baseFrame({
    seq: 200, sender: 'user:dan', type: 'prompt_reply',
    convo_id: CONVO,
    payload: { target_seq: CARD_SEQ, choice, text: null },
  });

  it('records the card seq, routes a valid tap, notices an invalid one, and drops a tombstoned one', () => {
    const { deps, warnings } = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    // Reserve the live identity (index.js does this from notifyQueuedMessage).
    consumer.queueRelease.noteQueued(CONVO, { promptId: PROMPT, itemId: ITEM });
    // The card echoes back → annotateSeq binds CARD_SEQ to the live prompt.
    consumer(cardEcho());

    // Valid action → classify 'live' → routed to the reply seam, NOT the
    // ordinary answer echo path.
    consumer(tap('send'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toEqual({
      target_seq: CARD_SEQ, choice: 'send', text: null,
    });
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();

    // Unknown action on a known card → warn + user notice, no route.
    consumer(tap('frobnicate'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1); // unchanged
    expect(deps.noticeQueuedReleaseIgnored).toHaveBeenCalledWith(CONVO, expect.objectContaining({ reason: 'invalid-action' }));
    expect(warnings.some(w => /invalid queued_release action/.test(w))).toBe(true);

    // Resolve the card (index.js does this via dropItem after the flush/cancel).
    consumer.queueRelease.dropItem(CONVO, ITEM);

    // A late/duplicate tap now classifies 'tombstoned' → dropped with a notice,
    // never falling through to the ordinary answer path.
    deps.noticeQueuedReleaseIgnored.mockClear();
    consumer(tap('send'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1); // still unchanged
    expect(deps.noticeQueuedReleaseIgnored).toHaveBeenCalledWith(CONVO, expect.objectContaining({ reason: 'tombstoned' }));
  });
});

// Ghost-answer window (post-restart): a prompt_reply whose target_seq predates
// this bridge process is answering a prompt whose asking session is gone. Since
// resolvePromptChoice matches options by case-insensitive label and the
// queued-release wire values (send/cancel) are common real-prompt labels,
// routing it to the current prompt could silently answer the WRONG one. Refuse.
describe('createJournalInputConsumer — ghost-answer refusal (processStartSeq)', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      noticeGhostPromptReply: vi.fn(),
      processStartSeq: 100,
      log: silentLog,
      ...overrides,
    };
  }

  const answerable = (seq) => baseFrame({
    seq, sender: 'agent:dev-2', type: 'prompt',
    payload: { question: 'ok?', mode: 'pick_one', options: [{ id: 'send', label: 'Send' }] },
  });
  const reply = (targetSeq, choice) => baseFrame({
    seq: 500, type: 'prompt_reply', payload: { target_seq: targetSeq, choice, text: null },
  });

  it('refuses a reply whose target_seq predates process start, with a notice and no route', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(reply(50, 'send')); // 50 <= processStartSeq 100 → ghost
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeGhostPromptReply).toHaveBeenCalledWith('convo-1', expect.objectContaining({ targetSeq: 50 }));
  });

  it('refuses even at the exact boundary seq (<= is inclusive)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(reply(100, 'cancel'));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeGhostPromptReply).toHaveBeenCalledTimes(1);
  });

  it('delivers a reply whose target_seq is after process start (a real current answer)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(answerable(150));      // current prompt, seq 150 > 100
    consumer(reply(150, 'send'));   // genuine answer to it
    expect(deps.noticeGhostPromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply.mock.calls[0][1]).toMatchObject({ target_seq: 150, choice: 'send' });
  });

  it('disables the check when processStartSeq is null (first boot)', () => {
    const deps = makeDeps({ processStartSeq: null });
    const consumer = createJournalInputConsumer(deps);
    consumer(answerable(5));
    consumer(reply(5, 'send'));
    expect(deps.noticeGhostPromptReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
  });
});

// The agent-chat room carve-out (spec: agent chat phase 3, Task 6). Frames in
// a conversation this bridge participates in as a room are session input even
// when agent-sent — that's the whole point of a room — so they divert to
// routeRoomFrame ABOVE the user:* loop guard. Own echoes are dropped by
// device id when both the frame's sender_device_id and our own id are known,
// by device name otherwise; unknown identity fails CLOSED (drop + warn once).
describe('agent-chat room carve-out', () => {
  const roomRecord = { sessionRoomId: '!s1:bridge', role: 'guest', state: 'joined', title: 'Test room' };

  function makeRoomDeps(overrides = {}) {
    return {
      isControlConvo: vi.fn(() => false),
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'room-1' })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      roomFor: vi.fn((id) => (id === 'room-1' ? { ...roomRecord } : null)),
      routeRoomFrame: vi.fn(),
      selfAgentName: vi.fn(() => 'dev-1'),
      log: silentLog,
      ...overrides,
    };
  }

  function roomFrame(overrides = {}) {
    return baseFrame({ convo_id: 'room-1', sender: 'agent:dev-2', ...overrides });
  }

  it('routes an agent text frame in an active room to routeRoomFrame (never the main input path)', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    const frame = roomFrame();
    consumer(frame);
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(1);
    const [room, routed] = deps.routeRoomFrame.mock.calls[0];
    expect(room).toMatchObject({ sessionRoomId: '!s1:bridge' });
    expect(routed).toBe(frame);
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('routes a USER frame in an active room to routeRoomFrame, not routeTextToSession', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'user:dan' }));
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(1);
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('routes a media (image/file) frame in an active room even without a routeMediaToSession seam', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ type: 'image', payload: { name: 'cat.png', blob_ref: 'b1' } }));
    consumer(roomFrame({ type: 'file', payload: { name: 'notes.txt', blob_ref: 'b2' } }));
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(2);
  });

  it('drops this bridge\'s own echo (sender agent:<self>)', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1' }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('warns exactly once when the peer shares our device name (own-echo drop would kill the room silently)', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({
      roomFor: vi.fn((id) => (id === 'room-1' ? { ...roomRecord, peerName: 'dev-1' } : null)),
      log,
    });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1' }));
    consumer(roomFrame({ sender: 'agent:dev-1', payload: { body: 'again' } }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled(); // still fails safe
    const ambiguousWarns = log.warn.mock.calls.filter(([msg]) => /same device name/.test(msg));
    expect(ambiguousWarns).toHaveLength(1);
  });

  it('a distinct peer name never triggers the ambiguous-name warning on own echoes', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({
      roomFor: vi.fn((id) => (id === 'room-1' ? { ...roomRecord, peerName: 'dev-2' } : null)),
      log,
    });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1' }));
    expect(log.warn.mock.calls.filter(([msg]) => /same device name/.test(msg))).toHaveLength(0);
  });

  it('fails CLOSED on unknown identity: agent frames dropped, warned exactly once', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({ selfAgentName: vi.fn(() => null), log });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame());
    consumer(roomFrame({ payload: { body: 'again' } }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    const identityWarns = log.warn.mock.calls.filter(([msg]) => /identity/.test(msg));
    expect(identityWarns).toHaveLength(1);
  });

  it('a missing selfAgentName seam behaves like unknown identity (drop, fail closed)', () => {
    const deps = makeRoomDeps({ selfAgentName: undefined });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame());
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
  });

  it('drops an agent frame whose sender_device_id matches our own device id even when the sender NAME differs', () => {
    const deps = makeRoomDeps({ selfAgentDeviceId: vi.fn(() => 42) });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:someone-else', sender_device_id: 42 }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it("routes a SAME-NAMED peer's frame when its sender_device_id differs from ours (no ambiguous-name warning)", () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({
      selfAgentDeviceId: vi.fn(() => 42),
      roomFor: vi.fn((id) => (id === 'room-1' ? { ...roomRecord, peerName: 'dev-1' } : null)),
      log,
    });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1', sender_device_id: 7 }));
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls.filter(([msg]) => /same device name/.test(msg))).toHaveLength(0);
  });

  it('a frame WITHOUT sender_device_id falls back to name logic even when our own id is known', () => {
    const deps = makeRoomDeps({ selfAgentDeviceId: vi.fn(() => 42) });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1' })); // own name, no id → dropped
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    consumer(roomFrame({ sender: 'agent:dev-2' })); // peer name, no id → routes
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(1);
  });

  it('device id 0 is a real id: selfAgentDeviceId 0 + frame sender_device_id 0 drops as own echo', () => {
    // Pins Number.isInteger over truthiness: with a truthy check, id 0 would
    // fall back to the name path and this differently-named echo would route.
    const deps = makeRoomDeps({ selfAgentDeviceId: vi.fn(() => 0) });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:someone-else', sender_device_id: 0 }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('a string-typed sender_device_id warns exactly once and falls back to name matching', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({ selfAgentDeviceId: vi.fn(() => 42), log });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'agent:dev-1', sender_device_id: '42' })); // own name → dropped via name path
    consumer(roomFrame({ sender: 'agent:dev-2', sender_device_id: '7' })); // peer name → routes via name path
    expect(deps.routeRoomFrame).toHaveBeenCalledTimes(1);
    const w = log.warn.mock.calls.filter(([msg]) => /non-integer sender_device_id/.test(msg));
    expect(w).toHaveLength(1);
  });

  it('sender_device_id present but own identity UNKNOWN fails closed via the name path (warnOnceNoIdentity)', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({
      selfAgentDeviceId: vi.fn(() => null),
      selfAgentName: vi.fn(() => null),
      log,
    });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender_device_id: 7 }));
    consumer(roomFrame({ sender_device_id: 7, payload: { body: 'again' } }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.filter(([msg]) => /identity/.test(msg))).toHaveLength(1);
  });

  it('drops a prompt_reply in a room convo entirely (prompt flows never route through rooms)', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'user:dan', type: 'prompt_reply', payload: { target_seq: 3, choice: 'opt_a' } }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('drops non-input frame types in a room (session_status et al.) without routing', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    for (const type of ['prompt', 'tool_output', 'session_status', 'read_marker', 'convo_meta', 'diff']) {
      consumer(roomFrame({ type }));
    }
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
  });

  it('drops a room frame whose sender is neither agent:* nor user:*', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame({ sender: 'bridge' }));
    consumer(roomFrame({ sender: 42 }));
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
  });

  it('an INACTIVE room (roomFor null) falls through to the normal guard: agent frame dropped, user frame routes to the session', () => {
    const deps = makeRoomDeps({ roomFor: vi.fn(() => null) });
    const consumer = createJournalInputConsumer(deps);
    consumer(roomFrame()); // agent-sent → loop-prevention filter drops it
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    consumer(roomFrame({ sender: 'user:dan' })); // user-sent → ordinary input
    expect(deps.routeTextToSession).toHaveBeenCalledTimes(1);
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
  });

  it('a routeRoomFrame that throws is contained (warned, consumer never throws)', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = makeRoomDeps({ routeRoomFrame: vi.fn(() => { throw new Error('boom'); }), log });
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(roomFrame())).not.toThrow();
    expect(log.warn.mock.calls.some(([msg]) => /routeRoomFrame threw: boom/.test(msg))).toBe(true);
  });

  it('non-room convos are completely unaffected by the seams being present', () => {
    const deps = makeRoomDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame()); // convo-1 — roomFor returns null for it
    expect(deps.routeTextToSession).toHaveBeenCalledTimes(1);
    expect(deps.routeRoomFrame).not.toHaveBeenCalled();
  });
});

// The wiring half of the room carve-out: index.js can't be imported
// in-process, so pin by source inspection that the consumer actually
// receives the room seams, that room delivery's isBusy covers BOTH busy and
// the resume-hold state (sendToSession's _awaitingInputReady branch returns
// true WITHOUT setting busy — Task 5 review finding 9), and that every
// turn-end/teardown seam speaks to roomDelivery.
describe('index.js agent-chat room wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('passes roomFor/routeRoomFrame/selfAgentName/selfAgentDeviceId to createJournalInputConsumer (before log:)', () => {
    const start = src.indexOf('createJournalInputConsumer({');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('log: console,', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/\broomFor\b/);
    expect(args).toMatch(/routeRoomFrame: journalOnRoomFrame/);
    expect(args).toMatch(/selfAgentName: \(\) => journalPublisher\.identity\(\)\?\.name \|\| null/);
    expect(args).toMatch(/selfAgentDeviceId: \(\) => journalPublisher\.identity\(\)\?\.deviceId \?\? null/);
    expect(args).toMatch(/agentRooms\.isActive\(convoId\)/);
  });

  it("room delivery's isBusy is the full composite: busy, resume-hold, and BOTH open-prompt states", () => {
    const start = src.indexOf('function sessionOccupiedForRoomDelivery(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/session\.busy/);
    expect(body).toMatch(/session\._awaitingInputReady/);
    // Task 6 review C2: the prompt paths deliberately clear busy so the
    // user's answer types into the PTY — a room message must not take the
    // idle branch there and answer the prompt.
    expect(body).toMatch(/session\.waitingForAnswer/);
    expect(body).toMatch(/session\.pendingInteractivePrompt/);
    // …and it is what createRoomDelivery actually receives as isBusy.
    const rd = src.indexOf('createRoomDelivery({');
    expect(rd).toBeGreaterThan(-1);
    const rdEnd = src.indexOf('});', rd);
    expect(src.slice(rd, rdEnd)).toMatch(/isBusy: sessionOccupiedForRoomDelivery/);
    // The injected turn must not re-mirror into the session's own convo.
    expect(src.slice(rd, rdEnd)).toMatch(/skipJournalMirror: true/);
  });

  it('every turn-end seam flushes the pending room inbox through the ONE shared occupied-gated helper', () => {
    // Task 6 review C1/C2/I3/I4: the seams (codex, iv, print, resume-hold
    // release) plus journalOnRoomFrame's self-heal all go through
    // maybeFlushRoomDelivery — never a bare roomDelivery.flush of their own,
    // so the occupied gate can't drift per seam.
    const gated = src.match(/maybeFlushRoomDelivery\(session\)/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(5);
    const bareFlushes = src.match(/roomDelivery\.flush\(session, session\.roomId\)/g) || [];
    expect(bareFlushes).toHaveLength(1); // inside maybeFlushRoomDelivery only
    expect(src).toMatch(/function maybeFlushRoomDelivery\(session\) \{\s*\n\s*if \(sessionOccupiedForRoomDelivery\(session\)\) return;/);
    // …and a queue flush that dispatched a turn suppresses the room flush
    // (the new turn's own end seam picks it up) — one gate per seam family:
    // codex, iv onTurnEnd, print result, and the resume-hold release (which
    // flushes a queue carried across a restart — see restart-deferral tests).
    expect(src.match(/flushPendingSessionQueue\(session\) === true/g) || []).toHaveLength(4);
    // The parked-slash release path must not append a room block onto the
    // just-typed slash command (Task 6 review I3) — but ONLY when the slash
    // was actually typed; the couldn't-run/held-messages branches typed
    // nothing and must still flush (whole-branch review, M4).
    expect(src).toMatch(/if \(!parkedSlashTyped\) maybeFlushRoomDelivery\(session\);/);
    expect(src).toMatch(/parkedSlashTyped = true;\s*\n\s*debug\(`typed parked /);
  });

  // Dan, 2026-08-09: "perhaps it could even show eg when the receiving chat
  // has queued the message but not had it delivered yet". A ⏳ that never
  // resolves is worse than none, so these pin both halves and the one case
  // where "busy" does NOT mean queued.
  describe('the queued-but-not-delivered state', () => {
    // The per-recipient body: journalOnRoomFrame is now a thin fan-out over
    // the room's bindings (a local room binds two sessions); the delivery
    // pipeline these tests pin lives in deliverRoomFrameTo.
    const frame = (() => {
      const start = src.indexOf('function deliverRoomFrameTo(');
      return src.slice(start, src.indexOf('\nfunction ', start + 1));
    })();

    it('reads queued-ness off the inbox, not deliver()\'s boolean', () => {
      // deliver() returns true for BOTH branches — "accepted", not
      // "delivered". Empty-before/non-empty-after is the only honest test of
      // "this message opened a pending batch".
      expect(frame).toMatch(/const queuedBefore = roomDelivery\.pendingCount\(session\.roomId\)/);
      expect(frame).toMatch(/queuedBefore === 0 && roomDelivery\.pendingCount\(session\.roomId\) > 0/);
    });

    it('publishes ⏳ only AFTER the reply-waiter short-circuit', () => {
      // During an agent_chat_send wait the session is busy but the reply is
      // consumed inline as the tool result and never queued at all. A notice
      // published before the short-circuit would claim "queued" in exactly
      // the case the peer agent answered fastest.
      const resolve = frame.indexOf('roomReplyWaiters.resolve(');
      const queued = frame.indexOf('ROOM_MESSAGE_QUEUED_NOTICE');
      expect(resolve).toBeGreaterThan(-1);
      expect(queued).toBeGreaterThan(resolve);
    });

    it('gates ⏳ to peer agents, like the 💬 notice it follows', () => {
      // A `user:` frame is Dan typing into the room convo himself; he gets no
      // 💬 line for it, so a bare ⏳ would have nothing to attach to.
      expect(frame).toMatch(/const isPeerAgent = sender\.startsWith\('agent:'\)/);
      expect(frame).toMatch(/if \(isPeerAgent\) \{/);
      expect(frame).toMatch(/if \(isPeerAgent && queuedBefore === 0/);
    });

    it('drains an older batch BEFORE publishing this message\'s notice', () => {
      // Otherwise the journal reads out of order: the 💬 for a message that
      // arrived second appears above the 📨 closing the batch before it.
      const flush = frame.indexOf('maybeFlushRoomDelivery(session)');
      const notice = frame.indexOf('formatRoomMessageNotice(');
      expect(flush).toBeGreaterThan(-1);
      expect(notice).toBeGreaterThan(flush);
    });

    it('closes the ⏳ at the flush seam, counting BEFORE flush clears the inbox', () => {
      const start = src.indexOf('function maybeFlushRoomDelivery(');
      const body = src.slice(start, src.indexOf('\n}', start));
      const count = body.indexOf('roomDelivery.pendingCount(');
      const flush = body.indexOf('roomDelivery.flush(');
      expect(count).toBeGreaterThan(-1);
      expect(flush).toBeGreaterThan(count);
      // Nothing queued => nothing to close, and no notice at all.
      expect(body).toMatch(/if \(!queued\) return;/);
      // A refused inject must say so rather than leave the ⏳ hanging.
      expect(body).toMatch(/flushed \? formatRoomDeliveredNotice\(queued\) : formatRoomDeliveryFailedNotice\(queued\)/);
    });
  });

  it('terminal teardown drops the pending room inbox with the session', () => {
    const start = src.indexOf('function journalEvictConvoInput(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    expect(src.slice(start, end)).toMatch(/roomDelivery\.dropSession\(session\?\.roomId\)/);
    // …and closes the ⏳ those dropped messages left open (Bugbot, #197): a
    // silent drop is the never-resolving indicator this feature exists to
    // avoid. Counted BEFORE the drop clears the inbox.
    const teardown = src.slice(start, end);
    expect(teardown.indexOf('roomDelivery.pendingCount(')).toBeLessThan(teardown.indexOf('roomDelivery.dropSession('));
    expect(teardown).toMatch(/if \(strandedRoomMessages && convoId\) \{\s*\n\s*journalPublishNotice\(convoId, formatRoomDeliveryFailedNotice\(strandedRoomMessages\)\)/);
    // Eviction must auto-leave every joined room so the peer's bridge doesn't
    // keep publishing into a black hole (whole-branch review, I4).
    expect(src.slice(start, end)).toMatch(/agentInvites\.leave\(\{ roomId: r\.roomId \}\)[\s\S]*agentRooms\.setState\(r\.roomId, 'left'\)/);
  });

  it('an inbound join_request never touches the room record — only the pendingJoinRequests seam (whole-branch review, C1)', () => {
    const start = src.indexOf('function journalInjectInviteRequest(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toMatch(/if \(isJoin\) \{[^}]*pendingJoinRequests\.set/);
    // The record() call must live in the non-join else branch only.
    const isJoinBlock = body.match(/if \(isJoin\) \{[\s\S]*?\n {4}\} else \{/)?.[0] ?? '';
    expect(isJoinBlock).not.toMatch(/agentRooms\.record/);
  });

  it('the publisher receives thunked invite/op-error dispatch into the (later-built) invite manager', () => {
    const start = src.indexOf('createJournalPublisher({');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    const args = src.slice(start, end);
    expect(args).toMatch(/onInviteFrame: \(frame\) => agentInvites\?\.onInviteFrame\(frame\)/);
    // Agent-spawn frames are thunked the same way, into the (later-built)
    // agentSpawnHandlers; onOpError tries the spawn side FIRST (its `true`
    // return means it consumed the ref) before falling through to invites.
    expect(args).toMatch(/onSpawnFrame: \(frame\) => agentSpawnHandlers\?\.onSpawnFrame\(frame\)/);
    expect(args).toMatch(/onOpError: \(e\) => \{ if \(agentSpawnHandlers\?\.onOpError\?\.\(e\)\) return; agentInvites\?\.onOpError\(e\); \}/);
  });
});

describe('isResumePickerTap', () => {
  it('accepts a resume choice the frame actually offered', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 'resume:abc123def456')).toBe(true);
  });

  it('rejects a resume choice the frame did not offer', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 'resume:other9999999')).toBe(false);
  });

  it('rejects non-resume picker values', () => {
    expect(isResumePickerTap(new Set(['model:sonnet']), 'model:sonnet')).toBe(false);
  });

  it('rejects when there is no frame', () => {
    expect(isResumePickerTap(null, 'resume:abc123def456')).toBe(false);
    expect(isResumePickerTap(undefined, 'resume:abc123def456')).toBe(false);
  });

  it('rejects a non-string choice', () => {
    expect(isResumePickerTap(new Set(['resume:abc123def456']), null)).toBe(false);
    expect(isResumePickerTap(new Set(['resume:abc123def456']), 7)).toBe(false);
  });
});

describe('isPickerFrame with resume options', () => {
  it('classifies a resume- option frame as a picker', () => {
    expect(isPickerFrame({ options: [{ id: 'resume-abc123def456', value: 'resume:abc123def456' }] })).toBe(true);
  });
});
