// Loopback handler behind the `search` MCP tool (spec 2026-10-12 unified
// search). HTTP-agnostic, same {status, body} contract as
// lib/missions-tools.js; index.js mounts it at /search/all. Unlike missions
// or memories, a search is not scoped to this conversation at all — the
// journal answers over the caller's whole user, so the only local gate is
// that a legitimate session is calling (same roomId check every other
// loopback route makes), with no journalConvoId needed afterwards.
const Q_MAX = 256;
const LIMIT_MAX = 50;
const KINDS = new Set(['mission', 'item', 'memory', 'project']);

const NOT_READY = 'This journal has no unified search yet; use the journal search API instead.';
const BAD_QUERY = 'the journal rejected the query — q must be 1-256 characters after trimming, and kinds must be mission, item, memory or project';

const bad = (error) => ({ status: 400, body: { error } });

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  if (r.status === 404) return { status: 404, body: { error: NOT_READY } };
  if (r.status === 400) return { status: 400, body: { error: BAD_QUERY } };
  return { status: r.status, body: r.data };
}

export function createSearchHandlers({ sessions, client }) {
  return {
    async all(data) {
      const roomId = data?.roomId;
      if (!roomId || typeof roomId !== 'string') return bad('roomId is required');
      if (!sessions.get(roomId)) return { status: 404, body: { error: `no active session for chat ${roomId}` } };

      const q = typeof data?.q === 'string' ? data.q.trim() : '';
      if (!q || q.length > Q_MAX) return bad(`q is required: what you are looking for, 1-${Q_MAX} characters`);
      let kinds;
      if (data?.kinds !== undefined) {
        if (!Array.isArray(data.kinds) || !data.kinds.length || !data.kinds.every((k) => KINDS.has(k))) {
          return bad(`kinds must be a non-empty list of ${[...KINDS].join(', ')}`);
        }
        kinds = data.kinds;
      }
      let limit;
      if (data?.limit !== undefined) {
        if (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > LIMIT_MAX) return bad(`limit must be 1-${LIMIT_MAX}`);
        limit = data.limit;
      }

      return passthrough(await client.searchAll({ q, kinds, limit }));
    },
  };
}
