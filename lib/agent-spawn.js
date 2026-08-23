// Parent-side agent spawn (spec: docs/superpowers/specs/
// 2026-08-10-agent-spawn-bridge-capacity-design.md): the bridge half of the
// journal's consent-brokered spawn flow. Two loopback handlers backing the
// agent_boxes / agent_session_start MCP tools, plus the kind:'spawn' frame
// consumer. Correlation is a request_id-keyed waiter map in the
// agent-invites style — armed BEFORE the frame is sent, because a frame
// batch can drain in one tick.

import { randomUUID } from 'crypto';
import { peerField, quotedField, PEER_ID_MAX } from './peer-text.js';

const TASK_MAX_CHARS = 2000;      // journal SPAWN_TASK_MAX_CHARS
const TOPIC_MAX_CHARS = 200;      // journal INVITE_TOPIC_MAX_CHARS
const WORKDIR_MAX_CHARS = 1024;   // journal SPAWN_WORKDIR_MAX_CHARS

// Tombstone TTL/sweep for pendingSpawns (see HANDLED below): generous
// relative to the journal's own spawn-expiry horizon (minutes), so it never
// competes with real ask lifetimes — it only bounds how long a *resolved*
// spawn's dedup marker lingers. Hourly sweep is plenty of resolution for a
// 24h TTL; both are overridable so tests don't need to wait real hours.
const HANDLED_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// deps: sessions, publisher, rooms, journalConvoIdFor(session) -> convoId|null,
//       notifyParent({session, convoId, text}), targetsTimeoutMs,
//       pendingTimeoutMs, handledTtlMs, sweepIntervalMs, log
export function createAgentSpawnHandlers({
  sessions,
  publisher,
  rooms,
  journalConvoIdFor = () => null,
  notifyParent = () => {},
  targetsTimeoutMs = 10000,
  pendingTimeoutMs = 10000,
  handledTtlMs = HANDLED_TTL_MS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  log = console,
} = {}) {
  const waiters = new Map();        // request_id -> {resolve, timer}
  const pendingSpawns = new Map();  // spawn_id -> {sessionKey, convoId, task, topic} | {[HANDLED]: true, ts}

  // Sentinel left in pendingSpawns once an outcome for a spawn id has been
  // notified — a duplicate outcome frame (the journal is at-most-once but
  // the wire is not) must produce no second notifyParent. A plain delete
  // can't tell "already handled" apart from "never tracked" (bridge
  // restarted between the ack and the outcome, so the context never
  // existed): both read back as absent. Tagged with a Symbol-keyed property
  // rather than a bare marker value so it can carry a timestamp for the
  // sweep below while staying unmistakable from a real context object
  // (whose keys are all plain strings).
  const HANDLED = Symbol('handled');
  const isHandled = (entry) => !!entry && entry[HANDLED] === true;

  // Sweep ONLY tombstones (isHandled entries) older than handledTtlMs — a
  // real, still-pending context (armed by sessionStart, awaiting its
  // outcome frame) is never touched by this sweep at all, regardless of
  // age, so a slow-to-answer spawn can never be evicted out from under
  // handleOutcome. Unbounded growth was the actual bug: every outcome frame
  // — including one for a request_id this bridge never tracked — left a
  // permanent tombstone; this bounds that to handledTtlMs.
  function sweepHandled() {
    const now = Date.now();
    for (const [id, entry] of pendingSpawns) {
      if (isHandled(entry) && now - entry.ts > handledTtlMs) pendingSpawns.delete(id);
    }
  }
  if (sweepIntervalMs > 0) {
    const sweepTimer = setInterval(sweepHandled, sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  const await_ = (requestId, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(requestId); resolve({ kind: 'timeout' }); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.set(requestId, { resolve, timer });
  });
  const settle = (requestId, value) => {
    const w = waiters.get(requestId);
    if (!w) return false;
    waiters.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(value);
    return true;
  };

  function callerSession(data) {
    const { roomId } = data || {};
    if (!roomId || typeof roomId !== 'string') return { err: { status: 400, body: { error: 'roomId is required' } } };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    return { session, sessionKey: roomId };
  }

  // Single-line summary published into the parent's session convo when a
  // spawn resolves. `ctx` may be null (bridge restarted between the ack and
  // the outcome frame — the pendingSpawns entry didn't survive), in which
  // case there is no task to prefix. ctx.task was already flattened/cleaned
  // via peerField when it was captured in sessionStart (below), but the
  // prefix here still wraps it in a literal `"…"` — a structural quote —
  // so it goes through quotedField (escapes embedded `"`/`\`) on top of
  // that, same discipline as formatInviteRequestNotice in agent-invites.js.
  // frame.room_id/child_convo_id/error_code (and, in the default branch,
  // frame.outcome itself) are target-bridge-authored — the journal validates
  // child_convo_id/error_code for length only, no character sanitization —
  // so a compromised peer box can inject newlines/control chars into a
  // notice this bridge signs and publishes. peerField (same helper
  // agent-invites.js uses for f.room_id) flattens newlines, strips control
  // chars and caps length; the `|| 'unknown'` fallback covers both an empty
  // sanitized result and a missing/undefined field, curing the literal-
  // `undefined` interpolation a 'started' outcome gets when the journal
  // omits room_id/child_convo_id.
  function safeFrameField(value) {
    return peerField(value, PEER_ID_MAX) || 'unknown';
  }

  function describeOutcome(frame, ctx) {
    const id = frame.request_id;
    const prefix = ctx && typeof ctx.task === 'string' && ctx.task ? `"${quotedField(ctx.task.slice(0, 60))}" — ` : '';
    switch (frame.outcome) {
      case 'started':
        return `🚀 Spawn ${id}: ${prefix}session started on the target box. Chat room ${safeFrameField(frame.room_id)} is the channel; the child was seeded with your task and will report there. Child conversation: ${safeFrameField(frame.child_convo_id)}.`;
      case 'declined':
        return `🚫 Spawn ${id}: ${prefix}the user declined the request.`;
      case 'expired':
        return `⌛ Spawn ${id}: ${prefix}the request expired unanswered (24h).`;
      case 'failed':
        return `❌ Spawn ${id}: ${prefix}failed (${safeFrameField(frame.error_code)}).`;
      default:
        return `Spawn ${id}: ${prefix}${safeFrameField(frame.outcome)}.`;
    }
  }

  function handleOutcome(frame) {
    const entry = pendingSpawns.get(frame.request_id);
    // Already notified for this spawn id — a duplicate frame is a no-op.
    if (isHandled(entry)) return;
    const ctx = entry || null;
    // Tombstone BEFORE notifying — exactly-once surfacing: a duplicate
    // outcome frame for the same spawn id finds the tombstone, not the
    // context, and returns above without a second notifyParent. ts feeds
    // the sweep above; it is never read for correctness, only for pruning.
    pendingSpawns.set(frame.request_id, { [HANDLED]: true, ts: Date.now() });
    if (!ctx) {
      notifyParent({ session: null, convoId: null, text: describeOutcome(frame, null) });
      return;
    }
    const session = sessions.get(ctx.sessionKey) || null;
    if (frame.outcome === 'started' && typeof frame.room_id === 'string' && frame.room_id) {
      // SAME-BOX spawn (#690 F1): when the parent spawns on its OWN box this
      // bridge is BOTH the parent's bridge and the target bridge, so the
      // target-side `start` handler (index.js bindSpawnRoom) has ALREADY bound
      // the child session into THIS registry as the primary binding —
      // {role:'guest', sessionRoomId: <child's bridge session key>} — before
      // this outcome frame arrives (approveSpawn awaits the start reply first,
      // so bindSpawnRoom runs strictly before us on the same connection). If we
      // then record the parent via sessionRoomId, record()'s merge OVERWRITES
      // that child key and the room loses its second local end: guestSessionRoomId
      // stays null, so lib/agent-rooms no longer treats it as a local room and
      // the child cannot route its report back to the parent. So detect that
      // pre-bound local child binding and PROMOTE it into the guest slot instead
      // of clobbering it — keeping BOTH local ends in the one record.
      //
      // The guest key MUST be the key bindSpawnRoom stored, NOT frame.child_convo_id:
      // a freshly spawned session mints its journal convo id (what the outcome
      // carries) separately from its bridge session key (what bindSpawnRoom
      // recorded and what the child's own MCP calls are keyed on), so the two
      // differ. CROSS-box: bindSpawnRoom ran on the REMOTE target box, so no
      // such local record exists here — `existing` is null and this stays
      // owner-only, exactly as before (a remote child must NOT be bound as a
      // local guest or its report would misroute to a non-existent local session).
      // Provenance is narrowed as tightly as the local state allows so an
      // unrelated single-ended record can never be misread as the child (room
      // id is already a fresh per-spawn UUID, so this is defence-in-depth):
      //   - the record must look EXACTLY like bindSpawnRoom's write
      //     ({role:'guest', state:'joined'}) — not merely any single-ended room;
      //   - it must be single-ended (guestSessionRoomId still null);
      //   - its key must not be the parent's own session; and
      //   - it must name a session that is LIVE in this bridge right now (the
      //     child bindSpawnRoom just started), so a stale/dead persisted
      //     binding is never promoted into a routable guest.
      let sameBoxChildKey = null;
      try {
        const existing = rooms.get?.(frame.room_id);
        if (existing && existing.role === 'guest' && existing.state === 'joined'
          && existing.guestSessionRoomId == null
          && typeof existing.sessionRoomId === 'string'
          && existing.sessionRoomId !== ctx.sessionKey
          && sessions.get(existing.sessionRoomId)) {
          sameBoxChildKey = existing.sessionRoomId;
        }
      } catch { /* get is best-effort; absent -> owner-only (cross-box) */ }
      // Registry write must not swallow the notify below.
      try {
        rooms.record(frame.room_id, {
          role: 'owner',
          state: 'joined',
          sessionRoomId: ctx.sessionKey,
          topic: ctx.topic,
          title: ctx.topic || (ctx.task || '').slice(0, 80),
          ...(sameBoxChildKey ? { guestSessionRoomId: sameBoxChildKey, guestState: 'joined' } : {}),
        });
      } catch (e) {
        try { log.warn(`[agent-spawn] rooms.record failed: ${e.message}`); } catch { }
      }
    }
    notifyParent({ session, convoId: ctx.convoId, text: describeOutcome(frame, ctx) });
  }

  return {
    async boxes(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (!publisher.identity()) {
        return { status: 409, body: { error: 'journal identity unknown; try again shortly' } };
      }
      const rid = randomUUID();
      const p = await_(rid, targetsTimeoutMs);
      if (!publisher.sendRoomOp({ op: 'spawn_targets', request_id: rid })) {
        settle(rid, { kind: 'discarded' });
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      const r = await p;
      if (r.kind === 'timeout') return { status: 504, body: { error: 'timed out waiting for the journal' } };
      if (r.kind === 'op_error') return { status: 502, body: { error: r.detail || r.code || 'journal error', code: r.code } };
      return { status: 200, body: { boxes: r.boxes } };
    },

    async sessionStart(data) {
      const { session, err } = callerSession(data);
      if (err) return err;
      const { device_id: deviceId, workdir, task, topic } = data || {};
      if (!Number.isInteger(deviceId)) return { status: 400, body: { error: 'device_id must be an integer' } };
      if (typeof workdir !== 'string' || !workdir || workdir.length > WORKDIR_MAX_CHARS) {
        return { status: 400, body: { error: `workdir is required and must be at most ${WORKDIR_MAX_CHARS} characters` } };
      }
      if (typeof task !== 'string' || !task || task.length > TASK_MAX_CHARS) {
        return { status: 400, body: { error: `task is required and must be at most ${TASK_MAX_CHARS} characters` } };
      }
      if (topic !== undefined && (typeof topic !== 'string' || topic.length > TOPIC_MAX_CHARS)) {
        return { status: 400, body: { error: `topic must be a string of at most ${TOPIC_MAX_CHARS} characters` } };
      }
      const fromConvoId = journalConvoIdFor(session);
      if (!fromConvoId) return { status: 409, body: { error: 'session has no journal conversation yet' } };

      const rid = randomUUID();
      const p = await_(rid, pendingTimeoutMs);
      const frame = {
        op: 'spawn_request',
        request_id: rid,
        from_convo_id: fromConvoId,
        target_device_id: deviceId,
        workdir,
        task,
        ...(topic ? { topic } : {}),
      };
      if (!publisher.sendRoomOp(frame)) {
        settle(rid, { kind: 'discarded' });
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      const r = await p;
      if (r.kind === 'timeout') return { status: 504, body: { error: 'timed out waiting for the journal' } };
      if (r.kind === 'op_error') {
        if (r.code === 'conflict') return { status: 409, body: { error: r.detail || 'conflicting spawn state' } };
        if (r.code === 'agent_unreachable') return { status: 502, body: { error: 'target box is offline' } };
        if (r.code === 'not_found') return { status: 404, body: { error: r.detail || 'target not found' } };
        return { status: 502, body: { error: r.detail || r.code || 'journal error' } };
      }
      if (r.kind === 'pending' && r.spawnId) {
        // Sanitize task/topic ONCE here, at capture — not the raw `task`/
        // `topic` sent on the wire above, but the copy this module holds
        // onto for its own later renders. Both describeOutcome's notice
        // text and handleOutcome's rooms.record title/topic read from this
        // ctx, so flattening here (oneLine strips embedded newlines/control
        // chars via peerField) covers both call sites in one move rather
        // than trusting every future reader to re-sanitize.
        pendingSpawns.set(r.spawnId, {
          sessionKey: data.roomId,
          convoId: fromConvoId,
          task: peerField(task, TASK_MAX_CHARS),
          topic: topic ? peerField(topic, TOPIC_MAX_CHARS) : '',
        });
        return { status: 200, body: { status: 'pending', spawn_id: r.spawnId } };
      }
      // 'pending' with a null spawnId — malformed ack; treat like a journal error.
      return { status: 502, body: { error: 'journal returned a malformed spawn ack' } };
    },

    onSpawnFrame(frame) {
      if (!frame || frame.kind !== 'spawn' || typeof frame.event !== 'string') return;
      if (frame.event === 'targets') {
        settle(frame.request_id, { kind: 'targets', boxes: Array.isArray(frame.boxes) ? frame.boxes : [] });
        return;
      }
      if (frame.event === 'pending') {
        settle(frame.request_id, { kind: 'pending', spawnId: typeof frame.spawn_id === 'string' ? frame.spawn_id : null });
        return;
      }
      if (frame.event === 'outcome') {
        handleOutcome(frame);
        return;
      }
    },

    onOpError({ code, ref, detail } = {}) {
      if (typeof ref !== 'string') return false;
      return settle(ref, { kind: 'op_error', code, detail });
    },
  };
}
