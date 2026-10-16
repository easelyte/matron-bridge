// The user's journal name, from GET /me (open to agent tokens). Needed for
// the shareable tracker links, `<journal>/u/<name>/<num>` (lib/tracker-links.js).
//
// A user's name rarely changes, so the last answer is kept and persisted
// (load/save, keyed by the journal base so a box re-paired to another
// journal never carries a name over): sessions resumed the moment a
// restarted bridge boots get the https form without waiting on the journal.
// refresh() re-asks when forced (boot, each hello_ok) and otherwise only
// while the name is unknown (each spawn). Until it is known, name() is null
// and the links render in the old matron:// form.
// Same discipline as lib/user-settings.js: never throws, never logs the token.

const DEFAULT_TIMEOUT_MS = 5_000;

export function createJournalIdentity({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // () -> {base, name} | null, and ({base, name}) -> void.
  load = () => null,
  save = () => {},
  log = console,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  let name = null;
  try {
    const stored = load();
    if (base && stored?.base === base && typeof stored?.name === 'string' && stored.name) name = stored.name;
  } catch { /* a missing or corrupt file means unknown */ }
  let inFlight = null;
  let warnedFailure = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  async function fetchName() {
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const got = data?.user?.name;
      if (typeof got === 'string' && got) {
        const changed = got !== name;
        name = got;
        warnedFailure = false;
        if (changed) {
          try { save({ base, name }); } catch (e) { warn(`[journal-identity] could not persist the user name: ${e?.message ?? e}`); }
        }
      }
    } catch (e) {
      // Once per failure streak: a journal that is down for an hour should
      // not write a line per spawn.
      if (!warnedFailure) {
        warnedFailure = true;
        warn(`[journal-identity] GET /me failed (${e?.message ?? e}); tracker links use the matron:// form until it answers`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: () => name,
    async refresh({ force = false } = {}) {
      if (!base || !token) return name;
      if (name && !force) return name;
      if (!inFlight) inFlight = fetchName().finally(() => { inFlight = null; });
      await inFlight;
      return name;
    },
  };
}
