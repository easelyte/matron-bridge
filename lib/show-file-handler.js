// Core request logic for the bridge's POST /show-file endpoint, extracted from
// index.js so it can be driven directly in tests without standing up the whole
// bridge (journal WS, spawns, port binds). index.js keeps only the thin
// req/res plumbing (method + body-size gating) and translates the returned
// { status, headers, body } into an HTTP response.
//
// State that the endpoint mutates is injected, not module-global:
//   - `sessions`  the live session Map (token -> session lookup + per-session
//                 in-flight counter on `session._showFileInFlight`).
//   - `budget`    a mutable { inFlight, reservedBytes } object reserved before
//                 the upload and always released in the finally.
// This keeps the concurrency/budget accounting observable from a test.

// F3: the whole open/read/upload must be time-bounded, not just the upload.
// validateAndOpen() does the open+stat+read, which can hang indefinitely on a
// stalled NFS/FUSE mount (O_NONBLOCK does not make regular-file I/O nonblocking).
// A hang there would hold this request's budget reservation forever and eventually
// return 429 to every session. Racing the whole operation against an overall
// deadline guarantees the awaited promise settles, so the finally always runs and
// releases the budget. (The underlying fd may still occupy a libuv thread until the
// OS returns; a complete fix needs a killable worker, but freeing the budget is the
// availability bug this closes.)
function withOperationTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`show-file operation timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function processShowFile({ body, sessions, budget, limits, deps }) {
  const {
    validateShowFileBody,
    auditShowFile,
    shareAgentMedia,
    validateAndOpen,
    FileLinkDenied,
    uploadMedia,
    journalPublish,
    denialToStatus,
  } = deps;

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    auditShowFile({ result: 'invalid-json', error });
    return { status: 400, body: { error: 'invalid JSON' } };
  }

  const validationError = validateShowFileBody(data);
  const filePath = typeof data?.path === 'string' ? data.path : undefined;
  if (validationError) {
    auditShowFile({ result: validationError.reason, filePath });
    // Carry the machine reason alongside the human message so the MCP adapter can
    // surface a specific, actionable error (e.g. missing-token on a session whose
    // root pin failed) instead of collapsing every validation failure to "internal
    // error".
    return { status: 400, body: { error: validationError.error, reason: validationError.reason } };
  }

  const { caption, token } = data;

  let session;
  for (const candidate of sessions.values()) {
    if (candidate.showFileToken && candidate.showFileToken === token) {
      session = candidate;
      break;
    }
  }
  if (!session) {
    auditShowFile({ result: 'invalid-token', filePath });
    return { status: 403, body: { error: 'invalid token', reason: 'invalid-token' } };
  }

  if ((session._showFileInFlight || 0) >= limits.maxInFlightPerSession
      || budget.inFlight >= limits.maxInFlight
      || budget.reservedBytes + limits.maxBytes > limits.globalByteBudget) {
    auditShowFile({ result: 'saturated', roomId: session.roomId, filePath });
    return { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'saturated' } };
  }

  // Reserve immediately before the try so the finally always releases exactly
  // what was reserved — no budgetHeld guard needed, unlike the pre-extraction
  // inline handler where reservation and the try/finally spanned parse errors.
  session._showFileInFlight = (session._showFileInFlight || 0) + 1;
  budget.inFlight += 1;
  budget.reservedBytes += limits.maxBytes;
  try {
    // Overall deadline covers open+read (validateAndOpen) AND the upload, which
    // has its own inner uploadTimeoutMs; give the read a bounded allowance beyond it.
    const operationTimeoutMs = Math.max(limits.uploadTimeoutMs * 2, limits.uploadTimeoutMs + 5000);
    const result = await withOperationTimeout(shareAgentMedia({
      filePath,
      caption,
      pinnedRoots: session.showFilePinnedRoots,
      maxBytes: limits.maxBytes,
      uploadTimeoutMs: limits.uploadTimeoutMs,
      deps: {
        validateAndOpen,
        FileLinkDenied,
        uploadMedia,
        publish: (method, payload) => journalPublish(session, method, payload),
      },
    }), operationTimeoutMs);

    if (result.ok) {
      auditShowFile({
        result: 'ok',
        roomId: session.roomId,
        realPath: result.realPath,
        kind: result.kind,
        size: result.size,
        media_id: result.media_id,
        sha256: result.sha256,
      });
      return { status: 200, body: { ok: true, media_id: result.media_id, kind: result.kind } };
    }

    auditShowFile({ result: result.denied, roomId: session.roomId, filePath });
    return { status: denialToStatus(result.denied), body: { error: result.denied } };
  } catch (error) {
    auditShowFile({ result: 'internal-error', roomId: session.roomId, filePath, error });
    return { status: 502, body: { error: 'internal error' } };
  } finally {
    session._showFileInFlight -= 1;
    budget.inFlight -= 1;
    budget.reservedBytes -= limits.maxBytes;
  }
}
