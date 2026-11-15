// The account lock ("panic"): the journal's broadcast that the whole account
// is locked. While it holds, the bridge stops running turns and starts none,
// from any source, and refuses spawns, chat invites and file transfers.
//
// Frames, as the journal sends them to every agent device of the account:
//   lock   {"kind":"panic","on":true,"since":<ms>,"source":<string|null>}
//   clear  {"kind":"panic","on":false}
//   hello_ok carries "panic":{"on":true,"since","source"} while locked; the
//   key is absent otherwise, and its absence clears a lock the bridge held.
// There is no ack.
//
// Only the journal clears it: nothing a client, an agent or a signed
// approval sends to the bridge does, and this module has no method that
// would. It does not depend on approval keys: a box with no keys file is
// locked like any other.
//
// The state is persisted, so a bridge that restarts while it cannot reach
// the journal stays locked until its next hello says otherwise. It fails
// closed: a lock frame or a hello `panic` it cannot read counts as locked.
// What falls due while locked (a session's own reminders) is held, also on
// disk, and handed back after the clear rather than dropped.
import nodeFs from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';

export const ACCOUNT_LOCKED_LINE = 'This account is locked. Sessions are stopped until it is cleared.';
const HELD_MAX = 500;

export function createAccountLock({
  stateFile = null,
  // (state) -> void: the account has just been locked (or the lock was
  // repeated): interrupt running turns.
  onLock = null,
  // (held[]) -> void: the lock was cleared; `held` is what hold() kept.
  onClear = null,
  fs = nodeFs,
  log = console,
} = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  let state = { on: false, since: null, source: null };
  let held = [];
  if (stateFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw?.on === true) state = { on: true, since: Number.isFinite(raw.since) ? raw.since : null, source: typeof raw.source === 'string' ? raw.source : null };
      if (Array.isArray(raw?.held)) held = raw.held.slice(0, HELD_MAX);
    } catch (e) {
      if (e?.code !== 'ENOENT') warn(`[account-lock] could not read ${stateFile}: ${e?.message ?? e}`);
    }
  }
  function save() {
    if (!stateFile) return;
    try { atomicWriteFileSync(stateFile, JSON.stringify({ ...state, held }), { fs, mode: 0o600 }); }
    catch (e) { warn(`[account-lock] could not write ${stateFile}: ${e?.message ?? e}`); }
  }
  // Conversations already told about this lock.
  let notified = new Set();

  function lock(info) {
    const first = !state.on;
    if (first) {
      state = {
        on: true,
        since: Number.isFinite(info?.since) ? info.since : null,
        source: typeof info?.source === 'string' && info.source ? info.source.slice(0, 200) : null,
      };
      notified = new Set();
      save();
      warn(`[account-lock] the account is locked${state.source ? ` (${state.source})` : ''}: stopping turns and refusing new work until the journal clears it`);
    }
    // Every lock frame stops turns again: one that slipped through since
    // the first is stopped by the repeat.
    if (typeof onLock === 'function') { try { onLock({ ...state }); } catch (e) { warn(`[account-lock] onLock threw: ${e?.message ?? e}`); } }
  }
  function clear() {
    if (!state.on) return;
    state = { on: false, since: null, source: null };
    const release = held;
    held = [];
    notified = new Set();
    save();
    warn('[account-lock] the journal cleared the account lock');
    if (typeof onClear === 'function') { try { onClear(release); } catch (e) { warn(`[account-lock] onClear threw: ${e?.message ?? e}`); } }
  }

  return {
    isLocked: () => state.on,
    state: () => ({ ...state }),
    // A live {kind:'panic'} frame. Only an explicit on:false clears.
    onFrame(frame) {
      if (frame && typeof frame === 'object' && frame.on === false) clear();
      else lock(frame);
    },
    // hello_ok's `panic` value: absent (null/undefined) means not locked.
    onHello(panic) {
      if (panic === null || panic === undefined) clear();
      else if (typeof panic === 'object' && panic.on === false) clear();
      else lock(panic);
    },
    // Keep something that fell due while locked (JSON-serialisable). False
    // when the account is not locked: the caller delivers it as usual.
    hold(item) {
      if (!state.on) return false;
      held.push(item);
      if (held.length > HELD_MAX) held.shift();
      save();
      return true;
    },
    // True the first time a conversation is refused during this lock: it is
    // told once, not on every refused message.
    shouldNotify(convoId) {
      if (!state.on || typeof convoId !== 'string' || !convoId || notified.has(convoId)) return false;
      notified.add(convoId);
      return true;
    },
    // For the input router (the same shape as the box lock's verdict).
    // `hard`: no exception for a signed tap, and no answer into a room.
    verdict() {
      return state.on ? { ok: false, hard: true, line: ACCOUNT_LOCKED_LINE } : { ok: true };
    },
  };
}
