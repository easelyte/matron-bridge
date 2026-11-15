import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApprovalGate, WINDOWS } from '../lib/approval-gate.js';
import { vectors, KEY_ID, SIGNED_AT, PINNED, sign, otherKeyPem, tempKeys, UNIX } from './approval-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// SHA-256 of lib/vendor/approval-verify.mjs as copied from the journal's
// tools/approval-verify.mjs at commit d3b72ff. The file is vendored
// unchanged: update it only by copying a newer one, with this constant.
const VERIFIER_SHA256 = '1bb87c2d81a0f91493195e8a1f6876179b47790ab9addd5a3aec0494a39ed9fa';

const temps = [];
afterEach(() => { while (temps.length) temps.pop().cleanup(); });

function gateWith(extra = {}, keys = PINNED) {
  const t = tempKeys(keys);
  temps.push(t);
  const clock = { now: SIGNED_AT + 1000 };
  const gate = createApprovalGate({
    keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'approval-nonces.json'),
    journalHost: 'journal.example', user: () => 'alice', now: () => clock.now, log: { warn() {}, log() {} }, ...extra,
  });
  return { gate, t, clock };
}

const SPAWN = vectors.statements.consent;
const SPAWN_SUBJECT = { op: 'spawn', ask: 'sp_1', box: 'box-a', workdir: '/home/alice/project', task_sha256: '98fa3fff3b511b6deb8e13945bc02a59b1833ea712caf83df7e4ec77d94965e1', decision: 'approve' };

describe('the vendored verifier', () => {
  it('is the journal file, byte for byte', () => {
    const bytes = fs.readFileSync(path.join(here, '..', 'lib', 'vendor', 'approval-verify.mjs'));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(VERIFIER_SHA256);
  });
});

describe('approval gate on a platform without user ids', () => {
  it('refuses to start with a keys file: the ownership rule cannot be checked', () => {
    const t = tempKeys();
    temps.push(t);
    expect(() => createApprovalGate({ keysFile: t.keysFile, uid: null, journalHost: 'journal.example', user: 'alice' })).toThrow(/no user ids/);
  });

  it('is simply off without one', () => {
    expect(createApprovalGate({ keysFile: '', uid: null }).enabled).toBe(false);
  });
});

describe.skipIf(!UNIX)('approval gate', () => {
  it('is off without a keys file, and refuses whatever it is asked', () => {
    const gate = createApprovalGate({ keysFile: '', journalHost: 'journal.example', user: 'alice' });
    expect(gate.enabled).toBe(false);
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'gate_off' });
  });

  it("passes the journal's consent vector once, and refuses it the second time", () => {
    const { gate } = gateWith();
    expect(gate.enabled).toBe(true);
    expect(gate.keyCount()).toBe(1);
    const first = gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT });
    expect(first).toMatchObject({ ok: true, keyId: KEY_ID });
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'nonce_reused' });
  });

  it("passes the journal's account and tap vectors", () => {
    const { gate } = gateWith();
    expect(gate.check(vectors.statements.account, { type: 'account', subject: { op: 'link_device', code: 'BCDF2345' }, consume: false }).ok).toBe(true);
    expect(gate.check(vectors.statements.item_tap, {
      type: 'item_tap', subject: { box: 'box-a' }, item_num: 7, action: 'Approve', reply_to: null,
      prompt_digest: vectors.prompt_digest_example.digest, item_id: 'it_abc123', consume: false,
    }).ok).toBe(true);
    expect(gate.check(vectors.statements.item_tap_reply, {
      type: 'item_tap', subject: { box: 'box-a' }, item_num: 7, action: 'Yes', reply_to: 'cm_def456',
      prompt_digest: vectors.reply_prompt_example.digest, item_id: 'it_abc123', consume: false,
    }).ok).toBe(true);
    // A follow-up's "Yes" never passes for the item's own button.
    expect(gate.check(vectors.statements.item_tap_reply, {
      type: 'item_tap', subject: { box: 'box-a' }, item_num: 7, action: 'Yes', reply_to: null, consume: false,
    })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('a check that does not consume leaves the nonce for the one that does', () => {
    const { gate } = gateWith();
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT, consume: false }).ok).toBe(true);
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT, consume: false }).ok).toBe(true);
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT }).ok).toBe(true);
  });

  it('a label check has no freshness limit and still passes after the statement was spent', () => {
    const { gate, clock } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT };
    expect(gate.check(SPAWN, o).ok).toBe(true);
    clock.now = SIGNED_AT + 40 * 24 * 3600 * 1000;
    expect(gate.check(SPAWN, { ...o, consume: false })).toMatchObject({ ok: true, keyId: KEY_ID });
    expect(gate.check(SPAWN, { ...o, consume: false, subject: { ...SPAWN_SUBJECT, box: 'box-b' } })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a key that is not pinned', () => {
    const { gate } = gateWith({}, { keys: [] });
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses a statement signed by another key under a pinned key id', () => {
    const { gate } = gateWith();
    const forged = sign({ type: 'consent', subject: SPAWN_SUBJECT, privateKeyPem: otherKeyPem() });
    expect(gate.check(forged, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a stale statement, by the window the caller names', () => {
    const { gate, clock } = gateWith();
    clock.now = SIGNED_AT + 6 * 60 * 1000;
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'stale' });
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT, maxAgeMs: WINDOWS.spawn }).ok).toBe(true);
  });

  it('the configured maximum age bounds every window', () => {
    const { gate, clock } = gateWith({ maxAgeMs: 60 * 1000 });
    clock.now = SIGNED_AT + 2 * 60 * 1000;
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT, maxAgeMs: WINDOWS.spawn })).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a subject, journal, user or type that differs from what is expected', () => {
    const { gate } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT, consume: false };
    expect(gate.check(SPAWN, { ...o, subject: { ...SPAWN_SUBJECT, workdir: '/elsewhere' } })).toEqual({ ok: false, reason: 'mismatch' });
    expect(gate.check(SPAWN, { ...o, type: 'account' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(gate.check(sign({ type: 'consent', subject: SPAWN_SUBJECT, journal: 'other.example' }), o)).toEqual({ ok: false, reason: 'mismatch' });
    expect(gate.check(sign({ type: 'consent', subject: SPAWN_SUBJECT, user: 'bob' }), o)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a malformed approval and a missing one, and never throws on a malformed expectation', () => {
    const { gate } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT };
    expect(gate.check(null, o)).toEqual({ ok: false, reason: 'approval_required' });
    expect(gate.check(undefined, o)).toEqual({ ok: false, reason: 'approval_required' });
    expect(gate.check({ statement: 'x' }, o)).toEqual({ ok: false, reason: 'bad_statement' });
    expect(gate.check({ ...SPAWN, extra: 1 }, o)).toEqual({ ok: false, reason: 'bad_statement' });
    expect(gate.check(SPAWN, { type: 'consent', subject: { n: 1 } })).toEqual({ ok: false, reason: 'check_failed' });
    expect(gate.check(SPAWN, { type: 'nope', subject: {} })).toEqual({ ok: false, reason: 'check_failed' });
  });

  it('refuses while it does not know which account it serves', () => {
    const { gate } = gateWith({ user: () => null });
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'identity_unknown' });
  });

  it('re-reads the keys file on every check: a key added later counts, a removed one stops counting', () => {
    const { gate, t } = gateWith({}, { keys: [] });
    const o = { type: 'consent', subject: SPAWN_SUBJECT, consume: false };
    expect(gate.check(SPAWN, o).reason).toBe('unknown_key');
    fs.chmodSync(t.keysFile, 0o644);
    fs.writeFileSync(t.keysFile, JSON.stringify(PINNED));
    expect(gate.check(SPAWN, o).ok).toBe(true);
    fs.writeFileSync(t.keysFile, JSON.stringify({ keys: [] }));
    expect(gate.check(SPAWN, o).reason).toBe('unknown_key');
  });

  it('refuses once the keys file is group- or world-writable, unreadable, replaced by a link, or no longer JSON', () => {
    const { gate, t } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT, consume: false };
    fs.chmodSync(t.keysFile, 0o664);
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'keys_file' });
    fs.chmodSync(t.keysFile, 0o646);
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'keys_file' });
    fs.chmodSync(t.keysFile, 0o644);
    expect(gate.check(SPAWN, o).ok).toBe(true);
    fs.writeFileSync(t.keysFile, '{not json');
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'keys_file' });
    fs.rmSync(t.keysFile);
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'keys_file' });
    const real = path.join(t.dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify(PINNED), { mode: 0o644 });
    fs.symlinkSync(real, t.keysFile);
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'keys_file' });
  });

  it("refuses a keys file the bridge's own user owns: at construction, and when it is swapped in later", () => {
    const t = tempKeys();
    temps.push(t);
    const opts = { keysFile: t.keysFile, noncesFile: path.join(t.dir, 'n.json'), journalHost: 'journal.example', user: 'alice', now: () => SIGNED_AT };
    expect(() => createApprovalGate({ ...opts, uid: process.getuid() })).toThrow(/owned by/);
    let uid = t.uid;
    const gate = createApprovalGate({ ...opts, uid: () => uid });
    uid = process.getuid();
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'keys_file' });
  });

  it('construction throws on a keys file that is missing, writable by others or not the right shape', () => {
    const t = tempKeys();
    temps.push(t);
    const opts = { uid: t.uid, noncesFile: path.join(t.dir, 'n.json'), journalHost: 'journal.example', user: 'alice' };
    expect(() => createApprovalGate({ ...opts, keysFile: path.join(t.dir, 'missing.json') })).toThrow(/MATRON_APPROVAL_KEYS_FILE/);
    fs.writeFileSync(t.keysFile, JSON.stringify({ keys: 'nope' }));
    expect(() => createApprovalGate({ ...opts, keysFile: t.keysFile })).toThrow(/keys/);
    fs.writeFileSync(t.keysFile, JSON.stringify(PINNED));
    fs.chmodSync(t.keysFile, 0o666);
    expect(() => createApprovalGate({ ...opts, keysFile: t.keysFile })).toThrow(/writable/);
  });

  it('the nonce ledger survives a restart, and forgets a nonce only after the longest window and an hour', () => {
    const { gate, t, clock } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT, maxAgeMs: 10 * 24 * 3600 * 1000 };
    expect(gate.check(SPAWN, o).ok).toBe(true);
    const again = () => createApprovalGate({
      keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'approval-nonces.json'),
      journalHost: 'journal.example', user: 'alice', now: () => clock.now, maxAgeMs: 10 * 24 * 3600 * 1000,
    });
    expect(again().check(SPAWN, o)).toEqual({ ok: false, reason: 'nonce_reused' });
    clock.now = SIGNED_AT + 24 * 3600 * 1000;
    expect(again().check(SPAWN, o)).toEqual({ ok: false, reason: 'nonce_reused' });
    clock.now = SIGNED_AT + 26 * 3600 * 1000;
    const late = again();
    late.check(sign({ subject: {} }), { type: 'account', subject: {}, maxAgeMs: 10 * 24 * 3600 * 1000 });
    expect(JSON.parse(fs.readFileSync(path.join(t.dir, 'approval-nonces.json'), 'utf8')).nonces).not.toHaveProperty(JSON.parse(SPAWN.statement).nonce);
  });

  it('a ledger file deleted while the bridge runs does not reopen a spent nonce', () => {
    const { gate, t } = gateWith();
    const o = { type: 'consent', subject: SPAWN_SUBJECT };
    expect(gate.check(SPAWN, o).ok).toBe(true);
    fs.rmSync(path.join(t.dir, 'approval-nonces.json'));
    expect(gate.check(SPAWN, o)).toEqual({ ok: false, reason: 'nonce_reused' });
  });

  it('refuses when the ledger cannot be written: a nonce it cannot record is not accepted', () => {
    const { gate } = gateWith({ noncesFile: '/proc/no-such-dir/approval-nonces.json' });
    expect(gate.check(SPAWN, { type: 'consent', subject: SPAWN_SUBJECT })).toEqual({ ok: false, reason: 'nonce_ledger' });
  });

  it('tells its listener about each refused consuming check, with the reason', () => {
    const { gate } = gateWith();
    const seen = [];
    gate.onRefusal((reason) => seen.push(reason));
    gate.check(sign({ subject: {}, privateKeyPem: otherKeyPem() }), { type: 'account', subject: {} });
    gate.check(sign({ subject: {} }), { type: 'account', subject: { a: 'b' } });
    gate.check(sign({ subject: {}, privateKeyPem: otherKeyPem() }), { type: 'account', subject: {}, consume: false });
    expect(seen).toEqual(['signature', 'mismatch']);
  });
});
