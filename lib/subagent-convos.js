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

// Disposition returned by noteBackgroundTaskStarted so the caller (index.js) can
// decide whether a task_started warrants reviving/re-attaching the child, rather
// than reviving unconditionally on every start (loop #764).
//   STARTED_NEW      — fresh spawn, or a normal same-ref start on a live child,
//                      or a provisional FIFO mispairing corrected on a running
//                      child. Caller may forceAttach + revive (revive no-ops
//                      unless the child is finished).
//   RESUMED          — a genuinely resumed child: FINISHED child restarting under
//                      a NEW tool_use_id. Caller SHOULD forceAttach + revive.
//   REJECTED_REPLAY  — a replayed task_started for an already-finished run (the
//                      same ref the finished child still holds, or a ref already
//                      retired by a prior resume). Caller MUST NOT revive/attach,
//                      or the completed child flips back to a phantom 'running'.
//   IGNORED          — invalid input or an internal error; caller does nothing.
export const TASK_STARTED_STARTED_NEW = 'started-new';
export const TASK_STARTED_RESUMED = 'resumed';
export const TASK_STARTED_REJECTED_REPLAY = 'rejected-replay';
export const TASK_STARTED_IGNORED = 'ignored';

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
      // Retry a revive whose write-ahead record failed. Gated on the explicit
      // flag, NOT on "an event arrived for a done child": trailing tail events
      // after a finish are normal and must never resurrect a genuinely-done
      // child (see _upsertChild's note).
      if (child.state === CHILD_STATE_FINISHED && child.revivePending) {
        _tryRevive(child, agentId, {
          incrementGeneration: child.revivePendingIncrementGeneration ?? true,
        });
      }
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
    // An explicit task_started pairing wins; the FIFO is the sync-Task fallback
    // (the stream gives those no agentId to pair on). Track whether the ref came
    // FROM the FIFO — a rollback below must return it, or a retry re-mints with no
    // taskRef and its noteTaskResult() can never find the child. A preassigned ref
    // is a non-consuming Map lookup, so it needs no restore.
    const preassignedRef = preassignedRefs.get(agentId);
    const fifoRef = preassignedRef == null ? (pendingTaskRefs.shift() || null) : null;
    child = {
      agentId,
      parentConvoId,
      convoId: childConvoId(parentConvoId, agentId),
      taskRef: preassignedRef ?? fifoRef,
      title: subagentTitle(label, agentType),
      model: null,
      contextTokens: null,
      state: CHILD_STATE_RUNNING,
      // Set when a revive() could not durably record its write-ahead entry, so
      // the next event on this child retries the transition. Never set by an
      // ordinary trailing event — only an explicit, failed resume request.
      revivePending: false,
      // Which INCARNATION of this agent we are on. A resumed subagent reuses the
      // same agentId and the same child convo, so state alone cannot tell run 1's
      // in-flight `done` acknowledgement apart from run 2's — see finish().
      generation: 0,
    };
    children.set(agentId, child);
    if (child.taskRef) taskRefToAgent.set(child.taskRef, agentId);
    // Write-ahead: the running record MUST persist BEFORE we publish the running
    // state, or a process kill between the two leaves a server-visible running
    // child with no reconciliation record — the exact unrecoverable ghost this
    // feature exists to prevent. So the persist is a PRECONDITION, not best-effort:
    // if the store can't durably record it (returns false) or throws, roll back
    // the tentative in-memory registration and do NOT publish. The child stays
    // un-minted, so the next watcher poll re-discovers the agent and retries the
    // mint. (No store = reconciliation disabled/tests → nothing to gate on.)
    let recorded;
    try {
      recorded = runningStore
        ? runningStore.add(child.convoId, { parentConvoId: child.parentConvoId, agentId })
        : true;
    } catch (e) {
      warn(`[subagent-convos] runningStore.add failed: ${e.message}`);
      recorded = false;
    }
    if (recorded === false) {
      children.delete(agentId);
      if (child.taskRef) taskRefToAgent.delete(child.taskRef);
      // Return the FIFO Task ref we consumed to the FRONT of the queue so the
      // retry re-pairs it (a preassigned ref was never consumed).
      if (fifoRef) pendingTaskRefs.unshift(fifoRef);
      return null;
    }
    _upsertChild(child);
    _publishStatus(child);
    return child;
  }

  // The write-ahead half of a revive, shared by the explicit revive() call and
  // its retry from ensureChild. Same precondition as the original mint: never
  // publish `running` without a durable reconciliation record. A failure is NOT
  // terminal — it sets revivePending so the next event on this child retries,
  // otherwise one transient store hiccup would leave the entire resumed run
  // rendered `done` with no recovery path at all (Codex R2 F4).
  function _tryRevive(child, agentId, { incrementGeneration = true } = {}) {
    let recorded;
    try {
      recorded = runningStore
        ? runningStore.add(child.convoId, { parentConvoId: child.parentConvoId, agentId })
        : true;
    } catch (e) {
      warn(`[subagent-convos] runningStore.add failed: ${e.message}`);
      recorded = false;
    }
    if (recorded === false) {
      child.revivePending = true;
      // Carry the increment intent so the deferred retry (ensureChild) preserves
      // it: a corrective revival of a prematurely-finished FIRST run must not
      // advance generation even when its write-ahead is retried.
      child.revivePendingIncrementGeneration = incrementGeneration;
      return null;
    }
    child.revivePending = false;
    // Generation advances only for a genuine RESUME (a new incarnation). A
    // corrective revival (restoring a first run finished early by the launch
    // tool_result, loop #764 F1) is the SAME incarnation, so leaving generation
    // at 0 keeps the never-resumed id-less completion fallback working (#751).
    if (incrementGeneration) child.generation += 1;
    child.state = CHILD_STATE_RUNNING;
    // Carry parentConvoId for the same reason finish() does: the row may not
    // exist (an undelivered mint), making this frame the INSERT, and
    // parent_convo_id is write-once.
    _upsertChild(child);
    return child;
  }

  function finish(agentId) {
    const child = children.get(agentId);
    if (!child || child.state === CHILD_STATE_FINISHED) {
      // A resume whose write-ahead record never landed, whose run has now ended
      // anyway: `done` is the truthful state, so stop trying to revive it.
      if (child) child.revivePending = false;
      return;
    }
    child.state = CHILD_STATE_FINISHED;
    // Clear the running record on the `done` frame's LOCAL send completion
    // (onLocalSendComplete = the ws.send write callback, NOT a server commit ack —
    // none exists on this path). Not settling here at all is not an option for this
    // site: reconcileStrandedSubagents only retires children whose PARENT convo is no
    // longer owned by a live session, so a finished child under a still-live parent
    // would otherwise linger in the store forever (and grow it per child). So the
    // local-send clear stays, and reconcile is the BACKSTOP: a queue-overflow drop or
    // crash-before-flush never fires this callback, so the write-ahead record survives
    // and the next startup/reconnect reconcile re-publishes `done` idempotently once the
    // parent is terminal. Residual (shared with the codex F4 note path): a `done` whose
    // write callback fired but whose server commit was lost, under a still-live parent,
    // heals only when the parent itself goes terminal — not permanently stranded, but
    // later than a true server ack would allow. onLocalSendComplete omitted when there's
    // no store (tests / disabled reconciliation).
    // The incarnation THIS frame settles. An acknowledgement only ever clears the
    // record written by its own run: a resume between publish and ack (state flips
    // back to running) OR a resume-and-finish (state is `done` again, but it is run
    // N+1's `done`, gated on a LATER frame's delivery) must both leave the record
    // alone. State alone cannot see the second case — run 1's stale ack would erase
    // run 2's write-ahead record and leave an unreconcilable `running` row if run 2's
    // own `done` were then lost.
    const generation = child.generation;
    const onLocalSendComplete = runningStore
      ? () => {
        if (child.state !== CHILD_STATE_FINISHED) return;
        if (child.generation !== generation) return;
        try { runningStore.remove(child.convoId); }
        catch (e) { warn(`[subagent-convos] runningStore.remove failed: ${e.message}`); }
      }
      : undefined;
    // Carry parentConvoId on the terminal frame too. finish() normally runs
    // after _upsertChild() already INSERTed the row, so the UPDATE path ignores
    // parentage — but this feature makes the record-survives-undelivered-send
    // path routine, so the `running` upsert can be lost (SIGKILL before flush,
    // socket down at mint) and this `done` frame becomes the INSERT. parent_convo_id
    // is written ONLY on INSERT (immutable after), so omitting it here would mint
    // an untitled ROOT orphan. child.parentConvoId is in memory — always include it.
    publisher.upsertConvo(
      child.convoId,
      { sessionState: CHILD_STATE_FINISHED, parentConvoId: child.parentConvoId },
      onLocalSendComplete ? { onLocalSendComplete } : undefined,
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
        if (typeof toolUseId !== 'string' || !toolUseId) return TASK_STARTED_IGNORED;
        if (typeof taskId !== 'string' || !taskId) return TASK_STARTED_IGNORED;
        // Whether a task_started for THIS ref was already processed. backgroundRefs
        // is add-only, so `has` before the add distinguishes the FIRST start for a
        // ref from a replay of it — the discriminator the same-ref branch needs.
        const startAlreadySeen = backgroundRefs.has(toolUseId);
        const queued = pendingTaskRefs.indexOf(toolUseId);
        if (queued !== -1) pendingTaskRefs.splice(queued, 1);
        backgroundRefs.add(toolUseId);
        taskRefToAgent.set(toolUseId, taskId);
        preassignedRefs.set(taskId, toolUseId);
        const child = children.get(taskId);
        // No child yet: a fresh background spawn that discovery will mint running.
        if (!child) return TASK_STARTED_STARTED_NEW;
        if (child.taskRef === toolUseId) {
          // A task_started carrying the ref the child ALREADY holds.
          if (child.state !== CHILD_STATE_FINISHED) return TASK_STARTED_STARTED_NEW;
          // The child is finished under this same ref. Two cases:
          //   * FIRST start for the ref (!startAlreadySeen): discovery FIFO-paired
          //     the ref onto the child, then the instant launch tool_result
          //     finished it prematurely (noteTaskResult, before backgroundRefs was
          //     populated) — this task_started is the child's genuine first start,
          //     so it must revive, not be dropped (Codex #764 F1). A live agent
          //     shown 'done' otherwise.
          //   * REPLAY (startAlreadySeen): the run already had its task_started and
          //     completed normally; a genuine resume would carry a NEW ref, so a
          //     repeat of the same ref is a replayed start — reviving it would
          //     resurrect a completed child as a phantom 'running'.
          return startAlreadySeen
            ? TASK_STARTED_REJECTED_REPLAY
            : TASK_STARTED_STARTED_NEW;
        }
        // Ref-change (child.taskRef !== toolUseId).
        //
        // Loop #751 hardening: reject a REPLAYED task_started that would restore a
        // RETIRED incarnation's ref — doing so would let a replayed run-N
        // completion pass the taskRef match and finish live run N+1, defeating the
        // completion gate.
        if (child.retiredRefs?.has(toolUseId)) return TASK_STARTED_REJECTED_REPLAY;
        // A ref-change while the child is FINISHED is a genuine RESUME: run N
        // completed (child FINISHED) before the resume's task_started fired, so
        // record the outgoing (run-N) ref as retired and advance to the new ref.
        if (child.state === CHILD_STATE_FINISHED && child.taskRef) {
          (child.retiredRefs ??= new Set()).add(child.taskRef);
          child.taskRef = toolUseId;
          _publishStatus(child);
          return TASK_STARTED_RESUMED;
        }
        // A ref-change while the child is RUNNING is NOT a retirement: it is a
        // provisional FIFO mispairing being corrected by its authoritative
        // pairing (the documented discovery-beats-system-event / reverse-discovery
        // path) and must be allowed. State alone is not a valid discriminator (it
        // rejected these valid corrections — #751 delta-gate F1).
        child.taskRef = toolUseId;
        _publishStatus(child);
        return TASK_STARTED_STARTED_NEW;
      } catch (e) {
        warn(`[subagent-convos] noteBackgroundTaskStarted failed: ${e.message}`);
        // Fail conservative: an uncertain start must not trigger a revive.
        return TASK_STARTED_IGNORED;
      }
    },

    // System task_notification: the background task's REAL completion.
    // task_id is the agentId, so this finishes the child directly — no ref
    // lookup, no FIFO. Safe no-op for agents never discovered (finish() on a
    // missing child does nothing).
    //
    // Gate on the notification's tool_use_id matching the child's CURRENT run
    // (child.taskRef). A subagent RESUMED via SendMessage runs again under the
    // SAME agentId but a NEW tool_use_id, which noteBackgroundTaskStarted
    // advances child.taskRef to. So a DUPLICATED or REPLAYED task_notification
    // for a PRIOR incarnation (run N) carries run N's now-stale tool_use_id and
    // must NOT finish the live resumed run (run N+1) — the exact defect loop
    // #751 describes (a late run-N notification killing run N+1).
    //
    // Correlated case (tool_use_id present): finish ONLY if it matches the
    // child's current taskRef; a mismatch is a stale/replayed notification and
    // is ignored.
    //
    // Uncorrelated case (no tool_use_id — streams that omit the field): we have
    // no way to tell which incarnation the notification reports. If the agent
    // has been RESUMED (generation >= 1) more than one incarnation exists, so
    // finishing blindly risks killing the live run — the very defect this gate
    // prevents; ignore it and let finishAll settle the child at parent teardown
    // (a briefly stranded 'running' card is far less harmful than a live agent
    // shown dead). A never-resumed child (generation 0) has exactly one
    // incarnation, so an uncorrelated completion is unambiguous and still
    // finishes — preserving support for producers that don't emit tool_use_id.
    noteTaskCompleted(taskId, toolUseId) {
      try {
        const child = children.get(taskId);
        if (typeof toolUseId === 'string' && toolUseId) {
          if (child && child.taskRef && child.taskRef !== toolUseId) return;
        } else if (child && child.generation > 0) {
          // Uncorrelated completion for a resumed child: fail VISIBLY rather than
          // silently strand or blindly finish. Not reachable via a self-consistent
          // producer — a child only reaches generation > 0 because the resume's
          // task_started carried a tool_use_id (index.js gates revive on it), and a
          // producer that emits the id on task_started emits it on task_notification
          // too — so this fires only on an inconsistent/degraded stream, where
          // leaving the live run untouched (finishAll settles it at teardown) beats
          // risking a finish of the wrong incarnation.
          warn(`[subagent-convos] ignoring uncorrelated task_notification for resumed child ${taskId} (no tool_use_id; generation=${child.generation})`);
          return;
        }
        finish(taskId);
      } catch (e) { warn(`[subagent-convos] noteTaskCompleted failed: ${e.message}`); }
    },

    // A subagent RESUMED via SendMessage runs again under the SAME agentId and
    // therefore the SAME deterministic child convo. If this tracker already
    // finished that child, nothing in the discovery/event path ever sets the
    // server back to `running` (_upsertChild publishes the child's CURRENT
    // state, and ensureChild only re-upserts on a title change) — so the card
    // would render `done` for the entire resumed run: a live agent that looks
    // dead in every client. Put it back to `running`.
    //
    // Same write-ahead precondition as the original mint: re-arm the persistent
    // running record BEFORE publishing, and don't publish at all if it can't be
    // durably recorded. After a bridge restart the tracker is fresh and this is
    // a no-op — discovery mints the child running on its own.
    //
    // No-op (returns null) for an unknown agent and for one already running.
    //
    // incrementGeneration (default true) advances the incarnation counter for a
    // genuine RESUME. Pass false for a corrective revival of a first run finished
    // early by the launch tool_result (loop #764 F1): that is the same
    // incarnation, so generation must stay put or the id-less completion fallback
    // (#751) would wrongly treat the single run as resumed and strand it.
    revive(agentId, { incrementGeneration = true } = {}) {
      try {
        const child = children.get(agentId);
        if (!child || child.state !== CHILD_STATE_FINISHED) return null;
        return _tryRevive(child, agentId, { incrementGeneration });
      } catch (e) {
        warn(`[subagent-convos] revive failed: ${e.message}`);
        return null;
      }
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
