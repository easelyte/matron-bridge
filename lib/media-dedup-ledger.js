// In-memory, TTL + LRU ledger of show_file publishes, keyed by content identity.
//
// Nothing below show_file dedups: POST /show-file takes no idempotency key, POST
// /media always stores a fresh blob, and publishImage/publishFile mint a new id
// per call. The real duplicate is the agent re-calling show_file after an error,
// which is a fresh tool call, so the key has to be the content, not the request.
//
// shareAgentMedia consults this before uploading and, on a hit, returns the
// earlier media_id instead of storing and publishing the same file again.
// Caption is part of the identity, so re-showing a file with a new caption is
// not suppressed.
//
// Fail-open: dedup is an optimization, never a gate on a legitimate publish.
// Bounded by both a TTL and an entry cap (LRU eviction plus an expiry sweep).

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // covers an agent's error-and-retry loop
const DEFAULT_MAX_ENTRIES = 500;

// Digest of already-buffered bytes. Computed locally rather than taken from the
// upload response so dedup does not depend on the server echoing a digest.
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Injective field encoding: each field is a type tag plus, for a string, a
// byte-length prefix ('N' = absent, 'S<len>:' + bytes = present), so no value can
// impersonate a field boundary or an absent field. ('a','b') never hashes like
// ('ab',''), and a caption equal to some sentinel never matches a missing one.
export function dedupKey({ token, realPath, sha256, caption }) {
  const h = crypto.createHash('sha256');
  const field = (v) => {
    if (v === undefined || v === null) {
      h.update('N');
      return;
    }
    const s = String(v);
    h.update(`S${Buffer.byteLength(s, 'utf8')}:`);
    h.update(s, 'utf8');
  };
  field(token);
  field(realPath);
  field(sha256);
  field(caption);
  return h.digest('hex');
}

export function createMediaDedupLedger({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  // Map keeps insertion order, so iteration is oldest-first (LRU eviction);
  // get() re-inserts a live entry to mark it most recently used.
  const map = new Map();

  function sweepExpired(nowMs) {
    for (const [k, v] of map) {
      if (v.expiresAt <= nowMs) map.delete(k);
    }
  }

  return {
    get(key) {
      const nowMs = now();
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= nowMs) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return { mediaId: entry.mediaId, kind: entry.kind, sha256: entry.sha256, at: entry.at };
    },
    set(key, { mediaId, kind, sha256 }) {
      const nowMs = now();
      sweepExpired(nowMs);
      map.delete(key);
      map.set(key, { mediaId, kind, sha256, at: nowMs, expiresAt: nowMs + ttlMs });
      while (map.size > maxEntries) {
        map.delete(map.keys().next().value);
      }
    },
    get size() {
      return map.size;
    },
  };
}
