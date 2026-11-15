import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createAccountLock, ACCOUNT_LOCKED_LINE } from '../lib/account-lock.js';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { createAgentInvites } from '../lib/agent-invites.js';
import { createTransferReceiver } from '../lib/transfer-receiver.js';
import { createJournalInputConsumer } from '../lib/journal-input-router.js';

const silent = { warn() {}, log() {}, error() {} };
const LOCK = { kind: 'panic', on: true, since: 1790000000000, source: 'sentinel' };
const CLEAR = { kind: 'panic', on: false };

function make({ dir = mkdtempSync(path.join(tmpdir(), 'account-lock-')) } = {}) {
  const onLock = vi.fn();
  const onClear = vi.fn();
  const lock = createAccountLock({ stateFile: path.join(dir, 'account-lock.json'), onLock, onClear, log: silent });
  return { lock, onLock, onClear, dir };
}

describe('account lock', () => {
  it('says the one line', () => {
    expect(ACCOUNT_LOCKED_LINE).toBe('This account is locked. Sessions are stopped until it is cleared.');
  });

  it('starts unlocked; a lock frame locks and tells the bridge to stop turns; a clear frame restores', () => {
    const { lock, onLock, onClear } = make();
    expect(lock.isLocked()).toBe(false);
    lock.onFrame(LOCK);
    expect(lock.isLocked()).toBe(true);
    expect(lock.state()).toEqual({ on: true, since: 1790000000000, source: 'sentinel' });
    expect(onLock).toHaveBeenCalledTimes(1);
    lock.onFrame(CLEAR);
    expect(lock.isLocked()).toBe(false);
    expect(lock.state()).toEqual({ on: false, since: null, source: null });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('a repeated lock frame stops turns again but is still one lock; a clear when not locked does nothing', () => {
    const { lock, onLock, onClear } = make();
    lock.onFrame(CLEAR);
    expect(onClear).not.toHaveBeenCalled();
    lock.onFrame(LOCK);
    lock.onFrame({ ...LOCK, source: null });
    expect(onLock).toHaveBeenCalledTimes(2);
    expect(lock.state().source).toBe('sentinel');
  });

  it('a hello that carries the lock locks; a hello without it clears', () => {
    const { lock, onLock, onClear } = make();
    lock.onHello({ on: true, since: 5, source: null });
    expect(lock.state()).toEqual({ on: true, since: 5, source: null });
    expect(onLock).toHaveBeenCalledTimes(1);
    lock.onHello(null);
    expect(lock.isLocked()).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
    lock.onHello(undefined);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a lock it cannot read: anything but an explicit off keeps or sets the lock', () => {
    const { lock } = make();
    lock.onHello({ since: 5 });
    expect(lock.isLocked()).toBe(true);
    lock.onFrame({ kind: 'panic' });
    expect(lock.isLocked()).toBe(true);
    lock.onFrame({ kind: 'panic', on: 'false' });
    expect(lock.isLocked()).toBe(true);
    lock.onFrame(CLEAR);
    expect(lock.isLocked()).toBe(false);
    lock.onFrame({ kind: 'panic', on: true, since: 'soon', source: 42 });
    expect(lock.state()).toEqual({ on: true, since: null, source: null });
  });

  it('a bridge that restarts while disconnected stays locked until a hello says otherwise', () => {
    const first = make();
    first.lock.onFrame(LOCK);
    const again = make({ dir: first.dir });
    expect(again.lock.isLocked()).toBe(true);
    expect(again.lock.state().since).toBe(1790000000000);
    expect(again.onLock).not.toHaveBeenCalled();
    again.lock.onHello(null);
    expect(again.lock.isLocked()).toBe(false);
    expect(make({ dir: first.dir }).lock.isLocked()).toBe(false);
  });

  it('nothing but a journal frame or hello clears it: there is no other way in the interface', () => {
    const { lock } = make();
    lock.onFrame(LOCK);
    expect(Object.keys(lock).sort()).toEqual(['hold', 'isLocked', 'onFrame', 'onHello', 'shouldNotify', 'state', 'verdict']);
  });

  it('holds what falls due while locked and hands it back, in order, after the clear, also across a restart', () => {
    const first = make();
    expect(first.lock.hold({ id: 0 })).toBe(false);
    first.lock.onFrame(LOCK);
    expect(first.lock.hold({ id: 1, text: 'check the build' })).toBe(true);
    expect(first.lock.hold({ id: 2, text: 'ping' })).toBe(true);
    const again = make({ dir: first.dir });
    expect(again.lock.hold({ id: 3 })).toBe(true);
    again.lock.onFrame(CLEAR);
    expect(again.onClear).toHaveBeenCalledWith([{ id: 1, text: 'check the build' }, { id: 2, text: 'ping' }, { id: 3 }]);
    again.lock.onFrame(LOCK);
    again.lock.onFrame(CLEAR);
    expect(again.onClear).toHaveBeenLastCalledWith([]);
  });

  it('says its line once per conversation per lock', () => {
    const { lock } = make();
    expect(lock.shouldNotify('c1')).toBe(false);
    lock.onFrame(LOCK);
    expect(lock.shouldNotify('c1')).toBe(true);
    expect(lock.shouldNotify('c1')).toBe(false);
    expect(lock.shouldNotify('c2')).toBe(true);
    lock.onFrame(CLEAR);
    lock.onFrame(LOCK);
    expect(lock.shouldNotify('c1')).toBe(true);
  });

  it('its verdict refuses users and peers alike, with no exception for a signed tap', () => {
    const { lock } = make();
    expect(lock.verdict()).toEqual({ ok: true });
    lock.onFrame(LOCK);
    expect(lock.verdict()).toEqual({ ok: false, hard: true, line: ACCOUNT_LOCKED_LINE });
  });

  it('a callback that throws does not undo the lock', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'account-lock-'));
    const lock = createAccountLock({ stateFile: path.join(dir, 's.json'), onLock: () => { throw new Error('boom'); }, onClear: () => { throw new Error('boom'); }, log: silent });
    lock.onFrame(LOCK);
    expect(lock.isLocked()).toBe(true);
    lock.onFrame(CLEAR);
    expect(lock.isLocked()).toBe(false);
  });
});

// --- every inbound path refuses while locked ---------------------------------

describe('while the account is locked', () => {
  it('a start and every session control action are refused; with the lock off they pass', async () => {
    let locked = true;
    const responses = [];
    const startSession = vi.fn(() => ({ claudeSessionId: 's1' }));
    const controlSession = vi.fn(async () => ({ ok: true, result: {} }));
    const handler = createRpcRequestHandler({
      respondRpc: (a) => responses.push(a), startSession, stopSession: () => {}, listPersistedSessions: () => [],
      defaultWorkdir: '/srv', defaultAgent: 'claude', expandHome: (p) => p, statSync: () => ({ isDirectory: () => true }),
      injectTurn: () => true, controlSession, accountLocked: () => locked, log: silent,
    });
    handler({ request_id: 'a', from_device_id: 0, method: 'start', params: { workdir: '/srv/p', prompt: 'task', spawn_id: 'sp' } });
    handler({ request_id: 'b', from_device_id: 4, method: 'start', params: {} });
    for (const action of ['carry_on', 'compact', 'alert', 'routine', 'set_model']) handler({ request_id: action, from_device_id: 0, method: 'session_control', params: { convo_id: 'c', action } });
    expect(responses.map((r) => r.error?.code)).toEqual(Array(7).fill('account_locked'));
    expect(startSession).not.toHaveBeenCalled();
    expect(controlSession).not.toHaveBeenCalled();
    handler({ request_id: 'folders', from_device_id: 4, method: 'recent_folders', params: {} });
    expect(responses[7].ok).toBe(true);
    locked = false;
    handler({ request_id: 'c', from_device_id: 4, method: 'start', params: {} });
    expect(responses[8].ok).toBe(true);
  });

  it('a chat invite and a join request are refused', () => {
    let locked = true;
    const sent = [];
    const injectRequestTurn = vi.fn();
    const m = createAgentInvites({ sendRoomOp: (op) => { sent.push(op); return true; }, rooms: { get: () => null }, injectRequestTurn, accountLocked: () => locked, log: silent });
    m.onInviteFrame({ kind: 'invite', event: 'request', room_id: 'r1', from_device_id: 3, justification: 'x' });
    m.onInviteFrame({ kind: 'invite', event: 'join_request', room_id: 'r1', from_device_id: 3, justification: 'x' });
    expect(injectRequestTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { op: 'agent_invite_answer', room_id: 'r1', accept: false, reason: 'account_locked' },
      { op: 'agent_invite_answer', room_id: 'r1', peer_device_id: 3, accept: false, reason: 'account_locked' },
    ]);
    locked = false;
    m.onInviteFrame({ kind: 'invite', event: 'request', room_id: 'r1', from_device_id: 3, justification: 'x' });
    expect(injectRequestTurn).toHaveBeenCalledTimes(1);
  });

  it('a file transfer is refused and nothing is downloaded', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'account-lock-transfer-'));
    mkdirSync(path.join(root, 'repo'));
    const bytes = Buffer.from('bytes');
    const client = {
      download: vi.fn(async () => new Response(bytes, { status: 200 })),
      received: vi.fn(async () => ({ ok: true, status: 200 })), failed: vi.fn(async () => ({ ok: true, status: 200 })),
      listPending: vi.fn(async () => ({ ok: true, status: 200, body: { transfers: [] } })),
    };
    const inbox = path.join(root, 'inbox');
    const r = createTransferReceiver({
      client, dirFor: () => inbox, sessionsForRoom: () => [{ roomId: '!s' }], stateFile: path.join(root, 'state.json'),
      log: silent, sleep: async () => {}, accountLocked: () => true,
    });
    r.onReady({ id: 't1', room_id: 'r1', name: 'f.txt', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    await r.idle();
    expect(client.download).not.toHaveBeenCalled();
    expect(client.failed).toHaveBeenCalledWith('t1', 'account_locked');
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([]);
  });

  it("user input, a verified signed tap and a peer's room message are all refused; the user is told, a room is not answered", async () => {
    const { lock } = make();
    lock.onFrame(LOCK);
    const calls = { text: vi.fn(), item: vi.fn(), room: vi.fn(), refused: vi.fn(), roomRefused: vi.fn(), verify: vi.fn(async () => ({ ok: true })) };
    const onEvent = createJournalInputConsumer({
      isControlConvo: () => false, handleControlCommand: () => {}, findSessionByConvoId: () => ({ roomId: '!s' }),
      routeTextToSession: calls.text, routeItemToSession: calls.item, routeRoomFrame: calls.room,
      roomFor: (id) => (id === 'room-1' ? { roomId: 'room-1' } : null), selfAgentName: () => 'box-a', selfAgentDeviceId: () => 9,
      ownerName: () => 'alice', inputLock: lock, onInputRefused: calls.refused, onRoomRefused: calls.roomRefused, verifySignedTap: calls.verify, log: silent,
    });
    const frame = (o) => ({ kind: 'journal', seq: 1, convo_id: 'c1', ts: 1, sender: 'user:alice', type: 'text', payload: { body: 'go' }, ...o });
    onEvent(frame({}));
    onEvent(frame({ type: 'item', payload: { item_id: 'it_1', num: 1, title: 'T', action: 'commented', by: 'user', comment: { id: 'ic', body: 'Approve', action: 'Approve', signed: true, key_id: 'k' } } }));
    onEvent(frame({ convo_id: 'room-1', sender: 'agent:box-b', sender_device_id: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.text).not.toHaveBeenCalled();
    expect(calls.item).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.room).not.toHaveBeenCalled();
    expect(calls.roomRefused).not.toHaveBeenCalled();
    expect(calls.refused).toHaveBeenCalledTimes(2);
    expect(calls.refused.mock.calls[0]).toEqual(['c1', ACCOUNT_LOCKED_LINE]);
  });
});
