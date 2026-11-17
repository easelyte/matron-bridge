import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApprovalGate } from '../lib/approval-gate.js';
import { createApprovalPaths, subjectValue } from '../lib/approval-paths.js';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';
import { createAgentInvites } from '../lib/agent-invites.js';
import { createTransferReceiver } from '../lib/transfer-receiver.js';
import { SIGNED_AT, sign, sha256Hex, tempKeys, otherKeyPem, UNIX } from './approval-helpers.js';

// Everything here but the subject rule runs a real gate.
const gatedDescribe = describe.skipIf(!UNIX);

const silent = { warn() {}, log() {}, error() {} };
const temps = [];
afterEach(() => { while (temps.length) temps.pop().cleanup(); });

// A gated box named box-a, device 9, serving alice on journal.example.
function gated({ identity = { deviceId: 9, name: 'box-a' } } = {}) {
  const t = tempKeys();
  temps.push(t);
  const gate = createApprovalGate({
    keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'nonces.json'),
    journalHost: 'journal.example', user: 'alice', now: () => SIGNED_AT + 1000, log: silent,
  });
  return createApprovalPaths({ gate, identity: () => identity, log: silent });
}
const ungated = () => createApprovalPaths({ gate: createApprovalGate({ keysFile: '' }), identity: () => ({ deviceId: 9, name: 'box-a' }), log: silent });

gatedDescribe('lockdown', () => {
  it('refuses every gated request, valid or not, while the box is locked down', () => {
    const t = tempKeys();
    temps.push(t);
    const gate = createApprovalGate({ keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'n.json'), journalHost: 'journal.example', user: 'alice', now: () => SIGNED_AT + 1000, log: silent });
    let down = true;
    const paths = createApprovalPaths({ gate, identity: () => ({ deviceId: 9, name: 'box-a' }), lockdown: () => down, log: silent });
    const approval = sign({ type: 'consent', subject: { op: 'spawn', ask: 'sp_1', box: 'box-a', workdir: '/srv/project', task_sha256: sha256Hex('t'), decision: 'approve' } });
    const request = { request_id: 'r', from_device_id: 0, params: { workdir: '/srv/project', prompt: 't', spawn_id: 'sp_1', approval } };
    expect(paths.start(request)).toEqual({ ok: false, reason: 'lockdown' });
    expect(paths.invite({ event: 'request', room_id: 'r1', justification: '' })).toEqual({ ok: false, reason: 'lockdown' });
    expect(paths.transfer({ id: 't1', sha256: 'x', size: 1 })).toEqual({ ok: false, reason: 'lockdown' });
    down = false;
    expect(paths.start(request).ok).toBe(true);
  });
});

describe('subjects', () => {
  it('a value over 200 characters is signed as its hash under <name>_sha256', () => {
    const long = '/'.padEnd(300, 'w');
    expect(subjectValue({}, 'workdir', '~/app')).toEqual({ workdir: '~/app' });
    expect(subjectValue({}, 'workdir', long)).toEqual({ workdir_sha256: sha256Hex(long) });
  });
});

// --- start / spawn -----------------------------------------------------------

function rpc(approvals, overrides = {}) {
  const responses = [];
  const startSession = vi.fn(() => ({ claudeSessionId: 'session-1' }));
  const controlSession = vi.fn(async () => ({ ok: true, result: { outcome: 'applied' } }));
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession, stopSession: () => {}, listPersistedSessions: () => [],
    defaultWorkdir: '/srv/default', defaultAgent: 'claude',
    expandHome: (p) => p, statSync: () => ({ isDirectory: () => true }),
    injectTurn: () => true, controlSession, approvals, log: silent, ...overrides,
  });
  return { handler, responses, startSession, controlSession };
}

const TASK = 'Run the test suite and report.';
const spawnSubject = (o = {}) => ({ op: 'spawn', ask: 'sp_1', box: 'box-a', workdir: '/srv/project', task_sha256: sha256Hex(TASK), decision: 'approve', ...o });
const spawnReq = (params = {}) => ({ request_id: 'r1', from_device_id: 0, method: 'start', params: { workdir: '/srv/project', prompt: TASK, spawn_id: 'sp_1', ...params } });
const startSubject = (o = {}) => ({ op: 'start', box: 'box-a', workdir: '/srv/project', prompt_sha256: sha256Hex(''), ...o });
const clientReq = (params = {}) => ({ request_id: 'r2', from_device_id: 4, approval_key_id: null, method: 'start', params: { workdir: '/srv/project', ...params } });
const refused = (responses, detail) => {
  expect(responses).toHaveLength(1);
  expect(responses[0].ok).toBe(false);
  if (detail === 'approval_required') expect(responses[0].error).toEqual({ code: 'approval_required' });
  else expect(responses[0].error).toEqual({ code: 'approval_invalid', detail });
};

gatedDescribe('start on a gated box', () => {
  it('a spawn with no approval is refused and nothing starts', () => {
    const { handler, responses, startSession } = rpc(gated());
    handler(spawnReq());
    refused(responses, 'approval_required');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('a spawn with a valid approval starts as before, once', () => {
    const { handler, responses, startSession } = rpc(gated());
    const approval = sign({ type: 'consent', subject: spawnSubject() });
    handler(spawnReq({ approval }));
    expect(responses[0]).toMatchObject({ ok: true, result: { convo_id: 'session-1' } });
    expect(startSession).toHaveBeenCalledTimes(1);
    handler(spawnReq({ approval }));
    expect(responses[1].error).toEqual({ code: 'approval_invalid', detail: 'nonce_reused' });
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('a spawn approval replayed with another task, workdir, ask or box is refused', () => {
    const approval = sign({ type: 'consent', subject: spawnSubject() });
    for (const params of [{ prompt: 'Delete everything.' }, { workdir: '/srv/other' }, { spawn_id: 'sp_2' }]) {
      const { handler, responses, startSession } = rpc(gated());
      handler(spawnReq({ approval, ...params }));
      refused(responses, 'mismatch');
      expect(startSession).not.toHaveBeenCalled();
    }
    const elsewhere = rpc(gated({ identity: { deviceId: 9, name: 'box-b' } }));
    elsewhere.handler(spawnReq({ approval }));
    refused(elsewhere.responses, 'mismatch');
  });

  it('a spawn approval older than its window is refused', () => {
    const { handler, responses } = rpc(gated());
    handler(spawnReq({ approval: sign({ type: 'consent', subject: spawnSubject(), signedAt: SIGNED_AT - 31 * 60 * 1000 }) }));
    refused(responses, 'stale');
  });

  it("a client's start with no prompt needs an approval over the empty prompt", () => {
    const { handler, responses, startSession } = rpc(gated());
    handler(clientReq());
    refused(responses, 'approval_required');
    handler(clientReq({ approval: sign({ type: 'account', subject: startSubject() }) }));
    expect(responses[1].ok).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("a client's start with no workdir signs the empty workdir; one with a prompt signs its hash", () => {
    const a = rpc(gated());
    a.handler({ request_id: 'r', from_device_id: 4, method: 'start', params: { approval: sign({ type: 'account', subject: startSubject({ workdir: '' }) }) } });
    expect(a.responses[0].ok).toBe(true);
    const b = rpc(gated());
    b.handler(clientReq({ prompt: 'Check the deploy logs', approval: sign({ type: 'account', subject: startSubject({ prompt_sha256: sha256Hex('Check the deploy logs') }) }) }));
    expect(b.responses[0].ok).toBe(true);
    const c = rpc(gated());
    c.handler(clientReq({ prompt: 'Something else', approval: sign({ type: 'account', subject: startSubject({ prompt_sha256: sha256Hex('Check the deploy logs') }) }) }));
    refused(c.responses, 'mismatch');
  });

  it('a consent statement never passes for a client start, nor an account one for a spawn', () => {
    const a = rpc(gated());
    a.handler(clientReq({ approval: sign({ type: 'consent', subject: startSubject() }) }));
    refused(a.responses, 'mismatch');
    const b = rpc(gated());
    b.handler(spawnReq({ approval: sign({ type: 'account', subject: spawnSubject() }) }));
    refused(b.responses, 'mismatch');
  });

  it('a forged approval is refused', () => {
    const { handler, responses, startSession } = rpc(gated());
    handler(spawnReq({ approval: sign({ type: 'consent', subject: spawnSubject(), privateKeyPem: otherKeyPem() }) }));
    refused(responses, 'signature');
    expect(startSession).not.toHaveBeenCalled();
  });

  it("another person's talk request never starts a session, approval or not", () => {
    const { handler, responses, startSession } = rpc(gated());
    handler(spawnReq({ talk: true, approval: sign({ type: 'consent', subject: spawnSubject() }) }));
    refused(responses, 'talk_request');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('a bad request is still answered as a bad request, before any approval is spent', () => {
    const { handler, responses } = rpc(gated(), { statSync: () => { throw new Error('missing'); } });
    const approval = sign({ type: 'consent', subject: spawnSubject() });
    handler(spawnReq({ approval }));
    expect(responses[0].error.code).toBe('bad_workdir');
  });

  it('refuses while the box does not know its own name', () => {
    const { handler, responses } = rpc(gated({ identity: null }));
    handler(spawnReq({ approval: sign({ type: 'consent', subject: spawnSubject() }) }));
    refused(responses, 'identity_unknown');
  });
});

gatedDescribe('start with the gate off', () => {
  it('behaves as before, with and without an approval field', () => {
    for (const approvals of [ungated(), undefined]) {
      const { handler, responses, startSession } = rpc(approvals);
      handler(spawnReq());
      handler(spawnReq({ approval: { statement: 'junk', signature: 'junk' } }));
      handler(clientReq());
      expect(responses.map((r) => r.ok)).toEqual([true, true, true]);
      expect(startSession).toHaveBeenCalledTimes(3);
    }
  });
});

gatedDescribe('session control on a gated box', () => {
  const control = (action, extra = {}) => ({ request_id: `c-${action}`, from_device_id: 5, method: 'session_control', params: { convo_id: 'c1', action, ...extra } });

  it('carry_on, set_model and a routine fire are refused; compact and alert go through', async () => {
    const { handler, responses, controlSession } = rpc(gated());
    handler(control('carry_on', { message: 'continue' }));
    handler(control('set_model', { model: 'opus' }));
    handler(control('routine'));
    handler(control('something_new'));
    expect(responses.map((r) => r.error)).toEqual(Array(4).fill({ code: 'approval_required', detail: 'session control cannot start or redirect work on a box with approval keys' }));
    expect(controlSession).not.toHaveBeenCalled();
    handler(control('compact'));
    handler(control('alert'));
    await Promise.resolve();
    expect(controlSession).toHaveBeenCalledTimes(2);
  });

  it('on a locked box outside an unlock window nothing goes through, compact and alert included', () => {
    let open = false;
    const t = tempKeys();
    temps.push(t);
    const gate = createApprovalGate({ keysFile: t.keysFile, uid: t.uid, noncesFile: path.join(t.dir, 'n.json'), journalHost: 'journal.example', user: 'alice', log: silent });
    const approvals = createApprovalPaths({ gate, identity: () => ({ deviceId: 9, name: 'box-a' }), peersAllowed: () => open, log: silent });
    const { handler, responses, controlSession } = rpc(approvals);
    handler(control('alert', { message: 'run this' }));
    handler(control('compact'));
    expect(responses.map((r) => r.error?.code)).toEqual(['approval_required', 'approval_required']);
    expect(controlSession).not.toHaveBeenCalled();
    open = true;
    handler(control('compact'));
    handler(control('carry_on', { message: 'x' }));
    expect(controlSession).toHaveBeenCalledTimes(1);
  });

  it('with the gate off, every action reaches the session as before', () => {
    const { handler, controlSession } = rpc(ungated());
    handler(control('carry_on', { message: 'continue' }));
    handler(control('set_model', { model: 'opus' }));
    expect(controlSession).toHaveBeenCalledTimes(2);
  });
});

// --- chat invites ------------------------------------------------------------

function invites(approvals) {
  const sent = [];
  const injectRequestTurn = vi.fn();
  const m = createAgentInvites({
    sendRoomOp: (op) => { sent.push(op); return true; },
    rooms: { get: () => null, setState() {} }, injectRequestTurn, approvals, log: silent,
  });
  return { m, sent, injectRequestTurn };
}
const WHY = 'Compare notes on the migration';
const request = (extra = {}) => ({ kind: 'invite', event: 'request', room_id: 'room-1', from_device_id: 3, from_name: 'box-b', justification: WHY, ...extra });
const chatSubject = (o = {}) => ({ op: 'chat', ask: 'room-1/9', box: 'box-a', message_sha256: sha256Hex(WHY), decision: 'approve', ...o });

gatedDescribe('chat invites on a gated box', () => {
  it('an invite with no approval is refused through the answer op and never reaches a session', () => {
    const { m, sent, injectRequestTurn } = invites(gated());
    m.onInviteFrame(request());
    expect(injectRequestTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([{ op: 'agent_invite_answer', room_id: 'room-1', accept: false, reason: 'approval_required: approval_required' }]);
  });

  it('an invite with a valid approval is delivered as before', () => {
    const { m, sent, injectRequestTurn } = invites(gated());
    const frame = request({ approval: sign({ type: 'consent', subject: chatSubject() }) });
    m.onInviteFrame(frame);
    expect(injectRequestTurn).toHaveBeenCalledWith(frame);
    expect(sent).toEqual([]);
  });

  it('an approval for another room, another justification or another box is refused', () => {
    const approval = sign({ type: 'consent', subject: chatSubject() });
    for (const extra of [{ room_id: 'room-2' }, { justification: 'Something else' }]) {
      const { m, sent, injectRequestTurn } = invites(gated());
      m.onInviteFrame(request({ approval, ...extra }));
      expect(injectRequestTurn).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({ accept: false, reason: 'approval_required: mismatch' });
    }
    const other = invites(gated({ identity: { deviceId: 10, name: 'box-a' } }));
    other.m.onInviteFrame(request({ approval }));
    expect(other.injectRequestTurn).not.toHaveBeenCalled();
  });

  it("a join request is signed over the joiner's device, and refused to the joiner", () => {
    const join = (extra = {}) => ({ kind: 'invite', event: 'join_request', room_id: 'room-1', from_device_id: 3, from_name: 'box-b', justification: WHY, ...extra });
    const ok = invites(gated());
    ok.m.onInviteFrame(join({ approval: sign({ type: 'consent', subject: chatSubject({ ask: 'room-1/3' }) }) }));
    expect(ok.injectRequestTurn).toHaveBeenCalledTimes(1);
    const no = invites(gated());
    no.m.onInviteFrame(join({ approval: sign({ type: 'consent', subject: chatSubject() }) }));
    expect(no.injectRequestTurn).not.toHaveBeenCalled();
    expect(no.sent[0]).toEqual({ op: 'agent_invite_answer', room_id: 'room-1', peer_device_id: 3, accept: false, reason: 'approval_required: mismatch' });
  });

  it('other invite frames are not gated', () => {
    const { m, sent } = invites(gated());
    m.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'room-1' });
    m.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'room-1', session_state: 'idle' });
    expect(sent).toEqual([]);
  });

  it('with the gate off, an invite is delivered with or without an approval field', () => {
    for (const approvals of [ungated(), undefined]) {
      const { m, injectRequestTurn } = invites(approvals);
      m.onInviteFrame(request());
      m.onInviteFrame(request({ approval: { statement: 'junk', signature: 'junk' } }));
      expect(injectRequestTurn).toHaveBeenCalledTimes(2);
    }
  });
});

// --- transfers ---------------------------------------------------------------

const CONTENT = Buffer.from('the build log\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const transferOf = (extra = {}) => ({ id: 'tr-1', room_id: 'room-1', name: 'build.log', size: CONTENT.length, sha256: sha(CONTENT), from_name: 'box-b', from_convo_id: 'convo-peer', ...extra });
const transferSubject = (o = {}) => ({ op: 'transfer', ask: 'tr-1', box: 'box-a', file_sha256: sha(CONTENT), size: String(CONTENT.length), decision: 'approve', ...o });

function receiver(approvals, { bytes = CONTENT } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'approval-transfer-'));
  mkdirSync(path.join(root, 'repo'));
  const session = { roomId: '!s', workdir: path.join(root, 'repo'), journalConvoId: 'convo-me' };
  const client = {
    download: vi.fn(async () => new Response(bytes, { status: 200 })),
    received: vi.fn(async () => ({ ok: true, status: 200 })),
    failed: vi.fn(async () => ({ ok: true, status: 200 })),
    listPending: vi.fn(async () => ({ ok: true, status: 200, body: { transfers: [] } })),
  };
  const deliver = vi.fn();
  const inbox = path.join(root, 'inbox');
  const r = createTransferReceiver({
    client, dirFor: () => inbox, deliver, sessionsForRoom: () => [session], stateFile: path.join(root, 'state.json'),
    log: silent, sleep: async () => {}, approvals,
  });
  const files = () => (existsSync(inbox) ? readdirSync(inbox) : []);
  return { r, client, deliver, files };
}

gatedDescribe('transfers on a gated box', () => {
  it('a transfer with no approval is refused: nothing is downloaded or written, and the journal is told', async () => {
    const { r, client, deliver, files } = receiver(gated());
    r.onReady(transferOf());
    await r.idle();
    await Promise.resolve();
    expect(client.download).not.toHaveBeenCalled();
    expect(files()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(client.failed).toHaveBeenCalledWith('tr-1', 'approval_required: approval_required');
  });

  it('a transfer with a valid approval arrives as before', async () => {
    const { r, client, files } = receiver(gated());
    r.onReady(transferOf({ approval: sign({ type: 'consent', subject: transferSubject() }) }));
    await r.idle();
    expect(files()).toEqual(['build.log']);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
  });

  it('an approval for another file hash, size or transfer is refused', async () => {
    const approval = sign({ type: 'consent', subject: transferSubject() });
    for (const extra of [{ sha256: sha(Buffer.from('other')) }, { size: CONTENT.length + 1 }, { id: 'tr-2' }]) {
      const { r, client, files } = receiver(gated());
      r.onReady(transferOf({ approval, ...extra }));
      await r.idle();
      expect(client.download).not.toHaveBeenCalled();
      expect(files()).toEqual([]);
      expect(client.failed.mock.calls[0][1]).toBe('approval_required: mismatch');
    }
  });

  it('bytes that do not match the signed hash are deleted and never released', async () => {
    const { r, client, deliver, files } = receiver(gated(), { bytes: Buffer.from('tampered bytes') });
    const wrong = transferOf({ size: Buffer.from('tampered bytes').length });
    r.onReady({ ...wrong, approval: sign({ type: 'consent', subject: transferSubject({ size: String(wrong.size) }) }) });
    await r.idle();
    expect(files()).toEqual([]);
    expect(client.received).not.toHaveBeenCalled();
    expect(deliver.mock.calls.every((c) => /failed verification/.test(c[1]))).toBe(true);
    expect(client.failed).toHaveBeenCalledWith('tr-1', 'sha256 mismatch after retry');
  });

  it('a transfer already admitted is not asked for its approval again when the journal lists it once more', async () => {
    const approvals = gated();
    const spy = vi.spyOn(approvals, 'transfer');
    const { r, client } = receiver(approvals);
    let release;
    client.download.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(CONTENT, { status: 200 })); }));
    const t = transferOf({ approval: sign({ type: 'consent', subject: transferSubject() }) });
    r.onReady(t);
    r.onReady(t);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await r.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(client.failed).not.toHaveBeenCalled();
  });

  it('with the gate off, a transfer arrives with or without an approval field', async () => {
    for (const approvals of [ungated(), undefined]) {
      const { r, files } = receiver(approvals);
      r.onReady(transferOf());
      await r.idle();
      expect(files()).toEqual(['build.log']);
    }
  });
});
