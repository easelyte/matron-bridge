function failureBlocks() {
  return [{ type: 'text', text: "⚠️ Couldn't process that burst — resend to retry" }];
}

function defaultQueue(session, blocks) {
  (session.queuedMessages ||= []).push(blocks);
}

export function makeFlusher(deps) {
  const {
    downloadAndMerge,
    sendToSession,
    queue = defaultQueue,
    startTyping = () => {},
    clearTyping = () => {},
    sendUnavailable = async () => {},
    sendFailureNotice = async () => {},
    onFirstMessage = () => {},
    appendHistory = () => {},
    onError = () => {},
  } = deps;

  return async function flushCoalesceBuffer(session, entries) {
    let merged = null;
    try {
      startTyping(session);
      merged = await downloadAndMerge(entries, session);
      if (!merged || merged.length === 0) {
        clearTyping(session);
        return;
      }

      let delivered = true;
      if (session.busy) {
        queue(session, merged);
      } else {
        delivered = sendToSession(session, merged);
        if (!delivered) {
          clearTyping(session);
          await sendUnavailable(session);
        }
      }

      if (delivered && !session.firstMessageCaptured) {
        onFirstMessage(session, entries, merged);
      }
      if (delivered) {
        // Persist ONLY genuine user-authored text (m.text/m.notice bodies) to
        // chatHistory — matching the pre-coalescing behavior where the direct
        // text path persisted user text but the media path persisted nothing.
        // Deriving from `merged` would leak media-derived text blocks (e.g.
        // "Contents of file.csv:\n<full body>", captions, transcriptions) into
        // ~/.claude-matrix-sessions.json (Phase-2 review Blocker 2).
        const userText = entries
          .filter((e) => e?.meta && (e.meta.msgtype === 'm.text' || e.meta.msgtype === 'm.notice'))
          .map((e) => e?.event?.content?.body || '')
          .filter((t) => t)
          .join('\n\n');
        if (userText) {
          appendHistory(session, userText);
        }
      }
    } catch (err) {
      onError(err);
      clearTyping(session);
      queue(session, merged && merged.length > 0 ? merged : failureBlocks());
      try {
        await sendFailureNotice(session);
      } catch {
        // The queued fail-visible block is the durable fallback; a notice send
        // failure must not rethrow from the timer-driven flush path.
      }
    }
  };
}
