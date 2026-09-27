// The user's memories, cached for the Coordinator's spawn (spec 2026-09-27
// memories, "The index at spawn"). The createCoordinatorLookup pattern:
// createSession is synchronous with a dozen callers, so spawns read the
// cache; it is kept current by a forced refresh on every hello_ok, on every
// `coordinator` and `memory` event, and a throttled refresh kicked behind
// every spawn. Never throws, never logs the token. A journal that predates
// GET /memories (404) reads as "known, none" and is warned once.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;

export function createMemoryLookup({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minRefreshMs = DEFAULT_MIN_REFRESH_MS,
  now = () => Date.now(),
  log = console,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  let known = false;
  let memories = [];
  let lastAttempt = -Infinity;
  let inFlight = null;
  let warnedFailure = false;
  let warnedLegacy = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function snapshot() {
    return { known, memories: memories.slice() };
  }

  async function fetchOnce() {
    if (!base) return { ok: false, reason: 'no journal configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/memories`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 404) return { ok: true, memories: [], legacy: true };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!Array.isArray(data?.memories)) return { ok: false, reason: 'unreadable response' };
      return { ok: true, memories: data.memories.filter((m) => m && typeof m === 'object') };
    } catch (e) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timed out' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh({ force = false } = {}) {
    // A forced refresh must see the journal AFTER whatever made the caller
    // force it, so it never piggybacks on a request already on the wire.
    if (inFlight) return force ? inFlight.then(() => refresh({ force: true })) : inFlight;
    if (!force && now() - lastAttempt < minRefreshMs) return Promise.resolve({ ...snapshot(), fetched: false });
    lastAttempt = now();
    inFlight = fetchOnce().then((r) => {
      if (r.ok) {
        known = true;
        memories = r.memories;
        warnedFailure = false;
        if (r.legacy && !warnedLegacy) {
          warnedLegacy = true;
          warn('[memory] this journal predates GET /memories — the Coordinator starts without memories until it is updated');
        }
      } else if (!warnedFailure) {
        warnedFailure = true;
        warn(`[memory] GET /memories failed (${r.reason}) — ${known
          ? `keeping the last known ${memories.length} memories`
          : 'memories unknown; the Coordinator is told to call memory_list'}`);
      }
      return { ...snapshot(), fetched: r.ok };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { refresh, snapshot };
}
