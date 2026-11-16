import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { trimChatHistory, rebaseHistoryIndex, historyDropCount, CHAT_HISTORY_MAX, CHAT_HISTORY_KEEP } from '../lib/chat-history-cap.js';

const entries = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  role: (from + i) % 2 ? 'assistant' : 'user',
  text: `message ${from + i}`,
}));

describe('trimChatHistory', () => {
  it('leaves a history at or under the cap alone', () => {
    const session = { chatHistory: entries(10), lastSummaryMsgCount: 7 };
    expect(trimChatHistory(session, { max: 10, keep: 5 })).toBe(0);
    expect(session.chatHistory).toHaveLength(10);
    expect(session.lastSummaryMsgCount).toBe(7);
    expect(historyDropCount(session.chatHistory)).toBe(0);
  });

  it('cuts back to the newest entries and keeps the opening user message', () => {
    const session = { chatHistory: entries(11) };
    const dropped = trimChatHistory(session, { max: 10, keep: 5 });
    // 11 - 5 = 6 removed, the opening message put back in front: net 5.
    expect(dropped).toBe(5);
    expect(session.chatHistory.map((m) => m.text)).toEqual([
      'message 0', 'message 6', 'message 7', 'message 8', 'message 9', 'message 10',
    ]);
    expect(historyDropCount(session.chatHistory)).toBe(5);
  });

  it('keeps the same array, so every holder of it sees the cut', () => {
    const history = entries(11);
    const session = { chatHistory: history };
    trimChatHistory(session, { max: 10, keep: 5 });
    expect(session.chatHistory).toBe(history);
  });

  it('does not pin a first user message that is already in the kept tail', () => {
    const history = [...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', text: `a${i}` })), { role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }, { role: 'assistant', text: 'x' }];
    const session = { chatHistory: history };
    expect(trimChatHistory(session, { max: 10, keep: 3 })).toBe(8);
    expect(session.chatHistory.map((m) => m.text)).toEqual(['hello', 'hi', 'x']);
  });

  it('moves every index into the history by the same amount, never below zero', () => {
    const session = {
      chatHistory: entries(11),
      lastSummaryMsgCount: 9,
      _agentHistoryCursor: 11,
      _agentSessions: { claude: { historyCursor: 11 }, codex: { historyCursor: 2 } },
      _pendingAgentHandoff: { prompt: 'p', fromIndex: 3, toIndex: 10 },
    };
    const dropped = trimChatHistory(session, { max: 10, keep: 5 });
    expect(dropped).toBe(5);
    expect(session.lastSummaryMsgCount).toBe(4);
    expect(session._agentHistoryCursor).toBe(6);
    expect(session._agentSessions.claude.historyCursor).toBe(6);
    expect(session._agentSessions.codex.historyCursor).toBe(0);
    expect(session._pendingAgentHandoff).toMatchObject({ fromIndex: 0, toIndex: 5 });
    // An index still names the same message after the cut.
    expect(session.chatHistory[session.lastSummaryMsgCount].text).toBe('message 9');
  });

  it('cuts rarely: after a cut the history has room for max - keep more messages', () => {
    const session = { chatHistory: entries(CHAT_HISTORY_MAX + 1) };
    expect(trimChatHistory(session)).toBeGreaterThan(0);
    const after = session.chatHistory.length;
    expect(after).toBeLessThanOrEqual(CHAT_HISTORY_KEEP + 1);
    for (let i = 0; i < CHAT_HISTORY_MAX - after; i++) {
      session.chatHistory.push({ role: 'user', text: `more ${i}` });
      expect(trimChatHistory(session)).toBe(0);
    }
  });

  it('copes with a session that has no history', () => {
    expect(trimChatHistory({})).toBe(0);
    expect(trimChatHistory(null)).toBe(0);
  });

  it('bounds a history that grows by one message at a time', () => {
    const session = { chatHistory: [], lastSummaryMsgCount: 0 };
    for (let i = 0; i < 10_000; i++) {
      session.chatHistory.push({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` });
      trimChatHistory(session);
      expect(session.chatHistory.length).toBeLessThanOrEqual(CHAT_HISTORY_MAX);
    }
    expect(session.chatHistory[0].text).toBe('m0');
    expect(session.chatHistory.at(-1).text).toBe('m9999');
  });
});

describe('rebaseHistoryIndex', () => {
  it('moves an index read before a cut by what the cut removed', () => {
    const session = { chatHistory: entries(11) };
    const before = historyDropCount(session.chatHistory);
    const nextCount = session.chatHistory.length;
    trimChatHistory(session, { max: 10, keep: 5 });
    expect(rebaseHistoryIndex(session.chatHistory, nextCount, before)).toBe(session.chatHistory.length);
  });

  it('sees a cut made by another session that shares the array', () => {
    const history = entries(11);
    const old = { chatHistory: history, lastSummaryMsgCount: 0 };
    const before = historyDropCount(history);
    const nextCount = history.length;
    // A restart hands the same array to a new session object, which cuts it.
    const replacement = { chatHistory: history, lastSummaryMsgCount: 0 };
    trimChatHistory(replacement, { max: 10, keep: 5 });
    expect(rebaseHistoryIndex(old.chatHistory, nextCount, before)).toBe(history.length);
  });

  it('leaves an index alone when nothing was cut', () => {
    expect(rebaseHistoryIndex(entries(3), 3, 0)).toBe(3);
  });
});

describe('wiring', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const titleSummary = fs.readFileSync(new URL('../lib/title-summary.js', import.meta.url), 'utf8');

  it('caps the history where a message is recorded, before it is persisted', () => {
    const body = index.slice(index.indexOf('function recordConversationMessage('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(/chatHistory\.push\([\s\S]*trimChatHistory\(session\)[\s\S]*persistSession\(/);
  });

  it('saves the moved summary cursor with the cut history', () => {
    const body = index.slice(index.indexOf('function recordConversationMessage('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(/const dropped = trimChatHistory\(session\)/);
    expect(fn).toMatch(/dropped > 0 \? \{ lastSummaryMsgCount: session\.lastSummaryMsgCount/);
  });

  it('moves the summary cursor by any cut made during the model call', () => {
    expect(titleSummary).toMatch(/droppedBefore = historyDropCount\(windowHistory\)/);
    expect(titleSummary).toMatch(/session\.chatHistory === windowHistory/);
    expect(titleSummary).toMatch(/lastSummaryMsgCount = rebaseHistoryIndex\(windowHistory, nextCount, droppedBefore\)/);
  });
});
