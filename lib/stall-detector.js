// Recognise a usage-limit stall from the assistant record Claude Code
// writes when the account meter is exhausted (spec 2026-09-29 coordinator
// session control §3). The record observed on this box (print mode, an
// sdk-cli transcript) is
//   { type:'assistant', isApiErrorMessage:true, error:'rate_limit',
//     apiErrorStatus:429, message:{ model:'<synthetic>', content:[{type:'text',
//     text:"You've reached your Fable limit. Switch to another model, or manage
//     usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."}]} }
// and the journal holds the older wordings "You've reached your Fable 5
// limit. Run /usage-credits to continue or switch models with /model." and
// "Error during compaction: You've reached your Fable 5 limit. …". The
// structured fields decide when present; the wording is the fallback for
// stream shapes that strip them. Either way only a record whose ONLY
// content is that text counts — a model that quotes the sentence mid-answer
// is not stalled.
import { isSidechainEvent } from './session-status.js';

export const USAGE_LIMIT_RE = /^(?:error during compaction:\s*)?(?:you'?ve reached your .{1,40} limit\b|claude ai usage limit reached\b)/i;

// Claude Code stamps error records with a placeholder model, never the one
// that hit the limit; the caller's session.currentModel is the real answer.
export const SYNTHETIC_MODEL = '<synthetic>';

function soleText(event) {
  const content = event.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') return null;
  return blocks[0].text.trim();
}

// The unknown / unavailable model record (Claude Code 2.1.280 bundle):
//   "The model <m> is not available on your <deployment> deployment. Try
//    /model … to switch to <l>, or ask your admin to enable this model."
//   "There's an issue with the selected model (<m>). It may not exist or
//    you may not have access to it."
// flagged error:'model_not_found' (HTTP 404). Reported as kind 'bad_model'
// so the bridge can switch to the default model once and carry on (§4).
export const BAD_MODEL_RE = /^(?:the model .{1,80} is not available on your |there'?s an issue with the selected model\b)/i;

export function stallFromAssistantEvent(event) {
  if (!event || event.type !== 'assistant' || isSidechainEvent(event)) return null;
  const text = soleText(event);
  if (text === null) return null;
  const m = event.message?.model;
  const model = typeof m === 'string' && m && m !== SYNTHETIC_MODEL ? m : undefined;
  const apiError = event.isApiErrorMessage === true;
  if ((apiError && (event.error === 'rate_limit' || event.apiErrorStatus === 429)) || USAGE_LIMIT_RE.test(text)) {
    return { kind: 'usage_limit', ...(model ? { model } : {}) };
  }
  // The wording alone counts only on a record Claude Code marked as an
  // error (the placeholder model is that mark too): an assistant that
  // merely quotes the sentence is not on a bad model.
  const errorRecord = apiError || m === SYNTHETIC_MODEL;
  if ((apiError && (event.error === 'model_not_found' || event.apiErrorStatus === 404)) || (errorRecord && BAD_MODEL_RE.test(text))) {
    return { kind: 'bad_model', ...(model ? { model } : {}) };
  }
  return null;
}

// The moment the stall lifts. The message names a model ("Fable limit"),
// which may be the weekly per-model meter rather than the 5-hour session
// one, so: the fullest meter (100% first) with a reset time, then the
// session meter (lib/usage-limits.js derives its id as 'session'), then any
// line carrying a reset. Undefined when nothing says.
export function stallResetsAt(lines) {
  if (!Array.isArray(lines)) return undefined;
  const withReset = lines.filter((l) => l && typeof l.resets_at === 'string' && Number.isFinite(l.percent));
  const full = withReset.filter((l) => l.percent >= 100).sort((a, b) => b.percent - a.percent)[0];
  if (full) return full.resets_at;
  const session = withReset.find((l) => l.id === 'session');
  if (session) return session.resets_at;
  return withReset[0]?.resets_at;
}
