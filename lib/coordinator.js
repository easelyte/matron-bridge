// The user's Coordinator (spec 2026-09-23 coordinator redesign, §2): which
// conversation holds the role, read from the journal, and every decision the
// bridge makes about it. Kept out of index.js so it is unit-testable; the
// wiring there is pinned by source inspection (test/coordinator-wiring.test.js).
//
// The role lives on the journal (GET /coordinator → {convo_id}), one per
// user; a bridge's agent token belongs to exactly one user, so this is one
// cached value per bridge. The answer is filtered by the journal's privacy
// rules: a Coordinator convo on another box's private conversation reads
// as null here — which is fine, because only the bridge that owns that
// room ever needs to know, and it sees the id. Null, a 404 and every
// failure all come out of roleFor() as "not the coordinator": the spawn is
// an ordinary session. createSession is synchronous with a dozen
// callers, so spawns read the cache; it is kept current by a forced refresh
// on every hello_ok, a forced refresh on every `coordinator` event, and a
// throttled refresh kicked behind every spawn. Never throws, never logs the
// token.

import { normalizeModelArg, SWITCHABLE_ALIASES } from './model-aliases.js';
import { AGENT_CLAUDE, AGENT_CODEX } from './agent-backend.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;

export function createCoordinatorLookup({
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
  let convoId = null;
  // Bumped by apply(): a GET that was already in flight when a live event
  // landed carries an answer from before the event, so it must not
  // overwrite what the event just set.
  let epoch = 0;
  let lastAttempt = -Infinity;
  let inFlight = null;
  let warnedFailure = false;
  let warnedLegacy = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function snapshot() {
    return { known, convoId };
  }

  async function fetchOnce() {
    if (!base) return { ok: false, reason: 'no journal configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/coordinator`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A journal that predates the Coordinator has no such route. Until it
      // is deployed nobody can be the Coordinator, so "nobody" is the truth.
      if (res.status === 404) return { ok: true, convoId: null, legacy: true };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const value = data?.convo_id;
      if (value === null) return { ok: true, convoId: null };
      if (typeof value === 'string' && value) return { ok: true, convoId: value };
      return { ok: false, reason: 'unreadable response' };
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
    const startEpoch = epoch;
    inFlight = fetchOnce().then((r) => {
      const current = r.ok && startEpoch === epoch;
      if (current) {
        known = true;
        convoId = r.convoId;
        warnedFailure = false;
        if (r.legacy && !warnedLegacy) {
          warnedLegacy = true;
          warn('[coordinator] this journal predates GET /coordinator — no session is the Coordinator until it is updated');
        }
      } else if (!r.ok && !warnedFailure) {
        warnedFailure = true;
        warn(`[coordinator] GET /coordinator failed (${r.reason}) — ${known
          ? `keeping the last known coordinator (${convoId ?? 'none'})`
          : 'role unknown; sessions start as ordinary sessions until the journal answers'}`);
      }
      return { ...snapshot(), fetched: current };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function apply(id, role) {
    if (typeof id !== 'string' || !id) return;
    if (role === 'assigned') {
      epoch += 1;
      known = true;
      convoId = id;
    } else if (role === 'released') {
      epoch += 1;
      if (known && convoId === id) convoId = null;
    }
  }

  function roleFor(candidates) {
    const ids = (Array.isArray(candidates) ? candidates : []).filter((c) => typeof c === 'string' && c);
    return { known, coordinator: known && convoId !== null && ids.includes(convoId) };
  }

  return { refresh, apply, roleFor, snapshot };
}

// --- Spawn-time shape (spec §2a, §2c) ---

export const COORDINATOR_MODEL = 'opus[1m]';
// MultiEdit is listed although current Claude CLIs fold it into Edit:
// disallowing a tool the CLI does not have is harmless (the flag still
// parses), and an older CLI that has it must not hand the Coordinator a
// file-editing tool.
export const COORDINATOR_DISALLOWED_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
export const COORDINATOR_CODEX_SANDBOX = 'read-only';
export const COORDINATOR_ASSIGNED_PREFIX = "[coordinator] You are now this user's Coordinator.";
export const COORDINATOR_RELEASED_TURN = '[coordinator] You are no longer the Coordinator; carry on as an ordinary session.';
// Used only when BRIDGE_COORDINATOR.md cannot be read: a Coordinator with a
// one-line brief still delegates; one with no brief at all does the work.
export const FALLBACK_COORDINATOR_BLOCK = "You are this user's Coordinator. Never do the work yourself: turn each request into a mission (mission_create) and start a session on it (agent_session_start with mission). Keep your own tasks for coordination steps only.";

export function loadCoordinatorBlock({ readFile, path, log = console }) {
  try {
    const text = String(readFile(path)).trim();
    if (text) return text;
    try { log.warn(`[coordinator] ${path} is empty — using the built-in coordinator brief`); } catch { /* logging must never throw */ }
  } catch (e) {
    try { log.warn(`[coordinator] could not read ${path}: ${e.message} — using the built-in coordinator brief`); } catch { /* logging must never throw */ }
  }
  return FALLBACK_COORDINATOR_BLOCK;
}

// Claude print and interactive spawns. A non-coordinator room gets back
// exactly what it had (a fresh copy of the list), so nothing changes for
// every ordinary session.
export function claudeCoordinatorArgs({ coordinator, basePrompt, block, baseDisallowed = [] }) {
  const disallowedTools = [...baseDisallowed];
  if (!coordinator) return { appendSystemPrompt: basePrompt, disallowedTools };
  for (const tool of COORDINATOR_DISALLOWED_TOOLS) {
    if (!disallowedTools.includes(tool)) disallowedTools.push(tool);
  }
  return { appendSystemPrompt: `${basePrompt}\n\n${block}`, disallowedTools };
}

export function codexCoordinatorOptions({ coordinator, baseInstructions, block, baseSandbox }) {
  if (!coordinator) return { developerInstructions: baseInstructions, sandbox: baseSandbox };
  return { developerInstructions: `${baseInstructions}\n\n${block}`, sandbox: COORDINATOR_CODEX_SANDBOX };
}

export function coordinatorTurnText(role, block) {
  if (role === 'assigned') return `${COORDINATOR_ASSIGNED_PREFIX}\n\n${block}`;
  if (role === 'released') return COORDINATOR_RELEASED_TURN;
  return null;
}

// --- Model (spec §2e) ---
//
// The persisted record cannot tell a pick from a default on its own: the
// live snapshot persists whatever model Claude reported (a full claude-* id)
// and /resume copies that to the top-level `model`. So every site where a
// person (or an agent on their behalf) picks a model now also persists
// `modelExplicit: true`, and the Coordinator's own implicit write persists
// `modelExplicit: false`. Records written before the flag existed fall back
// to: a persisted ALIAS was typed or tapped by someone (the snapshot never
// writes aliases), a full id was observed. `default` is the New Chat
// picker's preselected option, not a choice.
const LEGACY_PICKED_ALIASES = new Set([...SWITCHABLE_ALIASES.map((a) => a.alias), 'best']);

export function explicitModelFlag(model) {
  const m = normalizeModelArg(model);
  // Always returns the key, never {}: persistSession merges as
  // { ...existing, ...extra }, so a caller that omitted the key for
  // "default"/empty would leave a previous modelExplicit:true stale.
  // Picking "default" is itself a choice to stop being explicit.
  return { modelExplicit: !!(m && m !== 'default') };
}

// /resume's persist site: a typed --model is this resume's own pick, same
// as explicitModelFlag. Without one, the resumed session's currentModel is
// whatever Claude reports (a full claude-* id, never an explicit pick per
// isModelExplicit's legacy rule) — and /resume always starts a fresh room
// id, so persistSession has no prior record at that id to merge over; the
// flag would silently default to unset/false. resumePersisted (the record
// being resumed FROM, via listPersistedAgentSessions which spreads the
// whole row) is where the real answer lives, so it is carried forward
// explicitly. No persisted flag either (a legacy record): omit the key,
// same as explicitModelFlag never leaves a stale true — here there is
// nothing to leave, so isModelExplicit's own legacy fallback decides.
export function explicitModelFlagForResume(pickedModel, resumePersisted) {
  if (pickedModel) return explicitModelFlag(pickedModel);
  return resumePersisted?.modelExplicit !== undefined
    ? { modelExplicit: resumePersisted.modelExplicit }
    : {};
}

export function isModelExplicit(persisted) {
  if (persisted?.modelExplicit === true) return true;
  if (persisted?.modelExplicit === false) return false;
  const m = normalizeModelArg(persisted?.model);
  return m !== 'default' && LEGACY_PICKED_ALIASES.has(m);
}

// What a live role change does to a running session. An idle session is
// respawned (the recreateSession path /model and /restart use), so the block
// and the tool restrictions apply now rather than at the next idle reap; a
// busy one keeps running and picks the role up at its next spawn, except
// that a pending model switch is handed to the live /model path, which parks
// it until the turn ends.
//
// `parkedCommand` is the session's deferred-command slot
// (session._deferredCommandText). A `!model <x>` parked there WITHOUT
// `--implicit` is the user's own pick waiting for the turn to end — an
// explicit choice not persisted yet — so the implicit switch must not
// replace it (controller ruling, Task 5 review).
function isParkedUserModelPick(parkedCommand) {
  if (typeof parkedCommand !== 'string') return false;
  const parts = parkedCommand.trim().split(/\s+/);
  return parts[0] === '!model' && parts.length > 1 && !parts.slice(2).includes('--implicit');
}

// `busy` separates a running turn from the other occupied states (a pending
// question or permission prompt, the iv resume hold): only a running turn
// has a turn end to park a switch behind, and respawning under a pending
// question would kill it, so those wait for the next spawn. Defaults to
// `occupied` for callers that only know that much.
export function planCoordinatorTransition({ role, agent, occupied, busy = occupied, persisted, parkedCommand = null }) {
  const model = role === 'assigned'
    && agent === AGENT_CLAUDE
    && !isModelExplicit(persisted)
    && !isParkedUserModelPick(parkedCommand)
    && normalizeModelArg(persisted?.model) !== COORDINATOR_MODEL
    ? COORDINATOR_MODEL
    : null;
  if (!occupied) return { action: 'respawn', model };
  // Not busy: nothing to park behind, but the model still belongs to the
  // next spawn (spec §2e) — the caller persists it and holds it as the
  // session's pending model so a /restart meanwhile does not carry the old
  // live model over it.
  if (!busy) return { action: 'next-spawn', model };
  if (model) return { action: 'switch-model-live', model };
  return { action: 'next-spawn', model: null };
}

// The model recreateSession (the /restart, /model, /mode and Coordinator
// respawn path) hands the replacement when the caller does not override it.
// Normally the live model is carried across the swap. A Coordinator
// assignment that could not respawn at once leaves its model pending on the
// session (session._coordinatorModel): the live model then still reads as
// the OLD one — in iv mode it is re-observed from every assistant event,
// whatever /model was typed into the TUI — so carrying it would silently
// undo the switch. The pending model wins; a caller's explicit override
// still beats both. Codex keeps its explicit null ("use its config
// default") and is never given a pending Claude model.
export function recreateSpawnModel({ agent, currentModel, pendingModel = null }) {
  if (agent === AGENT_CODEX) return currentModel;
  return pendingModel || currentModel || undefined;
}

// --- Live role changes (spec §2a) ---
//
// `truth` is the answer of the forced GET /coordinator made after the event
// (createCoordinatorLookup.refresh). When it was fetched, it outranks the
// event: a frame replayed after a reconnect may describe a role that has
// moved on since, and a forged frame describes nothing. When it was not
// fetched but the role is known, the cache snapshot is the judge: a refresh
// superseded by a later event (A assigned, then B assigned at once) comes
// back fetched:false with the snapshot already on B, and a real failure
// leaves the snapshot where this event's apply() put it. Only when nothing
// is known at all is the event trusted outright — it did arrive on the
// journal's own socket.
//
// `pendingRole` is a role already queued on a busy session that has not
// respawned into it yet; it stands in for the spawn-time flag, so a replay
// of the same event during a long turn is 'none', not a second turn.
export function decideCoordinatorEvent({ role, convoId, truth, live, sessionCoordinator, pendingRole = null }) {
  if ((truth?.fetched || truth?.known) && (role === 'assigned') !== (truth.convoId === convoId)) return 'stale';
  if (!live) return role === 'assigned' ? 'persist-sleeping' : 'none';
  const current = pendingRole ? pendingRole === 'assigned' : !!sessionCoordinator;
  if (current === (role === 'assigned')) return 'none';
  return 'transition';
}

// The persisted-record edit for a Coordinator that is not running: the
// Claude spawn reads the top-level `model`, a resume reads the claude agent
// state's `model` (lib/agent-handoff.js getPersistedAgentState), so both are
// set. modelExplicit:false keeps the legacy alias rule in isModelExplicit
// from mistaking this write for a user pick.
export function withCoordinatorModel(record, model = COORDINATOR_MODEL) {
  const next = { ...record, model, modelExplicit: false };
  if (record?.agentSessions?.claude) {
    next.agentSessions = { ...record.agentSessions, claude: { ...record.agentSessions.claude, model } };
  }
  return next;
}
