// Bridge-local journal READ proxy (loop #765, decision #283 Option A).
//
// Spawned sessions (and their subagents) need the journal's search/read routes,
// but today the shipped prompt tells them to authenticate with the raw
// JOURNAL_TOKEN — a FULL-journal read credential that can pull every transcript
// (/snapshot, /roster, /items, ...). That token is inherited into every child
// env, so any bounded code subagent can read the whole journal. This proxy lets
// the bridge STRIP the token from child envs: children call these routes over
// the 127.0.0.1 loopback API (MATRON_BRIDGE_API_PORT) with NO token, and the
// bridge injects its own bearer server-side.
//
// Least privilege is the whole point, so the proxy is a strict ALLOWLIST — only
// the three READ routes a session legitimately needs are forwarded:
//   GET /journal/search              -> journal GET /search
//   GET /journal/convo/:id/messages  -> journal GET /convo/:id/messages
//   GET /journal/help                -> journal GET /help
// Never /snapshot, /roster, or any write route, even though the bridge token
// could reach them. Writes keep going through the existing tokenless item_*
// loopback routes. GET only. Query strings pass through verbatim — the journal
// validates and clamps q/limit/convo_id/around_seq itself. Per-child scoping and
// rate-limiting are intentionally omitted in v1: the proxy is loopback-only (the
// same trust boundary as the existing /items loopback routes) and every
// forwarded request still hits the journal's own rate limiter under the bridge
// token.

import { timingSafeEqual } from 'node:crypto';

const ALLOWED = [
  { re: /^\/journal\/search$/, target: () => '/search' },
  {
    re: /^\/journal\/convo\/([^/]+)\/messages$/,
    // Re-encode the id exactly once: the incoming path segment is already
    // URL-encoded, so decode-then-encode normalizes it and blocks a segment
    // that smuggled a `/` or `?` from widening the target path.
    target: (m) => `/convo/${encodeURIComponent(decodeURIComponent(m[1]))}/messages`,
  },
  // NB: the journal's own /help is deliberately NOT proxied — its digest
  // describes the RAW token-authenticated API (Bearer, JOURNAL_TOKEN_FILE,
  // unproxied routes), which is wrong for a tokenless proxy caller. The two
  // routes above are documented directly in BRIDGE_CLAUDE.md instead.
];

// True for any path this proxy owns (so the caller can 405 a non-GET method on a
// real proxy path rather than falling through to an unrelated 404).
export function isJournalProxyPath(pathname) {
  return ALLOWED.some((r) => r.re.test(pathname));
}

// Constant-time string compare so a caller can't time-probe the capability
// token byte by byte. Lengths are compared on the byte buffers, not the
// strings: Node decodes header values as latin1, so a non-ASCII character is
// one UTF-16 unit but two UTF-8 bytes, and timingSafeEqual throws on buffers
// of different lengths. Length mismatch short-circuits (lengths aren't secret).
function _tokenMatches(expected, got) {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createJournalReadProxy({ baseUrl, token, capabilityToken = '', fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const enabled = !!(baseUrl && token);

  // Returns { status, contentType, body } for an allowed route, or null when the
  // path is not a journal-proxy route (caller continues its own dispatch).
  // `callerToken` is the capability token the caller presented (from a request
  // header); it gates use of the proxy so a DIFFERENT local user hitting the
  // loopback port cannot search the journal with no credential (the proxy injects
  // the bridge bearer server-side). Bridge-spawned children get the capability
  // token in their env (readable only by the bridge's own uid).
  async function handle({ method, pathname, search = '', callerToken } = {}) {
    if (!isJournalProxyPath(pathname)) return null;
    if (method !== 'GET') {
      return { status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'method not allowed' }) };
    }
    if (!enabled) {
      return { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'journal proxy disabled — no journal configured' }) };
    }
    // Fail CLOSED: if no capability token is configured, or the caller's does not
    // match, refuse. A misconfigured proxy must not fall open to unauthenticated
    // journal reads.
    if (!capabilityToken || !_tokenMatches(capabilityToken, callerToken)) {
      return { status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) };
    }
    const route = ALLOWED.find((r) => r.re.test(pathname));
    // Guard target construction: the :id segment is passed through
    // decodeURIComponent, which THROWS URIError on a malformed percent-escape
    // (e.g. `%ZZ`). This runs in an async HTTP request listener with no outer
    // catch, so an unguarded throw becomes an unhandled rejection that crashes
    // the whole bridge (Node ≥15). A bad id is a client error, not a 500/crash.
    let targetPath;
    try {
      targetPath = route.target(pathname.match(route.re));
    } catch {
      return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'malformed path' }) };
    }
    const url = `${baseUrl}${targetPath}${search || ''}`;

    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        // The bridge's own bearer is injected here and NEVER reaches the child.
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const body = await res.text();
      const contentType = res.headers?.get?.('content-type') || 'application/json';
      return { status: res.status, contentType, body };
    } catch {
      return { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'journal unreachable' }) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { handle, isJournalProxyPath, enabled };
}
