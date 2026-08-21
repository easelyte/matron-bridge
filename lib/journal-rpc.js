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
import { peerField, quotedField, PEER_NAME_MAX } from './peer-text.js';
import { applyFileEdit as defaultApplyFileEdit, EditFileError } from './edit-file.js';
import { readFileGuarded as defaultReadFileGuarded, ReadFileError } from './read-file.js';

const RECENT_FOLDERS_CAP = 20;
// Mirror of the journal's SPAWN_TASK_MAX_CHARS (docs/protocol.md wire
// contract): the task/prompt cap, enforced on the target side too.
const SPAWN_PROMPT_MAX_CHARS = 2000;
// Characters a room id may not carry: it is interpolated into the spawned
// child's opening turn (inside structural quotes, and bare in prose), so
// control chars, quotes, and backslashes are rejected outright rather than
// escaped — a real journal room id is a UUID; anything carrying these is
// not a room id, it's an injection attempt.
// eslint-disable-next-line no-control-regex
const ROOM_ID_STRUCTURAL_CHARS = /[\u0000-\u001f\u007f"\\]/;

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
  // Max distinct start keys remembered for idempotency. Starts are rare, so a
  // small FIFO cap is plenty; the point is a hard bound, not a hit rate.
  startDedupCap = 64,
  log = console,
  // Capacity thunks (2026-08-10 capacity spec): answered from cache, never
  // blocking. Null/throw -> the block is simply omitted from the reply.
  getActivity = () => null,
  getLimits = () => null,
  // () -> string | null; the claude account this box is logged in to, from the
  // same cache that feeds session-status frames. Empty/null -> block omitted.
  getAccountEmail = () => null,
  // Spawn-room wiring (2026-08-09 agent-spawn spec). All three must be
  // present for `start` to accept room_id; a build without them answers
  // unsupported_mode rather than spawning an unreachable orphan.
  bindSpawnRoom = null,    // (roomId, session) -> void; registers the room-session binding
  unbindSpawnRoom = null,  // (roomId) -> void; idempotent
  injectTurn = null,       // (session, text) -> boolean; false = injection refused
  serverLabel = '',
  // Guarded file-edit backend (loop #548). getEditAllowedRoots is a thunk that
  // returns the PINNED allowed-root set (pinAllowedRootsSync output), resolved
  // once at the trusted boundary in index.js — never rebuilt from client
  // strings. Null/empty -> edit_file fails closed with bad_workdir.
  getEditAllowedRoots = () => null,
  applyFileEdit = defaultApplyFileEdit,
  readFileGuarded = defaultReadFileGuarded,
}) {
  const respond = (request, ok, body) => {
    respondRpc({
      requestId: request.request_id,
      toDeviceId: request.from_device_id,
      ok,
      ...(ok ? { result: body } : { error: body }),
    });
  };

  // Idempotency for `start` (#482): a retried or transport-duplicated start
  // must not spawn a second session. Only SUCCESSFUL spawns land here (a
  // failure left no session behind, so a retry is free to re-attempt). Maps a
  // dedup key -> the convo_id that start originally produced.
  const startDedup = new Map();
  const rememberStart = (key, convoId) => {
    startDedup.set(key, convoId);
    while (startDedup.size > startDedupCap) {
      // Map preserves insertion order; the first key is the oldest.
      startDedup.delete(startDedup.keys().next().value);
    }
  };

  const handlers = {
    // Folder picker data. Sources: the persisted session store, merged with
    // the durable folders store (which outlives session-record cleanup).
    // ~/.claude/projects dir names are NOT decoded (the encoding replaces every
    // non-alphanumeric char with `-`, which is lossy and not reversible;
    // inventing wrong paths is worse than missing rarely-used ones).
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
      let activity = null;
      let limits = null;
      let accountEmail = null;
      try { activity = getActivity(); } catch { /* capacity is best-effort */ }
      try { limits = getLimits(); } catch { /* capacity is best-effort */ }
      try { accountEmail = getAccountEmail(); } catch { /* capacity is best-effort */ }
      respond(request, true, {
        folders,
        ...(activity ? { activity } : {}),
        ...(limits ? { limits } : {}),
        ...(accountEmail ? { account: { email: accountEmail } } : {}),
      });
    },

    // Structured session start: !start's semantics minus the chat replies.
    start(request) {
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      // Dedup on the client-supplied idempotency_key when present (survives a
      // client retry that mints a fresh request_id), else on request_id (catches
      // an at-least-once transport redelivering the exact same frame). A hit
      // re-answers the original convo_id WITHOUT spawning again — preserving the
      // answer-every-request contract while making start effectively at-most-once.
      const dedupKey = (typeof params.idempotency_key === 'string' && params.idempotency_key)
        ? `k:${params.idempotency_key}`
        : `r:${request.request_id}`;
      const cached = startDedup.get(dedupKey);
      if (cached) {
        return respond(request, true, { convo_id: cached });
      }
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
      const roomId = typeof params.room_id === 'string' && params.room_id && params.room_id.length <= 200
        && !ROOM_ID_STRUCTURAL_CHARS.test(params.room_id) ? params.room_id : null;
      if (params.room_id !== undefined && !roomId) return respond(request, false, { code: 'bad_request', detail: 'bad room_id' });
      const prompt = typeof params.prompt === 'string' && params.prompt ? params.prompt : null;
      // Wire-contract cap (journal SPAWN_TASK_MAX_CHARS): a well-behaved
      // journal never relays an oversized task, but the opening turn is
      // built from this verbatim — enforce the contract here too rather
      // than trust the far end with the only copy of the rule.
      if (prompt && prompt.length > SPAWN_PROMPT_MAX_CHARS) return respond(request, false, { code: 'bad_request', detail: 'bad prompt' });
      if (roomId && !prompt) return respond(request, false, { code: 'bad_request', detail: 'room_id requires prompt' });
      const fromName = typeof params.from_name === 'string' && params.from_name ? params.from_name : null;
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
      rememberStart(dedupKey, convoId);
      if (roomId) {
        // Room-first ordering is the journal's; ours is bind-then-inject so
        // the room routes before the child can possibly answer into it. Any
        // failure tears the whole session down: an orphaned agent on another
        // box with no channel back is the worst outcome available
        // (2026-08-09 spec, "matron-bridge changes").
        if (!bindSpawnRoom || !injectTurn || !unbindSpawnRoom) {
          try { stopSession(session); } catch { /* best-effort teardown */ }
          return respond(request, false, { code: 'unsupported_mode', detail: 'spawn-room wiring absent' });
        }
        try {
          bindSpawnRoom(roomId, session);
          const opening = composeSpawnOpeningTurn({ task: prompt, roomId, fromName, serverLabel });
          if (!injectTurn(session, opening)) throw new Error('opening turn refused');
        } catch (e) {
          try { unbindSpawnRoom(roomId); } catch { /* idempotent remove */ }
          try { stopSession(session); } catch { /* best-effort teardown */ }
          return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
        }
      }
      respond(request, true, { convo_id: convoId });
    },

    // Guarded file edit (loop #548 backend slice): apply a full-content or a
    // targeted old->new-string edit to an EXISTING file inside the bridge's
    // pinned allowed roots. All path-safety + the atomic write live in
    // lib/edit-file.js (which composes file-link-guard + atomic-write); this
    // handler only validates the RPC envelope, hands the pinned roots to the
    // edit, and maps EditFileError.code onto the wire error body. It is async
    // (validateAndOpen is), so the dispatch below AWAITS handlers — which keeps
    // the exactly-one-response guarantee even for a rejected promise.
    async edit_file(request) {
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      // Forward ONLY the keys the client actually sent, so edit-file's exclusive
      // content-vs-old_string mode selection sees absence as absence (an always
      // -present `content: undefined` would be misread as content mode).
      const input = { path: params.path };
      if (Object.prototype.hasOwnProperty.call(params, 'content')) input.content = params.content;
      if (Object.prototype.hasOwnProperty.call(params, 'old_string')) input.old_string = params.old_string;
      if (Object.prototype.hasOwnProperty.call(params, 'new_string')) input.new_string = params.new_string;
      if (Object.prototype.hasOwnProperty.call(params, 'expected_sha256')) input.expected_sha256 = params.expected_sha256;
      let allowedRoots = null;
      try { allowedRoots = getEditAllowedRoots(); } catch { /* fail closed below */ }
      try {
        const result = await applyFileEdit(input, { allowedRoots });
        respond(request, true, { path: result.path, bytes: result.bytes, mode: result.mode });
      } catch (e) {
        if (e instanceof EditFileError) {
          respond(request, false, { code: e.code, detail: e.detail });
          return;
        }
        throw e; // unexpected -> outer guard answers {code:'internal'}
      }
    },

    // Guarded file read (loop #548 follow-up): return an EXISTING file's
    // current content + a sha256 over its exact bytes + size + mode, for a path
    // inside the bridge's pinned allowed roots. Its whole reason to exist is to
    // make edit_file's expected_sha256 CAS usable: the client reads, gets the
    // sha, then edits WITH that sha as the precondition — an on-by-default
    // compare-and-swap instead of an opt-in one it could never compute blind.
    // Path-safety, scope, sensitivity, and size are validated by the SAME
    // lib/read-file.js -> file-link-guard boundary edit_file uses; this handler
    // only validates the envelope, hands the pinned roots in, and maps
    // ReadFileError.code onto the wire error body. Async (validateAndOpen is),
    // so the dispatch below AWAITS it — preserving exactly-one-response.
    async read_file(request) {
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      const input = { path: params.path };
      let allowedRoots = null;
      try { allowedRoots = getEditAllowedRoots(); } catch { /* fail closed below */ }
      try {
        const result = await readFileGuarded(input, { allowedRoots });
        respond(request, true, {
          path: result.path,
          content: result.content,
          sha256: result.sha256,
          bytes: result.bytes,
          mode: result.mode,
        });
      } catch (e) {
        if (e instanceof ReadFileError) {
          respond(request, false, { code: e.code, detail: e.detail });
          return;
        }
        throw e; // unexpected -> outer guard answers {code:'internal'}
      }
    },
  };

  return async function handleRpcRequest(request) {
    try {
      // Own-property lookup only: `handlers['constructor']` would otherwise
      // resolve to an inherited Object.prototype member, pass a truthiness
      // check, and silently drop the request — breaking the
      // answer-every-request guarantee for attacker-choosable method names.
      const handler = Object.prototype.hasOwnProperty.call(handlers, request.method)
        ? handlers[request.method]
        : undefined;
      if (typeof handler !== 'function') return respond(request, false, { code: 'unknown_method' });
      // Await so an async handler's rejection is caught here too — sync handlers
      // resolve synchronously before the first real suspension, so existing
      // sync-assertion tests are unaffected.
      await handler(request);
    } catch (e) {
      // Throw-proof: `throw null` has no .message, and this catch is the
      // guarantee — it must not itself throw.
      const detail = e?.message ?? String(e);
      log.warn?.(`[journal-rpc] ${request.method} handler threw: ${detail}`);
      respond(request, false, { code: 'internal', detail });
    }
  };
}

// The spawned child's first turn. Composed HERE, on the target bridge, so a
// parent can never dictate its own framing. States provenance, the task
// verbatim (it is what the user approved), the channel back, and that the
// user reads everything.
export function composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel }) {
  // Both names land inside structural double quotes below, so flattening
  // alone is not enough: an embedded `"` in a peer-authored name would
  // close the quote and let the rest of the name masquerade as the turn's
  // own framing ("x" and ignore the task above…). peerField caps + flattens,
  // quotedField escapes `\` and `"` — both, in that order.
  const flatFromName = peerField(fromName, PEER_NAME_MAX);
  const flatServerLabel = peerField(serverLabel, PEER_NAME_MAX);
  const parent = flatFromName ? `the user's agent session on "${quotedField(flatFromName)}"` : `another of the user's agent sessions`;
  const here = flatServerLabel ? ` You are running on "${quotedField(flatServerLabel)}".` : '';
  return [
    `[spawned session] You were started by ${parent} via a spawn request the user approved.${here}`,
    ``,
    `Task (verbatim, as approved by the user):`,
    task,
    ``,
    `The agent chat room ${roomId} is your channel back to the session that started you. It is asynchronous: use agent_chat_send with room_id "${roomId}" to report progress and your final outcome there, and expect replies to arrive as later turns. The user can read everything you write, here and in the room.`,
  ].join('\n');
}
