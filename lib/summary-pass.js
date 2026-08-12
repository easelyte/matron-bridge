// Incremental prompt window for the title/summary pass. The old pass sent
// chatHistory.slice(-50) every 5 messages — ~45 of the 50 were re-sends, so
// each message was billed ~10x over its lifetime and the prompt never carried
// the prior summary text at all. Now: only messages since the last SUCCESSFUL
// pass (cursor advances on success only, in index.js), capped at 200 with the
// oldest overflow dropped-but-skipped, plus the previous ROSTER paragraph as
// an explicitly fenced context preamble.

// 1, not higher: a conversation that goes idle before reaching a bigger
// threshold would leave its last messages unsummarized forever. The floor
// only exists to skip turn ends with nothing new at all.
export const SUMMARY_MIN_NEW = 1;
export const SUMMARY_WINDOW_CAP = 200;

export function summaryWindow(chatHistory, lastCount, { cap = SUMMARY_WINDOW_CAP } = {}) {
  const history = Array.isArray(chatHistory) ? chatHistory : [];
  const since = Math.max(0, Math.min(lastCount || 0, history.length));
  const fresh = history.slice(since);
  return {
    messages: fresh.slice(-cap),
    newCount: fresh.length,
    nextCount: history.length,
  };
}

export function buildSummaryPrompt({ messages, priorRoster, hasCumulative }) {
  const rendered = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  // Triple-quote fencing: the roster is model output and could contain lines
  // like "TITLE:" — fencing keeps it visually distinct from the format block.
  const preamble = priorRoster
    ? `Context — previous rolling summary of this conversation:\n"""\n${priorRoster}\n"""\n\nThe messages below are what happened AFTER that summary.\n\n`
    : '';
  // ROSTER must stay the LAST format line in both variants:
  // parseTitlePassResponse's multi-line capture stops at the next KEY: line
  // or end-of-text, so a field placed after it would be swallowed.
  const shared = 'a 3-5 word title (max 34 chars) describing the overall topic/feature being worked on';
  const format = hasCumulative
    ? `Based on these recent messages, provide:\n1. ${shared}, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what just happened\n3. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific and concise.`
    : `Based on these messages, provide:\n1. ${shared}, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n3. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific.`;
  return `${preamble}${format}\n\nMessages:\n${rendered}`;
}
