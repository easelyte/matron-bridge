import { buildSessionStatus, contextTokensFromUsage } from './session-status.js';

// Subagent child conversations (spec: matron-apple
// docs/superpowers/specs/2026-07-15-subagent-subchats-design.md, PR B).
//
// When the parent's subagent watcher (lib/subagent-watcher.js) discovers a
// subagent, that subagent gets its OWN journal conversation, linked to the
// parent via parent_convo_id. Its text/tool-output/diffs route to the child
// convo instead of being prefixed into the parent, and its model/context are
// published as a per-subagent `status` on the child. This module owns that
// lifecycle state machine; index.js is a thin adapter that forwards the
// watcher's events (and the parent stream's Task tool_use / tool_result) into
// it and routes the child's text/diffs through publisher methods with the
// convo id this module hands back.

// The child convo id is derived deterministically from the parent convo id and
// the watcher's agentId, so a bridge restart / journal reconnect re-derives the
// exact same id rather than minting a duplicate conversation. ':' is a safe
// separator: convo ids are opaque strings server-side (GRDB primary keys in the
// apps). A 36-char UUID parent + this 5-char infix + a 36-char UUID agentId is
// 77 chars, comfortably under the server's 128-char id cap.
export const CHILD_CONVO_INFIX = ':sub:';

// session_state is a hard enum server-side (matron-journal src/db.js CHECK
// constraint IN ('running','waiting','done','archived')), NOT a free string —
// so a child runs as 'running' and completes as 'done'. The spec's "finished"
// maps to 'done', the only terminal value the server will accept; sending
// 'finished' would fail the DB constraint. task_ref therefore CANNOT ride
// inside session_state (nor can session_state be JSON-encoded) — it travels in
// the child's status payload instead (see _publishStatus).
export const CHILD_STATE_RUNNING = 'running';
export const CHILD_STATE_FINISHED = 'done';

export function childConvoId(parentConvoId, agentId) {
  return `${parentConvoId}${CHILD_CONVO_INFIX}${agentId}`;
}

// Child title from the sidecar meta: the watcher's resolved label (which is
// itself description -> agentType -> short-id inside the watcher), falling back
// to agentType, then null so the caller omits the title entirely rather than
// blanking an existing one.
export function subagentTitle(label, agentType) {
  if (typeof label === 'string' && label.trim()) return label;
  if (typeof agentType === 'string' && agentType.trim()) return agentType;
  return null;
}

/**
 * Owns the child-conversation lifecycle for one parent session's subagents.
 *
 * @param {object}   opts
 * @param {object}   opts.publisher         journal publisher (lib/journal-publisher.js)
 * @param {function} opts.getParentConvoId  () => the parent's stable journal convo id (or null if not known yet)
 * @param {object}   [opts.runningStore]    persistent running-child store (lib/subagent-running-store.js); add on mint, remove on finish, so a bridge restart can reconcile ghosts from persisted state. Optional — omitted in tests that don't exercise reconciliation.
 * @param {object}   [opts.log]             logger with .warn (defaults to console)
 * @returns {object} tracker
 */
export function createSubagentConvoTracker({ publisher, getParentConvoId, runningStore = null, log = console } = {}) {
  // agentId -> child record.
  const children = new Map();
  // Task tool_use_ids seen in the parent stream but not yet paired to a
  // discovered subagent. The watcher can't reliably tell which Task call
  // produced which agent-<id>.jsonl (the spec calls this out), so we pair
  // FIFO — a best-effort association. When it's wrong the app still reaches the
  // child via the parent's child strip; when it's right the Task card links.
  const pendingTaskRefs = [];
  // task_ref -> agentId, so the matching Task tool_result finishes the right
  // child. Whatever ref we paired at discovery is the one we finish on — a
  // consistent (if occasionally misassociated) mapping.
  const taskRefToAgent = new Map();
  // Background spawns (Agent tool, run_in_background): the stream's
  // task_started system event pairs tool_use_id ↔ task_id EXPLICITLY (the
  // task_id is the watcher's agentId — agent-<task_id>.jsonl), so these never
  // ride the FIFO. Their refs also go in backgroundRefs: the spawning
  // tool_result arrives instantly at launch ("Async agent launched…"), so it
  // must NOT finish the child — the task_notification system event is the
  // real completion signal (noteTaskCompleted).
  const backgroundRefs = new Set();
  // agentId -> task_ref pre-registered by task_started before the watcher
  // discovers the transcript; ensureChild consumes it ahead of the FIFO.
  const preassignedRefs = new Map();

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // Upsert the child with its CURRENT state — never a hard-coded 'running'.
  // Trailing tail events are normal after the parent's Task tool_result (the
  // final answer drains late), and a title refresh riding one of them must not
  // resurrect a done child: the tracker already believes it is finished, so
  // nothing would ever set the server back to 'done'.
  function _upsertChild(child) {
    const opts = { sessionState: child.state, parentConvoId: child.parentConvoId };
    if (child.title != null) opts.title = child.title;
    publisher.upsertConvo(child.convoId, opts);
  }

  // Per-subagent status on the child convo: the subagent's own model and
  // context footprint (read straight off its events — see onEvent), plus the
  // task_ref linking the child back to the spawning Task card. buildSessionStatus
  // omits absent parts, so an early status may be task_ref-only; a status with
  // nothing to say is skipped. The journal server caches the last status per
  // convo and replays it on viewing, so task_ref reliably reaches the apps.
  function _publishStatus(child) {
    const status = buildSessionStatus({ model: child.model, contextTokens: child.contextTokens });
    if (child.taskRef) status.task_ref = child.taskRef;
    if (Object.keys(status).length === 0) return;
    publisher.publishStatus(child.convoId, status);
  }

  function ensureChild(agentId, { label, agentType } = {}) {
    let child = children.get(agentId);
    if (child) {
      // Update the title if a real label/agentType arrived after discovery
      // (the .meta.json is sometimes written a beat after the .jsonl, so the
      // first discovery can carry only the short-id fallback). parent_convo_id
      // is immutable server-side, so re-upserting is safe.
      const title = subagentTitle(label, agentType);
      if (title && title !== child.title) {
        child.title = title;
        _upsertChild(child);
      }
      return child;
    }
    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) {
      // The watcher only exists once the parent session id is known, so this
      // is not expected — but never route a child under a missing parent.
      warn(`[subagent-convos] no parent convo id yet — skipping child for ${agentId}`);
      return null;
    }
    child = {
      agentId,
      parentConvoId,
      convoId: childConvoId(parentConvoId, agentId),
      // An explicit task_started pairing wins; the FIFO is the sync-Task
      // fallback (the stream gives those no agentId to pair on).
      taskRef: preassignedRefs.get(agentId) ?? (pendingTaskRefs.shift() || null),
      title: subagentTitle(label, agentType),
      model: null,
      contextTokens: null,
      state: CHILD_STATE_RUNNING,
    };
    children.set(agentId, child);
    if (child.taskRef) taskRefToAgent.set(child.taskRef, agentId);
    // Write-ahead: persist the running record BEFORE publishing the running
    // state. A process kill between the two would otherwise leave a
    // server-visible running child with no reconciliation record — an
    // unrecoverable ghost. Persist first so recovery intent always precedes the
    // externally visible mutation. Best-effort — a store hiccup (surfaced by the
    // store's own warn) must never break the live subagent feature; the residual
    // is one child whose record failed to write, visible in the logs.
    try { runningStore?.add(child.convoId, { parentConvoId: child.parentConvoId, agentId }); }
    catch (e) { warn(`[subagent-convos] runningStore.add failed: ${e.message}`); }
    _upsertChild(child);
    _publishStatus(child);
    return child;
  }

  function finish(agentId) {
    const child = children.get(agentId);
    if (!child || child.state === CHILD_STATE_FINISHED) return;
    child.state = CHILD_STATE_FINISHED;
    // Clear the running record ONLY once the `done` frame is confirmed delivered.
    // Removing eagerly would discard the write-ahead record while a
    // queue-overflow drop or a crash-before-flush left the server still running
    // — an unrecoverable ghost. Until delivery the record survives, so the next
    // startup/reconnect reconcile re-publishes `done` idempotently. onDelivered
    // omitted when there's no store (tests / disabled reconciliation).
    const onDelivered = runningStore
      ? () => {
        try { runningStore.remove(child.convoId); }
        catch (e) { warn(`[subagent-convos] runningStore.remove failed: ${e.message}`); }
      }
      : undefined;
    publisher.upsertConvo(
      child.convoId,
      { sessionState: CHILD_STATE_FINISHED },
      onDelivered ? { onDelivered } : undefined,
    );
  }

  return {
    // Parent stream saw a `Task`/`Agent` tool_use — remember its tool_use_id to
    // pair with the next discovered subagent (FIFO). A NESTED Task (one a
    // subagent spawned, observed in the subagent's own stream) must NOT enter
    // the queue: its tool_result only ever appears in the subagent's
    // transcript, never the parent stream, so the ref could never be consumed
    // — it would only mis-pair the next sibling and let a parent tool_result
    // mark the wrong child done. Nested children carry no task_ref (the app
    // reaches them via the child strip) and settle via finishAll.
    noteTaskStarted(toolUseId, { nested = false } = {}) {
      try {
        if (nested) return;
        if (typeof toolUseId === 'string' && toolUseId) pendingTaskRefs.push(toolUseId);
      } catch (e) { warn(`[subagent-convos] noteTaskStarted failed: ${e.message}`); }
    },

    // Parent stream saw a tool_result — if its tool_use_id is a SYNC Task we
    // paired to a child, that subagent has completed. No-op for every other
    // tool, and for background refs: their tool_result fires at LAUNCH
    // ("Async agent launched…"), not completion — finishing here would mark a
    // child done seconds into a minutes-long run. Background children settle
    // via noteTaskCompleted (the task_notification system event).
    noteTaskResult(toolUseId) {
      try {
        if (backgroundRefs.has(toolUseId)) return;
        const agentId = taskRefToAgent.get(toolUseId);
        if (agentId) finish(agentId);
      } catch (e) { warn(`[subagent-convos] noteTaskResult failed: ${e.message}`); }
    },

    // System task_started: the stream's explicit tool_use_id ↔ task_id
    // pairing for a background spawn (task_id IS the watcher's agentId).
    // Pull the ref out of the FIFO (noteTaskStarted queued it when the Agent
    // tool_use appeared — it must not mis-pair the next sibling), remember it
    // as background, and attach it to the child directly — back-filling and
    // republishing status if discovery already created the child ref-less.
    noteBackgroundTaskStarted(toolUseId, taskId) {
      try {
        if (typeof toolUseId !== 'string' || !toolUseId) return;
        if (typeof taskId !== 'string' || !taskId) return;
        const queued = pendingTaskRefs.indexOf(toolUseId);
        if (queued !== -1) pendingTaskRefs.splice(queued, 1);
        backgroundRefs.add(toolUseId);
        taskRefToAgent.set(toolUseId, taskId);
        preassignedRefs.set(taskId, toolUseId);
        const child = children.get(taskId);
        if (child && child.taskRef !== toolUseId) {
          child.taskRef = toolUseId;
          _publishStatus(child);
        }
      } catch (e) { warn(`[subagent-convos] noteBackgroundTaskStarted failed: ${e.message}`); }
    },

    // System task_notification: the background task's REAL completion.
    // task_id is the agentId, so this finishes the child directly — no ref
    // lookup, no FIFO. Safe no-op for agents never discovered (finish() on a
    // missing child does nothing).
    noteTaskCompleted(taskId) {
      try { finish(taskId); }
      catch (e) { warn(`[subagent-convos] noteTaskCompleted failed: ${e.message}`); }
    },

    // Watcher discovery (subagent-start): create + upsert the child running,
    // publish its first status (carrying task_ref). Idempotent per agentId.
    discover(agentId, meta) {
      try { return ensureChild(agentId, meta); }
      catch (e) { warn(`[subagent-convos] discover failed: ${e.message}`); return null; }
    },

    // Watcher event (subagent-event): ensure the child exists, refresh its
    // title, and derive+publish its per-subagent status from the subagent's OWN
    // event. Deliberately reads event.message.model / event.message.usage
    // directly rather than via modelFromEvent / contextTokensFromAssistantEvent
    // — those guards return null for subagent-tagged (isSidechain /
    // parent_tool_use_id) events precisely to protect the PARENT's model/gauge;
    // the child's own numbers live on the very events those guards reject.
    // Returns the child (with its convoId) so index.js can route text/diffs.
    onEvent(agentId, { label, agentType, event } = {}) {
      try {
        const child = ensureChild(agentId, { label, agentType });
        if (!child) return null;
        if (event && event.type === 'assistant' && event.message) {
          const model = event.message.model;
          if (typeof model === 'string' && model) child.model = model;
          const tokens = contextTokensFromUsage(event.message.usage);
          if (tokens != null) child.contextTokens = tokens;
        }
        _publishStatus(child);
        return child;
      } catch (e) {
        warn(`[subagent-convos] onEvent failed: ${e.message}`);
        return null;
      }
    },

    // Child convo id for an already-discovered agent, else null.
    convoIdFor(agentId) {
      return children.get(agentId)?.convoId ?? null;
    },

    // Terminal sweep: mark every still-running child done. Called when the
    // parent session tears down (the watcher's transcript tails close) — the
    // "transcript closes" completion signal and the catch-all for any subagent
    // whose Task tool_result was never paired. Idempotent.
    finishAll() {
      try { for (const agentId of children.keys()) finish(agentId); }
      catch (e) { warn(`[subagent-convos] finishAll failed: ${e.message}`); }
    },
  };
}
