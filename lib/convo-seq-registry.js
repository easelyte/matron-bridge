// A per-convo registry of inner Maps: `Map<convoId, Map<key, value>>`.
//
// The journal input router keeps several pieces of per-convo, seq-keyed
// bookkeeping — picker frames (/model, /effort, /mode) and the queued-release
// card identities — that all share the same lifecycle: lazily create an inner
// map per convo, look entries up by key, drop the whole inner map on session
// teardown (evictConvo), and bound growth so a long-lived convo can't leak.
// Rather than hand-roll that `Map<convoId, Map<...>>` dance three times, each
// registry is one instance of this primitive, so the getOrCreate / evict /
// retention logic lives in exactly one place.
//
// `retention` bounds each inner map by insertion order (Map preserves it, so
// the oldest key is dropped first) on every `set`. Leave it at the default
// (Infinity) for registries that prune on their own schedule via `pruneWhere`.
export function createConvoSeqRegistry({ retention = Infinity } = {}) {
  const byConvo = new Map();
  const EMPTY = new Map();

  function inner(convoId, create = false) {
    let map = byConvo.get(convoId);
    if (!map && create) { map = new Map(); byConvo.set(convoId, map); }
    return map;
  }

  return {
    get(convoId, key) { return inner(convoId)?.get(key); },
    has(convoId, key) { return inner(convoId)?.has(key) ?? false; },
    size(convoId) { return inner(convoId)?.size ?? 0; },
    keys(convoId) { return (inner(convoId) ?? EMPTY).keys(); },
    values(convoId) { return (inner(convoId) ?? EMPTY).values(); },
    entries(convoId) { return (inner(convoId) ?? EMPTY).entries(); },

    // Insert/overwrite one entry, then enforce the insertion-order retention
    // bound (drop-oldest) when one is configured.
    set(convoId, key, value) {
      const map = inner(convoId, true);
      map.set(key, value);
      while (map.size > retention) map.delete(map.keys().next().value);
      return value;
    },

    // Remove one entry; drop the whole convo bucket once it empties so an
    // exhausted convo leaves no residue.
    delete(convoId, key) {
      const map = inner(convoId);
      if (!map) return;
      map.delete(key);
      if (map.size === 0) byConvo.delete(convoId);
    },

    // Session-teardown eviction: forget everything for this convo.
    evict(convoId) { byConvo.delete(convoId); },

    // Retention for registries whose "keep vs drop" decision is semantic, not
    // purely age-based: keep every key for which `isLive(key)` is true, and
    // drop the oldest non-live keys once their count exceeds `max`.
    pruneWhere(convoId, max, isLive) {
      const map = inner(convoId);
      if (!map) return;
      let resolved = 0;
      for (const key of map.keys()) if (!isLive(key)) resolved++;
      if (resolved <= max) return;
      for (const key of map.keys()) {
        if (isLive(key)) continue;
        map.delete(key);
        resolved--;
        if (resolved <= max) break;
      }
      if (map.size === 0) byConvo.delete(convoId);
    },

    // Fold `fromConvoId`'s bucket into `toConvoId`'s and forget the source
    // (used when a convo id is reassigned). `fromFirst` controls ordering:
    // when true the source's keys are ordered first (target values win on a
    // key collision); when false the target's keys come first (source values
    // win). Returns the merged inner map, or undefined if there was nothing to
    // move.
    merge(fromConvoId, toConvoId, { fromFirst = true } = {}) {
      if (fromConvoId === toConvoId) return byConvo.get(toConvoId);
      const fromMap = byConvo.get(fromConvoId);
      if (!fromMap) return byConvo.get(toConvoId);
      const toMap = byConvo.get(toConvoId);
      const merged = !toMap
        ? fromMap
        : fromFirst
          ? new Map([...fromMap, ...toMap])
          : new Map([...toMap, ...fromMap]);
      byConvo.set(toConvoId, merged);
      byConvo.delete(fromConvoId);
      return merged;
    },
  };
}
