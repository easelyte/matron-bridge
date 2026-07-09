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
        const textSegments = merged
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text);
        if (textSegments.length > 0) {
          appendHistory(session, textSegments.join('\n\n'));
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
