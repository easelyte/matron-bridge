// Title and summary orchestration: the per-turn LLM pass that names a
// conversation (once), publishes its roster summary and TOC entry, and keeps
// the cumulative pinned summary, plus the turn-end gate that schedules it.
//
// Moved out of index.js as-is. The pure pieces live in lib/summary-pass.js and
// lib/journal-title-seed.js; session ownership, persistence and the journal
// publisher stay in index.js and are injected here.

import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, splitSpoken, spokenPayload, spokenRefFor } from './summary-pass.js';
import { parseTitlePassResponse, withSessionShort, titleMarkerFor, hintIsEarnedTitle } from './journal-title-seed.js';

export function createTitleSummary({
  SERVER_LABEL,
  applyFallbackTitle,
  summaryModel,
  summaryModelNag,
  updateRoomName,
  getPersistedSession,
  persistSession,
  journalConvoIdFor,
  journalUpsertConvo,
  journalPublish,
  debug,
}) {
  // Generate the title once: has this conversation's LLM title
  // already been earned? The live flag, then the persisted record's — either
  // one, true or false, is the answer (a /resume writes false when it gives
  // the conversation a non-LLM title) — then, for a record from before the
  // flag, hintIsEarnedTitle's reading of the current title. The derived answer
  // is kept on the session, which persistSession writes into the record: a yes
  // at once, a no with the next persist (only an applied LLM title turns it).
  function llmTitleEarned(session) {
    if (typeof session._llmTitleEarned === 'boolean') return session._llmTitleEarned;
    const persisted = getPersistedSession(session.roomId)?.llmTitleEarned;
    if (typeof persisted === 'boolean') {
      session._llmTitleEarned = persisted;
      return persisted;
    }
    if (!hintIsEarnedTitle(session, { serverLabel: SERVER_LABEL, workdir: session.workdir })) {
      session._llmTitleEarned = false;
      return false;
    }
    markLlmTitleEarned(session);
    return true;
  }

  // The first LLM title has been applied: never ask for one again, across
  // restarts too.
  function markLlmTitleEarned(session) {
    session._llmTitleEarned = true;
    persistSession(session.roomId, session.claudeSessionId, session.workdir,
      session.originRoomId, { llmTitleEarned: true });
  }

  async function maybeUpdatePinnedSummary(session) {
    // Name the convo from the first user message — the same summary
    // `claude --resume` and /sessions display — instead of leaving the
    // workdir seed. One-shot, and guarded to only ever replace the seed.
    // With Gemini configured this covers the gap before the LLM rename's
    // 5-message threshold (short chats never get there); without Gemini
    // it is the only naming that runs.
    applyFallbackTitle(session, { serverLabel: SERVER_LABEL, updateRoomName, workdir: session.workdir });
    if (!summaryModel) {
      // Nothing else in the bridge notices that summarization is off. Say so
      // once, in the tracker, now that a conversation exists to file against.
      summaryModelNag.maybeFile(journalConvoIdFor(session));
      return;
    }

    if (!session.chatHistory) session.chatHistory = [];
    debug(`maybeUpdatePinnedSummary: chatHistory.length=${session.chatHistory.length}`);

    // NOTE: the every-5-messages modulo gate is GONE — the caller
    // (maybeSummarizeAtTurnEnd) gates on >=SUMMARY_MIN_NEW new messages.

    try {
      // Use in-memory summary as source of truth
      let currentSummary = session.pinnedSummaryText || '';
      const bulletCount = (currentSummary.match(/^•/gm) || []).length;

      // Check if we need to compact (>15 bullets)
      if (bulletCount > 15 && currentSummary) {
        const compactPrompt = `Condense this session summary into exactly 3 bullet points (using • prefix) capturing the key accomplishments. Keep it concise and focused on major milestones:\n\n${currentSummary}`;
        currentSummary = (await summaryModel.generate(compactPrompt)).trim();
        // Persist compacted result immediately so it isn't lost if the next LLM call fails to match
        session.pinnedSummaryText = currentSummary;
      }

      // Incremental window: only messages since the last SUCCESSFUL pass
      // (cursor advances below on success only), capped at 200, plus the
      // prior ROSTER paragraph as a fenced context preamble.
      const { messages, nextCount } = summaryWindow(session.chatHistory, session.lastSummaryMsgCount);
      if (!messages.length) return;
      // Which reply the spoken lines will belong to. Read here, in the same
      // step as the window and BEFORE the model call below: that call takes
      // seconds, and a reply flushed by the next turn meanwhile must not lend
      // its ref to this window's lines.
      const replyRef = spokenRefFor(messages, session._lastReplyRef);
      // Once the title is earned the pass stops asking for one; roster,
      // summary and spoken lines still update every turn.
      const wantTitle = !llmTitleEarned(session);
      const prompt = buildSummaryPrompt({
        messages,
        priorRoster: session.lastRosterText || null,
        hasCumulative: Boolean(currentSummary),
        wantTitle,
        structured: true,
      });

      // The model travels with the text: another session's pass may finish
      // in between, so nothing shared is read after this await.
      const { text, model: writtenBy } = await summaryModel.generateWithModel(prompt);
      // The spoken lines come out first; the title/summary parser gets the rest
      // (see splitSpoken for why it must not see spoken prose).
      const voiced = splitSpoken(text);
      const parsed = parseTitlePassResponse(voiced.rest);

      // Update room name (Element sidebar truncates visually, full name visible on hover)
      // A TITLE the model wrote anyway after the title was earned is ignored.
      if (wantTitle && parsed.title) {
        // A spawned session's rename keeps its 🐣 — the marker is identity,
        // not part of the disposable title text.
        const name = withSessionShort(session.claudeSessionId || session.roomId, parsed.title.slice(0, 60), titleMarkerFor(session));
        updateRoomName(session.roomId, name);
        markLlmTitleEarned(session);
      }

      // Publish the roster summary to the journal so other agents' rosters show
      // what this session is doing. Don't-clobber analysis: the journal's
      // COALESCE keeps the existing summary whenever the field is omitted, and
      // journalUpsertConvo only carries `summary` when this pass actually
      // produced one. The seed path (lib/journal-title-seed.js), the state-only
      // path (journalSessionState), and the hint-replay upserts in
      // journalPublish never carry `summary` — the publisher's omit-don't-null
      // handling makes that automatic. No fallback summary when the summary
      // model is off: the roster shows '', which is honest.
      if (parsed.roster) {
        journalUpsertConvo(session, { summary: parsed.roster.slice(0, 1000) });
      }

      // TOC event: one per successful pass, anchored by its own journal seq.
      // It also carries the spoken version of the agent's last reply for voice
      // mode — {spoken, spoken_more?, spoken_ref}, all or none (spokenPayload).
      // Old apps ignore the extra keys; the journal passes the payload through.
      const toc = (parsed.added || parsed.summary || '').trim();
      if (toc) {
        journalPublish(session, 'publishSummary', {
          toc: toc.slice(0, 300),
          detail: (parsed.roster || '').slice(0, 1000),
          model: writtenBy,
          ...spokenPayload(voiced, replyRef),
        });
      }

      // Cursor + roster memory advance ONLY on a successful, parseable pass —
      // a failing provider replays the same window next turn (capped at 200).
      if (toc || parsed.roster) {
        session.lastSummaryMsgCount = nextCount;
        if (parsed.roster) session.lastRosterText = parsed.roster;
      }

      // Build cumulative summary for pinned message
      let updatedSummary = '';
      if (parsed.added && currentSummary) {
        updatedSummary = `${currentSummary}\n• ${parsed.added}`;
      } else if (parsed.summary && !currentSummary) {
        // Only use SUMMARY: for the initial summary, not after compaction
        updatedSummary = `• ${parsed.summary}`;
      } else if (currentSummary) {
        // LLM didn't produce a match — keep the existing summary (e.g. after compaction)
        updatedSummary = currentSummary;
      }

      if (updatedSummary) {
        // Store accumulated summary in session (source of truth). Only the
        // summary text itself has ongoing meaning, so that's all that gets
        // persisted.
        session.pinnedSummaryText = updatedSummary;
        if (session.claudeSessionId) {
          persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, {
            chatHistory: session.chatHistory,
            pinnedSummaryText: updatedSummary,
            lastSummaryMsgCount: session.lastSummaryMsgCount ?? 0,
            lastRosterText: session.lastRosterText || '',
          });
        }
      } else if (session.claudeSessionId && (toc || parsed.roster)) {
        // No cumulative summary change (e.g. a roster-only pass), but the
        // cursor still advanced — persist it so a restart doesn't replay the
        // same window.
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, {
          chatHistory: session.chatHistory,
          lastSummaryMsgCount: session.lastSummaryMsgCount ?? 0,
          lastRosterText: session.lastRosterText || '',
        });
      }
    } catch (e) {
      // warn, not debug: these failures were invisible in production (DEBUG is
      // off), which made a chat that silently never got its title/summary
      // undiagnosable after the fact.
      console.warn(`[summary] title/summary pass failed for ${session.roomId}: ${e.message}`);
    }
  }

  // Turn-end gate for the summary pass. Fire-and-forget with an explicit catch
  // (an un-awaited rejection would be fatal under Node 22 defaults) and a
  // re-entrancy latch — turn-ends can arrive while a prior LLM call is pending.
  // A trigger swallowed by the latch is coalesced into one rerun when the
  // in-flight pass settles; otherwise messages recorded during a slow LLM call
  // would wait for the NEXT turn-end, and a conversation that goes quiet right
  // after would keep a stale summary indefinitely. Bounded: at most one rerun
  // per dropped trigger, and the min-new gate re-checks before the rerun fires.
  function maybeSummarizeAtTurnEnd(session) {
    const count = session.chatHistory?.length || 0;
    if (count - (session.lastSummaryMsgCount || 0) < SUMMARY_MIN_NEW) return;
    if (session._summaryInFlight) {
      session._summaryRerunQueued = true;
      return;
    }
    session._summaryInFlight = true;
    maybeUpdatePinnedSummary(session)
      .catch((e) => console.warn(`[summary] turn-end pass failed for ${session.roomId}: ${e.message}`))
      .finally(() => {
        session._summaryInFlight = false;
        if (session._summaryRerunQueued) {
          session._summaryRerunQueued = false;
          maybeSummarizeAtTurnEnd(session);
        }
      });
  }

  return { llmTitleEarned, markLlmTitleEarned, maybeUpdatePinnedSummary, maybeSummarizeAtTurnEnd };
}
