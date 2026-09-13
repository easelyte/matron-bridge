// Registry of switchable model aliases (shown as buttons for the no-arg
// /model) plus validation/labelling for `/model <arg>`. The in-TUI
// `/model <alias>` command applies immediately with no picker (Claude Code
// docs), so the bridge validates here then drives the alias into the PTY.

export const SWITCHABLE_ALIASES = [
  { alias: 'default',    label: 'Default' },
  { alias: 'opus',       label: 'Opus' },
  { alias: 'opus[1m]',   label: 'Opus 1M' },
  { alias: 'sonnet',     label: 'Sonnet' },
  { alias: 'sonnet[1m]', label: 'Sonnet 1M' },
  { alias: 'haiku',      label: 'Haiku' },
  { alias: 'opusplan',   label: 'Opus Plan' },
  { alias: 'fable',      label: 'Fable' },
];

// 'best' is valid to type but not surfaced as a button.
const KNOWN_ALIASES = new Set([...SWITCHABLE_ALIASES.map(m => m.alias), 'best']);

// Full model names like claude-opus-4-8 or claude-opus-4-8[1m].
const FULL_NAME_RE = /^claude-[a-z0-9.-]+(\[1m\])?$/;

export const VALID_ALIAS_HINT = SWITCHABLE_ALIASES.map(m => m.alias).join(', ');

// The switchable aliases as status-frame `model_options` — {value,label}
// pairs the composer offers as arguments to /model. Same list the buttons
// come from, so 'best' stays valid to type and absent from the offer.
export function modelOptions() {
  return SWITCHABLE_ALIASES.map(m => ({ value: m.alias, label: m.label }));
}

export function normalizeModelArg(arg) {
  return String(arg ?? '').trim().toLowerCase();
}

// Matrix / mobile clients auto-correct a leading `--` into an em/en dash, so
// `--model` arrives as `—model`. Same sieve (and same character class) as
// extractMcpExtraFlags in lib/mcp-config.js and extractAgentFlag in
// lib/agent-backend.js — users type these on iPhones.
const LEADING_UNICODE_DASHES = /^[‐‑‒–—―]+/;

const missingValueError = () =>
  `--model needs a model alias, e.g. --model sonnet. Options: ${VALID_ALIAS_HINT} (or a full claude-* name).`;

const unknownModelError = (raw) =>
  `Unknown model "${raw}". Try: ${VALID_ALIAS_HINT} (or a full claude-* name).`;

// Value-taking `--model <alias>` / `--model=<alias>` flag for the /start
// command family, in the shape of its sibling extractors: recognised flags are
// consumed, everything else is returned VERBATIM in `rest` so the existing
// positional handling (workdir, session id) is untouched.
//
// `present` reports that a --model flag was typed at all, valid or not, so a
// caller can refuse the flag for a backend it doesn't apply to (Codex) before
// surfacing a Claude-alias error the user can do nothing with.
export function extractModelFlag(tokens = []) {
  const rest = [];
  let model = null;
  let present = false;
  let error = null;
  const fail = (message) => { if (!error) error = message; };

  for (let i = 0; i < tokens.length; i++) {
    const original = String(tokens[i]);
    const token = original.replace(LEADING_UNICODE_DASHES, '--');
    let raw;
    if (token === '--model') {
      present = true;
      const next = i + 1 < tokens.length ? String(tokens[i + 1]) : null;
      // A following flag is NOT this flag's value: `--model --browser` is a
      // missing value, and swallowing --browser would silently drop it too.
      const nextIsFlag = next != null && next.replace(LEADING_UNICODE_DASHES, '--').startsWith('--');
      if (next == null || nextIsFlag || !next.trim()) {
        fail(missingValueError());
        continue;
      }
      i += 1;
      raw = next;
    } else if (token.startsWith('--model=')) {
      present = true;
      raw = token.slice('--model='.length);
      if (!raw.trim()) {
        fail(missingValueError());
        continue;
      }
    } else {
      rest.push(original);
      continue;
    }

    if (!isValidModelArg(raw)) {
      fail(unknownModelError(raw));
      continue;
    }
    const normalized = normalizeModelArg(raw);
    if (model && model !== normalized) {
      fail('Choose only one model: --model <alias>.');
      continue;
    }
    model = normalized;
  }

  return { model, present, rest, error };
}

export function isValidModelArg(arg) {
  const a = normalizeModelArg(arg);
  if (!a) return false;
  return KNOWN_ALIASES.has(a) || FULL_NAME_RE.test(a);
}

export function aliasLabel(arg) {
  const a = normalizeModelArg(arg);
  const found = SWITCHABLE_ALIASES.find(m => m.alias === a);
  if (found) return found.label;
  if (a === 'best') return 'Best';
  return a;
}

// Current model is read off any event carrying message.model (assistant /
// tools_changed records in both print and iv mode). Returns null otherwise.
export function modelFromEvent(event) {
  // Subagent events are skipped — print mode tags them with
  // parent_tool_use_id, older inline transcripts with isSidechain — because
  // their model is the SUBAGENT's, not the session's. contextWindowFor()
  // derives the gauge window from the model, so one leaked event corrupts
  // both the header's model label and the context percentage (the guard
  // mirrors contextTokensFromAssistantEvent in session-status.js).
  if (event?.parent_tool_use_id || event?.isSidechain) return null;
  const m = event?.message?.model;
  return typeof m === 'string' && m ? m : null;
}
