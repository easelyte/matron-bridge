// Agent-RPC request handler (docs/superpowers/specs/
// 2026-07-15-rpc-consumer-design.md): the bridge-side counterpart to
// matron-journal's agent RPC relay. Injectable factory in the style of
// lib/journal-publisher.js — index.js wires the real session machinery in,
// tests stub it.
//
// Contract: EVERY request delivered here gets exactly one respondRpc call —
// the whole dispatch is wrapped, and a throw anywhere answers
// {code:'internal'}. respondRpc never throws (publisher contract), so the
// guarantee is structural, not best-effort.

import fs from 'fs';
import path from 'path';

const RECENT_FOLDERS_CAP = 20;

export function createRpcRequestHandler({
  respondRpc,
  // ({workdir, mcpExtras}) -> session; throws on spawn failure. index.js
  // implements this as the !start body minus the origin-room replies.
  startSession,
  // (session) -> void; teardown for the unsupported_mode path.
  stopSession,
  // () -> array of persisted session records ({workdir, lastUsed, ...}).
  listPersistedSessions,
  // () -> [{path, lastUsed}] from the durable folders store
  // (lib/recent-folders.js) — folders remembered independently of session
  // records, so the picker survives stale-session cleanup.
  listRememberedFolders = () => [],
  defaultWorkdir,
  expandHome,
  statSync = fs.statSync,
  log = console,
}) {
  const respond = (request, ok, body) => {
    respondRpc({
      requestId: request.request_id,
      toDeviceId: request.from_device_id,
      ok,
      ...(ok ? { result: body } : { error: body }),
    });
  };

  const handlers = {
    // Folder picker data. Sources: the persisted session store, merged with
    // the durable folders store (which outlives session-record cleanup).
    // ~/.claude/projects dir names are NOT decoded (the /→- encoding is
    // lossy; inventing wrong paths is worse than missing rarely-used ones).
    // last_used:null means "available, never used". Folders whose directory
    // no longer exists are dropped from the listing (a picker entry that
    // can only answer bad_workdir helps no one) — but stay in the durable
    // store, so a returning directory gets its history back.
    recent_folders(request) {
      const byPath = new Map();
      for (const rec of listPersistedSessions()) {
        if (!rec || typeof rec.workdir !== 'string' || !rec.workdir) continue;
        const lastUsed = typeof rec.lastUsed === 'number' ? rec.lastUsed : 0;
        const prev = byPath.get(rec.workdir);
        if (prev === undefined || lastUsed > prev) byPath.set(rec.workdir, lastUsed);
      }
      for (const rec of listRememberedFolders()) {
        if (!rec || typeof rec.path !== 'string' || !rec.path) continue;
        const lastUsed = typeof rec.lastUsed === 'number' ? rec.lastUsed : 0;
        const prev = byPath.get(rec.path);
        if (prev === undefined || lastUsed > prev) byPath.set(rec.path, lastUsed);
      }
      const isDir = (p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      };
      const folders = [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([p]) => isDir(p))
        .slice(0, RECENT_FOLDERS_CAP)
        .map(([p, t]) => ({ path: p, last_used: t || null }));
      // The picker's "home" entry, present even on a fresh box (and even if
      // the cap sliced it out of a long history).
      if (!folders.some((f) => f.path === defaultWorkdir)) {
        folders.push({ path: defaultWorkdir, last_used: null });
      }
      respond(request, true, { folders });
    },

    // Structured session start: !start's semantics minus the chat replies.
    start(request) {
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      let workdir = defaultWorkdir;
      if (typeof params.workdir === 'string' && params.workdir) {
        const resolved = path.resolve(expandHome(params.workdir));
        let stat = null;
        try { stat = statSync(resolved); } catch { /* missing -> bad_workdir below */ }
        if (!stat || !stat.isDirectory()) {
          return respond(request, false, { code: 'bad_workdir', detail: resolved });
        }
        workdir = resolved;
      }
      const mcpExtras = params.browser === true ? ['browser'] : [];
      let session;
      try {
        session = startSession({ workdir, mcpExtras });
      } catch (e) {
        return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
      }
      // The journal convo id is the STABLE bridge conversation id — since
      // the codex-backend work it may live in session.journalConvoId, with
      // claudeSessionId as the historical fallback (mirror of index.js's
      // journalConvoIdFor). The room key is bridge-internal; this is the
      // only id the app can navigate to.
      const convoId = session?.journalConvoId || session?.claudeSessionId || null;
      if (!convoId) {
        // Claude sessions (print and interactive) pre-assign their id at
        // spawn, so this guard only fires for backends whose id arrives
        // asynchronously (fresh codex sessions learn their thread_id from
        // the stream). Tear the orphan down — answering success with no
        // usable convo id would strand the app.
        try { if (session) stopSession(session); } catch { /* best-effort teardown */ }
        return respond(request, false, { code: 'unsupported_mode', detail: 'session id unknown at spawn; this agent backend cannot answer start' });
      }
      respond(request, true, { convo_id: convoId });
    },
  };

  return function handleRpcRequest(request) {
    try {
      // Own-property lookup only: `handlers['constructor']` would otherwise
      // resolve to an inherited Object.prototype member, pass a truthiness
      // check, and silently drop the request — breaking the
      // answer-every-request guarantee for attacker-choosable method names.
      const handler = Object.prototype.hasOwnProperty.call(handlers, request.method)
        ? handlers[request.method]
        : undefined;
      if (typeof handler !== 'function') return respond(request, false, { code: 'unknown_method' });
      handler(request);
    } catch (e) {
      // Throw-proof: `throw null` has no .message, and this catch is the
      // guarantee — it must not itself throw.
      const detail = e?.message ?? String(e);
      log.warn?.(`[journal-rpc] ${request.method} handler threw: ${detail}`);
      respond(request, false, { code: 'internal', detail });
    }
  };
}
