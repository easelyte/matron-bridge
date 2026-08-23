import path from 'path';

// If the codex LLM rename in maybeUpdatePinnedSummary does not run, convos keep
// their workdir-basename seed forever. Fall back to the same name Claude Code
// itself gives a session — the first user message, as shown by the
// `claude --resume` command and the bridge's own /sessions listing (see
// lib/session-summary.js's extraction, whose cleaning rules this mirrors).
// One-shot per session: the first user message never changes, so there is
// nothing to re-derive. Same title format as the LLM rename
// (`VPS · <repo> · <text>`) so journals look uniform whichever path named
// them.
const FALLBACK_TITLE_MAX = 60;
const REPO_LABEL_MAX = 24;

// Code-point-aware truncation: a raw UTF-16 slice can cut an astral character
// (emoji, etc.) mid-surrogate-pair and leave an unpaired surrogate that renders
// as `�` in the room name. LLM-inferred repo labels can carry arbitrary
// Unicode, so slice by code point (Array.from splits on code points) to keep
// the cap at maxLength code points with no corruption. ASCII behavior is
// unchanged.
function truncateWithEllipsis(value, maxLength) {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : value;
}

export function repoLabel(workdir, { defaultWorkdir }) {
  const resolvedWorkdir = path.resolve(workdir);
  const repo = resolvedWorkdir === defaultWorkdir ? 'son-of-anton' : path.basename(resolvedWorkdir);
  return truncateWithEllipsis(repo, REPO_LABEL_MAX);
}

// Values the summary LLM may emit when it cannot infer a target repo.
const REPO_SENTINELS = new Set(['unknown', 'none', 'n/a', 'na', '-']);

// Extract an LLM-inferred target-repo label from a codex summary response.
// The session cwd (repoLabel) is a poor repo indicator for cross-repo work
// rooted in son-of-anton, so codex is asked to infer the repo actually being
// worked on and emit it on a `REPO:` line. That line is model output over
// UNTRUSTED transcript content (and this feature runs on the bridge whose own
// sessions discuss `REPO:` lines), so extraction is deliberately strict:
//   - line-anchored + exactly-one — a mid-line `REPO:` echoed inside TITLE/prose
//     is ignored, and DUPLICATE `REPO:` lines are ambiguous/spoofable so the
//     whole override is rejected to the workdir fallback rather than guessing
//     which is canonical (P33 parse-don't-validate);
//   - blank-safe — horizontal-whitespace-only + line-bounded capture so an
//     empty `REPO:` cannot cross the newline and swallow the next field;
//   - sentinel-guarded — `unknown`/`none`/etc. mean "no override";
//   - sanitized for a display sink — control/format/bidi/separator chars,
//     tag delimiters, stray angle brackets, and the `·` title separator are
//     stripped (content preserved; CodeQL parity with applyFallbackTitle) so
//     nothing forges markup, reorders text, or injects extra title segments;
//   - capped at REPO_LABEL_MAX (code-point-aware) like every other repo label.
// Returns null when absent, duplicated, a sentinel, or empty after cleaning.
// Canonical display-sink cleaning for a repo label, shared by every repo
// source (the codex REPO: override AND the activity-inferred filesystem label
// from lib/repo-infer.js). Strips control/format/bidi/separator chars, tag
// delimiters, stray angle brackets, and the `·` title separator so no source
// can forge markup, reorder text, or inject extra title segments. Content is
// preserved (chars collapse to spaces), matching applyFallbackTitle's parity
// with CodeQL. Returns '' when nothing survives.
export function sanitizeRepoLabel(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/·/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractRepoOverride(text) {
  if (typeof text !== 'string') return null;
  const lines = text.match(/^REPO:[^\S\r\n]*[^\r\n]*$/gim);
  if (!lines || lines.length !== 1) return null;
  const raw = lines[0].replace(/^REPO:[^\S\r\n]*/i, '').trim();
  if (!raw || REPO_SENTINELS.has(raw.toLowerCase())) return null;
  const clean = sanitizeRepoLabel(raw);
  if (!clean) return null;
  return truncateWithEllipsis(clean, REPO_LABEL_MAX);
}

export function formatRoomTitle({ serverLabel, workdir, text, defaultWorkdir, repo }) {
  // Every repo source is untrusted at this sink (codex prose over an untrusted
  // transcript; a filesystem directory name that could contain `·`/bidi/etc.),
  // so sanitize here rather than trusting callers. An empty-after-cleaning
  // label falls back to the workdir-derived segment.
  const cleanRepo = typeof repo === 'string' ? sanitizeRepoLabel(repo) : '';
  const repoSegment = cleanRepo
    ? truncateWithEllipsis(cleanRepo, REPO_LABEL_MAX)
    : repoLabel(workdir, { defaultWorkdir });
  // No server-label prefix: which box owns a conversation is data
  // (conversations.agent_device_id) clients render as a chip, and on a single-box
  // deployment the label is pure redundancy. The 2-char session short (applied by
  // withSessionShort at the earned-title sites) is what tells same-box sessions
  // apart. The repo segment stays: it's the "what is this session about" signal.
  const base = repoSegment;
  return text ? `${base} · ${truncateWithEllipsis(text, FALLBACK_TITLE_MAX)}` : base;
}

// Two characters of the session id, prefixed to every EARNED title (the
// first-message fallback, the LLM rename, resume titles) as `[ab]`, optionally
// behind a marker. Seed titles stay bare (the native id often doesn't exist at
// seed time). Nothing else distinguishes two sessions on the SAME box.
export function withSessionShort(id, title, marker = '') {
  const short = typeof id === 'string' ? id.trim().slice(0, 2) : '';
  const prefix = marker ? `${marker} ` : '';
  return short ? `${prefix}[${short}] ${title}` : `${prefix}${title}`;
}

// Marks a session another agent started (journal-rpc `start`): `🐣 [ab] Title`.
export const SPAWN_TITLE_MARKER = '🐣';

// The marker every EARNED title of this session must carry. Spawned sessions set
// `spawnedByAgent` at spawn; after a bridge restart that flag is gone, so fall
// back to whether the CURRENT title already carries the marker (`_journalTitleHint`
// tracks every publish and rides the persisted record) — a rename must never
// silently drop the 🐣.
export function titleMarkerFor(session) {
  if (session?.spawnedByAgent) return SPAWN_TITLE_MARKER;
  const hint = session?._journalTitleHint;
  return typeof hint === 'string' && hint.startsWith(`${SPAWN_TITLE_MARKER} `)
    ? SPAWN_TITLE_MARKER
    : '';
}

// The seed title seedJournalTitle below would give this workdir — the only
// title the fallback is allowed to replace. Anything else (a resume summary,
// media naming, an earlier fallback surviving a bridge restart) already beat
// the seed and must not be clobbered.
// Shared cleaning for anything that becomes a title: tag-strip, then drop
// stray angle brackets outright — a single-pass strip can reassemble or pass
// through `<script` fragments (CodeQL js/incomplete-multi-character-
// sanitization), and a title has no legitimate need for < or >.
function cleanTitleText(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seedTitleFor(workdir) {
  const base = workdir ? path.basename(path.resolve(workdir)) : '';
  return base || 'session';
}

export function applyFallbackTitle(session, { serverLabel, updateRoomName, workdir, defaultWorkdir, repo }) {
  const applied = session._fallbackTitleApplied;
  if (applied) {
    // Re-title as the inferred repo evolves (F1r2/F1r3): the flush that names a
    // short session fires before its first tool result commits activity, and the
    // first committed signal may be a weak READ (son-of-anton) later corrected
    // by a WRITE (the sibling repo) — read-then-write is the common shape. So do
    // NOT lock after the first repo; keep re-titling WHILE WE STILL OWN the
    // title. The moment a codex summary pass wins the title (hint diverges from
    // the value we last set), stop — never clobber a better title.
    if (session._journalTitleHint !== session._fallbackTitleValue) return false;
  } else {
    const hint = session._journalTitleHint;
    if (hint !== undefined && hint !== seedTitleFor(workdir)) return false;
  }
  // A spawned session's first user message is the composed opening turn —
  // boilerplate that made every spawned chat read identically. Name it from
  // the approved task instead (journal-rpc sets session.spawnTask), which is
  // what the conversation is actually about; otherwise the chat history.
  const spawnTask = typeof session.spawnTask === 'string' ? [{ role: 'user', text: session.spawnTask }] : null;
  const history = spawnTask ?? (Array.isArray(session.chatHistory) ? session.chatHistory : []);
  // First user message whose text survives cleaning — a tag-only opener
  // (IDE context pastes) must not block naming forever.
  for (const m of history) {
    if (m?.role !== 'user' || typeof m.text !== 'string') continue;
    const clean = cleanTitleText(m.text);
    if (!clean) continue;
    // `repo` is the activity-inferred target (see lib/repo-infer.js) — a better
    // signal than the workdir basename for path-reached cross-repo work, so when
    // present it overrides the workdir-derived segment in formatRoomTitle.
    const baseTitle = formatRoomTitle({ serverLabel, workdir, text: clean, defaultWorkdir, repo });
    // Prefix the 2-char session short (+ 🐣 for spawned sessions) so two same-box
    // sessions in the same repo are still distinguishable.
    const title = withSessionShort(session.claudeSessionId || session.roomId, baseTitle, titleMarkerFor(session));
    // Nothing changed (same dominant repo committed again, or the seed re-fires):
    // avoid a redundant rename/publish.
    if (applied && title === session._fallbackTitleValue) return false;
    session._fallbackTitleApplied = true;
    session._fallbackTitleValue = title;
    updateRoomName(session.roomId, title);
    return true;
  }
  return false; // no usable user turn yet — stay armed for the next flush
}

// Seed a journal convo title from the session's workdir (basename), unless a
// live title hint already won. Fails open — a title is cosmetic.
//
// `incomingHint` carries the title from this convo's PRIOR life across a
// restart/resume (the good Gemini summary lived on the old session object).
// When present it is adopted onto the fresh session SILENTLY — no upsert —
// because that title already exists server-side. Publishing the workdir
// basename here instead would clobber it via the journal's COALESCE upsert
// (the title-revert bug: a respawn re-seeded the bare repo name over the
// good title). Note `undefined` means "no prior title"; '' is a real,
// deliberately-chosen title and is adopted like any other.
//
// `persistedHint` is the same idea across a full BRIDGE restart, where no
// live session object survives to carry incomingHint: the last published
// title, read back from the persisted session record (journalUpsertConvo
// writes it there on every title change). Only adopted when reattaching —
// on a brand-new convo the server has no title yet, so a stale hint from
// the room's prior convo must not suppress the seed. Without this, a
// resumed session's first assistant flush saw no hint, re-applied the
// first-user-message fallback title, and clobbered the earned Gemini title.
export async function seedJournalTitle(session, { workdir, incomingHint, persistedHint, reattaching = false, upsertConvo, warn = () => {} }) {
  try {
    if (incomingHint !== undefined) {
      session._journalTitleHint = incomingHint;
      return false;
    }
    if (session._journalTitleHint !== undefined) return false;
    // Reattaching to an existing conversation (a journalConvoId was supplied):
    // it already exists server-side with whatever title it earned, so seeding
    // the workdir basename could only clobber it. Only a brand-new convo seeds.
    if (reattaching) {
      if (persistedHint !== undefined) session._journalTitleHint = persistedHint;
      return false;
    }
    upsertConvo(session, { title: seedTitleFor(workdir) });
    return true;
  } catch (e) {
    warn(`seedJournalTitle failed: ${e?.message || e}`);
    return false;
  }
}
