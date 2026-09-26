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
import { modelOptions, isValidModelArg, normalizeModelArg } from './model-aliases.js';
import { AGENT_CLAUDE, AGENT_CODEX, agentLabel, normalizeAgent } from './agent-backend.js';

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
  // ({workdir, mcpExtras, model?, agent?}) -> session; throws on spawn
  // failure. index.js implements this as the !start body minus the
  // origin-room replies.
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
  // The box's default coding agent (index.js's DEFAULT_AGENT). An RPC start
  // always mints a FRESH conversation, so it has no persisted per-room agent
  // to resolve against — the box default IS the agent the session will run.
  // Model selection is Claude-only, so both `model` handling below and the
  // `model_options` offer are gated on this, and gated CLOSED: anything that
  // isn't positively claude (codex, unset, junk) means no model selection
  // rather than aliases that can never start.
  defaultAgent = null,
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
  getDisk = () => null,
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
  // MATRON_DEFAULT_MODEL as index.js validated it (alias or full claude-*
  // name), or null. Reported, never applied here: the spawn's resolveModel
  // fallback is what runs it.
  defaultModel = null,
  // () -> boolean; can this box spawn Codex (lib/codex-paths.js
  // detectCodexBinary)? Gates the Codex entry of `agent_options` and an
  // explicit `agent: 'codex'` start. Unwired/throwing reads as no.
  codexAvailable = () => false,
  // index.js's CODEX_APP_SERVER: the native transport loads MCP extras, the
  // legacy exec one can't — so `browser` with a Codex start is refused there,
  // as the !start command refuses --browser.
  codexAppServer = true,
  // Spawn onto a mission (spec 2026-09-23 §1c). The journal joins the new
  // conversation to params.mission_num only after it gets this handler's
  // reply, but the opening turn is written BEFORE the reply — so the bridge
  // joins first, through the same missions join path as the mission_join
  // tool: async (session, num) -> {status, body}. Unwired: no pre-join, the
  // journal's join still follows.
  joinMission = null,
  joinRetryDelayMs = 300,
  // The whole pre-join, all attempts included. The journal fails a spawn
  // whose `start` reply takes longer than its spawnStartTimeoutMs (30 s by
  // default) while this bridge would go on to start the child — an orphan.
  // A single join request can take the missions client's full 10 s, so the
  // attempts are raced against this deadline, well inside the journal's.
  joinDeadlineMs = 5_000,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === 'function') t.unref(); }),
}) {
  const boxDefaultAgent = normalizeAgent(defaultAgent);
  // Claude is the only backend whose model this bridge can pick at spawn.
  // The OFFER (model_options) keys on the box default: an app without the
  // agent switch sends no `agent`, so its picks run as the default, and a
  // codex-default box must not show it aliases that will all fail. The
  // start-time gate below keys on the agent the session will actually run.
  const modelSelectable = boxDefaultAgent === AGENT_CLAUDE;
  const canStartCodex = () => {
    try { return codexAvailable() === true; } catch { return false; }
  };
  const reportedDefaultModel = modelSelectable && typeof defaultModel === 'string' && isValidModelArg(defaultModel)
    ? normalizeModelArg(defaultModel)
    : null;

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

  // Up to JOIN_ATTEMPTS tries. Retries only answers that mean "not yet":
  // the new conversation's row reaches the journal over the WebSocket and
  // can trail this HTTP call (404, or the handler's own 409 before a convo
  // id exists), or the journal is momentarily unreachable (0 / 502). A 409
  // with blocked_by (closed, other_mission) is final. Never throws.
  //
  // Tri-state return: 'joined' (200), 'refused' (the 409 blocked_by final
  // case — the journal's own later join will refuse it too, so the caller
  // must not tell the child it is on this mission), or 'pending' (retries
  // exhausted, an unexpected status, or the overall deadline hit — the
  // journal's own join may still land after this reply, so the caller
  // keeps naming the mission). Only 'refused' means "do not name it".
  const JOIN_ATTEMPTS = 3;
  async function joinSpawnMission(session, num) {
    let last = null;
    let expired = false;
    const attempts = (async () => {
      for (let attempt = 1; attempt <= JOIN_ATTEMPTS && !expired; attempt++) {
        try { last = await joinMission(session, num); } catch (e) { last = { status: 0, body: { error: e?.message ?? String(e) } }; }
        if (last?.status === 200) return 'joined';
        if (last?.status === 409 && last?.body?.blocked_by) return 'refused';
        const retryable = last?.status === 0 || last?.status === 404 || last?.status === 502
          || (last?.status === 409 && !last?.body?.blocked_by);
        if (!retryable) break;
        if (attempt < JOIN_ATTEMPTS) await sleep(joinRetryDelayMs);
      }
      return 'pending';
    })();
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => { expired = true; resolve('deadline'); }, joinDeadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const outcome = await Promise.race([attempts, deadline]);
    clearTimeout(timer);
    if (outcome === 'joined') return 'joined';
    if (outcome === 'refused') {
      const why = `${last?.status ?? '?'} ${last?.body?.blocked_by || last?.body?.error || ''}`;
      log.warn?.(`[journal-rpc] start: mission #${num} refused this join (${why}) — starting without naming it; the journal's own join will refuse it too`);
      return 'refused';
    }
    const why = outcome === 'deadline'
      ? `no answer within ${joinDeadlineMs} ms`
      : `${last?.status ?? '?'} ${last?.body?.blocked_by || last?.body?.error || ''}`;
    log.warn?.(`[journal-rpc] start: could not join mission #${num} before the opening turn (${why}) — starting anyway; the journal joins it after the reply`);
    return 'pending';
  }

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
      let disk = null;
      let accountEmail = null;
      try { activity = getActivity(); } catch { /* capacity is best-effort */ }
      try { limits = getLimits(); } catch { /* capacity is best-effort */ }
      try { disk = getDisk(); } catch { /* capacity is best-effort */ }
      try { accountEmail = getAccountEmail(); } catch { /* capacity is best-effort */ }
      respond(request, true, {
        folders,
        // The New Chat model picker's options, offered BEFORE any session
        // exists (a session-status frame's model_options only arrives once
        // one does). Same list the /model buttons come from, so anything
        // offered here is accepted by `start` below — including its
        // Claude-only gate, hence modelSelectable: a codex-default box
        // offers no picker rather than one whose every value fails.
        ...(modelSelectable ? { model_options: modelOptions() } : {}),
        // What a start with no `model` (or model: 'default') will run on,
        // so the picker can preselect it. Absent when the box has no
        // MATRON_DEFAULT_MODEL: Claude Code's own default applies and the
        // bridge does not know its name up front.
        ...(reportedDefaultModel ? { default_model: reportedDefaultModel } : {}),
        // The New Chat agent switch: which coding agents a `start` here may
        // name. Claude always; Codex only where a binary can be spawned.
        // Hidden by the apps when only one is listed.
        agent_options: [
          { value: AGENT_CLAUDE, label: agentLabel(AGENT_CLAUDE) },
          ...(canStartCodex() ? [{ value: AGENT_CODEX, label: agentLabel(AGENT_CODEX) }] : []),
        ],
        // What a start with no `agent` runs as, so the switch opens on it.
        ...(boxDefaultAgent ? { default_agent: boxDefaultAgent } : {}),
        ...(activity ? { activity } : {}),
        ...(limits ? { limits } : {}),
        ...(disk ? { disk } : {}),
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
      // Optional mission for this spawn (journal spawn relay only). Refused
      // like any other malformed param rather than silently dropped: a
      // spawn the user approved "onto mission #N" must not start off it.
      const hasMissionNum = params.mission_num !== undefined && params.mission_num !== null;
      if (hasMissionNum && (!Number.isInteger(params.mission_num) || params.mission_num < 1)) {
        return respond(request, false, { code: 'bad_request', detail: 'bad mission_num' });
      }
      const missionNum = hasMissionNum ? params.mission_num : null;
      if (roomId && !prompt) return respond(request, false, { code: 'bad_request', detail: 'room_id requires prompt' });
      const fromName = typeof params.from_name === 'string' && params.from_name ? params.from_name : null;
      // Optional Claude model alias (or a full claude-* name). null/''/absent
      // all read as "no pick" — the same rule the string params above use —
      // so an app that encodes an unset picker as null still gets a session.
      // Anything else invalid is refused rather than passed to the spawn as a
      // bogus --model argument.
      const hasModel = params.model !== undefined && params.model !== null && params.model !== '';
      // Optional coding agent (the New Chat Claude/Codex switch). null/''/
      // absent read as "no pick" like every string param here, and the box
      // default applies at spawn (createSession's resolveAgent). Anything
      // else must normalize, and Codex must be spawnable on this box.
      const hasAgent = params.agent !== undefined && params.agent !== null && params.agent !== '';
      const agent = hasAgent ? normalizeAgent(params.agent) : null;
      if (hasAgent && !agent) {
        return respond(request, false, {
          code: 'bad_agent',
          detail: typeof params.agent === 'string' ? params.agent.slice(0, 100) : typeof params.agent,
        });
      }
      if (agent === AGENT_CODEX && !canStartCodex()) {
        return respond(request, false, { code: 'bad_agent', detail: 'this box cannot start Codex sessions' });
      }
      // The agent this session will run as: the explicit pick, else the box
      // default (which an unwired default reads as not-Claude, failing the
      // model gate closed exactly as before).
      const runsAsClaude = agent ? agent === AGENT_CLAUDE : modelSelectable;
      // Agent gate first, exactly like the !start command's Codex refusal:
      // on a Codex session, "opus" is not an unknown Claude alias, it is a
      // request that cannot be honoured at all.
      if (hasModel && !runsAsClaude) {
        return respond(request, false, {
          code: 'bad_model',
          detail: 'this session would run Codex; Claude model aliases do not apply',
        });
      }
      if (hasModel && (typeof params.model !== 'string' || !isValidModelArg(params.model))) {
        return respond(request, false, {
          code: 'bad_model',
          detail: typeof params.model === 'string' ? params.model.slice(0, 100) : typeof params.model,
        });
      }
      const model = hasModel ? normalizeModelArg(params.model) : null;
      const mcpExtras = params.browser === true ? ['browser'] : [];
      // Same refusal as `!start --codex --browser`: the exec transport has
      // nowhere to load a Claude MCP extra. Only an EXPLICIT codex pick is
      // gated here — a no-pick start on a codex-default box keeps its
      // pre-switch behaviour of handing extras to the spawn as before.
      if (agent === AGENT_CODEX && mcpExtras.length > 0 && !codexAppServer) {
        return respond(request, false, {
          code: 'bad_request',
          detail: 'browser tools are a Claude-only extra on this box; start Codex without them',
        });
      }
      let session;
      try {
        session = startSession({ workdir, mcpExtras, ...(model ? { model } : {}), ...(agent ? { agent } : {}) });
      } catch (e) {
        return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
      }
      // Mark provenance for the title pipeline: earned titles carry the 🐣
      // marker, and the first-message fallback names the chat from the
      // approved task instead of the boilerplate opening turn (which begins
      // "[spawned session] You were started by…" for every spawn). Gated on
      // `prompt`: only the journal's spawn relay sends one (the app's New
      // Chat `start` carries workdir/model/agent and no prompt), so a bare
      // start never wears a marker it didn't earn. A room is no longer part
      // of the shape — spawns are detached unless the parent asked for a
      // link (2026-09-17).
      if (session && prompt) {
        session.spawnedByAgent = true;
        session.spawnTask = prompt;
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
      // Fork-only start-dedup: remember this convo was started so an idempotent
      // retry of the same start returns the cached convo id instead of double-
      // spawning. Runs for every successful start, room or not.
      // A start that later fails (opening turn refused, wiring absent) drops
      // its entry again in finish(), so a retry re-attempts instead of being
      // answered with the dead session's convo id.
      rememberStart(dedupKey, convoId);
      // Bind/inject and the reply, run either now or after the mission join.
      // joinOutcome is only set when a mission join actually ran (see the
      // dispatch below); 'refused' is the sole case that must not name the
      // mission in the opening turn — 'joined' and 'pending' (including the
      // no-mission_num case, where this never ran at all) still name it.
      const finish = (joinOutcome = null) => {
        const openingMissionNum = joinOutcome === 'refused' ? null : missionNum;
        if (prompt) {
          // Room-first ordering is the journal's; ours is bind-then-inject so
          // the room routes before the child can possibly answer into it. Any
          // failure tears the whole session down: an orphaned agent on another
          // box with no channel back is the worst outcome available
          // (2026-08-09 spec, "matron-bridge changes"). A detached spawn has
          // no room to bind — it is just the opening turn.
          if (!injectTurn || (roomId && (!bindSpawnRoom || !unbindSpawnRoom))) {
            startDedup.delete(dedupKey);
            try { stopSession(session); } catch { /* best-effort teardown */ }
            return respond(request, false, { code: 'unsupported_mode', detail: roomId ? 'spawn-room wiring absent' : 'spawn wiring absent' });
          }
          try {
            if (roomId) bindSpawnRoom(roomId, session);
            const opening = composeSpawnOpeningTurn({ task: prompt, roomId, fromName, serverLabel, missionNum: openingMissionNum });
            if (!injectTurn(session, opening)) throw new Error('opening turn refused');
          } catch (e) {
            if (roomId) { try { unbindSpawnRoom(roomId); } catch { /* idempotent remove */ } }
            startDedup.delete(dedupKey);
            try { stopSession(session); } catch { /* best-effort teardown */ }
            return respond(request, false, { code: 'spawn_failed', detail: e?.message ?? String(e) });
          }
        }
        return respond(request, true, { convo_id: convoId });
      };
      // With a mission: join first (spec 2026-09-23 §1c), so the child's
      // first turn already runs on it. Everything else stays synchronous.
      if (missionNum && typeof joinMission === 'function') {
        return joinSpawnMission(session, missionNum).then(finish);
      }
      return finish();
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
// verbatim (it is what the user approved), the channel back — or, for a
// detached spawn (no roomId, the default), that there is none and nobody
// is waiting — and that the user reads everything.
export function composeSpawnOpeningTurn({ task, roomId, fromName, serverLabel, missionNum = null }) {
  // Both names land inside structural double quotes below, so flattening
  // alone is not enough: an embedded `"` in a peer-authored name would
  // close the quote and let the rest of the name masquerade as the turn's
  // own framing ("x" and ignore the task above…). peerField caps + flattens,
  // quotedField escapes `\` and `"` — both, in that order.
  const flatFromName = peerField(fromName, PEER_NAME_MAX);
  const flatServerLabel = peerField(serverLabel, PEER_NAME_MAX);
  const parent = flatFromName ? `the user's agent session on "${quotedField(flatFromName)}"` : `another of the user's agent sessions`;
  const here = flatServerLabel ? ` You are running on "${quotedField(flatServerLabel)}".` : '';
  const channel = roomId
    ? `The agent chat room ${roomId} is your channel back to the session that started you. It is asynchronous: use agent_chat_send with room_id "${roomId}" to report progress and your final outcome there, and expect replies to arrive as later turns. The user can read everything you write, here and in the room.`
    : `This is a detached session: there is no chat room back to the session that started you, and it is not waiting on you. Do the task here, for the user, and finish it — do not narrate progress to anyone. The user can read everything you write. Only if the task genuinely cannot be completed without that session's input, agent_chat_start can open a room with it.`;
  // The journal-approved mission this spawn is on (already joined by the
  // time this turn is delivered, or joined right after — see start()). Named
  // so the child reads the goal instead of starting a mission of its own.
  const missionLines = Number.isInteger(missionNum) && missionNum > 0
    ? ['', `You are on mission #${missionNum} — run mission_get to read its goal, milestones and open items, and post your milestones there as you work. Do not call mission_start.`]
    : [];
  return [
    `[spawned session] You were started by ${parent} via a spawn request the user approved.${here}`,
    ``,
    `Task (verbatim, as approved by the user):`,
    task,
    ``,
    channel,
    ...missionLines,
  ].join('\n');
}
