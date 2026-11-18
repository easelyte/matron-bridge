// POST/GET/DELETE /restart: ask the bridge to restart itself at the next
// quiet moment, without a code update. The code-update watcher
// (lib/code-update-restart.js) owns the policy; this is the HTTP face of its
// `request()` / `cancelRequest()`. Operator token only (lib/api-auth.js).
//
//   GET     dry run: who holds a bridge restart right now, and why
//   POST    ask for one; the body may carry { reason } and { force: true }
//           to skip the restart gate for this request (the way past a gate
//           that is stuck or gone; sessions with work still hold it)
//   DELETE  withdraw the request
//
// Pure: the watcher and the live state come in as arguments.

// holds() -> { holders: [{ session, reason }], unreadable }
// gateHold() -> Promise<string|null>: the reason a restart gate would give
//   for holding right now, or null. Optional; see index.js.
export async function bridgeRestartResponse({ method, body = null, watcher, holds, gateHold = async () => null, by = 'operator' }) {
  if (!watcher) {
    return { status: 409, body: { error: 'bridge restart is not available: the code-update watcher is not running (MATRON_CODE_UPDATE_RESTART is off, or this checkout has no git history)' } };
  }
  if (method === 'DELETE') {
    return { status: 200, body: { cancelled: watcher.cancelRequest() } };
  }
  const state = async () => {
    const { holders, unreadable } = holds();
    return {
      requested: watcher.requested,
      holders: holders.map(h => ({ roomId: h.session.roomId, reason: h.reason })),
      unreadable,
      gate: (await gateHold()) || null,
    };
  };
  if (method === 'GET') return { status: 200, body: await state() };
  if (method === 'POST') {
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'requested through the API';
    const r = watcher.request({ reason, by, force: body?.force === true });
    if (!r.ok) return { status: 409, body: { error: r.error } };
    return { status: 202, body: await state() };
  }
  return { status: 405, body: { error: 'Method not allowed' } };
}
