// In-memory, TTL + LRU content-identity ledger for show_file publishes.
//
// Why: there is no dedup at any of the three show_file layers (POST /show-file
// takes no idem key; POST /media always inserts a fresh blob; publishImage/File
// mints a fresh randomUUID() per call). The real duplicate is the LLM agent
// RE-CALLING show_file after an error — a fresh tool call, so a request-scoped
// UUID cannot catch it. The key must be content/identity-based.
//
// This ledger maps a content-identity hash -> the media_id that was already
// published for it, within a short TTL window. shareAgentMedia consults it and,
// on a hit, SKIPS the re-publish and returns the prior media_id, so the operator
// never sees a duplicate media bubble. Caption is part of the identity, so a
// deliberate re-show with a new caption is NOT suppressed.
//
// Fail-open: any error in the ledger path must let the publish proceed normally
// — dedup is an optimization, never a gate on a legitimate publish. Bounded by
// both a TTL and a hard entry cap (LRU eviction + opportunistic expiry sweep) so
// it cannot grow without limit.

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — covers an agent's error-and-retry loop
const DEFAULT_MAX_ENTRIES = 500;

// Content hash of already-buffered bytes. shareAgentMedia keys on this LOCAL
// digest (not the journal-echoed sha256) so dedup is deterministic and cannot be
// defeated by a stale/constant/format-drifted server digest or silently no-op
// under version skew.
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Injective field encoding: each field is emitted as a type tag + (for strings)
// a byte-length prefix, so NO field value — including one that happens to equal a
// delimiter or an "absent" sentinel — can impersonate another field's boundary.
// 'N' marks null/absent (no value follows); 'S<byteLen>:' precedes the UTF-8 bytes
// of a present string. Length-prefixing means the reader knows exactly how many
// bytes belong to the field, so ('a','b') can never hash the same as ('ab','') and
// caption "<absent>" can never collide with a genuinely absent caption. Pure ASCII
// in source → the file stays text to Git.
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
  // Map preserves insertion order → iteration yields oldest-first, which we use
  // for LRU eviction. get() re-inserts a live entry to mark it most-recently-used.
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
      // LRU touch: move to the most-recent end.
      map.delete(key);
      map.set(key, entry);
      return { mediaId: entry.mediaId, kind: entry.kind };
    },
    set(key, { mediaId, kind }) {
      const nowMs = now();
      // Opportunistic sweep first so expired entries can't wedge the cap.
      sweepExpired(nowMs);
      map.delete(key);
      map.set(key, { mediaId, kind, expiresAt: nowMs + ttlMs });
      // Hard cap: evict oldest (front of insertion order) until within bound.
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}
