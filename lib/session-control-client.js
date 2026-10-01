// Coordinator session control, calling side (spec
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md,
// "Decisions"): the three MCP tools' HTTP handlers. The Coordinator's
// bridge sends the journal a `session_control` op, waits for the `sent`
// ack (or an error frame keyed by request id), answers the tool at once,
// and later turns the `result` frame — which can take minutes when the
// target box has to wake — into a notice in the Coordinator's own chat.
// Same waiter/settle shape as lib/agent-spawn.js.
import { randomUUID } from 'crypto';
import { describeControlResult } from './session-control.js';

const ACTIONS = { setModel: 'set_model', compact: 'compact', carryOn: 'carry_on' };
const RESULT_TTL_MS = 10 * 60 * 1000;

export function createSessionControlHandlers({
  sessions,
  publisher,
  journalConvoIdFor = () => null,
  // (convoId, text) -> void: the Coordinator-chat notice for a result.
  notify = () => {},
  pendingTimeoutMs = 10000,
  resultTtlMs = RESULT_TTL_MS,
  log = console,
} = {}) {
  const waiters = new Map();   // request_id -> {resolve, timer}
  const inflight = new Map();  // request_id -> {convoId, action, targetConvoId, ts}

  const await_ = (rid, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(rid); resolve({ kind: 'timeout' }); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.set(rid, { resolve, timer });
  });
  const settle = (rid, value) => {
    const w = waiters.get(rid);
    if (!w) return false;
    clearTimeout(w.timer);
    waiters.delete(rid);
    w.resolve(value);
    return true;
  };
  // An outcome that never came is still an outcome the Coordinator is owed.
  function sweep() {
    const now = Date.now();
    for (const [rid, ctx] of inflight) {
      if (now - ctx.ts <= resultTtlMs) continue;
      inflight.delete(rid);
      try { notify(ctx.convoId, describeControlResult({ ok: false, error: { code: 'no_outcome', detail: `no result from the target bridge within ${Math.round(resultTtlMs / 60000)} min` } }, { action: ctx.action })); } catch { /* best effort */ }
    }
  }

  function caller(data) {
    const roomId = data?.roomId;
    if (!roomId) return { err: { status: 400, body: { error: 'roomId is required' } } };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: 'no session for this room' } } };
    // The journal refuses a non-Coordinator too; this is the clearer message.
    if (session.coordinator !== true) {
      return { err: { status: 403, body: { error: 'only the Coordinator may control other sessions — this conversation is not the Coordinator' } } };
    }
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { session, convoId };
  }

  async function send(data, action, fields) {
    const { session, convoId, err } = caller(data);
    if (err) return err;
    void session;
    const target = data?.target_convo_id;
    if (typeof target !== 'string' || !target) return { status: 400, body: { error: 'target_convo_id is required — the target conversation id from agent_roster or mission_get' } };
    if (target === convoId) return { status: 400, body: { error: 'that is this conversation — session control targets other sessions' } };
    const reason = typeof data?.reason === 'string' && data.reason.trim() ? data.reason.trim().slice(0, 200) : null;
    const rid = randomUUID();
    const frame = {
      op: 'session_control', request_id: rid, from_convo_id: convoId, target_convo_id: target, action,
      ...fields, ...(reason ? { reason } : {}),
    };
    const p = await_(rid, pendingTimeoutMs);
    sweep();
    inflight.set(rid, { convoId, action, targetConvoId: target, ts: Date.now() });
    if (!publisher.sendRoomOp(frame)) {
      settle(rid, { kind: 'discarded' });
      inflight.delete(rid);
      return { status: 502, body: { error: 'journal unreachable' } };
    }
    const r = await p;
    if (r.kind === 'timeout') { inflight.delete(rid); return { status: 504, body: { error: 'timed out waiting for the journal' } }; }
    if (r.kind === 'op_error') {
      inflight.delete(rid);
      if (r.code === 'forbidden' && r.detail === 'not_coordinator') return { status: 403, body: { error: 'the journal does not list this conversation as the Coordinator' } };
      if (r.code === 'not_found') return { status: 404, body: { error: 'no such session — the conversation id is wrong, belongs to another user, or its box is hidden by privacy' } };
      if (r.code === 'agent_unreachable') return { status: 502, body: { error: 'the target box is offline and cannot be woken from here' } };
      if (r.code === 'bad_request') return { status: 400, body: { error: r.detail || 'bad request' } };
      return { status: 502, body: { error: `journal refused: ${r.code}${r.detail ? ` — ${r.detail}` : ''}` } };
    }
    if (r.kind === 'sent') {
      return { status: 200, body: { sent: true, request_id: rid, ...(r.targetWaking ? { target_waking: true } : {}) } };
    }
    inflight.delete(rid);
    return { status: 502, body: { error: 'journal returned a malformed ack' } };
  }

  return {
    setModel(data) {
      const model = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : null;
      const agent = typeof data?.agent === 'string' && data.agent ? data.agent : null;
      if (!model && !agent) return Promise.resolve({ status: 400, body: { error: 'model or agent is required' } });
      return send(data, ACTIONS.setModel, { ...(model ? { model } : {}), ...(agent ? { agent } : {}) });
    },
    compact(data) {
      return send(data, ACTIONS.compact, {});
    },
    carryOn(data) {
      const message = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : null;
      if (!message) return Promise.resolve({ status: 400, body: { error: 'message is required — what the session should do next' } });
      const when = data?.when === 'after_limit_reset' ? 'after_limit_reset' : 'now';
      return send(data, ACTIONS.carryOn, { message, when });
    },

    onSessionControlFrame(frame) {
      if (!frame || frame.kind !== 'session_control' || typeof frame.request_id !== 'string') return;
      if (frame.event === 'sent') {
        settle(frame.request_id, { kind: 'sent', targetWaking: frame.target_waking === true });
        return;
      }
      if (frame.event === 'result') {
        const ctx = inflight.get(frame.request_id);
        if (!ctx) return; // unknown or already handled (at-most-once on the wire, but be safe)
        inflight.delete(frame.request_id);
        const text = describeControlResult(frame, { action: ctx.action, box: frame.result?.box });
        try { notify(ctx.convoId, text); } catch (e) { log.warn?.(`[session-control] notify failed: ${e.message}`); }
      }
    },

    // Error frames from the journal carry the request id; `true` means owned.
    onOpError({ code, ref, detail, requestId } = {}) {
      if (typeof requestId === 'string' && settle(requestId, { kind: 'op_error', code, detail })) return true;
      // An older journal keys the frame by ref alone.
      if (typeof ref === 'string' && settle(ref, { kind: 'op_error', code, detail })) return true;
      return false;
    },

    _inflightCount: () => inflight.size,
  };
}
