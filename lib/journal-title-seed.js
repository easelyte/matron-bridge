import path from 'path';

// Without a GEMINI_API_KEY the LLM rename in maybeUpdatePinnedSummary never
// runs, so convos kept their workdir-basename seed forever. Fall back to the
// same name Claude Code itself gives a session — the first user message, as
// shown by `claude --resume` and the bridge's own /sessions listing (see
// lib/session-summary.js's extraction, whose cleaning rules this mirrors).
// One-shot per session: the first user message never changes, so there is
// nothing to re-derive. Same title format as the LLM rename
// (`label:xx <text>`) so journals look uniform whichever path named them.
const FALLBACK_TITLE_MAX = 60;

// The seed title seedJournalTitle below would give this workdir — the only
// title the fallback is allowed to replace. Anything else (a resume summary,
// media naming, an earlier fallback surviving a bridge restart) already beat
// the seed and must not be clobbered.
function seedTitleFor(workdir) {
  const base = workdir ? path.basename(path.resolve(workdir)) : '';
  return base || 'session';
}

export function applyFallbackTitle(session, { serverLabel, updateRoomName, workdir }) {
  if (session._fallbackTitleApplied) return false;
  const hint = session._journalTitleHint;
  if (hint !== undefined && hint !== seedTitleFor(workdir)) return false;
  const history = Array.isArray(session.chatHistory) ? session.chatHistory : [];
  // First user message whose text survives cleaning — a tag-only opener
  // (IDE context pastes) must not block naming forever.
  for (const m of history) {
    if (m?.role !== 'user' || typeof m.text !== 'string') continue;
    // Tag-strip, then drop stray angle brackets outright: a single-pass strip
    // can reassemble or pass through `<script` fragments (CodeQL
    // js/incomplete-multi-character-sanitization), and a title has no
    // legitimate need for < or >.
    const clean = m.text
      .replace(/<[^>]*>/g, ' ')
      .replace(/[<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    const text = clean.length > FALLBACK_TITLE_MAX ? `${clean.slice(0, FALLBACK_TITLE_MAX)}…` : clean;
    const sessionShort = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);
    session._fallbackTitleApplied = true;
    updateRoomName(session.roomId, `${serverLabel}:${sessionShort} ${text}`);
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
export async function seedJournalTitle(session, { workdir, incomingHint, reattaching = false, upsertConvo, warn = () => {} }) {
  try {
    if (incomingHint !== undefined) {
      session._journalTitleHint = incomingHint;
      return false;
    }
    if (session._journalTitleHint !== undefined) return false;
    // Reattaching to an existing conversation (a journalConvoId was supplied):
    // it already exists server-side with whatever title it earned, so seeding
    // the workdir basename could only clobber it. Only a brand-new convo seeds.
    if (reattaching) return false;
    upsertConvo(session, { title: seedTitleFor(workdir) });
    return true;
  } catch (e) {
    warn(`seedJournalTitle failed: ${e?.message || e}`);
    return false;
  }
}
