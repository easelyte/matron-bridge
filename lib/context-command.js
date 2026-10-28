// Pure helpers for the bridge-level /context trimming feature.
//
// claude's /context local command returns a full markdown report — usage
// table, MCP tools, memory files, skills, easily 100+ lines — which is
// noise on a phone-sized Matron client. The bridge trims it to the
// two headline lines (Model / Tokens) plus a pointer to /context-full, a
// bridge-only command that reruns /context and lets the report through
// untrimmed. claude itself only knows /context, so the bridge rewrites
// /context-full before it reaches stdin.
//
// Kept in lib/ so both halves (the rewrite in sendToSession, the trim in
// flushResponse) stay pure and unit-testable.

const CONTEXT_FULL_RE = /^\/context-full\s*$/;

// The report's identifying shape: claude prints `## Context Usage` as the
// first line, with `**Model:**` / `**Tokens:**` headline lines right after.
const REPORT_RE = /^##\s+Context Usage\b/;

// If `text` is exactly the bridge-only /context-full command, return the
// native command to send to claude instead; otherwise null. Anchored to the
// whole (trimmed) message — a /context-full mentioned mid-sentence, or a
// busy-queue flush that merged it with other messages, wouldn't have run as
// a slash command natively either, so it passes through untouched.
export function contextFullToNative(text) {
  if (typeof text !== 'string') return null;
  return CONTEXT_FULL_RE.test(text.trim()) ? '/context' : null;
}

// If `text` is a /context report, return the trimmed version; otherwise
// null. Returns null (caller falls back to the full text) when the report
// shape ever changes enough that the headline lines can't be found — wrong
// output beats no output.
export function briefContextReport(text) {
  if (typeof text !== 'string' || !REPORT_RE.test(text.trim())) return null;
  const lines = text.split('\n').map((l) => l.trim());
  const model = lines.find((l) => l.startsWith('**Model:**'));
  const tokens = lines.find((l) => l.startsWith('**Tokens:**'));
  if (!model || !tokens) return null;
  // Trailing double-space = markdown hard break, so Model/Tokens stay on
  // separate lines when rendered as HTML.
  return `${model}  \n${tokens}\n\nSend /context-full for full context.`;
}
