import { extractRepoOverride, withSessionShort, titleMarkerFor } from './journal-title-seed.js';

let activeCount = 0;

const DEFAULT_MAX_CONCURRENT = 2;
const MIN_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 32;
const MAX_COMPACTED_CHARS = 400;
const MAX_SUMMARY_BULLETS = 20;
const RETAINED_SUMMARY_BULLETS = 15;

function capSummaryBullets(summary) {
  const lines = summary.split('\n');
  const bulletIndexes = lines
    .map((line, index) => line.startsWith('•') ? index : -1)
    .filter(index => index !== -1);

  if (bulletIndexes.length <= MAX_SUMMARY_BULLETS) return summary;

  const indexesToDrop = new Set(
    bulletIndexes.slice(0, bulletIndexes.length - RETAINED_SUMMARY_BULLETS),
  );
  return lines.filter((_line, index) => !indexesToDrop.has(index)).join('\n');
}

// The journal caps convo_upsert.summary at 1000 chars (matron-journal
// src/ws.js SUMMARY_MAX_CHARS) and rejects the WHOLE frame over it — title,
// agent_kind and session_state included — with a warn-once-per-connection drop
// and no retry (journal-publisher.js onOpError path). Measured 2026-09-13 on
// live data: 7 of 24 populated summaries already exceed 1000 chars (max 2082),
// so an unclamped publish is an immediate regression, not a latent risk.
// Clamp here, at the single producer, so the server cap is a backstop we never
// touch. Drops OLDEST bullets first (same retain-newest policy as
// capSummaryBullets); a single bullet over the budget is hard-cut.
export const JOURNAL_SUMMARY_MAX_CHARS = 1000;

// Group lines into bullet blocks: a line starting with '•' opens a block and
// any following non-bullet lines (a wrapped bullet, or prose the model emitted
// without a marker) belong to it. Leading non-bullet lines form their own
// block. Dropping whole blocks avoids stranding an orphan continuation line at
// the top of the clamped text.
function bulletBlocks(lines) {
  const blocks = [];
  for (const line of lines) {
    if (line.startsWith('•') || blocks.length === 0) blocks.push([line]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.map(block => block.join('\n'));
}

export function summaryForJournal(text, max = JOURNAL_SUMMARY_MAX_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  const blocks = bulletBlocks(s.split('\n').map(l => l.trim()).filter(Boolean));
  while (blocks.length > 1 && blocks.join('\n').length > max) blocks.shift();
  const out = blocks.join('\n');
  // Single oversize block: hard-cut with an ellipsis. Ugly and bounded beats a
  // rejected frame. '…' is one UTF-16 code unit, so the result is exactly max.
  return out.length <= max ? out : `${out.slice(0, Math.max(0, max - 1))}…`;
}

export function parseMaxConcurrent(value) {
  const maxConcurrent = Number(value);
  return Number.isInteger(maxConcurrent)
    && maxConcurrent >= MIN_MAX_CONCURRENT
    && maxConcurrent <= MAX_MAX_CONCURRENT
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT;
}

// Test-only seam: Vitest shares this module instance across test cases.
export function __resetConcurrency() {
  activeCount = 0;
}

// Builds the publishSummary dep index.js injects (loop #554 B3). Factored here,
// next to the clamp, so the kill switch and the don't-re-send-unchanged rule
// are unit-testable without importing the bridge entrypoint.
//
// SUMMARY_JOURNAL_PUBLISH=0 is the phase-1 kill switch (design §9): it stops
// the WRITE. It is deliberately independent of SUMMARY_CODEX_ENABLED, which
// stops the model CALL. Read per call, not captured, so a restart with a
// changed unit environment is enough to flip it.
//
// The unchanged-value skip matters beyond bandwidth: a resume backfill or a
// pass that produced no new bullet would otherwise re-send an identical
// digest, and once the server records a summary_updated_at (phase 3) that
// would stamp an old digest as fresh — the exact lie the field exists to
// prevent. Returns whether a frame was sent, for tests and callers.
export function makeJournalSummaryPublisher({ upsertConvo, env = process.env } = {}) {
  return function publishJournalSummary(session, summary) {
    if ((env.SUMMARY_JOURNAL_PUBLISH ?? '1') === '0') return false;
    if (!summary || summary === session._journalSummaryHint) return false;
    session._journalSummaryHint = summary;
    upsertConvo(session, { summary });
    return true;
  };
}

// Publish ONLY after the digest is durably on disk (loop #554 F2). persistSession
// is fail-open — a full disk logs and returns rather than throwing — so a publish
// that ran first could leave the journal holding text the session store never
// recorded. The next resume would then restore the OLDER persisted digest and
// back-fill it over the newer published one (index.js B5), silently rolling the
// operator's summary backwards. Persist-then-publish makes disk the dominant
// copy at every instant, so the backfill can only ever re-send the same or newer
// text. `persisted === false` is an explicit failure report; undefined means the
// caller didn't report (a session with no id has nothing to persist, and nothing
// to roll back TO — resume reads '' and skips the backfill).
//
// Publishing itself is a side channel: a throwing publisher must not abort the
// pass and cost the session its title update. Fail LOUD in the log, fail open in
// control flow.
function publishJournalSummary(session, text, publishSummary, warn, persisted) {
  if (persisted === false) {
    warn('[summary] journal publish skipped: summary not persisted', { roomId: session.roomId });
    return;
  }
  try {
    publishSummary(session, summaryForJournal(text));
  } catch (e) {
    warn('[summary] journal publish failed', { error: String(e?.message || e) });
  }
}

export async function updatePinnedSummary(session, {
  codexOneShot,
  formatRoomTitle,
  applyFallbackTitle,
  persistSession,
  updateRoomName,
  // Journal publish seam (loop #554 B2). Called with the CLAMPED digest every
  // time session.pinnedSummaryText is (re)written, so conversations.summary
  // tracks the bridge-local accumulator. Injected rather than called from
  // updateRoomName because (a) updateRoomName also fires for initial and
  // media-file naming, where there is no new summary, and (b) a pass can
  // produce a new bullet while the title repeats. Default no-op keeps every
  // caller that has not wired it — and every existing test — unchanged.
  publishSummary = () => {},
  debug,
  warn,
  serverLabel,
  defaultWorkdir,
  // Activity-inferred repo target (lib/repo-infer.js). Used beneath codex's
  // REPO: override and on every fallback path so the repo segment reflects the
  // repo actually worked on, not the workspace-root cwd. Optional: defaults to
  // "no signal" so callers/tests that don't wire it keep the workdir basename.
  inferRepo = () => null,
  env = process.env,
}) {
  const enabled = (env.SUMMARY_CODEX_ENABLED ?? '1') !== '0';
  if (!enabled) {
    applyFallbackTitle(session, {
      serverLabel,
      updateRoomName,
      workdir: session.workdir,
      defaultWorkdir,
      repo: inferRepo(session),
    });
    debug('[summary] kill-switch', { killSwitch: true });
    return;
  }

  if (!session.chatHistory) session.chatHistory = [];
  debug('[summary] history', { length: session.chatHistory.length });

  if (session.chatHistory.length < 5 || session.chatHistory.length % 5 !== 0) return;

  if (session._summaryInFlight) {
    debug('[summary] in-flight', {});
    return;
  }

  const maxConcurrent = parseMaxConcurrent(env.SUMMARY_CODEX_MAX_CONCURRENT);
  if (activeCount >= maxConcurrent) {
    debug('[summary] at-capacity', { activeCount });
    return;
  }

  session._summaryInFlight = true;
  try {
    activeCount++;
    try {
      let currentSummary = session.pinnedSummaryText || '';
      const bulletCount = (currentSummary.match(/^•/gm) || []).length;

      if (bulletCount > 15 && currentSummary) {
        if ((session._compactionFailures || 0) < 2) {
          const compactPrompt = `Condense this session summary into exactly 3 bullet points (using • prefix) capturing the key accomplishments. Keep it concise and focused on major milestones:\n\n${currentSummary}`;
          const compactResult = await codexOneShot(compactPrompt);
          const compactedSummary = compactResult.text?.trim() || '';
          if (/^•/m.test(compactedSummary)) {
            currentSummary = compactedSummary.slice(0, MAX_COMPACTED_CHARS);
            session.pinnedSummaryText = currentSummary;
            session._compactionFailures = 0;
            let persisted;
            if (session.claudeSessionId) {
              persisted = persistSession(
                session.roomId,
                session.claudeSessionId,
                session.workdir,
                session.originRoomId,
                { chatHistory: session.chatHistory, pinnedSummaryText: currentSummary },
              );
            }
            publishJournalSummary(session, currentSummary, publishSummary, warn, persisted);
          } else {
            session._compactionFailures = (session._compactionFailures || 0) + 1;
            warn('[summary] compaction failed', {
              reason: compactResult.text === null ? compactResult.reason : 'invalid-output',
              exitCode: compactResult.exitCode,
              signal: compactResult.signal,
              durationMs: compactResult.durationMs,
              model: env.SUMMARY_CODEX_MODEL || null,
            });
            if (session._compactionFailures === 2) {
              warn('[summary] compaction skipped', { failures: session._compactionFailures });
            }
          }
        }
      }

      const recentMessages = session.chatHistory.slice(-50).map(m =>
        `${m.role}: ${m.text}`
      ).join('\n\n');

      const prompt = currentSummary
        ? `Based on these recent messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature being worked on, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. REPO: the git repository or project being worked on, inferred from file paths, --workdir flags, PR targets, or repo names in the messages. Write "unknown" if unclear.\n3. A brief 1-sentence summary of what was accomplished\n\nFormat:\nTITLE: <title>\nREPO: <repo or unknown>\nNEW: <1 sentence>\n\nNo quotes. Be specific and concise.\n\nMessages:\n${recentMessages}`
        : `Based on these messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature, e.g. "bridge room name truncation" or "voice note support"\n2. REPO: the git repository or project being worked on, inferred from file paths, --workdir flags, PR targets, or repo names in the messages. Write "unknown" if unclear.\n3. A 1-2 sentence summary (what's been done, current status)\n\nFormat:\nTITLE: <title>\nREPO: <repo or unknown>\nSUMMARY: <summary>\n\nNo quotes. Be specific.\n\nMessages:\n${recentMessages}`;

      const result = await codexOneShot(prompt);
      if (result.text === null) {
        applyFallbackTitle(session, {
          serverLabel,
          updateRoomName,
          workdir: session.workdir,
          defaultWorkdir,
          repo: inferRepo(session),
        });
        warn('[summary] failed', {
          reason: result.reason,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stderrTail: result.stderrTail?.slice(-500) || '',
          model: env.SUMMARY_CODEX_MODEL || null,
        });
        return;
      }

      const titleMatch = result.text.match(/TITLE:\s*(.+)/i);
      const summaryMatch = result.text.match(/SUMMARY:\s*(.+)/i);
      const newMatch = result.text.match(/NEW:\s*(.+)/i);

      if (titleMatch) {
        // Codex's REPO: line wins when present (it can be richer/org-qualified,
        // e.g. "easelyte/goodfellow"); activity inference is the deterministic
        // floor for when codex omits it or emits a sentinel/ambiguous value.
        const repo = extractRepoOverride(result.text) || inferRepo(session);
        const earnedTitle = formatRoomTitle({
          serverLabel,
          workdir: session.workdir,
          text: titleMatch[1].trim(),
          defaultWorkdir,
          repo,
        });
        // Same 2-char short (+ 🐣) as applyFallbackTitle, so the earned LLM title
        // is distinguishable across same-box sessions and consistent with the fallback.
        updateRoomName(session.roomId, withSessionShort(session.claudeSessionId || session.roomId, earnedTitle, titleMarkerFor(session)));
      } else {
        debug('[summary] no title match', {});
      }

      let updatedSummary = '';
      if (newMatch && currentSummary) {
        updatedSummary = capSummaryBullets(`${currentSummary}\n• ${newMatch[1].trim()}`);
      } else if (summaryMatch && !currentSummary) {
        updatedSummary = `• ${summaryMatch[1].trim()}`;
      } else if (currentSummary) {
        updatedSummary = currentSummary;
      }

      if (updatedSummary) {
        session.pinnedSummaryText = updatedSummary;
        let persisted;
        if (session.claudeSessionId) {
          persisted = persistSession(
            session.roomId,
            session.claudeSessionId,
            session.workdir,
            session.originRoomId,
            { chatHistory: session.chatHistory, pinnedSummaryText: updatedSummary },
          );
        }
        publishJournalSummary(session, updatedSummary, publishSummary, warn, persisted);
      }

      if (titleMatch) debug('[summary] ok', { durationMs: result.durationMs });
    } finally {
      activeCount--;
    }
  } finally {
    session._summaryInFlight = false;
  }
}
