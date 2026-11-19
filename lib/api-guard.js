// Guards for the bridge's local HTTP API and its process: a call that fails
// is answered with its real error, and neither a failing call nor a stray
// rejected promise ends the bridge.

const logError = (msg) => console.error(msg);

// Answer a call whose handler threw: 500 with the error's message. When the
// response has already started, a second writeHead would itself throw, so the
// half-written answer is cut off instead (the caller sees a failed request
// rather than waiting on one that never finishes).
export function respondApiError(res, error, { log = logError } = {}) {
  try { log(`[api] request failed: ${error?.stack || error?.message || error}`); } catch { /* logging must never throw */ }
  try {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'internal error' }));
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } catch { /* the connection has gone; nothing left to tell it */ }
}

// Wrap an async request listener so a throw becomes that request's own 500
// instead of an unhandled rejection.
export function guardApiListener(res, listener, opts) {
  return async (...args) => {
    try { await listener(...args); }
    catch (e) { respondApiError(res, e, opts); }
  };
}

// Node ends the process on a promise rejection nobody handled. For a service
// that holds every session on the machine, one forgotten catch must not do
// that: log it loudly and keep running. Uncaught exceptions stay fatal.
export function installUnhandledRejectionLogger(proc, { log = logError } = {}) {
  proc.on('unhandledRejection', (reason) => {
    try { log(`[unhandled-rejection] ${reason?.stack || reason?.message || reason}`); } catch { /* logging must never throw */ }
  });
}
