import path from 'node:path';
import { validateAndOpen, pinAllowedRootIdentities, FileLinkDenied, MAX_PAGE_BYTES, isPageFile } from './file-link-guard.js';
import { generatePageUrl } from './viewer-tokens.js';

// Bridge side of the share_html_page MCP tool: turns one HTML file in the
// session's workdir into a signed viewer /page link that renders it as a
// sandboxed web page. The viewer re-runs every guard on each open; running
// them here as well is what lets the agent get a clear refusal now instead
// of a link that 404s when the user clicks it.

export const PAGE_LINK_DEFAULT_DAYS = 7;
export const PAGE_LINK_MAX_DAYS = 30;

const DENIAL_ERRORS = {
  'not-html': 'Refused: only .html or .htm files can be shared as a page.',
  sensitive: 'Refused: that file looks sensitive (keys/credentials/env). Use share_sensitive_data instead.',
  'outside-workdir': 'Refused: path is outside the session workdir.',
  'outside-scope': 'Refused: path is outside the session workdir.',
  'path-race': 'Refused: the file changed while it was being checked.',
  'too-large': `Refused: the page is larger than ${MAX_PAGE_BYTES / (1024 * 1024)} MB.`,
  symlink: 'Refused: the path is a symlink; share the real file.',
  'not-a-file': 'Refused: not a regular file.',
  unreadable: 'File not found or unreadable.',
  'bad-workdir': 'Refused: the session workdir could not be resolved.',
};

export function pageLinkTtlSeconds(ttlDays) {
  const days = Number.isFinite(ttlDays) && ttlDays > 0
    ? Math.min(ttlDays, PAGE_LINK_MAX_DAYS)
    : PAGE_LINK_DEFAULT_DAYS;
  return Math.round(days * 86400);
}

// `shorten` (optional) turns the long signed URL into a short /l/<code> one
// (lib/short-links.js shortenViewerUrl); without it the long URL goes out.
export function createPageLinkHandler({ sessions, secret, baseUrl, shorten = null }) {
  return async function handlePageLink(data) {
    const { roomId, path: reqPath, ttl_days: ttlDays } = data || {};
    if (!roomId || typeof roomId !== 'string' || !reqPath || typeof reqPath !== 'string') {
      return { status: 400, body: { error: 'roomId and path are required' } };
    }
    if (!secret || !baseUrl) {
      return { status: 500, body: { error: 'Viewer not configured (missing HMAC_SECRET or VIEWER_BASE_URL)' } };
    }
    const session = sessions.get(roomId);
    if (!session) return { status: 404, body: { error: `no active session for chat ${roomId}` } };
    // Fail closed, as send_attachment does: without a workdir there is no
    // containment boundary to sign into the token.
    if (!session.workdir) {
      return { status: 400, body: { error: 'session has no working directory — cannot share pages' } };
    }
    const workdir = path.resolve(session.workdir);
    const absTarget = path.isAbsolute(reqPath) ? path.resolve(reqPath) : path.resolve(workdir, reqPath);

    let realPath;
    let roots;
    try {
      if (!isPageFile(absTarget)) throw new FileLinkDenied('not-html');
      // Use the root pinned at session creation, before the agent process
      // ran. Re-resolving session.workdir here would trust a pathname the agent
      // may have renamed and replaced by a symlink; a session with no pin
      // gets no link. The same identity is signed into the link, and
      // validateAndOpen re-stats it. pageLinkPinnedRoots is pinned for every
      // session (lib/session-roots.js); showFilePinnedRoots exists only with
      // the opt-in `share` extra, so it is only a fallback for sessions made
      // before pageLinkPinnedRoots existed.
      const pinned = session.pageLinkPinnedRoots?.roots?.[0]
        ?? session.showFilePinnedRoots?.roots?.[0];
      if (!pinned) throw new FileLinkDenied('bad-workdir');
      roots = [{ realPath: pinned.realPath, dev: pinned.dev, ino: pinned.ino }];
      const allowedRoots = pinAllowedRootIdentities(roots);
      ({ realPath } = await validateAndOpen(absTarget, { allowedRoots, maxBytes: MAX_PAGE_BYTES }));
    } catch (err) {
      const reason = err instanceof FileLinkDenied ? err.reason : 'unreadable';
      const status = reason === 'unreadable' ? 404 : 403;
      return { status, body: { error: DENIAL_ERRORS[reason] || `Refused: ${reason}` } };
    }

    const ttlSeconds = pageLinkTtlSeconds(ttlDays);
    const longUrl = generatePageUrl(baseUrl, realPath, secret, ttlSeconds, workdir, roots);
    const url = shorten ? shorten(longUrl) : longUrl;
    return {
      status: 200,
      body: { url, path: realPath, expiresAt: Date.now() + ttlSeconds * 1000 },
    };
  };
}
