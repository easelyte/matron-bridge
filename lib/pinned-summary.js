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

export async function updatePinnedSummary(session, {
  codexOneShot,
  formatRoomTitle,
  applyFallbackTitle,
  persistSession,
  updateRoomName,
  debug,
  warn,
  serverLabel,
  defaultWorkdir,
  env = process.env,
}) {
  const enabled = (env.SUMMARY_CODEX_ENABLED ?? '1') !== '0';
  if (!enabled) {
    applyFallbackTitle(session, {
      serverLabel,
      updateRoomName,
      workdir: session.workdir,
      defaultWorkdir,
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
            if (session.claudeSessionId) {
              persistSession(
                session.roomId,
                session.claudeSessionId,
                session.workdir,
                session.originRoomId,
                { chatHistory: session.chatHistory, pinnedSummaryText: currentSummary },
              );
            }
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
        ? `Based on these recent messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature being worked on, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what was accomplished\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\n\nNo quotes. Be specific and concise.\n\nMessages:\n${recentMessages}`
        : `Based on these messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\n\nNo quotes. Be specific.\n\nMessages:\n${recentMessages}`;

      const result = await codexOneShot(prompt);
      if (result.text === null) {
        applyFallbackTitle(session, {
          serverLabel,
          updateRoomName,
          workdir: session.workdir,
          defaultWorkdir,
        });
        warn('[summary] failed', {
          reason: result.reason,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          model: env.SUMMARY_CODEX_MODEL || null,
        });
        return;
      }

      const titleMatch = result.text.match(/TITLE:\s*(.+)/i);
      const summaryMatch = result.text.match(/SUMMARY:\s*(.+)/i);
      const newMatch = result.text.match(/NEW:\s*(.+)/i);

      if (titleMatch) {
        updateRoomName(session.roomId, formatRoomTitle({
          serverLabel,
          workdir: session.workdir,
          text: titleMatch[1].trim(),
          defaultWorkdir,
        }));
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
        if (session.claudeSessionId) {
          persistSession(
            session.roomId,
            session.claudeSessionId,
            session.workdir,
            session.originRoomId,
            { chatHistory: session.chatHistory, pinnedSummaryText: updatedSummary },
          );
        }
      }

      if (titleMatch) debug('[summary] ok', { durationMs: result.durationMs });
    } finally {
      activeCount--;
    }
  } finally {
    session._summaryInFlight = false;
  }
}
