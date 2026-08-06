import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createJournalInputConsumer, resolvePromptChoice, promptExpectsReply } from '../lib/journal-input-router.js';
import {
  buildPermissionKey,
  createPermissionSeams,
  PERMISSION_MAX_PENDING_GLOBAL,
  PERMISSION_MAX_PENDING_PER_CONVO,
} from '../lib/permission-registry.js';

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

  it('evictConvo cancels live queue cards before clearing the queue and registry', () => {
    const order = [];
    const emitRelease = vi.fn((convoId, release) => {
      order.push(`release:${release.releasedIds[0]}`);
      expect(convoId).toBe('convo-1');
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

describe('createJournalInputConsumer — permission registry seam foundation', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      notePermissionSeq: vi.fn(() => true),
      resolvePermissionReply: vi.fn(),
      hasLivePermissionPending: vi.fn(() => false),
      isLivePendingToolUse: vi.fn(() => false),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  it('registers a valid bridge-owned permission_request echo exactly once', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    let assigned = false;
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((candidateKey, convoId) => (
        candidateKey === key && convoId === 'convo-1'
      )),
      notePermissionSeq: vi.fn(() => {
        if (assigned) return false;
        assigned = true;
        return true;
      }),
    });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 42,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));

    expect(deps.isLivePendingToolUse).toHaveBeenCalledWith(key, 'convo-1');
    expect(deps.notePermissionSeq).toHaveBeenCalledTimes(2);
    expect(deps.notePermissionSeq).toHaveBeenCalledWith(key, 41, 'convo-1');
    expect(deps.notePermissionSeq.mock.results.map(({ value }) => value)).toEqual([true, false]);
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('binds two concurrent permission replies independently to their own seq keys', () => {
    const firstKey = buildPermissionKey('convo-1', 'toolu_1');
    const secondKey = buildPermissionKey('convo-1', 'toolu_2');
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const pendingPermissionDecisions = new Map([
      [firstKey, { resolve: firstResolve, seq: null, convoId: 'convo-1' }],
      [secondKey, { resolve: secondResolve, seq: null, convoId: 'convo-1' }],
    ]);
    const deps = makeDeps(createPermissionSeams({ pendingPermissionDecisions }));
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 50,
      sender: 'agent:dev-2',
      type: 'prompt',
      payload: { question: 'Newer ordinary prompt', options: [] },
    }));
    for (const [seq, toolUseId] of [[41, 'toolu_1'], [42, 'toolu_2']]) {
      consumer(baseFrame({
        seq,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: toolUseId },
      }));
    }
    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 42, choice: 'deny', text: null },
    }));
    consumer(baseFrame({
      seq: 52,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'Allow', text: null },
    }));

    expect(firstResolve).toHaveBeenCalledOnce();
    expect(firstResolve).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });
    expect(secondResolve).toHaveBeenCalledOnce();
    expect(secondResolve).toHaveBeenCalledWith({ decision: 'deny', source: 'operator' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('passes the operator identity to the permission finalizer', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((candidateKey) => candidateKey === key),
    });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 42,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: 'must not echo' },
    }));

    expect(deps.resolvePermissionReply).toHaveBeenCalledWith(key, 'allow', { username: 'dan' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('resolves a proven permission member even when target_seq equals its own frame seq', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((candidateKey) => candidateKey === key),
    });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 41,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: null },
    }));

    expect(deps.resolvePermissionReply).toHaveBeenCalledWith(key, 'allow', { username: 'dan' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('resolves a proven permission member even when its reply frame seq is not an integer', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((candidateKey) => candidateKey === key),
    });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: '42',
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: null },
    }));

    expect(deps.resolvePermissionReply).toHaveBeenCalledWith(key, 'allow', { username: 'dan' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('rejects and never buffers a future target_seq guess', () => {
    vi.useFakeTimers();
    try {
      const key = buildPermissionKey('convo-1', 'toolu_future');
      const deps = makeDeps({
        hasLivePermissionPending: vi.fn(() => true),
        isLivePendingToolUse: vi.fn((candidateKey) => candidateKey === key),
      });
      const consumer = createJournalInputConsumer(deps);

      consumer(baseFrame({
        seq: 40,
        type: 'prompt_reply',
        payload: { target_seq: 41, choice: 'allow', text: null },
      }));

      expect(vi.getTimerCount()).toBe(0);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledOnce();
      expect(deps.routePromptReply).not.toHaveBeenCalled();

      consumer(baseFrame({
        seq: 41,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: 'toolu_future' },
      }));

      expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers a stale-target tap while a seq-null permission is live, then drains it on echo', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    const resolve = vi.fn();
    const pendingPermissionDecisions = new Map([
      [key, { resolve, seq: null, convoId: 'convo-1' }],
    ]);
    const deps = makeDeps(createPermissionSeams({ pendingPermissionDecisions }));
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 50,
      sender: 'agent:dev-2',
      type: 'prompt',
      payload: { question: 'Ordinary prompt', options: [] },
    }));
    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: ' allow ', text: 'tap before echo' },
    }));

    expect(resolve).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('refuses an ordinary stale reply immediately when no seq-null permission is live', () => {
    const deps = makeDeps({ hasLivePermissionPending: vi.fn(() => false) });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 50,
      sender: 'agent:dev-2',
      type: 'prompt',
      payload: { question: 'Latest prompt', options: [] },
    }));
    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 40, choice: 'opt_a', text: null },
    }));

    expect(deps.hasLivePermissionPending).toHaveBeenCalledWith('convo-1');
    expect(deps.noticeStalePromptReply).toHaveBeenCalledOnce();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
  });

  it('routes an ordinary latest-seq answer unchanged even with a seq-null permission live', () => {
    const deps = makeDeps({ hasLivePermissionPending: vi.fn(() => true) });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 50,
      sender: 'agent:dev-2',
      type: 'prompt',
      payload: { question: 'Latest prompt', options: [] },
    }));
    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 50, choice: 'opt_a', text: 'ordinary answer' },
    }));

    expect(deps.routePromptReply).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' },
      { target_seq: 50, choice: 'opt_a', text: 'ordinary answer' },
      { username: 'dan' },
    );
    expect(deps.hasLivePermissionPending).not.toHaveBeenCalled();
    expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
  });

  it('buffers a first-card permission tap before its echo and drains it once the echo arrives', () => {
    vi.useFakeTimers();
    try {
      const key = buildPermissionKey('convo-1', 'toolu_first');
      const resolve = vi.fn();
      const pendingPermissionDecisions = new Map([
        [key, { resolve, seq: null, convoId: 'convo-1' }],
      ]);
      const deps = makeDeps(createPermissionSeams({ pendingPermissionDecisions }));
      const consumer = createJournalInputConsumer(deps);

      consumer(baseFrame({
        seq: 42,
        type: 'prompt_reply',
        payload: { target_seq: 41, choice: 'allow', text: 'tap before echo' },
      }));

      expect(resolve).not.toHaveBeenCalled();
      expect(deps.routePromptReply).not.toHaveBeenCalled();
      expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      consumer(baseFrame({
        seq: 41,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: 'toolu_first' },
      }));

      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });
      expect(deps.routePromptReply).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first buffered decision and its original TTL on a conflicting duplicate', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const key = buildPermissionKey('convo-1', 'toolu_first');
      const resolve = vi.fn();
      const pendingPermissionDecisions = new Map([
        [key, { resolve, seq: null, convoId: 'convo-1' }],
      ]);
      const deps = makeDeps(createPermissionSeams({ pendingPermissionDecisions }));
      const consumer = createJournalInputConsumer(deps);

      consumer(baseFrame({
        seq: 42,
        type: 'prompt_reply',
        payload: { target_seq: 41, choice: 'deny', text: null },
      }));
      expect(setTimeoutSpy).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(1_000);
      consumer(baseFrame({
        seq: 43,
        type: 'prompt_reply',
        payload: { target_seq: 41, choice: 'allow', text: null },
      }));

      expect(setTimeoutSpy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);

      consumer(baseFrame({
        seq: 41,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: 'toolu_first' },
      }));

      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith({ decision: 'deny', source: 'operator' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('routes an ordinary answer when no latest prompt or seq-null permission is recorded', () => {
    const deps = makeDeps({ hasLivePermissionPending: vi.fn(() => false) });
    const consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 40, choice: 'opt_a', text: 'ordinary answer' },
    }));

    expect(deps.routePromptReply).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' },
      { target_seq: 40, choice: 'opt_a', text: 'ordinary answer' },
      { username: 'dan' },
    );
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
    expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
  });

  it('maps Allow and allow to allow and every other permission choice to deny', () => {
    const pendingPermissionDecisions = new Map();
    const resolves = [];
    for (const toolUseId of ['toolu_1', 'toolu_2', 'toolu_3']) {
      const resolve = vi.fn();
      resolves.push(resolve);
      pendingPermissionDecisions.set(buildPermissionKey('convo-1', toolUseId), {
        resolve,
        seq: null,
        convoId: 'convo-1',
      });
    }
    const deps = makeDeps(createPermissionSeams({ pendingPermissionDecisions }));
    const consumer = createJournalInputConsumer(deps);

    for (const [seq, toolUseId] of [[41, 'toolu_1'], [42, 'toolu_2'], [43, 'toolu_3']]) {
      consumer(baseFrame({
        seq,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: toolUseId },
      }));
    }
    for (const [seq, choice] of [[41, 'Allow'], [42, 'allow'], [43, 'yes']]) {
      consumer(baseFrame({
        seq: seq + 10,
        type: 'prompt_reply',
        payload: { target_seq: seq, choice, text: null },
      }));
    }

    expect(resolves[0]).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });
    expect(resolves[1]).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });
    expect(resolves[2]).toHaveBeenCalledWith({ decision: 'deny', source: 'operator' });
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('drops a buffered reply when its short TTL expires without resolving the later echo', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        hasLivePermissionPending: vi.fn(() => true),
        isLivePendingToolUse: vi.fn(() => true),
        notePermissionSeq: vi.fn(() => true),
      });
      const consumer = createJournalInputConsumer(deps);
      consumer(baseFrame({
        seq: 50,
        sender: 'agent:dev-2',
        type: 'prompt',
        payload: { question: 'Latest prompt', options: [] },
      }));
      consumer(baseFrame({
        seq: 51,
        type: 'prompt_reply',
        payload: { target_seq: 41, choice: 'allow', text: null },
      }));

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
        username: 'dan',
        targetSeq: 41,
        latestSeq: 50,
      });
      consumer(baseFrame({
        seq: 41,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: 'toolu_1' },
      }));

      expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
      expect(deps.routePromptReply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds buffered permission replies at the per-convo pending cap', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ hasLivePermissionPending: vi.fn(() => true) });
      const consumer = createJournalInputConsumer(deps);
      consumer(baseFrame({
        seq: 1_000,
        sender: 'agent:dev-2',
        type: 'prompt',
        payload: { question: 'Latest prompt', options: [] },
      }));

      for (let seq = 1; seq <= PERMISSION_MAX_PENDING_PER_CONVO + 1; seq += 1) {
        consumer(baseFrame({
          seq: 1_000 + seq,
          type: 'prompt_reply',
          payload: { target_seq: seq, choice: 'allow', text: null },
        }));
      }

      expect(vi.getTimerCount()).toBe(PERMISSION_MAX_PENDING_PER_CONVO);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
        username: 'dan',
        targetSeq: PERMISSION_MAX_PENDING_PER_CONVO + 1,
        latestSeq: 1_000,
      });
      expect(deps.routePromptReply).not.toHaveBeenCalled();

      consumer.evictConvo('convo-1');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds buffered permission replies at the global pending cap', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ hasLivePermissionPending: vi.fn(() => true) });
      const consumer = createJournalInputConsumer(deps);
      const convoCount = PERMISSION_MAX_PENDING_GLOBAL / PERMISSION_MAX_PENDING_PER_CONVO;

      for (let seq = 1; seq <= PERMISSION_MAX_PENDING_GLOBAL; seq += 1) {
        const convoId = `convo-${Math.floor((seq - 1) / PERMISSION_MAX_PENDING_PER_CONVO)}`;
        consumer(baseFrame({
          seq: PERMISSION_MAX_PENDING_GLOBAL + seq,
          convo_id: convoId,
          type: 'prompt_reply',
          payload: { target_seq: seq, choice: 'allow', text: null },
        }));
      }
      consumer(baseFrame({
        seq: PERMISSION_MAX_PENDING_GLOBAL * 2 + 1,
        convo_id: 'convo-overflow',
        type: 'prompt_reply',
        payload: {
          target_seq: PERMISSION_MAX_PENDING_GLOBAL + 1,
          choice: 'allow',
          text: null,
        },
      }));

      expect(vi.getTimerCount()).toBe(PERMISSION_MAX_PENDING_GLOBAL);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledTimes(1);
      expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-overflow', {
        username: 'dan',
        targetSeq: PERMISSION_MAX_PENDING_GLOBAL + 1,
        latestSeq: undefined,
      });
      expect(deps.routePromptReply).not.toHaveBeenCalled();

      for (let convo = 0; convo < convoCount; convo += 1) {
        consumer.evictConvo(`convo-${convo}`);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects user-origin, wrong-convo, unknown-tool, empty-id, and non-integer permission echoes', () => {
    const liveKey = buildPermissionKey('convo-1', 'toolu_live');
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((key, convoId) => (
        key === liveKey && convoId === 'convo-1'
      )),
    });
    const consumer = createJournalInputConsumer(deps);

    const invalidFrames = [
      { seq: 40, sender: 'user:dan', convo_id: 'convo-1', payload: { tool_use_id: 'toolu_live' } },
      { seq: 41, sender: 'agent:dev-2', convo_id: 'convo-2', payload: { tool_use_id: 'toolu_live' } },
      { seq: 42, sender: 'agent:dev-2', convo_id: 'convo-1', payload: { tool_use_id: 'toolu_unknown' } },
      { seq: 43, sender: 'agent:dev-2', convo_id: 'convo-1', payload: { tool_use_id: '   ' } },
      { seq: '44', sender: 'agent:dev-2', convo_id: 'convo-1', payload: { tool_use_id: 'toolu_live' } },
    ];
    for (const overrides of invalidFrames) {
      consumer(baseFrame({ type: 'permission_request', ...overrides }));
    }

    expect(deps.notePermissionSeq).not.toHaveBeenCalled();
  });

  it('retains seq-to-key bindings for all 32 allowed live permission cards', () => {
    const pendingPermissionDecisions = new Map();
    for (let seq = 1; seq <= PERMISSION_MAX_PENDING_PER_CONVO; seq += 1) {
      pendingPermissionDecisions.set(buildPermissionKey('convo-1', `toolu_${seq}`), {
        seq: null,
        convoId: 'convo-1',
      });
    }
    const seams = createPermissionSeams({ pendingPermissionDecisions });
    const notePermissionSeq = vi.fn(seams.notePermissionSeq);
    const resolvePermissionReply = vi.fn(seams.resolvePermissionReply);
    const deps = makeDeps({ ...seams, notePermissionSeq, resolvePermissionReply });
    const consumer = createJournalInputConsumer(deps);

    for (let seq = 1; seq <= PERMISSION_MAX_PENDING_PER_CONVO; seq += 1) {
      consumer(baseFrame({
        seq,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: `toolu_${seq}` },
      }));
    }
    // The permission route rejects the 33rd request at the pending cap, so it
    // has no live registry entry and its echo cannot become dispatchable.
    consumer(baseFrame({
      seq: PERMISSION_MAX_PENDING_PER_CONVO + 1,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_overflow' },
    }));

    for (let seq = 1; seq <= PERMISSION_MAX_PENDING_PER_CONVO; seq += 1) {
      expect(consumer.permissionFrameKey('convo-1', seq)).toBe(
        buildPermissionKey('convo-1', `toolu_${seq}`),
      );
    }
    expect(consumer.permissionFrameKey(
      'convo-1',
      PERMISSION_MAX_PENDING_PER_CONVO + 1,
    )).toBeNull();
    expect(notePermissionSeq).toHaveBeenCalledTimes(PERMISSION_MAX_PENDING_PER_CONVO);
    expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
  });

  it('evictPermissionSeq tombstones the retired seq and leaves picker state intact', () => {
    const assignedKeys = new Set();
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn(() => true),
      notePermissionSeq: vi.fn((key) => {
        if (assignedKeys.has(key)) return false;
        assignedKeys.add(key);
        return true;
      }),
    });
    const consumer = createJournalInputConsumer(deps);
    const firstKey = buildPermissionKey('convo-1', 'toolu_1');

    for (const [seq, toolUseId] of [[41, 'toolu_1'], [42, 'toolu_2']]) {
      consumer(baseFrame({
        seq,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: toolUseId },
      }));
    }
    consumer(baseFrame({
      seq: 50,
      sender: 'agent:dev-2',
      type: 'prompt',
      payload: { options: [{ id: 'model-opus', value: 'model:opus' }] },
    }));

    consumer.evictPermissionSeq(firstKey, 'convo-1');
    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 42,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_2' },
    }));
    consumer(baseFrame({
      seq: 51,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: null },
    }));
    consumer(baseFrame({
      seq: 52,
      type: 'prompt_reply',
      payload: { target_seq: 50, choice: 'model:opus', text: null },
    }));

    expect(deps.notePermissionSeq).toHaveBeenCalledTimes(4);
    expect(deps.notePermissionSeq.mock.results.map(({ value }) => value)).toEqual([
      true, true, false, false,
    ]);
    expect(deps.resolvePermissionReply).not.toHaveBeenCalled();
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.routePromptReply).toHaveBeenNthCalledWith(
      1,
      { claudeSessionId: 'convo-1' },
      { target_seq: 50, choice: 'model:opus', text: null, picker: true },
      { username: 'dan' },
    );
  });

  it('notices a duplicate late tap after operator resolution evicts its permission seq', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    let consumer;
    const deps = makeDeps({
      isLivePendingToolUse: vi.fn((candidateKey) => candidateKey === key),
      resolvePermissionReply: vi.fn((candidateKey) => {
        consumer.evictPermissionSeq(candidateKey, 'convo-1');
      }),
    });
    consumer = createJournalInputConsumer(deps);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 42,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: null },
    }));
    consumer(baseFrame({
      seq: 43,
      type: 'prompt_reply',
      payload: { target_seq: 41, choice: 'allow', text: null },
    }));

    expect(deps.resolvePermissionReply).toHaveBeenCalledOnce();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledOnce();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
      username: 'dan',
      targetSeq: 41,
      latestSeq: undefined,
    });
  });

  it('evictConvo clears permission frame membership and buffered-reply timers idempotently', () => {
    vi.useFakeTimers();
    try {
      const key = buildPermissionKey('convo-1', 'toolu_1');
      const deps = makeDeps({
        isLivePendingToolUse: vi.fn((candidateKey, convoId) => (
          candidateKey === key && convoId === 'convo-1'
        )),
        notePermissionSeq: vi.fn(() => true),
        hasLivePermissionPending: vi.fn(() => true),
      });
      const consumer = createJournalInputConsumer(deps);
      const permissionEcho = baseFrame({
        seq: 41,
        sender: 'agent:dev-2',
        type: 'permission_request',
        payload: { tool_use_id: 'toolu_1' },
      });

      consumer(permissionEcho);
      expect(consumer.permissionFrameKey('convo-1', permissionEcho.seq)).toBe(key);
      consumer(baseFrame({
        seq: 50,
        sender: 'agent:dev-2',
        type: 'prompt',
        payload: { question: 'Latest prompt', options: [] },
      }));
      consumer(baseFrame({
        seq: 51,
        type: 'prompt_reply',
        payload: { target_seq: 40, choice: 'allow', text: null },
      }));
      expect(vi.getTimerCount()).toBe(1);
      consumer.evictConvo('convo-1');
      // A late tap's target seq is no longer a permission-frame member.
      expect(consumer.permissionFrameKey('convo-1', permissionEcho.seq)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(() => consumer.evictConvo('convo-1')).not.toThrow();

      expect(deps.notePermissionSeq).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the production permission seams and exposes safe cleanup hooks', () => {
    const key = buildPermissionKey('convo-1', 'toolu_1');
    const otherKey = buildPermissionKey('convo-1', 'toolu_2');
    const otherConvoKey = buildPermissionKey('convo-2', 'toolu_3');
    const resolve = vi.fn();
    const pendingPermissionDecisions = new Map([
      [key, { resolve, seq: null, convoId: 'convo-1' }],
      [otherKey, { resolve: vi.fn(), seq: 42, convoId: 'convo-1' }],
      [otherConvoKey, { resolve: vi.fn(), seq: null, convoId: 'convo-2' }],
    ]);
    const seams = createPermissionSeams({ pendingPermissionDecisions });
    const deps = makeDeps(seams);
    const consumer = createJournalInputConsumer(deps);

    expect(typeof consumer.evictPermissionSeq).toBe('function');
    expect(seams.hasLivePermissionPending('convo-1')).toBe(true);
    expect(seams.hasLivePermissionPending('convo-2')).toBe(true);
    expect(seams.hasLivePermissionPending('convo-missing')).toBe(false);
    expect(seams.isLivePendingToolUse(key, 'convo-1')).toBe(true);
    expect(seams.isLivePendingToolUse(key, 'convo-2')).toBe(false);
    expect(seams.isLivePendingToolUse(
      buildPermissionKey('convo-1', 'toolu_missing'),
      'convo-1',
    )).toBe(false);
    expect(seams.notePermissionSeq('missing-key', 40, 'convo-1')).toBe(false);
    expect(seams.notePermissionSeq(key, 40, 'convo-2')).toBe(false);

    consumer(baseFrame({
      seq: 41,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    consumer(baseFrame({
      seq: 99,
      sender: 'agent:dev-2',
      type: 'permission_request',
      payload: { tool_use_id: 'toolu_1' },
    }));
    expect(pendingPermissionDecisions.get(key).seq).toBe(41);
    expect(seams.notePermissionSeq(key, 99, 'convo-1')).toBe(false);
    expect(seams.hasLivePermissionPending('convo-1')).toBe(false);
    // A registered seq is still a live tool-use entry; only the convo must match.
    expect(seams.isLivePendingToolUse(key, 'convo-1')).toBe(true);

    seams.resolvePermissionReply(key, 'allow');
    expect(resolve).toHaveBeenCalledWith({ decision: 'allow', source: 'operator' });

    expect(() => consumer.evictPermissionSeq(key, 'convo-1')).not.toThrow();
    expect(() => consumer.evictPermissionSeq('missing-key', 'missing-convo')).not.toThrow();
    expect(() => consumer.evictConvo('convo-1')).not.toThrow();
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

describe('index.js journal input consumer — permission echo wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('echoes a static label through the normal answer helper only after a live finalizer succeeds', () => {
    const resolverStart = src.indexOf('function resolveJournalPermissionReply(');
    expect(resolverStart).toBeGreaterThan(-1);
    const resolverEnd = src.indexOf('// Assembled once', resolverStart);
    const resolver = src.slice(resolverStart, resolverEnd);
    expect(resolver).toMatch(
      /if \(!permissionSeams\.resolvePermissionReply\(key, decision\)\) return false;/,
    );
    expect(resolver).toMatch(/decision === 'allow' \? 'Allow' : 'Deny'/);
    expect(resolver).toMatch(/journalEchoPromptAnswer\(/);
    expect(resolver.match(/journalEchoPromptAnswer\(/g)).toHaveLength(1);

    const promptReplyStart = src.indexOf('function journalOnPromptReply(');
    const promptReplyEnd = src.indexOf('function journalIsControlConvo(', promptReplyStart);
    expect(src.slice(promptReplyStart, promptReplyEnd)).toMatch(/journalEchoPromptAnswer\(/);

    const start = src.indexOf('createJournalInputConsumer({');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('log: console,', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/resolvePermissionReply:\s*resolveJournalPermissionReply/);
    expect(args).not.toMatch(/publishPromptReply/);
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

// Picker taps (/model, /effort, /mode) arrive as prompt_reply frames whose
// `choice` carries the button VALUE (`model:<alias>` / `effort:<level>` /
// `mode:<target>`). Like queue-tile taps, their picker frame never advances
// the staleness guard (non-answerable, issue #98), so the guard's target_seq
// comparison would wrongly refuse the tap whenever ANY answerable prompt has
// been recorded for the convo. The consumer must classify them by value shape
// (lib/picker-dispatch.js isPickerValue) and route them around the guard —
// exactly like the queue-action block (loop #461).
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
  const pickerFrame = (seq, opts) => baseFrame({
    seq, sender: 'agent:dev-2', type: 'prompt',
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
