// The approval gate: this box's own check of a signed approval against keys
// pinned on the box (journal protocol: "Approval keys (step-up)", "Verifying
// on a box"). The journal relays the user's signed statement; the box must
// not take the journal's word that it was valid, so it verifies the
// signature itself, compares the statement with what it is about to do, and
// refuses a statement it has seen before.
//
// The keys come from MATRON_APPROVAL_KEYS_FILE, never from the journal. An
// agent runs under the bridge's uid, so a file that uid could write would
// let an agent pin its own key: the file must belong to another user (root,
// in practice), must not be group- or world-writable, and must not be a
// symlink. The rule is checked on EVERY call, on the same open file the keys
// are read from, so a file swapped or loosened while the bridge runs is
// refused at the next check rather than served from a cached copy.
//
// Everything fails closed: an unreadable file, a malformed approval, a
// verifier that throws, a nonce that cannot be recorded -> refused.
import nodeFs from 'node:fs';
import { verifyApproval } from './vendor/approval-verify.mjs';
import { atomicWriteFileSync } from './atomic-write.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// How old a statement may be, per kind of request. A tap or an unlock is
// signed and sent at once; consent the journal forwards can be much older:
// a spawn waits for the box to wake, an invite for its next connect, a
// transfer for its upload.
export const WINDOWS = Object.freeze({
  tap: 5 * MINUTE,
  unlock: 5 * MINUTE,
  start: 10 * MINUTE,
  spawn: 30 * MINUTE,
  chat: 24 * HOUR,
  transfer: 24 * HOUR,
});
// A nonce is remembered for the longest window and an hour, counted from
// when the statement was signed.
const NONCE_KEEP_MS = 24 * HOUR + HOUR;

// Reasons that only a forged or broken request produces. An honest app can
// cause the others (an edit between reading and signing, a slow network).
// `unknown_key` is not among them on a box: it means "not pinned here", and
// a device the user enrolled but the operator did not pin is honest.
export const FORGED_REASONS = Object.freeze(['signature', 'bad_statement']);

const TAP_KEYS = ['item_num', 'action', 'reply_to', 'prompt_digest', 'item_id'];
const value = (v) => (typeof v === 'function' ? v() : v);

// The pinned file through one descriptor: the ownership rule and the bytes
// are of the same file. Throws an Error whose message names what is wrong.
function readKeys(file, { fs, uid }) {
  if (typeof uid !== 'number') throw new Error('this platform has no user ids to check the file against');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    throw new Error(e?.code === 'ELOOP' ? 'it is a symlink' : `cannot open it (${e?.code || e?.message})`, { cause: e });
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('it is not a regular file');
    if (st.uid === uid && uid !== 0) throw new Error("it is owned by the bridge's own user; it must be owned by root or another user");
    if (st.mode & 0o022) throw new Error('it is writable by its group or by everyone');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { throw new Error('it is not JSON'); }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) throw new Error('it must be {"keys":[{"key_id","public_key","name"}]}');
    return parsed;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

export function createApprovalGate({
  // Path of the pinned keys file. Empty or unset: the gate is off.
  keysFile = '',
  // An upper bound on every freshness window (MATRON_APPROVAL_MAX_AGE_MS).
  maxAgeMs = null,
  // Where spent nonces are kept across restarts.
  noncesFile = null,
  // The journal's host as statements name it, and the account this box
  // serves. Values or functions (the account's name arrives after boot).
  journalHost,
  user,
  now = Date.now,
  fs = nodeFs,
  // The uid the bridge (and so every agent) runs as.
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  log = console,
} = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  if (!keysFile) {
    return {
      enabled: false,
      keyCount: () => 0,
      check: () => ({ ok: false, reason: 'gate_off' }),
      onRefusal() {},
    };
  }

  try {
    readKeys(keysFile, { fs, uid: value(uid) });
  } catch (e) {
    throw new Error(`MATRON_APPROVAL_KEYS_FILE (${keysFile}) cannot be used: ${e.message}`, { cause: e });
  }

  // nonce -> when it may be forgotten. Held in memory and written through,
  // so deleting the file while the bridge runs reopens nothing.
  const nonces = new Map();
  if (noncesFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(noncesFile, 'utf8'));
      for (const [n, until] of Object.entries(stored?.nonces || {})) if (Number.isFinite(until)) nonces.set(n, until);
    } catch (e) {
      if (e?.code !== 'ENOENT') warn(`[approval-gate] could not read the nonce ledger ${noncesFile}: ${e?.message ?? e}`);
    }
  }
  function recordNonce(nonce, signedAt) {
    const t = now();
    for (const [n, until] of nonces) if (until <= t) nonces.delete(n);
    nonces.set(nonce, Math.max(signedAt, t - NONCE_KEEP_MS) + NONCE_KEEP_MS);
    if (!noncesFile) return true;
    try {
      atomicWriteFileSync(noncesFile, JSON.stringify({ nonces: Object.fromEntries(nonces) }), { fs, mode: 0o600 });
      return true;
    } catch (e) {
      nonces.delete(nonce);
      warn(`[approval-gate] could not write the nonce ledger ${noncesFile}: ${e?.message ?? e}`);
      return false;
    }
  }

  let listener = null;

  // approval: {statement, signature} as relayed. expected: {type, subject}
  // built by the caller from what it is about to do, plus the tap fields for
  // an item_tap; maxAgeMs picks the window (default: a tap's); consume:false
  // verifies without spending the nonce (labels only, never an action).
  function check(approval, { type, subject, maxAgeMs: window = WINDOWS.tap, consume = true, ...rest } = {}) {
    const refuse = (reason) => {
      if (consume && listener) { try { listener(reason); } catch { /* a listener must not change the answer */ } }
      return { ok: false, reason };
    };
    if (approval === null || approval === undefined) return refuse('approval_required');
    // Exactly {statement, signature}, both strings: the vendored verifier
    // lets extra keys through, the protocol does not.
    if (typeof approval !== 'object' || Array.isArray(approval) || Object.keys(approval).sort().join() !== 'signature,statement'
      || typeof approval.statement !== 'string' || typeof approval.signature !== 'string') return refuse('bad_statement');
    let keys;
    try {
      keys = readKeys(keysFile, { fs, uid: value(uid) });
    } catch (e) {
      warn(`[approval-gate] refusing: the keys file ${keysFile} cannot be used: ${e.message}`);
      return refuse('keys_file');
    }
    const journal = value(journalHost);
    const account = value(user);
    if (typeof journal !== 'string' || !journal || typeof account !== 'string' || !account) return refuse('identity_unknown');
    const expect = { journal, user: account, type, subject };
    for (const k of TAP_KEYS) if (Object.hasOwn(rest, k) && rest[k] !== undefined) expect[k] = rest[k];
    const cap = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : Infinity;
    // A label check (consume:false) only says whose signature a stored
    // statement carries: it has no freshness limit and does not mind that
    // the statement was spent. Nothing may act on its answer.
    const age = consume ? Math.min(window, cap) : Number.MAX_SAFE_INTEGER;
    let r;
    try {
      r = verifyApproval(approval, { keys, expect, now: now(), maxAgeMs: age });
    } catch (e) {
      warn(`[approval-gate] refusing: the check itself failed: ${e?.message ?? e}`);
      return refuse('check_failed');
    }
    if (!r || r.ok !== true) return refuse(typeof r?.reason === 'string' ? r.reason : 'check_failed');
    const st = r.statement;
    if (consume && nonces.has(st.nonce) && nonces.get(st.nonce) > now()) return refuse('nonce_reused');
    if (consume && !recordNonce(st.nonce, st.signed_at)) return refuse('nonce_ledger');
    return { ok: true, keyId: st.key_id, statement: st };
  }

  return {
    enabled: true,
    // How many keys the file pins right now (0 when it cannot be used).
    keyCount() {
      try { return readKeys(keysFile, { fs, uid: value(uid) }).keys.length; } catch { return 0; }
    },
    check,
    // (reason) -> void, called for every refused check that would have
    // spent a nonce. The box lock counts forged-looking ones.
    onRefusal(fn) { listener = typeof fn === 'function' ? fn : null; },
  };
}
