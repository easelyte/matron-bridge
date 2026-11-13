function deliveryError(error, fallback) {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error) return new Error(error);
  return new Error(fallback);
}

function startDelivery(session) {
  const token = Symbol('prompt-answer-delivery');
  session._pendingPromptAnswerDelivery = token;
  return token;
}

function finishDelivery(session, token, callback, value) {
  try {
    callback?.(value);
  } finally {
    if (session._pendingPromptAnswerDelivery === token) {
      session._pendingPromptAnswerDelivery = null;
    }
  }
}

// A prompt answer sent through Claude's stream-json stdin is not dispatched
// merely because write() did not throw synchronously. Keep provider handoffs
// blocked until the Writable callback confirms the chunk, then record it.
export function writePromptAnswer(session, payload, { onDelivered, onError } = {}) {
  const stream = session?.proc?.stdin;
  if (!stream || typeof stream.write !== 'function') {
    onError?.(new Error('Claude stdin is unavailable.'));
    return false;
  }

  const token = startDelivery(session);
  let settled = false;
  let synchronousFailure = false;
  let writing = true;

  const settle = (error) => {
    if (settled) return;
    settled = true;
    if (error) {
      if (writing) synchronousFailure = true;
      finishDelivery(
        session,
        token,
        onError,
        deliveryError(error, 'Claude rejected the prompt answer.'),
      );
      return;
    }
    finishDelivery(session, token, onDelivered);
  };

  try {
    // A false return means backpressure, not rejection; the callback remains
    // the success/failure signal for this accepted chunk.
    stream.write(payload, settle);
  } catch (error) {
    settle(error);
    writing = false;
    return false;
  }
  writing = false;
  return !synchronousFailure;
}

// Free-text options in Claude's TUI need a short menu-to-input transition.
// Hold the handoff gate across that delay and record the answer only after
// sendText accepts it, with no event-loop gap between those two operations.
export function sendDelayedPromptAnswer(
  session,
  { response, text, delayMs = 250, onDelivered, onError } = {},
) {
  const iv = session?.iv;
  if (!iv || !iv.alive || typeof iv.respondToPrompt !== 'function' || typeof iv.sendText !== 'function') {
    onError?.(new Error('Claude interactive input is unavailable.'));
    return false;
  }

  const token = startDelivery(session);
  let accepted;
  try {
    accepted = iv.respondToPrompt(response) === true;
  } catch (error) {
    finishDelivery(session, token, onError, deliveryError(error, 'Claude rejected the prompt selection.'));
    return false;
  }

  if (!accepted) {
    finishDelivery(session, token, onError, new Error('Claude rejected the prompt selection.'));
    return false;
  }

  setTimeout(() => {
    try {
      if (session.iv !== iv || !iv.alive || iv.sendText(text) !== true) {
        finishDelivery(session, token, onError, new Error('Claude rejected the prompt answer.'));
        return;
      }
      finishDelivery(session, token, onDelivered);
    } catch (error) {
      finishDelivery(session, token, onError, deliveryError(error, 'Claude rejected the prompt answer.'));
    }
  }, delayMs);

  return true;
}
