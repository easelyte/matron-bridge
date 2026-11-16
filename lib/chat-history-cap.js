// A session's chatHistory is the bridge's own copy of the conversation
// (role + text per message). It is persisted whole into the sessions file on
// every message, and that file is read and rewritten whole each time, so an
// uncapped history makes every message cost more than the last. A long-lived
// session that takes many turns a day reached tens of thousands of entries:
// tens of megabytes of JSON parsed and serialised per message, and a heap
// that ran out.
//
// Nothing reads far back. The summary pass reads at most the newest 200
// messages since its cursor, an agent handoff at most 50, and titles come
// from the first user message, which is kept below. So the history is cut
// back to the newest `keep` entries once it passes `max`; the gap between the
// two means the cut happens once every few hundred messages, not on each one.
//
// Every index into the history moves with the cut: the summary cursor, the
// active agent's cursor, each provider's stored cursor and a pending
// handoff's range. The count of entries removed so far is kept per array,
// not per session: a restarted session takes over the same array, so a pass
// that read an index before an await sees every cut made to it since, by
// whichever session made it.

export const CHAT_HISTORY_MAX = 2000;
export const CHAT_HISTORY_KEEP = 1500;

const droppedByHistory = new WeakMap();

// Entries trimChatHistory has removed from this array so far.
export function historyDropCount(history) {
  return (history && droppedByHistory.get(history)) || 0;
}

const shift = (value, by) => (Number.isFinite(value) ? Math.max(0, value - by) : value);

// Cut session.chatHistory back to the newest `keep` entries when it holds
// more than `max`. The first user message stays at the front (titles and the
// session list name a conversation by it). Returns how many entries were
// removed (0 when nothing changed).
export function trimChatHistory(session, { max = CHAT_HISTORY_MAX, keep = CHAT_HISTORY_KEEP } = {}) {
  const history = session?.chatHistory;
  if (!Array.isArray(history) || history.length <= max) return 0;
  const keepCount = Math.max(1, Math.min(keep, max));
  const firstUserIndex = history.findIndex((m) => m?.role === 'user' && typeof m.text === 'string' && m.text);
  let cutEnd = history.length - keepCount;
  // Keep the opening user message, unless it is already inside the kept tail.
  const pinFirst = firstUserIndex >= 0 && firstUserIndex < cutEnd;
  if (pinFirst) {
    const first = history[firstUserIndex];
    history.splice(0, cutEnd);
    history.unshift(first);
    cutEnd -= 1; // the pinned entry takes one slot back
  } else {
    history.splice(0, cutEnd);
  }
  const dropped = cutEnd;
  if (dropped <= 0) return 0;

  session.lastSummaryMsgCount = shift(session.lastSummaryMsgCount, dropped);
  session._agentHistoryCursor = shift(session._agentHistoryCursor, dropped);
  if (session._agentSessions && typeof session._agentSessions === 'object') {
    for (const state of Object.values(session._agentSessions)) {
      if (state && typeof state === 'object') state.historyCursor = shift(state.historyCursor, dropped);
    }
  }
  const pending = session._pendingAgentHandoff;
  if (pending && typeof pending === 'object') {
    pending.fromIndex = shift(pending.fromIndex, dropped);
    pending.toIndex = shift(pending.toIndex, dropped);
  }
  droppedByHistory.set(history, historyDropCount(history) + dropped);
  return dropped;
}

// An index read from `history` before an await, moved by whatever
// trimChatHistory removed from that array since. `droppedBefore` is
// historyDropCount(history) as it was when the index was read.
export function rebaseHistoryIndex(history, index, droppedBefore) {
  const before = Number.isFinite(droppedBefore) ? droppedBefore : 0;
  return shift(index, Math.max(0, historyDropCount(history) - before));
}
