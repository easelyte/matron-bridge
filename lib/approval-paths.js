// What this box expects a signed approval to say on each inbound path, built
// from what the box is about to do, never from what the request claims
// (journal protocol: "Protected boxes", "What is forwarded"). One object,
// handed to the RPC handler, the invites manager and the transfer receiver.
//
// Each check answers {ok:true, gated, keyId?} or {ok:false, reason}. With the
// gate off (no pinned keys file) every check answers {ok:true, gated:false}
// and the caller behaves exactly as it did before approval keys.
import { createHash } from 'node:crypto';
import { WINDOWS } from './approval-gate.js';

const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const SUBJECT_VALUE_MAX = 200;

// A value that can be long is signed, over 200 characters, as its hash under
// `<name>_sha256`. Returns the subject for chaining.
export function subjectValue(subject, name, value) {
  const v = String(value);
  if (v.length > SUBJECT_VALUE_MAX) subject[`${name}_sha256`] = sha256Hex(v);
  else subject[name] = v;
  return subject;
}

export function createApprovalPaths({
  gate,
  // () -> {deviceId, name} | null: this box as the journal's hello_ok named
  // it. `box` in every subject is that stored device name.
  identity,
  // () -> boolean: the box is in lockdown (lib/box-lock.js). Every gated
  // request is then refused, valid or not, without looking at it.
  lockdown = () => false,
  // () -> boolean: another session may start work here now (lib/box-lock.js
  // allowsPeer: true unless the box is in locked mode with no window open).
  peersAllowed = () => true,
  log = console,
}) {
  const enabled = !!gate && gate.enabled === true;
  const lockedDown = () => { try { return lockdown() === true; } catch { return true; } };
  const open = { ok: true, gated: false };
  const self = () => {
    let id = null;
    try { id = identity(); } catch { /* unknown */ }
    return id && typeof id.name === 'string' && id.name ? id : null;
  };
  function run(what, approval, expected) {
    const r = gate.check(approval, expected);
    if (r.ok) return { ok: true, gated: true, keyId: r.keyId };
    try { log.warn(`[approval-gate] refused ${what}: ${r.reason}`); } catch { /* logging must never throw */ }
    return { ok: false, reason: r.reason };
  }
  const refuse = (what, reason) => {
    try { log.warn(`[approval-gate] refused ${what}: ${reason}`); } catch { /* logging must never throw */ }
    return { ok: false, reason };
  };

  return {
    enabled,

    // A `start` RPC. From the journal itself (from_device_id 0) it is an
    // approved spawn, a `consent` statement over the task; from a client it
    // is the user's own start, an `account` statement. Anything else the
    // journal sends as a start (a hand-over, a talk request) carries no such
    // statement and is refused.
    start(request) {
      if (!enabled) return open;
      if (lockedDown()) return refuse('a start', 'lockdown');
      const params = request?.params && typeof request.params === 'object' ? request.params : {};
      const what = `start ${request?.request_id ?? ''}`.trim();
      if (params.talk === true) return refuse(what, 'talk_request');
      const me = self();
      if (!me) return refuse(what, 'identity_unknown');
      const workdir = typeof params.workdir === 'string' ? params.workdir : '';
      const prompt = typeof params.prompt === 'string' ? params.prompt : '';
      if (request.from_device_id === 0) {
        const subject = { op: 'spawn', decision: 'approve', task_sha256: sha256Hex(prompt) };
        subjectValue(subject, 'ask', typeof params.spawn_id === 'string' ? params.spawn_id : '');
        subjectValue(subject, 'box', me.name);
        subjectValue(subject, 'workdir', workdir);
        return run(what, params.approval, { type: 'consent', subject, maxAgeMs: WINDOWS.spawn });
      }
      const subject = { op: 'start', prompt_sha256: sha256Hex(prompt) };
      subjectValue(subject, 'box', me.name);
      subjectValue(subject, 'workdir', workdir);
      return run(what, params.approval, { type: 'account', subject, maxAgeMs: WINDOWS.start });
    },

    // An inbound chat invite (`request`) or a request to join a room this
    // box owns (`join_request`), as delivered.
    invite(frame) {
      if (!enabled) return open;
      if (lockedDown()) return refuse('a chat request', 'lockdown');
      const what = `chat ${frame?.event} for room ${frame?.room_id}`;
      const me = self();
      if (!me || !Number.isInteger(me.deviceId)) return refuse(what, 'identity_unknown');
      const device = frame.event === 'join_request' ? frame.from_device_id : me.deviceId;
      const subject = { op: 'chat', decision: 'approve', message_sha256: sha256Hex(typeof frame.justification === 'string' ? frame.justification : '') };
      subjectValue(subject, 'ask', `${frame.room_id}/${device}`);
      subjectValue(subject, 'box', me.name);
      return run(what, frame.approval, { type: 'consent', subject, maxAgeMs: WINDOWS.chat });
    },

    // A file transfer that is ready to download. The bytes must then match
    // the signed hash, which the receiver checks before it releases the file.
    transfer(t) {
      if (!enabled) return open;
      if (lockedDown()) return refuse('a transfer', 'lockdown');
      const what = `transfer ${t?.id}`;
      const me = self();
      if (!me) return refuse(what, 'identity_unknown');
      const subject = { op: 'transfer', decision: 'approve', file_sha256: String(t.sha256), size: String(t.size) };
      subjectValue(subject, 'ask', t.id);
      subjectValue(subject, 'box', me.name);
      return run(what, t.approval, { type: 'consent', subject, maxAgeMs: WINDOWS.transfer });
    },

    // Coordinator session control. A box with approval keys takes work only
    // with the user's signature, and session control carries none: only the
    // actions that neither start nor redirect work go through.
    sessionControl(params) {
      if (!enabled) return open;
      // A locked box with no window open takes nothing from outside: an
      // alert is a message, and a compact can wake a sleeping session.
      let windowOpen;
      try { windowOpen = peersAllowed() === true; } catch { windowOpen = false; }
      if (!windowOpen) return refuse(`session control ${String(params?.action).slice(0, 40)}`, 'locked');
      if (params?.action === 'compact' || params?.action === 'alert') return { ok: true, gated: true };
      return refuse(`session control ${String(params?.action).slice(0, 40)}`, 'session_control');
    },
  };
}
