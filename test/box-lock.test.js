import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createApprovalGate } from '../lib/approval-gate.js';
import { createBoxLock, LOCKED_USER_LINE, lockedPeerLine } from '../lib/box-lock.js';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { KEY_ID, SIGNED_AT, sign, tempKeys, otherKeyPem, UNIX } from './approval-helpers.js';

// The lock runs on a real gate.
const gatedDescribe = describe.skipIf(!UNIX);

const silent = { warn() {}, log() {}, error() {} };
const MIN = 60 * 1000;
const temps = [];
afterEach(() => { while (temps.length) temps.pop().cleanup(); });

function box({ locked = true, maxMinutes = 120, reuse = null } = {}) {
  const t = reuse?.t ?? tempKeys();
  if (!reuse) temps.push(t);
  const clock = reuse?.clock ?? { now: SIGNED_AT + 1000 };
  const gate = createApprovalGate({
    keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'nonces.json'),
    journalHost: 'journal.example', user: 'alice', now: () => clock.now, log: silent,
  });
  const fileNotice = vi.fn();
  const onChange = vi.fn();
  const lock = createBoxLock({
    gate, locked, maxMinutes, now: () => clock.now, stateFile: path.join(t.dir, 'lock.json'),
    boxName: () => 'box-a', fileNotice, onChange, log: silent,
  });
  return { lock, gate, clock, t, fileNotice, onChange };
}
// Statements are signed "now" on the test clock unless a time is given.
const unlockApproval = (clock, minutes = '30', extra = {}) => sign({ type: 'account', subject: { op: 'unlock_box', box: 'box-a', minutes }, signedAt: clock.now, ...extra });
const clearApproval = (clock, extra = {}) => sign({ type: 'account', subject: { op: 'clear_lockdown', box: 'box-a' }, signedAt: clock.now, ...extra });
const forged = (clock) => unlockApproval(clock, '30', { privateKeyPem: otherKeyPem() });

gatedDescribe('a box that is not in locked mode', () => {
  it('lets every user and peer through, and reports no lock', () => {
    const { lock } = box({ locked: false });
    expect(lock.allowsUser(null)).toBe(true);
    expect(lock.allowsUser('anything')).toBe(true);
    expect(lock.allowsPeer()).toBe(true);
    expect(lock.state()).toEqual({ on: false, until: null, lockdownUntil: null });
    expect(lock.report()).toEqual({ on: false, until: null, lockdown_until: null });
    expect(lock.verdict('user', null)).toEqual({ ok: true });
  });

  it('cannot be unlocked', () => {
    const { lock, clock } = box({ locked: false });
    expect(lock.unlock(unlockApproval(clock))).toEqual({ ok: false, reason: 'not_locked' });
  });
});

gatedDescribe('locked mode', () => {
  it('refuses users and peers until unlocked, and says what to do', () => {
    const { lock } = box();
    expect(lock.state()).toEqual({ on: true, until: null, lockdownUntil: null });
    expect(lock.report()).toEqual({ on: true, until: null, lockdown_until: null });
    expect(lock.allowsUser(KEY_ID)).toBe(false);
    expect(lock.allowsPeer()).toBe(false);
    expect(lock.verdict('user', KEY_ID)).toEqual({ ok: false, line: LOCKED_USER_LINE });
    expect(lock.verdict('peer')).toEqual({ ok: false, line: lockedPeerLine('box-a') });
    expect(LOCKED_USER_LINE).toBe('This box is locked. Unlock it to send instructions.');
    expect(lockedPeerLine('box-a')).toBe('box-a is locked; ask the user to unlock it');
  });

  it('a valid unlock opens a window for the device that signed it, and for peers', () => {
    const { lock, clock, onChange } = box();
    const r = lock.unlock(unlockApproval(clock, '30'));
    expect(r).toEqual({ ok: true, until: clock.now + 30 * MIN });
    expect(lock.allowsUser(KEY_ID)).toBe(true);
    expect(lock.allowsUser('f'.repeat(64))).toBe(false);
    expect(lock.allowsUser(null)).toBe(false);
    expect(lock.allowsUser(undefined)).toBe(false);
    expect(lock.allowsPeer()).toBe(true);
    expect(lock.state()).toEqual({ on: true, until: clock.now + 30 * MIN, lockdownUntil: null });
    expect(lock.report()).toEqual({ on: false, until: clock.now + 30 * MIN, lockdown_until: null });
    expect(onChange).toHaveBeenCalled();
  });

  it('the window ends on time', () => {
    const { lock, clock } = box();
    lock.unlock(unlockApproval(clock, '30'));
    clock.now += 30 * MIN - 1;
    expect(lock.allowsUser(KEY_ID)).toBe(true);
    clock.now += 1;
    expect(lock.allowsUser(KEY_ID)).toBe(false);
    expect(lock.allowsPeer()).toBe(false);
    expect(lock.report()).toEqual({ on: true, until: null, lockdown_until: null });
  });

  it('lock ends the window early, and needs no signature', () => {
    const { lock, clock, onChange } = box();
    lock.unlock(unlockApproval(clock));
    onChange.mockClear();
    lock.lock();
    expect(lock.allowsUser(KEY_ID)).toBe(false);
    expect(lock.state().until).toBe(null);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refuses minutes over the cap, under one, or not a whole number, without spending the statement', () => {
    const { lock, clock } = box({ maxMinutes: 60 });
    expect(lock.unlock(unlockApproval(clock, '61'))).toEqual({ ok: false, reason: 'bad_minutes' });
    expect(lock.unlock(unlockApproval(clock, '0'))).toEqual({ ok: false, reason: 'bad_minutes' });
    expect(lock.unlock(unlockApproval(clock, '1.5'))).toEqual({ ok: false, reason: 'bad_minutes' });
    expect(lock.unlock(unlockApproval(clock, '030'))).toEqual({ ok: false, reason: 'bad_minutes' });
    expect(lock.unlock({ statement: 'junk', signature: 'x' })).toEqual({ ok: false, reason: 'bad_statement' });
    expect(lock.unlock(null)).toEqual({ ok: false, reason: 'approval_required' });
    expect(lock.unlock(unlockApproval(clock, '60')).ok).toBe(true);
  });

  it('an unlock statement cannot be used twice, and one for another box is refused', () => {
    const { lock, clock } = box();
    const a = unlockApproval(clock);
    expect(lock.unlock(a).ok).toBe(true);
    lock.lock();
    expect(lock.unlock(a)).toEqual({ ok: false, reason: 'nonce_reused' });
    expect(lock.unlock(sign({ type: 'account', subject: { op: 'unlock_box', box: 'box-b', minutes: '30' }, signedAt: clock.now }))).toEqual({ ok: false, reason: 'mismatch' });
    expect(lock.unlock(sign({ type: 'consent', subject: { op: 'unlock_box', box: 'box-a', minutes: '30' }, signedAt: clock.now }))).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('an unlock older than five minutes is refused', () => {
    const { lock, clock } = box();
    const a = unlockApproval(clock);
    clock.now += 6 * MIN;
    expect(lock.unlock(a)).toEqual({ ok: false, reason: 'stale' });
  });

  it('a restart inside a window keeps the same end time and the same device; one after it starts locked', () => {
    const first = box();
    const { until } = first.lock.unlock(unlockApproval(first.clock, '30'));
    first.clock.now += 10 * MIN;
    const again = box({ reuse: first });
    expect(again.lock.state().until).toBe(until);
    expect(again.lock.allowsUser(KEY_ID)).toBe(true);
    expect(again.lock.allowsUser('f'.repeat(64))).toBe(false);
    first.clock.now += 21 * MIN;
    const later = box({ reuse: first });
    expect(later.lock.allowsUser(KEY_ID)).toBe(false);
    expect(later.lock.state().until).toBe(null);
  });

  it('a stored window longer than any unlock could open is dropped at start, and the file corrected', () => {
    const first = box();
    first.lock.unlock(unlockApproval(first.clock, '30'));
    const file = path.join(first.t.dir, 'lock.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Exactly the longest window from now is kept.
    fs.writeFileSync(file, JSON.stringify({ ...stored, window: { ...stored.window, until: first.clock.now + 120 * MIN } }));
    const kept = box({ reuse: first });
    expect(kept.lock.state().until).toBe(first.clock.now + 120 * MIN);
    expect(kept.lock.allowsUser(KEY_ID)).toBe(true);
    // One millisecond more is not.
    fs.writeFileSync(file, JSON.stringify({ ...stored, window: { ...stored.window, until: first.clock.now + 120 * MIN + 1 } }));
    const dropped = box({ reuse: first });
    expect(dropped.lock.state()).toEqual({ on: true, until: null, lockdownUntil: null });
    expect(dropped.lock.report()).toEqual({ on: true, until: null, lockdown_until: null });
    expect(dropped.lock.allowsUser(KEY_ID)).toBe(false);
    expect(dropped.lock.allowsPeer()).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).window).toBe(null);
    // The limit is the one in force at start: a lower one applies to a window opened under a higher one.
    fs.writeFileSync(file, JSON.stringify({ ...stored, window: { ...stored.window, until: first.clock.now + 20 * MIN } }));
    expect(box({ reuse: first, maxMinutes: 10 }).lock.allowsUser(KEY_ID)).toBe(false);
    // The box can be unlocked again as usual.
    first.clock.now += 1000;
    const again = box({ reuse: first });
    expect(again.lock.unlock(unlockApproval(first.clock, '5'))).toEqual({ ok: true, until: first.clock.now + 5 * MIN });
  });

  it('a second unlock replaces the window: it never extends one silently', () => {
    const { lock, clock } = box();
    lock.unlock(unlockApproval(clock, '60'));
    const r = lock.unlock(unlockApproval(clock, '5'));
    expect(r.until).toBe(clock.now + 5 * MIN);
    expect(lock.state().until).toBe(clock.now + 5 * MIN);
  });
});

gatedDescribe('lockdown', () => {
  it('three forged-looking refusals within ten minutes lock the gate down for thirty minutes and file a notice', () => {
    const { lock, clock, fileNotice } = box();
    lock.unlock(forged(clock));
    lock.unlock(forged(clock));
    expect(lock.state().lockdownUntil).toBe(null);
    lock.unlock(forged(clock));
    expect(lock.state().lockdownUntil).toBe(clock.now + 30 * MIN);
    expect(fileNotice).toHaveBeenCalledTimes(1);
    expect(fileNotice.mock.calls[0][0].title).toMatch(/locked down/i);
    expect(fileNotice.mock.calls[0][0].body.split('\n')[0]).toBe('Box: box-a');
    expect(fileNotice.mock.calls[0][0].labels).toEqual(['box-lockdown']);
    expect(lock.report()).toEqual({ on: true, until: null, lockdown_until: clock.now + 30 * MIN });
  });

  it('a statement from a key that is not pinned on this box never counts: an enrolled device the operator did not pin is honest', () => {
    const { lock, gate, clock, t } = box();
    fs.writeFileSync(t.keysFile, JSON.stringify({ keys: [] }));
    for (let i = 0; i < 5; i++) expect(gate.check(sign({ type: 'consent', subject: {}, signedAt: clock.now }), { type: 'consent', subject: {} }).reason).toBe('unknown_key');
    expect(lock.state().lockdownUntil).toBe(null);
  });

  it('a window cap beyond what a timer can hold does not spin', () => {
    const t = tempKeys();
    temps.push(t);
    const clock = { now: SIGNED_AT + 1000 };
    const gate = createApprovalGate({ keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'n.json'), journalHost: 'journal.example', user: 'alice', now: () => clock.now, log: silent });
    const delays = [];
    const lock = createBoxLock({ gate, locked: true, maxMinutes: 100000, now: () => clock.now, stateFile: path.join(t.dir, 'l.json'), boxName: () => 'box-a', schedule: (fn, ms) => { delays.push(ms); return null; }, log: silent });
    expect(lock.unlock(unlockApproval(clock, '100000')).ok).toBe(true);
    expect(Math.max(...delays)).toBeLessThanOrEqual(24 * 60 * MIN);
  });

  it('refusals an honest app can cause never count', () => {
    const { lock, gate, clock } = box();
    for (let i = 0; i < 5; i++) lock.unlock(sign({ type: 'account', subject: { op: 'unlock_box', box: 'box-b', minutes: '30' }, signedAt: clock.now }));
    for (let i = 0; i < 5; i++) gate.check(null, { type: 'account', subject: {} });
    for (let i = 0; i < 5; i++) lock.unlock(unlockApproval(clock, '999'));
    expect(lock.state().lockdownUntil).toBe(null);
  });

  it('refusals more than ten minutes apart never add up', () => {
    const { lock, clock } = box();
    lock.unlock(forged(clock));
    lock.unlock(forged(clock));
    clock.now += 11 * MIN;
    lock.unlock(forged(clock));
    expect(lock.state().lockdownUntil).toBe(null);
  });

  it("a refusal anywhere in the gate counts, not only an unlock's", () => {
    const { lock, gate, clock } = box({ locked: false });
    for (let i = 0; i < 3; i++) gate.check(sign({ type: 'consent', subject: {}, signedAt: clock.now, privateKeyPem: otherKeyPem() }), { type: 'consent', subject: {} });
    expect(lock.state().lockdownUntil).toBe(clock.now + 30 * MIN);
    expect(lock.report()).toEqual({ on: false, until: null, lockdown_until: clock.now + 30 * MIN });
  });

  it('in lockdown a valid unlock is refused, an open window is shut, and gated requests are refused', () => {
    const { lock, clock } = box();
    lock.unlock(unlockApproval(clock));
    for (let i = 0; i < 3; i++) lock.unlock(forged(clock));
    expect(lock.allowsUser(KEY_ID)).toBe(false);
    expect(lock.allowsPeer()).toBe(false);
    expect(lock.inLockdown()).toBe(true);
    expect(lock.unlock(unlockApproval(clock))).toEqual({ ok: false, reason: 'lockdown' });
  });

  it('lockdown ends by itself, and the next one lasts twice as long, up to a day', () => {
    const { lock, clock } = box();
    const trip = () => { for (let i = 0; i < 3; i++) lock.unlock(forged(clock)); return lock.state().lockdownUntil - clock.now; };
    expect(trip()).toBe(30 * MIN);
    clock.now += 30 * MIN;
    expect(lock.inLockdown()).toBe(false);
    expect(lock.unlock(unlockApproval(clock)).ok).toBe(true);
    expect(trip()).toBe(60 * MIN);
    for (const expected of [120, 240, 480, 960, 1440, 1440]) {
      clock.now += 24 * 60 * MIN;
      expect(trip()).toBe(expected * MIN);
    }
  });

  it('clear_lockdown, signed for this box, is the only early way out; a replayed unlock is not', () => {
    const { lock, clock, onChange } = box();
    const earlier = unlockApproval(clock);
    for (let i = 0; i < 3; i++) lock.unlock(forged(clock));
    expect(lock.clearLockdown(earlier)).toEqual({ ok: false, reason: 'mismatch' });
    expect(lock.clearLockdown(sign({ type: 'account', subject: { op: 'clear_lockdown', box: 'box-b' }, signedAt: clock.now }))).toEqual({ ok: false, reason: 'mismatch' });
    expect(lock.inLockdown()).toBe(true);
    onChange.mockClear();
    expect(lock.clearLockdown(clearApproval(clock))).toEqual({ ok: true });
    expect(lock.inLockdown()).toBe(false);
    expect(onChange).toHaveBeenCalled();
    expect(lock.unlock(unlockApproval(clock)).ok).toBe(true);
  });

  it('forged clear_lockdown attempts during a lockdown do not lengthen it', () => {
    const { lock, clock } = box();
    for (let i = 0; i < 3; i++) lock.unlock(forged(clock));
    const until = lock.state().lockdownUntil;
    for (let i = 0; i < 5; i++) lock.clearLockdown(clearApproval(clock, { privateKeyPem: otherKeyPem() }));
    expect(lock.state().lockdownUntil).toBe(until);
  });

  it('survives a restart', () => {
    const first = box();
    for (let i = 0; i < 3; i++) first.lock.unlock(forged(first.clock));
    const again = box({ reuse: first });
    expect(again.lock.inLockdown()).toBe(true);
    expect(again.lock.state().lockdownUntil).toBe(first.lock.state().lockdownUntil);
  });

  it('a stored lockdown longer than a lockdown can last is shortened to a day at start, never dropped', () => {
    const first = box();
    for (let i = 0; i < 3; i++) first.lock.unlock(forged(first.clock));
    const file = path.join(first.t.dir, 'lock.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, lockdown: { until: first.clock.now + 400 * 24 * 60 * MIN } }));
    const again = box({ reuse: first });
    expect(again.lock.inLockdown()).toBe(true);
    expect(again.lock.state().lockdownUntil).toBe(first.clock.now + 24 * 60 * MIN);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).lockdown).toEqual({ until: first.clock.now + 24 * 60 * MIN });
    // One within the limit is kept as stored.
    fs.writeFileSync(file, JSON.stringify({ ...stored, lockdown: { until: first.clock.now + 24 * 60 * MIN } }));
    expect(box({ reuse: first }).lock.state().lockdownUntil).toBe(first.clock.now + 24 * 60 * MIN);
  });

  it('a notice that cannot be filed does not stop the lockdown', () => {
    const b = box();
    b.fileNotice.mockImplementation(() => { throw new Error('journal down'); });
    for (let i = 0; i < 3; i++) b.lock.unlock(forged(b.clock));
    expect(b.lock.inLockdown()).toBe(true);
  });
});

gatedDescribe('unlock, lock and clear_lockdown over RPC', () => {
  function rpc(lock) {
    const responses = [];
    const handler = createRpcRequestHandler({
      respondRpc: (args) => responses.push(args), startSession: () => ({}), stopSession: () => {}, listPersistedSessions: () => [],
      defaultWorkdir: '/srv', expandHome: (p) => p, boxLock: lock, log: silent,
    });
    return { handler, responses };
  }
  const req = (method, params = {}) => ({ request_id: `r-${method}`, from_device_id: 4, approval_key_id: KEY_ID, method, params });

  it('unlock answers with the window, lock closes it, and each failure names its reason', () => {
    const { lock, clock } = box();
    const { handler, responses } = rpc(lock);
    handler(req('unlock', { approval: unlockApproval(clock, '15') }));
    expect(responses[0].result).toEqual({ locked: { on: false, until: clock.now + 15 * MIN, lockdown_until: null } });
    handler(req('lock'));
    expect(responses[1].result).toEqual({ locked: { on: true, until: null, lockdown_until: null } });
    handler(req('unlock', {}));
    expect(responses[2].error).toEqual({ code: 'approval_required' });
    handler(req('unlock', { approval: forged(clock) }));
    expect(responses[3].error).toEqual({ code: 'approval_invalid', detail: 'signature' });
    handler(req('unlock', { approval: unlockApproval(clock, '999') }));
    expect(responses[4].error).toEqual({ code: 'bad_minutes' });
    for (let i = 0; i < 2; i++) handler(req('unlock', { approval: forged(clock) }));
    handler(req('unlock', { approval: unlockApproval(clock) }));
    expect(responses[7].error).toEqual({ code: 'lockdown' });
  });

  it('clear_lockdown clears a lockdown', () => {
    const { lock, clock } = box();
    for (let i = 0; i < 3; i++) lock.unlock(forged(clock));
    const { handler, responses } = rpc(lock);
    handler(req('clear_lockdown', { approval: clearApproval(clock) }));
    expect(responses[0]).toMatchObject({ ok: true });
    expect(lock.inLockdown()).toBe(false);
  });

  it('a box without approval keys answers these as it always did: unknown_method', () => {
    const { handler, responses } = rpc(null);
    handler(req('unlock', {}));
    handler(req('lock'));
    handler(req('clear_lockdown', {}));
    expect(responses.map((r) => r.error.code)).toEqual(['unknown_method', 'unknown_method', 'unknown_method']);
  });
});
