import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, statSync } from 'fs';
import fsp from 'fs/promises';
import nodeFs from 'fs';
import { tmpdir } from 'os';
import { createTransferReceiver } from '../lib/transfer-receiver.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const silent = { log() {}, warn() {}, error() {} };
const noSleep = vi.fn(async () => {});
const readState = (f) => JSON.parse(readFileSync(f, 'utf-8'));

const CONTENT = Buffer.from('hello from box-a, this is the build log\n');

function transferOf(extra = {}) {
  return {
    id: 'tr-1', room_id: 'room-1', name: 'build.log', size: CONTENT.length, sha256: sha(CONTENT),
    content_type: 'text/plain', from_name: 'box-a', from_convo_id: 'convo-owner', ...extra,
  };
}

// A journal that serves `bytes` for every transfer id, honouring Range the
// way /transfers/:id/content does (206 for bytes=a-, 416 past the end).
function fakeClient({ bytes = CONTENT, pending = [], download } = {}) {
  const serve = async (id, { start = 0 } = {}) => {
    if (start >= bytes.length && start > 0) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
    }
    if (start > 0) {
      return new Response(bytes.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } });
    }
    return new Response(bytes, { status: 200 });
  };
  return {
    download: vi.fn(download || serve),
    received: vi.fn(async () => ({ ok: true, status: 200, body: { phase: 'delivered' } })),
    failed: vi.fn(async () => ({ ok: true, status: 200, body: { phase: 'failed' } })),
    listPending: vi.fn(async () => ({ ok: true, status: 200, body: { transfers: pending } })),
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'transfer-receiver-'));
  const workdir = path.join(root, 'repo');
  mkdirSync(workdir);
  const owner = { roomId: '!owner', workdir, journalConvoId: 'convo-owner' };
  const guest = { roomId: '!guest', workdir, journalConvoId: 'convo-guest' };
  const dirFor = (s) => path.join(root, 'files', s.roomId, 'inbox');
  return { root, workdir, owner, guest, dirFor, stateFile: path.join(root, 'inbox-state.json') };
}

function makeReceiver(fx, { client = fakeClient(), sessions, muted = () => false, deliver = vi.fn() } = {}) {
  const all = sessions || [fx.owner, fx.guest];
  const sessionsForRoom = vi.fn((roomId, fromConvoId) => all.filter((s) => s.journalConvoId !== fromConvoId));
  const receiver = createTransferReceiver({
    client, dirFor: fx.dirFor, deliver, sessionsForRoom, isMuted: (roomId, s) => muted(s),
    stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
  });
  return { receiver, client, deliver, sessionsForRoom };
}

describe('transfer receiver', () => {
  it('a ready frame downloads, verifies, saves outside the workdir, confirms and tells only the session that did not send', async () => {
    const fx = fixture();
    const { receiver, client, deliver, sessionsForRoom } = makeReceiver(fx);
    receiver.onReady(transferOf());
    expect(receiver.active()).toBe(1);
    await receiver.idle();
    expect(receiver.active()).toBe(0);

    expect(sessionsForRoom).toHaveBeenCalledWith('room-1', 'convo-owner');
    const saved = path.join(fx.dirFor(fx.guest), 'build.log');
    expect(readFileSync(saved)).toEqual(CONTENT);
    expect(saved.startsWith(fx.workdir + path.sep)).toBe(false);
    expect(readdirSync(fx.dirFor(fx.guest))).toEqual(['build.log']); // no .part left behind
    expect(client.download).toHaveBeenCalledWith('tr-1', expect.objectContaining({ start: 0 }));
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));

    // Same-bridge room: the owner session sent it, so only the guest hears.
    expect(deliver).toHaveBeenCalledTimes(1);
    const [who, line, meta] = deliver.mock.calls[0];
    expect(who).toBe(fx.guest);
    expect(line).toBe(`[sent file "build.log" — saved to ${saved} (${CONTENT.length} B, sha256 ${sha(CONTENT).slice(0, 12)}…)]`);
    expect(meta).toEqual(expect.objectContaining({ roomId: 'room-1', fromName: 'box-a' }));

    // Recorded for the inbox sweep; nothing left pending.
    const state = readState(fx.stateFile);
    expect(state.arrived).toEqual([{ path: saved, arrivedAt: 1_000, transferId: 'tr-1' }]);
    expect(state.pending).toEqual({});
  });

  it('adds the sender\'s caption when the transfer carries one', async () => {
    const fx = fixture();
    const { receiver, deliver } = makeReceiver(fx);
    receiver.onReady(transferOf({ reason: 'the failing run' }));
    await receiver.idle();
    expect(deliver.mock.calls[0][1]).toMatch(/…\)\]: the failing run$/);
  });

  it('does not overwrite an earlier file of the same name: -1, -2', async () => {
    const fx = fixture();
    mkdirSync(fx.dirFor(fx.guest), { recursive: true });
    writeFileSync(path.join(fx.dirFor(fx.guest), 'build.log'), 'older');
    writeFileSync(path.join(fx.dirFor(fx.guest), 'build-1.log'), 'older still');
    const { receiver, deliver } = makeReceiver(fx);
    receiver.onReady(transferOf());
    await receiver.idle();
    const saved = path.join(fx.dirFor(fx.guest), 'build-2.log');
    expect(readFileSync(saved)).toEqual(CONTENT);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'), 'utf-8')).toBe('older');
    expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} `);
  });

  it('a pre-existing .part resumes with Range from its length', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const { receiver, client } = makeReceiver(fx);
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT.subarray(0, 10));
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.download.mock.calls[0][1].start).toBe(10);
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
  });

  it('a .part that is already whole: the 416 counts as done, and it goes on to verify', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const { receiver, client, deliver } = makeReceiver(fx);
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT);
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download.mock.calls[0][1].start).toBe(CONTENT.length);
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a 200 to a Range request starts the .part over rather than appending', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const client = fakeClient({ download: async () => new Response(CONTENT, { status: 200 }) });
    const { receiver } = makeReceiver(fx, { client });
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT.subarray(0, 10));
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
  });

  it('a sha mismatch retries once from zero, then reports failure and leaves no file', async () => {
    const fx = fixture();
    const client = fakeClient({ bytes: Buffer.alloc(CONTENT.length, 'z') });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(2);
    expect(client.download.mock.calls.map((c) => c[1].start)).toEqual([0, 0]);
    expect(client.received).not.toHaveBeenCalled();
    const dir = fx.dirFor(fx.guest);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(fx.guest);
    expect(deliver.mock.calls[0][1]).toBe('[file "build.log" failed verification and was not saved]');
    expect(readState(fx.stateFile).pending).toEqual({});
  });

  it('a second mismatch tells the journal, after the room line, so the sender hears at once', async () => {
    const fx = fixture();
    const client = fakeClient({ bytes: Buffer.alloc(CONTENT.length, 'z') });
    const order = [];
    const deliver = vi.fn(() => order.push('line'));
    client.failed = vi.fn(async () => { order.push('failed'); return { ok: true, status: 200, body: {} }; });
    const { receiver } = makeReceiver(fx, { client, deliver });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.failed).toHaveBeenCalledWith('tr-1', 'sha256 mismatch after retry');
    expect(order).toEqual(['line', 'failed']);
  });

  it('telling the journal of a failed verification is best effort', async () => {
    const fx = fixture();
    const client = fakeClient({ bytes: Buffer.alloc(CONTENT.length, 'z') });
    client.failed = vi.fn(async () => { throw new Error('boom'); });
    const log = { log() {}, warn: vi.fn(), error() {} };
    const deliver = vi.fn();
    const receiver = createTransferReceiver({
      client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
      stateFile: fx.stateFile, log, now: () => 1_000, sleep: noSleep,
    });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(readState(fx.stateFile).pending).toEqual({});
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/telling the journal .*tr-1/);
  });

  it('a mismatch that clears on the retry does not tell the journal anything failed', async () => {
    const fx = fixture();
    let n = 0;
    const client = fakeClient({ download: async () => new Response(n++ === 0 ? Buffer.alloc(CONTENT.length, 'z') : CONTENT, { status: 200 }) });
    const { receiver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.failed).not.toHaveBeenCalled();
  });

  it('a mismatch that clears on the retry saves the file', async () => {
    const fx = fixture();
    let n = 0;
    const client = fakeClient({ download: async () => new Response(n++ === 0 ? Buffer.alloc(CONTENT.length, 'x') : CONTENT, { status: 200 }) });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "build.log"/);
  });

  it('a transient failure retries with backoff, resuming from the .part', async () => {
    const fx = fixture();
    let calls = 0;
    const client = fakeClient({
      download: async (id, { start = 0 } = {}) => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        if (calls === 2) {
          // Half the body, then the stream dies.
          const half = CONTENT.subarray(0, 12);
          let sent = false;
          const body = new ReadableStream({ pull(c) { if (sent) { c.error(new Error('reset')); return; } sent = true; c.enqueue(half); } });
          return new Response(body, { status: 200 });
        }
        return new Response(CONTENT.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}` } });
      },
    });
    const sleep = vi.fn(async () => {});
    const receiver = createTransferReceiver({
      client, dirFor: fx.dirFor, deliver: vi.fn(), sessionsForRoom: () => [fx.guest],
      stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep,
    });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 8000]);
    expect(client.download.mock.calls[2][1].start).toBe(12);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
  });

  it('after the retries it keeps the .part and the pending entry for catchUp', async () => {
    const fx = fixture();
    const client = fakeClient({ download: async () => new Response(null, { status: 503 }) });
    const sleep = vi.fn(async () => {});
    const deliver = vi.fn();
    const receiver = createTransferReceiver({
      client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
      stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep,
    });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 8000, 30000]);
    expect(deliver).not.toHaveBeenCalled();
    expect(Object.keys(readState(fx.stateFile).pending)).toEqual(['tr-1']);
  });

  describe('relaunching a stalled download while connected', () => {
    function stalledReceiver(fx, plan) {
      // plan(call) -> a status for that download call (200 serves CONTENT).
      let calls = 0;
      const client = fakeClient({
        download: async () => {
          calls += 1;
          const status = plan(calls);
          return status === 200 ? new Response(CONTENT, { status: 200 }) : new Response(null, { status });
        },
      });
      const deliver = vi.fn();
      const receiver = createTransferReceiver({
        client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      return { receiver, client, deliver };
    }
    const tick = async (receiver, ms) => { vi.advanceTimersByTime(ms); await receiver.idle(); };

    it('relaunches after 1 min, 5 min, then every 15 min, and stops once it is saved', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const fx = fixture();
        const { receiver, client, deliver } = stalledReceiver(fx, (n) => (n <= 20 ? 503 : 200));
        receiver.onReady(transferOf());
        await receiver.idle();
        expect(client.download).toHaveBeenCalledTimes(4);
        expect(receiver.active()).toBe(1); // waiting to relaunch still holds the box awake
        await tick(receiver, 59_999);
        expect(client.download).toHaveBeenCalledTimes(4);
        await tick(receiver, 1);
        expect(client.download).toHaveBeenCalledTimes(8);
        await tick(receiver, 5 * 60_000 - 1);
        expect(client.download).toHaveBeenCalledTimes(8);
        await tick(receiver, 1);
        expect(client.download).toHaveBeenCalledTimes(12);
        await tick(receiver, 15 * 60_000);
        expect(client.download).toHaveBeenCalledTimes(16);
        await tick(receiver, 15 * 60_000);
        expect(client.download).toHaveBeenCalledTimes(20);
        await tick(receiver, 15 * 60_000);
        expect(client.download).toHaveBeenCalledTimes(21);
        expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(readState(fx.stateFile).pending).toEqual({});
        expect(vi.getTimerCount()).toBe(0);
        expect(receiver.active()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a 404 or 410 on a relaunch ends it: the .part and the entry go, and no timer is left', async () => {
      for (const gone of [404, 410]) {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const fx = fixture();
          const { receiver, client, deliver } = stalledReceiver(fx, (n) => (n <= 4 ? 503 : gone));
          receiver.onReady(transferOf());
          await receiver.idle();
          await tick(receiver, 60_000);
          expect(client.download).toHaveBeenCalledTimes(5);
          expect(readState(fx.stateFile).pending).toEqual({});
          expect(existsSync(receiver.partPathFor(fx.dirFor(fx.guest), transferOf()))).toBe(false);
          expect(deliver).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
          await tick(receiver, 60 * 60_000);
          expect(client.download).toHaveBeenCalledTimes(5);
        } finally {
          vi.useRealTimers();
        }
      }
    });

    it('a ready frame before the relaunch is due runs it now and clears the timer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const fx = fixture();
        const { receiver, client } = stalledReceiver(fx, (n) => (n <= 4 ? 503 : 200));
        receiver.onReady(transferOf());
        await receiver.idle();
        expect(vi.getTimerCount()).toBe(1);
        receiver.onReady(transferOf());
        await receiver.idle();
        expect(client.download).toHaveBeenCalledTimes(5);
        expect(readState(fx.stateFile).pending).toEqual({});
        expect(vi.getTimerCount()).toBe(0);
        await tick(receiver, 60 * 60_000);
        expect(client.download).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('where hard links fail, it copies without replacing: never a rename onto the target', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'build.log'), 'older');
    const link = vi.fn(async () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); });
    const rename = vi.spyOn(fsp, 'rename');
    try {
      const deliver = vi.fn();
      const receiver = createTransferReceiver({
        client: fakeClient(), dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep, link,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(link).toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(readFileSync(path.join(dir, 'build.log'), 'utf-8')).toBe('older');
      const saved = path.join(dir, 'build-1.log');
      expect(readFileSync(saved)).toEqual(CONTENT);
      expect(readdirSync(dir).sort()).toEqual(['build-1.log', 'build.log']); // the .part is gone
      expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} `);
      expect(readState(fx.stateFile).arrived.map((a) => a.path)).toEqual([saved]);
    } finally {
      rename.mockRestore();
    }
  });

  it('catchUp downloads a released transfer missed while asleep', async () => {
    const fx = fixture();
    const client = fakeClient({ pending: [transferOf()] });
    const { receiver, deliver } = makeReceiver(fx, { client });
    await receiver.catchUp();
    await receiver.idle();
    expect(client.listPending).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('catchUp after a restart picks up a download left pending in the state file', async () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, JSON.stringify({ pending: { 'tr-1': { transfer: transferOf() } }, arrived: [] }));
    const client = fakeClient({ pending: [] });
    client.listPending = vi.fn(async () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } }));
    const { receiver } = makeReceiver(fx, { client });
    await receiver.catchUp();
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
  });

  it('a ready frame and catchUp for the same transfer download it once', async () => {
    const fx = fixture();
    const client = fakeClient({ pending: [transferOf()] });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.catchUp();
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a muted binding gets no line, but the file is still saved and confirmed', async () => {
    const fx = fixture();
    const { receiver, client, deliver } = makeReceiver(fx, { muted: (s) => s === fx.guest });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a second bound session gets its own copy (a hard link) in its own inbox', async () => {
    const fx = fixture();
    const third = { roomId: '!third', workdir: fx.workdir, journalConvoId: 'convo-third' };
    const { receiver, deliver } = makeReceiver(fx, { sessions: [fx.owner, fx.guest, third] });
    receiver.onReady(transferOf());
    await receiver.idle();
    const a = path.join(fx.dirFor(fx.guest), 'build.log');
    const b = path.join(fx.dirFor(third), 'build.log');
    expect(readFileSync(b)).toEqual(CONTENT);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([fx.guest, third]);
    expect(deliver.mock.calls[1][1]).toContain(`saved to ${b} `);
    expect(readState(fx.stateFile).arrived.map((r) => r.path)).toEqual([a, b]);
  });

  it('a name with path parts is saved under its base name only', async () => {
    const fx = fixture();
    const { receiver } = makeReceiver(fx);
    receiver.onReady(transferOf({ name: '../../escape.log' }));
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'escape.log'))).toEqual(CONTENT);
  });

  it('a 404 (no longer downloadable) drops the transfer quietly', async () => {
    const fx = fixture();
    const client = fakeClient({ download: async () => new Response(null, { status: 404 }) });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).pending).toEqual({});
  });

  it('no session to receive it: nothing is downloaded', async () => {
    const fx = fixture();
    const { receiver, client } = makeReceiver(fx, { sessions: [fx.owner] });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).not.toHaveBeenCalled();
  });

  it('ignores a malformed transfer', async () => {
    const fx = fixture();
    const { receiver, client } = makeReceiver(fx);
    receiver.onReady({ id: 'tr-1' });
    receiver.onReady(null);
    receiver.onReady(transferOf({ sha256: 'nothex' }));
    await receiver.idle();
    expect(client.download).not.toHaveBeenCalled();
  });

  describe('fix round 1', () => {
    it('matches saved copies to targets by key: a session whose inbox moved mid-download still gets its line', async () => {
      const fx = fixture();
      const guest = { ...fx.guest, live: false };
      const dirFor = (s) => path.join(fx.root, s.live ? 'live' : 'asleep', s.roomId, 'inbox');
      const client = fakeClient();
      const serve = client.download.getMockImplementation();
      client.download.mockImplementation(async (...a) => { guest.live = true; return serve(...a); });
      const deliver = vi.fn();
      const receiver = createTransferReceiver({
        client, dirFor, deliver, sessionsForRoom: () => [guest], stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      const saved = path.join(fx.root, 'asleep', '!guest', 'inbox', 'build.log');
      expect(readFileSync(saved)).toEqual(CONTENT);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} `);
    });

    it('a target that joins after the save gets its own copy and its line at finish', async () => {
      const fx = fixture();
      const third = { roomId: '!third', workdir: fx.workdir, journalConvoId: 'convo-third' };
      const all = [fx.guest];
      const client = fakeClient();
      client.received.mockImplementation(async () => { all.push(third); return { ok: true, status: 200, body: {} }; });
      const deliver = vi.fn();
      const receiver = createTransferReceiver({
        client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => all, stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(deliver.mock.calls.map((c) => c[0])).toEqual([fx.guest, third]);
      expect(readFileSync(path.join(fx.dirFor(third), 'build.log'))).toEqual(CONTENT);
    });

    it('after a restart mid-delivery, only the targets not yet told get the line', async () => {
      const fx = fixture();
      const third = { roomId: '!third', workdir: fx.workdir, journalConvoId: 'convo-third' };
      const a = path.join(fx.dirFor(fx.guest), 'build.log');
      const b = path.join(fx.dirFor(third), 'build.log');
      mkdirSync(path.dirname(a), { recursive: true });
      mkdirSync(path.dirname(b), { recursive: true });
      writeFileSync(a, CONTENT);
      writeFileSync(b, CONTENT);
      writeFileSync(fx.stateFile, JSON.stringify({
        pending: { 'tr-1': { transfer: transferOf(), saved: [{ key: '!guest', path: a }, { key: '!third', path: b }], receipted: true, told: ['!guest'] } },
        arrived: [],
      }));
      const client = fakeClient({ pending: [] });
      const { receiver, deliver } = makeReceiver(fx, { client, sessions: [fx.owner, fx.guest, third] });
      await receiver.catchUp();
      await receiver.idle();
      expect(deliver.mock.calls.map((c) => c[0])).toEqual([third]);
      expect(readState(fx.stateFile).pending).toEqual({});
    });

    it('a very long name is capped to 200 bytes, keeping its extension', async () => {
      const fx = fixture();
      const { receiver, deliver } = makeReceiver(fx);
      receiver.onReady(transferOf({ name: `${'é'.repeat(200)}.log` }));
      await receiver.idle();
      const files = readdirSync(fx.dirFor(fx.guest));
      expect(files).toHaveLength(1);
      expect(Buffer.byteLength(files[0])).toBeLessThanOrEqual(200);
      expect(files[0].endsWith('.log')).toBe(true);
      expect(readFileSync(path.join(fx.dirFor(fx.guest), files[0]))).toEqual(CONTENT);
      expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "/);
    });

    it('an inbox that cannot be made is a clean failure: the line, and nothing left pending', async () => {
      const fx = fixture();
      writeFileSync(path.join(fx.root, 'blocker'), 'not a dir');
      const deliver = vi.fn();
      const client = fakeClient();
      const receiver = createTransferReceiver({
        client, dirFor: () => path.join(fx.root, 'blocker', 'inbox'), deliver, sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(client.download).not.toHaveBeenCalled();
      expect(deliver.mock.calls.map((c) => c[1])).toEqual(['[file "build.log" could not be saved: the inbox is not a directory]']);
      expect(readState(fx.stateFile).pending).toEqual({});
    });

    it('a local failure tells the journal, so the sender hears it failed', async () => {
      const fx = fixture();
      writeFileSync(path.join(fx.root, 'blocker'), 'not a dir');
      const deliver = vi.fn();
      const client = fakeClient();
      const receiver = createTransferReceiver({
        client, dirFor: () => path.join(fx.root, 'blocker', 'inbox'), deliver, sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(client.failed).toHaveBeenCalledWith('tr-1', 'the inbox is not a directory');
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('telling the journal is best effort: a refusal or a throw is logged, the line still goes out first', async () => {
      for (const failed of [
        vi.fn(async () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } })),
        vi.fn(async () => { throw new Error('boom'); }),
      ]) {
        const fx = fixture();
        writeFileSync(path.join(fx.root, 'blocker'), 'not a dir');
        const order = [];
        const deliver = vi.fn(() => order.push('line'));
        const client = fakeClient();
        client.failed = vi.fn(async (...a) => { order.push('failed'); return failed(...a); });
        const log = { log() {}, warn: vi.fn(), error() {} };
        const receiver = createTransferReceiver({
          client, dirFor: () => path.join(fx.root, 'blocker', 'inbox'), deliver, sessionsForRoom: () => [fx.guest],
          stateFile: fx.stateFile, log, now: () => 1_000, sleep: noSleep,
        });
        receiver.onReady(transferOf());
        await receiver.idle();
        expect(order).toEqual(['line', 'failed']);
        expect(readState(fx.stateFile).pending).toEqual({});
        expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/telling the journal .*tr-1/);
      }
    });

    it('records the saved path before removing the .part, so a crash cannot download it again', async () => {
      const fx = fixture();
      const { receiver } = makeReceiver(fx);
      const seen = [];
      const real = fsp.unlink;
      const spy = vi.spyOn(fsp, 'unlink').mockImplementation(async (p) => {
        if (String(p).endsWith('.part')) seen.push(readState(fx.stateFile).pending['tr-1']?.saved);
        return real(p);
      });
      try {
        receiver.onReady(transferOf());
        await receiver.idle();
      } finally {
        spy.mockRestore();
      }
      const saved = path.join(fx.dirFor(fx.guest), 'build.log');
      expect(seen).toEqual([[{ key: '!guest', path: saved }]]);
      expect(readdirSync(fx.dirFor(fx.guest))).toEqual(['build.log']);
    });

    it('after a crash between the save and removing the .part, a restart neither downloads again nor makes a -1 copy', async () => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const saved = path.join(dir, 'build.log');
      writeFileSync(saved, CONTENT);
      const first = makeReceiver(fx);
      writeFileSync(first.receiver.partPathFor(dir, transferOf()), CONTENT);
      writeFileSync(fx.stateFile, JSON.stringify({
        pending: { 'tr-1': { transfer: transferOf(), dir, saved: [{ key: '!guest', path: saved }] } },
        arrived: [{ path: saved, arrivedAt: 1_000, transferId: 'tr-1' }],
      }));
      const { receiver, client, deliver } = makeReceiver(fx);
      await receiver.catchUp();
      await receiver.idle();
      expect(client.download).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual(['build.log']);
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    // POSIX file modes; Windows has none.
    it.skipIf(process.platform === 'win32')('writes its state file with mode 0600', async () => {
      const fx = fixture();
      const { receiver } = makeReceiver(fx);
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(statSync(fx.stateFile).mode & 0o777).toBe(0o600);
    });

    it('a .part that cannot be written fails cleanly and cancels the response body', async () => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const cancel = vi.fn();
      const client = fakeClient({
        download: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(CONTENT); }, cancel }), { status: 200 }),
      });
      const { receiver, deliver } = makeReceiver(fx, { client });
      mkdirSync(receiver.partPathFor(dir, transferOf())); // a directory where the .part goes
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(client.download).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalled();
      expect(deliver.mock.calls.map((c) => c[1])).toEqual([expect.stringMatching(/^\[file "build\.log" could not be saved: /)]);
      expect(readState(fx.stateFile).pending).toEqual({});
    });

    // Windows may refuse to make a symlink without the privilege: then there
    // is nothing to test.
    const plantSymlink = (ctx, target, at) => {
      try {
        symlinkSync(target, at);
      } catch (e) {
        if (e?.code === 'EPERM') ctx.skip();
        throw e;
      }
    };

    it('never writes through a symlink planted at the .part path', async (ctx) => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const outside = path.join(fx.root, 'outside.txt');
      writeFileSync(outside, 'untouched');
      const { receiver, deliver } = makeReceiver(fx);
      plantSymlink(ctx, outside, receiver.partPathFor(dir, transferOf()));
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(readFileSync(outside, 'utf-8')).toBe('untouched');
      expect(deliver.mock.calls.map((c) => c[1])).toEqual([expect.stringMatching(/could not be saved/)]);
    });

    it('without O_NOFOLLOW (Windows) a symlink at the .part path is refused before the open', async (ctx) => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const outside = path.join(fx.root, 'outside.txt');
      writeFileSync(outside, 'untouched');
      const { O_NOFOLLOW: _none, ...fsConstants } = nodeFs.constants;
      const deliver = vi.fn();
      const client = fakeClient();
      const receiver = createTransferReceiver({
        client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep, fsConstants,
      });
      plantSymlink(ctx, outside, receiver.partPathFor(dir, transferOf()));
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(readFileSync(outside, 'utf-8')).toBe('untouched');
      expect(deliver.mock.calls.map((c) => c[1])).toEqual(['[file "build.log" could not be saved: a symlink is in the way]']);
      expect(client.failed).toHaveBeenCalledWith('tr-1', 'a symlink is in the way');
    });

    it('without O_NOFOLLOW a 200 still starts a regular .part over', async () => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const { O_NOFOLLOW: _none, ...fsConstants } = nodeFs.constants;
      const client = fakeClient({ download: async () => new Response(CONTENT, { status: 200 }) });
      const receiver = createTransferReceiver({
        client, dirFor: fx.dirFor, deliver: vi.fn(), sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep, fsConstants,
      });
      writeFileSync(receiver.partPathFor(dir, transferOf()), 'GARBAGE---');
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    });

    it('without O_NOFOLLOW a download still resumes from a regular .part', async () => {
      const fx = fixture();
      const dir = fx.dirFor(fx.guest);
      mkdirSync(dir, { recursive: true });
      const { O_NOFOLLOW: _none, ...fsConstants } = nodeFs.constants;
      const client = fakeClient();
      const receiver = createTransferReceiver({
        client, dirFor: fx.dirFor, deliver: vi.fn(), sessionsForRoom: () => [fx.guest],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep, fsConstants,
      });
      writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT.subarray(0, 10));
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(client.download).toHaveBeenCalledWith('tr-1', expect.objectContaining({ start: 10 }));
      expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    });

    it('a second inbox that cannot take a copy gets the failure line; the first still gets its file', async () => {
      const fx = fixture();
      writeFileSync(path.join(fx.root, 'blocker'), 'not a dir');
      const third = { roomId: '!third', workdir: fx.workdir, journalConvoId: 'convo-third', blocked: true };
      const dirFor = (s) => (s.blocked ? path.join(fx.root, 'blocker', 'inbox') : fx.dirFor(s));
      const deliver = vi.fn();
      const receiver = createTransferReceiver({
        client: fakeClient(), dirFor, deliver, sessionsForRoom: () => [fx.guest, third],
        stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
      });
      receiver.onReady(transferOf());
      await receiver.idle();
      expect(deliver.mock.calls.map((c) => c[0])).toEqual([fx.guest, third]);
      expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "build\.log"/);
      expect(deliver.mock.calls[1][1]).toBe('[file "build.log" could not be saved: the inbox is not a directory]');
      expect(readState(fx.stateFile).pending).toEqual({});
    });

    it('catchUp resumes an unfinished download the journal no longer lists (a 404 then drops it)', async () => {
      const fx = fixture();
      writeFileSync(fx.stateFile, JSON.stringify({ pending: { 'tr-1': { transfer: transferOf() } }, arrived: [] }));
      const client = fakeClient({ pending: [] });
      const { receiver } = makeReceiver(fx, { client });
      await receiver.catchUp();
      await receiver.idle();
      expect(client.download).toHaveBeenCalledTimes(1);
      expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    });

    // `"` is not a legal file-name character on Windows, so it is saved as
    // `_` everywhere; `]` is legal, and only the room line escapes it.
    it('escapes " and ] in the name inside a room line', async () => {
      const fx = fixture();
      const { receiver, deliver } = makeReceiver(fx);
      receiver.onReady(transferOf({ name: 'a"b]c.txt' }));
      await receiver.idle();
      const saved = path.join(fx.dirFor(fx.guest), 'a_b]c.txt');
      expect(readFileSync(saved)).toEqual(CONTENT);
      expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "a_b\)c\.txt" — saved to /);
      expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} (`);
    });

    it('saves a name Windows would refuse under the same safe name on every platform', async () => {
      const fx = fixture();
      const { receiver, deliver } = makeReceiver(fx);
      receiver.onReady(transferOf({ name: 'why?: a<b>|c*.log. . ' }));
      await receiver.idle();
      const dir = fx.dirFor(fx.guest);
      expect(readdirSync(dir)).toEqual(['why__ a_b__c_.log']);
      const saved = path.join(dir, 'why__ a_b__c_.log');
      expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "why__ a_b__c_\.log" — saved to /);
      expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} (`);
      expect(readState(fx.stateFile).arrived.map((a) => a.path)).toEqual([saved]);
    });

    it('a name of only dots and spaces is saved as "file"', async () => {
      const fx = fixture();
      const { receiver } = makeReceiver(fx);
      receiver.onReady(transferOf({ name: '. . .' }));
      await receiver.idle();
      expect(readdirSync(fx.dirFor(fx.guest))).toEqual(['file']);
    });

    it('downloads at most 2 at once; queued ones still count as active', async () => {
      const fx = fixture();
      const gates = [];
      let inFlight = 0;
      let peak = 0;
      const client = fakeClient({
        download: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => gates.push(resolve));
          inFlight -= 1;
          return new Response(CONTENT, { status: 200 });
        },
      });
      const { receiver } = makeReceiver(fx, { client });
      for (const id of ['tr-1', 'tr-2', 'tr-3']) receiver.onReady(transferOf({ id }));
      await vi.waitFor(() => expect(gates.length).toBe(2));
      expect(receiver.active()).toBe(3);
      expect(client.download).toHaveBeenCalledTimes(2);
      gates.shift()();
      await vi.waitFor(() => expect(client.download).toHaveBeenCalledTimes(3));
      const release = setInterval(() => { while (gates.length) gates.shift()(); }, 5);
      await receiver.idle();
      clearInterval(release);
      expect(peak).toBe(2);
      expect(receiver.active()).toBe(0);
    });
  });
});
