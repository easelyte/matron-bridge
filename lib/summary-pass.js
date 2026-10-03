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

// The two spoken lines for voice mode (matron-apple spec
// 2026-10-03-voice-mode-carplay-design.md §1). The wording is the spec's, word
// for word — it was approved as written, so change it there first. The apps
// say SPOKEN aloud when a turn ends and SPOKEN_MORE when the listener asks
// for more.
const SPOKEN_FORMAT = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most, said by the agent in the first person ("I", never "the agent"). First, anything I am asking, need decided or am blocked on, naming the options or who has to act. Then the outcome in one sentence. Then what I will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff, code or a long list, do not read it out: end with a few words saying it is in the chat.>';
const SPOKEN_MORE_FORMAT = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat I raised. Same first person, the same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything worth hearing.>';

export function buildSummaryPrompt({ messages, priorRoster, hasCumulative }) {
  const rendered = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  // Triple-quote fencing: the roster is model output and could contain lines
  // like "TITLE:" — fencing keeps it visually distinct from the format block.
  const preamble = priorRoster
    ? `Context — previous rolling summary of this conversation:\n"""\n${priorRoster}\n"""\n\nThe messages below are what happened AFTER that summary.\n\n`
    : '';
  // ROSTER must stay the LAST format line in both variants:
  // parseTitlePassResponse's multi-line capture stops at the next KEY: line
  // or end-of-text, so a field placed after it would be swallowed. The two
  // spoken lines therefore sit just before it.
  const shared = 'a 3-5 word title (max 34 chars) describing the overall topic/feature being worked on';
  const spokenItem = 'Two spoken versions of the agent\'s latest reply, for someone listening instead of reading';
  const spokenLines = `${SPOKEN_FORMAT}\n${SPOKEN_MORE_FORMAT}`;
  const format = hasCumulative
    ? `Based on these recent messages, provide:\n1. ${shared}, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what just happened\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific and concise.`
    : `Based on these messages, provide:\n1. ${shared}, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific.`;
  return `${preamble}${format}\n\nMessages:\n${rendered}`;
}

// --- Reading the spoken lines back out of the model's answer ---

export const SPOKEN_MAX = 400;
export const SPOKEN_MORE_MAX = 1200;

// Every format key of the pass. A spoken field runs from its own label at the
// start of a line to the next of THESE at the start of a line, or to the end
// of the text — so SPOKEN_MORE may wrap over several lines, and ordinary
// prose such as `API:` or `TODO:` at the start of a line does not end it.
// SPOKEN_MORE sits before SPOKEN only for the reader: `SPOKEN:` cannot match
// the longer label, because `_` is not `:`.
const PASS_KEYS = 'TITLE|SUMMARY|NEW|SPOKEN_MORE|SPOKEN|ROSTER';
const FIELD_END = `(?=\\n(?:${PASS_KEYS}):|$)`;
const SPOKEN_RE = new RegExp(`(?:^|\\n)SPOKEN:([\\s\\S]*?)${FIELD_END}`);
const SPOKEN_MORE_RE = new RegExp(`(?:^|\\n)SPOKEN_MORE:([\\s\\S]*?)${FIELD_END}`);
const SPOKEN_BLOCKS_RE = new RegExp(`(?:^|\\n)SPOKEN(?:_MORE)?:[\\s\\S]*?${FIELD_END}`, 'g');

// One line of speech. The model's line wraps mean nothing to a voice, so every
// run of whitespace becomes one space. NONE (the prompt's word for "nothing to
// add"), in any case, is no line. Over the cap, cut back to the last whole
// word rather than leave half a word to be read out.
function speakable(raw, max) {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s || /^none\.?$/i.test(s)) return null;
  if (s.length <= max) return s;
  const at = s.slice(0, max + 1).lastIndexOf(' ');
  return at > 0 ? s.slice(0, at) : s.slice(0, max);
}

// Splits the model's answer into the two spoken lines and everything else.
// `rest` is the answer with both spoken blocks cut out, and is what
// parseTitlePassResponse must be given: its TITLE/SUMMARY/NEW patterns match
// anywhere in a line and ignore case, so spoken prose such as "In summary: …"
// would otherwise be read as the SUMMARY field. Cutting the blocks out also
// means a model that writes them AFTER ROSTER does not get them swallowed
// into the roster. An answer with no spoken lines comes back unchanged.
export function splitSpoken(text) {
  const t = typeof text === 'string' ? text : '';
  return {
    spoken: speakable(t.match(SPOKEN_RE)?.[1], SPOKEN_MAX),
    spokenMore: speakable(t.match(SPOKEN_MORE_RE)?.[1], SPOKEN_MORE_MAX),
    rest: t.replace(SPOKEN_BLOCKS_RE, ''),
  };
}

// The ref the spoken lines belong to: the message_ref on the text event of
// the agent's last reply (session._lastReplyRef, set by flushResponse). Only
// when this window holds an assistant message — a pass over a turn in which
// the agent said nothing must not hang its lines on the reply before it.
export function spokenRefFor(messages, lastReplyRef) {
  const hasReply = Array.isArray(messages) && messages.some((m) => m?.role === 'assistant');
  return hasReply && typeof lastReplyRef === 'string' && lastReplyRef ? lastReplyRef : null;
}

// The keys the `summary` event gains: {spoken, spoken_more?, spoken_ref}.
// All or nothing — with no spoken line, or no reply to hang it on, the event
// is published exactly as before and the apps fall back to their own cleaner.
export function spokenPayload({ spoken, spokenMore } = {}, replyRef) {
  if (!spoken || !replyRef) return {};
  return {
    spoken,
    ...(spokenMore ? { spoken_more: spokenMore } : {}),
    spoken_ref: replyRef,
  };
}
