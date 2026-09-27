// Bridge-local journal READ proxy.
//
// Sessions need the journal's search / read routes, but authenticating them
// with the bridge's own journal agent token means every session, and every
// subagent or tool it starts, inherits a credential that reads every
// conversation the user has (/snapshot, /roster, /items, ...). This proxy lets
// the bridge keep that token out of child envs: children call the routes over
// the loopback API (127.0.0.1:MATRON_BRIDGE_API_PORT) and the bridge injects
// its bearer server-side.
//
// Least privilege is the point, so the proxy is a strict ALLOWLIST of the two
// read routes a session needs:
//   GET /journal/search              -> journal GET /search
//   GET /journal/convo/:id/messages  -> journal GET /convo/:id/messages
// Never /snapshot, /roster, /items or any write route, even though the bridge
// token could reach them (tracker writes go through the item_* / mission_* MCP
// tools). The journal's /help is not proxied either: its digest describes the
// raw token-authenticated API, which is wrong for a proxy caller; the two
// routes are documented in BRIDGE_CLAUDE.md / BRIDGE_CODEX.md instead. GET
// only. Query strings pass through verbatim; the journal validates and clamps
// q / limit / convo_id / around_seq itself, and its rate limiter still applies.
//
// The loopback port is reachable by every local user, so the proxy also
// requires a per-boot capability token (see index.js). The capability only
// unlocks the two routes above.

import { timingSafeEqual } from 'node:crypto';

// Encode a convo id for the target path. The incoming segment is already
// URL-encoded, so decode-then-encode normalizes it and a smuggled `/` or `?`
// stays inside the segment. `.` / `..` would survive encodeURIComponent and be
// resolved as dot segments by fetch's URL parser, widening the target path, so
// they are refused. decodeURIComponent throws on a malformed escape; the
// caller maps any throw to 400.
function encodeConvoId(raw) {
  const id = decodeURIComponent(raw);
  if (id === '.' || id === '..') throw new Error('dot segment');
  return encodeURIComponent(id);
}

const ALLOWED = [
  { re: /^\/journal\/search$/, target: () => '/search' },
  { re: /^\/journal\/convo\/([^/]+)\/messages$/, target: (m) => `/convo/${encodeConvoId(m[1])}/messages` },
];

// True for any path this proxy owns, so the caller can answer a non-GET on a
// proxy path with 405 instead of falling through to an unrelated 404.
export function isJournalProxyPath(pathname) {
  return ALLOWED.some((r) => r.re.test(pathname));
}

// Constant-time compare so a caller can't time-probe the capability token.
// Lengths are compared on the byte buffers, not the strings: Node decodes
// header values as latin1, so a non-ASCII character is one UTF-16 unit but two
// UTF-8 bytes, and timingSafeEqual throws on buffers of different lengths.
// Length mismatch short-circuits (the length isn't secret).
function tokenMatches(expected, got) {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (status, error) => ({ status, contentType: 'application/json', body: JSON.stringify({ error }) });

export function createJournalReadProxy({ baseUrl, token, capabilityToken = '', fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const enabled = !!(baseUrl && token);

  // Returns { status, contentType, body } for a proxy route, or null when the
  // path is not one (the caller continues its own dispatch). `callerToken` is
  // the capability the caller presented.
  async function handle({ method, pathname, search = '', callerToken } = {}) {
    if (!isJournalProxyPath(pathname)) return null;
    if (method !== 'GET') return json(405, 'method not allowed');
    if (!enabled) return json(503, 'journal proxy disabled: no journal configured');
    // Fail closed: no configured capability, or a mismatch, is a refusal.
    if (!capabilityToken || !tokenMatches(capabilityToken, callerToken)) return json(401, 'unauthorized');
    const route = ALLOWED.find((r) => r.re.test(pathname));
    // This runs inside the API server's async request listener, which has no
    // outer catch: an unguarded throw would be an unhandled rejection that
    // takes the bridge down. A bad id is a client error.
    let targetPath;
    try {
      targetPath = route.target(pathname.match(route.re));
    } catch {
      return json(400, 'malformed path');
    }
    const url = `${baseUrl}${targetPath}${search || ''}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        // The bridge's bearer is added here and never reaches the child.
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const body = await res.text();
      const contentType = res.headers?.get?.('content-type') || 'application/json';
      return { status: res.status, contentType, body };
    } catch {
      return json(502, 'journal unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return { handle, isJournalProxyPath, enabled };
}
