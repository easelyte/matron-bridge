import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendDelayedPromptAnswer, writePromptAnswer } from '../lib/prompt-answer-delivery.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('writePromptAnswer', () => {
  it('records only after stdin confirms the answer and gates handoffs until then', () => {
    let callback;
    const delivered = vi.fn();
    const session = {
      proc: {
        stdin: {
          write: vi.fn((_payload, cb) => {
            callback = cb;
            return true;
          }),
        },
      },
    };

    expect(writePromptAnswer(session, 'answer\n', { onDelivered: delivered })).toBe(true);
    expect(session._pendingPromptAnswerDelivery).toBeTruthy();
    expect(delivered).not.toHaveBeenCalled();

    callback();

    expect(delivered).toHaveBeenCalledOnce();
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });

  it('does not record a failed write and releases the handoff gate', () => {
    let callback;
    const delivered = vi.fn();
    const failed = vi.fn();
    const session = {
      proc: { stdin: { write: vi.fn((_payload, cb) => { callback = cb; return true; }) } },
    };

    writePromptAnswer(session, 'answer\n', { onDelivered: delivered, onError: failed });
    callback(new Error('broken pipe'));

    expect(delivered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken pipe' }));
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });

  it('treats Writable backpressure as accepted and waits for its callback', () => {
    let callback;
    const delivered = vi.fn();
    const session = {
      proc: { stdin: { write: vi.fn((_payload, cb) => { callback = cb; return false; }) } },
    };

    expect(writePromptAnswer(session, 'answer\n', { onDelivered: delivered })).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    expect(session._pendingPromptAnswerDelivery).toBeTruthy();

    callback();

    expect(delivered).toHaveBeenCalledOnce();
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });

  it('handles a synchronous stdin failure without recording', () => {
    const delivered = vi.fn();
    const failed = vi.fn();
    const session = {
      proc: { stdin: { write: vi.fn(() => { throw new Error('closed'); }) } },
    };

    expect(writePromptAnswer(session, 'answer\n', { onDelivered: delivered, onError: failed })).toBe(false);
    expect(delivered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'closed' }));
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });
});

describe('sendDelayedPromptAnswer', () => {
  it('gates handoffs across the delay and records immediately after the PTY accepts the text', () => {
    vi.useFakeTimers();
    const actions = [];
    const session = {
      iv: {
        alive: true,
        respondToPrompt: vi.fn(() => { actions.push('select'); return true; }),
        sendText: vi.fn(() => { actions.push('send'); return true; }),
      },
    };

    expect(sendDelayedPromptAnswer(session, {
      response: { kind: 'numbered', key: '2' },
      text: 'custom answer',
      onDelivered: () => actions.push('record'),
    })).toBe(true);
    expect(actions).toEqual(['select']);
    expect(session._pendingPromptAnswerDelivery).toBeTruthy();

    vi.advanceTimersByTime(250);

    expect(actions).toEqual(['select', 'send', 'record']);
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });

  it('does not record when the delayed PTY send fails', () => {
    vi.useFakeTimers();
    const delivered = vi.fn();
    const failed = vi.fn();
    const session = {
      iv: {
        alive: true,
        respondToPrompt: vi.fn(() => true),
        sendText: vi.fn(() => false),
      },
    };

    sendDelayedPromptAnswer(session, {
      response: { kind: 'numbered', key: '2' },
      text: 'custom answer',
      onDelivered: delivered,
      onError: failed,
    });
    vi.advanceTimersByTime(250);

    expect(delivered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Claude rejected the prompt answer.' }));
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });

  it('rejects immediately when the prompt selection cannot be sent', () => {
    const delivered = vi.fn();
    const failed = vi.fn();
    const session = {
      iv: {
        alive: true,
        respondToPrompt: vi.fn(() => false),
        sendText: vi.fn(() => true),
      },
    };

    expect(sendDelayedPromptAnswer(session, {
      response: { kind: 'numbered', key: '2' },
      text: 'custom answer',
      onDelivered: delivered,
      onError: failed,
    })).toBe(false);
    expect(delivered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Claude rejected the prompt selection.' }));
    expect(session._pendingPromptAnswerDelivery).toBeNull();
  });
});
