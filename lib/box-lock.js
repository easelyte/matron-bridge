// Locked mode and lockdown for a box with pinned approval keys.
//
// Locked mode (MATRON_LOCKED=1): the bridge takes instructions from outside
// only during an unlock window the user opened with a signed statement,
// {op:'unlock_box', box, minutes}. Inside a window, user input counts only
// when the journal stamped it with the key that signed the unlock; messages
// from other sessions count during any window. Outside one, both are
// refused, visibly and without being queued (a held message would be
// delivered by the owner's own unlock).
//
// Lockdown (any box with pinned keys): a genuine app never sends a bad
// signature, so three forged-looking approvals within ten minutes shut the
// gate for thirty minutes, doubling up to a day. Every gated request is then
// refused, valid or not, an open unlock window included; the only early way
// out is a signed {op:'clear_lockdown', box}.
//
// The window and the lockdown are persisted, so a bridge restart neither
// reopens nor extends a window and does not end a lockdown.
import nodeFs from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';
import { WINDOWS, FORGED_REASONS } from './approval-gate.js';

const MINUTE = 60 * 1000;
const REFUSALS_TO_LOCK = 3;
const REFUSAL_WINDOW_MS = 10 * MINUTE;
const LOCKDOWN_BASE_MS = 30 * MINUTE;
const LOCKDOWN_MAX_MS = 24 * 60 * MINUTE;
// The doubling starts over once the last lockdown ended this long ago.
const LOCKDOWN_FORGET_MS = 7 * 24 * 60 * MINUTE;

// The label on the notice a lockdown files.
export const LOCKDOWN_LABEL = 'box-lockdown';
export const LOCKED_USER_LINE = 'This box is locked. Unlock it to send instructions.';
export const lockedPeerLine = (box) => `${box || 'This box'} is locked; ask the user to unlock it`;

// The most minutes an unlock statement can name (see unlock()).
const UNLOCK_MINUTES_CEILING = 999999;

const defaultSchedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

export function createBoxLock({
  gate,
  // MATRON_LOCKED=1. False: no unlock windows; lockdown still applies.
  locked = false,
  // The longest window an unlock may ask for (MATRON_UNLOCK_MAX_MINUTES).
  maxMinutes = 120,
  now = Date.now,
  stateFile = null,
  // () -> this box's device name, as the journal's hello_ok gave it.
  boxName,
  // ({title, body}) -> void: file a notice for the user. Best effort.
  fileNotice = null,
  // () -> void: the mode changed; the caller reports it to the journal.
  onChange = null,
  schedule = defaultSchedule,
  fs = nodeFs,
  log = console,
} = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  const state = { window: null, lockdown: null, level: 0, lastEndedAt: null, refusals: [] };
  // The longest a window can be: maxMinutes, itself never more than the six
  // digits an unlock statement's minutes may have.
  const maxWindowMs = (Number.isFinite(maxMinutes) ? Math.min(Math.max(0, maxMinutes), UNLOCK_MINUTES_CEILING) : UNLOCK_MINUTES_CEILING) * MINUTE;
  // Set when the stored state was out of bounds; the file is then rewritten.
  let corrected = false;
  if (stateFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const t = now();
      // No unlock can open a window longer than maxMinutes, so a stored one
      // that ends later than that from now is not one this bridge opened
      // under its present limit. It is dropped, not shortened: the box
      // starts locked and the user unlocks it again.
      if (raw?.window && Number.isFinite(raw.window.until) && typeof raw.window.keyId === 'string') {
        if (raw.window.until - t <= maxWindowMs) state.window = { until: raw.window.until, keyId: raw.window.keyId };
        else { warn(`[box-lock] the stored unlock window ends later than a ${maxMinutes}-minute window could; starting locked`); corrected = true; }
      }
      // A lockdown never runs longer than LOCKDOWN_MAX_MS. A stored one that
      // ends later is shortened to that, not dropped: the gate stays shut.
      if (raw?.lockdown && Number.isFinite(raw.lockdown.until)) {
        state.lockdown = { until: Math.min(raw.lockdown.until, t + LOCKDOWN_MAX_MS) };
        if (state.lockdown.until !== raw.lockdown.until) { warn(`[box-lock] the stored lockdown ends later than a lockdown can last; it now ends ${new Date(state.lockdown.until).toISOString()}`); corrected = true; }
      }
      if (Number.isInteger(raw?.level) && raw.level >= 0) state.level = raw.level;
      if (Number.isFinite(raw?.lastEndedAt)) state.lastEndedAt = raw.lastEndedAt;
      if (Array.isArray(raw?.refusals)) state.refusals = raw.refusals.filter(Number.isFinite);
    } catch (e) {
      if (e?.code !== 'ENOENT') warn(`[box-lock] could not read ${stateFile}: ${e?.message ?? e}`);
    }
  }
  function save() {
    if (!stateFile) return;
    try { atomicWriteFileSync(stateFile, JSON.stringify(state), { fs, mode: 0o600 }); }
    catch (e) { warn(`[box-lock] could not write ${stateFile}: ${e?.message ?? e}`); }
  }
  if (corrected) save();
  function changed() {
    save();
    arm();
    if (typeof onChange === 'function') { try { onChange(); } catch (e) { warn(`[box-lock] onChange threw: ${e?.message ?? e}`); } }
  }
  // The box's name as the journal gave it; where it is shown (a room line, a
  // notice) it is flattened to one line first.
  const name = () => { try { return typeof boxName === 'function' ? boxName() : boxName; } catch { return null; } };
  const shownName = () => String(name() || 'This box').replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, 100) || 'This box';

  // Expire what has run out. Called before every read.
  function settle() {
    const t = now();
    if (state.lockdown && state.lockdown.until <= t) { state.lastEndedAt = state.lockdown.until; state.lockdown = null; }
    if (state.window && state.window.until <= t) state.window = null;
  }
  const inLockdown = () => { settle(); return !!state.lockdown; };
  const windowOpen = () => { settle(); return !state.lockdown && !!state.window; };

  // Tell the caller when a window or a lockdown runs out by itself, so the
  // journal's copy of the mode does not go stale.
  let timer = null;
  function arm() {
    if (timer) { clearTimeout(timer); timer = null; }
    settle();
    const next = Math.min(state.lockdown?.until ?? Infinity, state.window?.until ?? Infinity);
    if (!Number.isFinite(next) || typeof schedule !== 'function') return;
    // A timer cannot hold more than about 24 days; a longer wait is taken
    // a day at a time (an early wake just re-arms).
    const wait = Math.min(Math.max(1000, next - now() + 50), LOCKDOWN_MAX_MS);
    timer = schedule(() => { timer = null; const before = JSON.stringify([state.window, state.lockdown]); settle(); if (before !== JSON.stringify([state.window, state.lockdown])) changed(); else arm(); }, wait);
  }

  function enterLockdown() {
    const t = now();
    if (state.lastEndedAt !== null && t - state.lastEndedAt >= LOCKDOWN_FORGET_MS) state.level = 0;
    const length = Math.min(LOCKDOWN_BASE_MS * 2 ** state.level, LOCKDOWN_MAX_MS);
    state.level += 1;
    state.lockdown = { until: t + length };
    state.window = null;
    state.refusals = [];
    warn(`[box-lock] lockdown: ${REFUSALS_TO_LOCK} invalid approvals within ${REFUSAL_WINDOW_MS / MINUTE} minutes; refusing every gated request until ${new Date(state.lockdown.until).toISOString()}`);
    changed();
    if (typeof fileNotice === 'function') {
      const box = shownName();
      try {
        // `labels` and the first body line are for the apps: they mark the
        // notice so a "Clear lockdown" button can be offered, and name the box.
        const out = fileNotice({
          title: `${box} locked down: invalid approval signatures`,
          labels: [LOCKDOWN_LABEL],
          body: `Box: ${box}\n\n${box} received ${REFUSALS_TO_LOCK} approvals within ${REFUSAL_WINDOW_MS / MINUTE} minutes that were forged or malformed (a bad signature or a malformed statement). A genuine app never sends one.\n\n`
            + `Until ${new Date(state.lockdown.until).toISOString()} it refuses every request that needs your approval, valid or not: session starts, chat invites, file transfers and unlocks. `
            + 'Sessions already running carry on.\n\nTo end it early, clear the lockdown from one of your devices with an approval key. If this was not you, check which devices are signed in to your account.',
        });
        if (out && typeof out.catch === 'function') out.catch((e) => warn(`[box-lock] could not file the lockdown notice: ${e?.message ?? e}`));
      } catch (e) {
        warn(`[box-lock] could not file the lockdown notice: ${e?.message ?? e}`);
      }
    }
  }

  // One forged-looking refusal. Ignored during a lockdown: an attacker
  // cannot lengthen one that is already running.
  function noteRefusal() {
    if (inLockdown()) return;
    const t = now();
    state.refusals = state.refusals.filter((at) => t - at < REFUSAL_WINDOW_MS);
    state.refusals.push(t);
    if (state.refusals.length >= REFUSALS_TO_LOCK) enterLockdown();
    else save();
  }
  if (gate && typeof gate.onRefusal === 'function') {
    gate.onRefusal((reason) => { if (FORGED_REASONS.includes(reason)) noteRefusal(); });
  }

  // The minutes a statement asks for, read only to know what to expect of
  // it; the gate then checks the statement says exactly that.
  function askedMinutes(approval) {
    try {
      const m = JSON.parse(approval.statement)?.subject?.minutes;
      return typeof m === 'string' ? m : null;
    } catch {
      return undefined; // not parseable: the gate names the reason
    }
  }

  arm();

  return {
    // {on: locked mode, until: the open window's end, lockdownUntil}.
    state() {
      settle();
      return { on: locked === true, until: windowOpen() ? state.window.until : null, lockdownUntil: state.lockdown ? state.lockdown.until : null };
    },
    // What the journal is told (`locked` on hello and box_status), and what
    // the unlock / lock / clear_lockdown requests answer with. `on`: outside
    // input is refused for want of an unlock window; `until`: the end of an
    // open window; `lockdown_until`: the end of a lockdown. The journal keeps
    // it as reported, so it is reported again whenever a window or a
    // lockdown runs out.
    report() {
      settle();
      return {
        on: locked === true && !state.window,
        until: locked === true && state.window ? state.window.until : null,
        lockdown_until: state.lockdown ? state.lockdown.until : null,
      };
    },
    inLockdown,

    unlock(approval) {
      if (!locked) return { ok: false, reason: 'not_locked' };
      if (inLockdown()) return { ok: false, reason: 'lockdown' };
      const box = name();
      if (!box) return { ok: false, reason: 'identity_unknown' };
      let minutes = '0';
      if (approval !== null && approval !== undefined) {
        const asked = askedMinutes(approval);
        if (asked !== undefined) {
          if (asked === null || !/^[1-9]\d{0,5}$/.test(asked) || Number(asked) > maxMinutes) return { ok: false, reason: 'bad_minutes' };
          minutes = asked;
        }
      }
      const r = gate.check(approval, { type: 'account', subject: { op: 'unlock_box', box, minutes }, maxAgeMs: WINDOWS.unlock });
      if (!r.ok) return { ok: false, reason: r.reason };
      state.window = { until: now() + Number(minutes) * MINUTE, keyId: r.keyId };
      changed();
      return { ok: true, until: state.window.until };
    },

    lock() {
      settle();
      if (state.window) { state.window = null; changed(); }
      return { ok: true };
    },

    clearLockdown(approval) {
      const box = name();
      if (!box) return { ok: false, reason: 'identity_unknown' };
      const r = gate.check(approval, { type: 'account', subject: { op: 'clear_lockdown', box }, maxAgeMs: WINDOWS.unlock });
      if (!r.ok) return { ok: false, reason: r.reason };
      settle();
      if (state.lockdown) { state.lastEndedAt = now(); state.lockdown = null; }
      state.refusals = [];
      changed();
      return { ok: true };
    },

    // User input stamped by the journal with `keyId`, the approval key on
    // the device that sent it (null when it has none or is not known).
    allowsUser(keyId) {
      if (!locked) return true;
      return windowOpen() && typeof keyId === 'string' && keyId !== '' && keyId === state.window.keyId;
    },
    // A message from another session.
    allowsPeer() {
      if (!locked) return true;
      return windowOpen();
    },
    // The two above as one answer, with the line to show when refused.
    verdict(kind, keyId = null) {
      if (kind === 'user') return this.allowsUser(keyId) ? { ok: true } : { ok: false, line: LOCKED_USER_LINE };
      return this.allowsPeer() ? { ok: true } : { ok: false, line: lockedPeerLine(shownName()) };
    },
    noteRefusal,
  };
}
