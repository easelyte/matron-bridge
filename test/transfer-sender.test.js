import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { createTransferSender, TRANSFER_CHUNK_BYTES } from '../lib/transfer-sender.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const silent = { log() {}, warn() {}, error() {} };

// 16 bytes in chunks of 4: four chunks, so a resume can skip the first two.
function fixture({ content = 'aaaabbbbccccdddd' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'transfer-sender-'));
  const absPath = path.join(dir, 'notes.txt');
  writeFileSync(absPath, content);
  const st = statSync(absPath);
  const stateFile = path.join(dir, 'transfers.json');
  return { dir, absPath, size: st.size, mtimeMs: st.mtimeMs, stateFile, bytes: Buffer.from(content) };
}

function fakeClient({ received = [], chunkBytes = 4, chunks = 4 } = {}) {
  return {
    create: vi.fn(async () => ({ ok: true, status: 201, body: { transfer_id: 'tr-1', chunk_bytes: chunkBytes, chunks } })),
    status: vi.fn(async () => ({ ok: true, status: 200, body: { id: 'tr-1', phase: 'open', consent: 'awaiting_user', upload: 'uploading', chunk_bytes: chunkBytes, chunks, received } })),
    putChunk: vi.fn(async (id, n) => ({ ok: true, status: 200, body: { n } })),
    complete: vi.fn(async () => ({ ok: true, status: 200, body: { id: 'tr-1', phase: 'open', upload: 'uploaded' } })),
    cancel: vi.fn(async () => ({ ok: true, status: 200, body: { phase: 'cancelled' } })),
  };
}

const cleanScan = vi.fn(async () => ({ verdict: 'clean', findings: [] }));
const readState = (f) => JSON.parse(readFileSync(f, 'utf-8'));

function startArgs(fx, extra = {}) {
  return { sessionKey: '!s1', roomId: 'room-1', fromConvoId: 'convo-own', absPath: fx.absPath, name: 'notes.txt', size: fx.size, mtimeMs: fx.mtimeMs, contentType: 'text/plain', caption: 'build log for the bug', ...extra };
}

describe('transfer sender', () => {
  it('uses 32 MiB chunks by default', () => {
    expect(TRANSFER_CHUNK_BYTES).toBe(33554432);
  });

  it('start returns a job id before any upload starts', async () => {
    const fx = fixture();
    const client = fakeClient();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    const r = sender.start(startArgs(fx));
    expect(typeof r.jobId).toBe('string');
    expect(client.create).not.toHaveBeenCalled();
    expect(client.putChunk).not.toHaveBeenCalled();
    await sender.idle();
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('hashes, scans, creates with the caption as the reason, uploads every chunk and completes', async () => {
    const fx = fixture();
    const client = fakeClient();
    const scan = vi.fn(async () => ({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 3, value: 'never sent' }] }));
    const sender = createTransferSender({ client, scan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(scan).toHaveBeenCalledWith(fx.absPath);
    expect(client.create).toHaveBeenCalledWith({
      room_id: 'room-1', from_convo_id: 'convo-own', name: 'notes.txt', size: 16, sha256: sha(fx.bytes),
      content_type: 'text/plain', reason: 'build log for the bug',
      scan: { verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 3 }] },
    });
    expect(client.putChunk.mock.calls.map((c) => c[1])).toEqual([0, 1, 2, 3]);
    const [id, n, body, chunkSha] = client.putChunk.mock.calls[2];
    expect(id).toBe('tr-1');
    expect(n).toBe(2);
    expect(Buffer.from(body).toString()).toBe('cccc');
    expect(chunkSha).toBe(sha('cccc'));
    // The size lets the client wait long enough for the journal's hash.
    expect(client.complete).toHaveBeenCalledWith('tr-1', { size: 16 });
    // Still in state until the journal says how it ended.
    const st = readState(fx.stateFile);
    expect(Object.values(st.jobs)[0]).toMatchObject({ transferId: 'tr-1', sha256: sha(fx.bytes), roomId: 'room-1', fromConvoId: 'convo-own', uploaded: true });
  });

  it("persists the asking turn's causes and sends them on create; none, none sent", async () => {
    const fx = fixture();
    const client = fakeClient();
    const causes = [{ kind: 'item_tap', ref: 'item:7@2026-01-01T00:00:00.000Z', at: 5 }];
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    sender.start(startArgs(fx, { causes }));
    await sender.idle();
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ causes }));
    expect(Object.values(readState(fx.stateFile).jobs)[0].causes).toEqual(causes);

    const fx2 = fixture();
    const client2 = fakeClient();
    const sender2 = createTransferSender({ client: client2, scan: cleanScan, stateFile: fx2.stateFile, log: silent, chunkBytes: 4 });
    sender2.start(startArgs(fx2));
    await sender2.idle();
    expect(client2.create.mock.calls[0][0]).not.toHaveProperty('causes');
  });

  it('a job resumed before its create sends the causes it persisted', async () => {
    const fx = fixture();
    const causes = [{ kind: 'routine', ref: 'routine:daily-sweep@2026-01-01T08:00:00.000Z', at: 9 }];
    writeFileSync(fx.stateFile, JSON.stringify({ jobs: { 'job-1': {
      transferId: null, absPath: fx.absPath, size: fx.size, mtimeMs: fx.mtimeMs, sha256: null,
      roomId: 'room-1', fromConvoId: 'convo-own', sessionKey: '!s1', name: 'notes.txt', contentType: 'text/plain', caption: 'why', causes,
    } } }));
    const client = fakeClient();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    await sender.resumeAll();
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ from_convo_id: 'convo-own', causes }));
  });

  it('after a restart uploads only the chunks the journal does not have', async () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, JSON.stringify({ jobs: { 'job-1': {
      transferId: 'tr-1', absPath: fx.absPath, size: fx.size, mtimeMs: fx.mtimeMs, sha256: sha(fx.bytes),
      roomId: 'room-1', fromConvoId: 'convo-own', sessionKey: '!s1', name: 'notes.txt', contentType: 'text/plain', chunkBytes: 4,
    } } }));
    const client = fakeClient({ received: [0, 1] });
    const scan = vi.fn(cleanScan);
    const sender = createTransferSender({ client, scan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    await sender.resumeAll();
    expect(client.create).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(client.status).toHaveBeenCalledWith('tr-1');
    expect(client.putChunk.mock.calls.map((c) => [c[1], Buffer.from(c[2]).toString()])).toEqual([[2, 'cccc'], [3, 'dddd']]);
    expect(client.complete).toHaveBeenCalledWith('tr-1', expect.anything());
  });

  it('a file whose mtime changed since start is cancelled and the session told', async () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, JSON.stringify({ jobs: { 'job-1': {
      transferId: 'tr-1', absPath: fx.absPath, size: fx.size, mtimeMs: fx.mtimeMs - 60_000, sha256: sha(fx.bytes),
      roomId: 'room-1', fromConvoId: 'convo-own', sessionKey: '!s1', name: 'notes.txt', chunkBytes: 4,
    } } }));
    const client = fakeClient();
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    await sender.resumeAll();
    expect(client.putChunk).not.toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalledWith('tr-1');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: '!s1', roomId: 'room-1', text: expect.stringMatching(/^\[transfer of "notes\.txt" cancelled: .*changed/) }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('a file changed during hashing never reaches create', async () => {
    const fx = fixture();
    const client = fakeClient();
    const scan = vi.fn(async (p) => { const t = new Date(Date.now() + 120_000); utimesSync(p, t, t); return { verdict: 'clean', findings: [] }; });
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.create).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/cancelled/) }));
  });

  it('retries a failed chunk with 2/8/30 s backoff', async () => {
    const fx = fixture({ content: 'aaaa' });
    const client = fakeClient({ chunks: 1 });
    let calls = 0;
    client.putChunk = vi.fn(async () => (++calls < 4 ? { ok: false, status: 0, body: { error: 'journal unreachable' } } : { ok: true, status: 200, body: {} }));
    const sleep = vi.fn(async () => {});
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, sleep, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.putChunk).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 8000, 30000]);
    expect(client.complete).toHaveBeenCalled();
  });

  it('keeps the job for the next resume when the journal stays unreachable', async () => {
    const fx = fixture({ content: 'aaaa' });
    const client = fakeClient({ chunks: 1 });
    client.putChunk = vi.fn(async () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } }));
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, sleep: async () => {}, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.complete).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(Object.values(readState(fx.stateFile).jobs)[0]).toMatchObject({ transferId: 'tr-1' });
  });

  it('a refused create is reported and dropped', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.create = vi.fn(async () => ({ ok: false, status: 413, body: { error: 'quota_exceeded' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: '[transfer of "notes.txt" failed: quota_exceeded]' }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('too many transfers awaiting the user: a clear "not started" line', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.create = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'too_many_awaiting' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx, { name: 'a"b]c.txt' }));
    await sender.idle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: `[transfer of "a'b)c.txt" not started: too many files are already waiting for the user's approval; wait for those to be answered]`,
    }));
    expect(client.putChunk).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('no other session in the room: a clear "not started" line', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.create = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'no_recipients' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: '[transfer of "notes.txt" not started: no other session is in this room]' }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('more than one other session in the room: a clear "not started" line', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.create = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'multiple_recipients' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx, { name: 'x' }));
    await sender.idle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: '[transfer of "x" not started: this room has more than one other session; files go to one session at a time]',
    }));
    expect(client.putChunk).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('a declined outcome is told once, however many times the journal says so', async () => {
    const fx = fixture();
    const client = fakeClient();
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    client.status = vi.fn(async () => ({ ok: true, status: 200, body: { id: 'tr-1', phase: 'declined' } }));
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    await sender.resumeAll();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('409 hashing on complete waits about 30 s, checks status and completes again; not a failure', async () => {
    const fx = fixture();
    const client = fakeClient();
    let completes = 0;
    client.complete = vi.fn(async () => (++completes === 1
      ? { ok: false, status: 409, body: { error: 'conflict', detail: 'hashing' } }
      : { ok: true, status: 200, body: { id: 'tr-1', phase: 'open', upload: 'uploaded' } }));
    const sleep = vi.fn(async () => {});
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, sleep, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(sleep).toHaveBeenCalledWith(30_000);
    // Once before the upload, once after the wait.
    expect(client.status).toHaveBeenCalledTimes(2);
    expect(client.complete).toHaveBeenCalledTimes(2);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(Object.values(readState(fx.stateFile).jobs)[0]).toMatchObject({ uploaded: true, stalls: 0 });
  });

  it('409 hashing, then the status shows it uploaded: done without another complete', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.complete = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'hashing' } }));
    const open = client.status;
    let statuses = 0;
    client.status = vi.fn(async (id) => (++statuses === 1 ? open(id)
      : { ok: true, status: 200, body: { id: 'tr-1', phase: 'open', upload: 'uploaded', received: [0, 1, 2, 3] } }));
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, sleep: async () => {}, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(Object.values(readState(fx.stateFile).jobs)[0]).toMatchObject({ uploaded: true, stalls: 0 });
  });

  it('a refused status while waiting out hashing tells the session it failed', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.complete = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'hashing' } }));
    const open = client.status;
    let statuses = 0;
    client.status = vi.fn(async (id) => (++statuses === 1 ? open(id) : { ok: false, status: 404, body: { error: 'not_found' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, sleep: async () => {}, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: '[transfer of "notes.txt" failed: not_found]' }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('a complete still hashing after every wait is tried again later, never cancelled', async () => {
    const fx = fixture();
    const client = fakeClient();
    client.complete = vi.fn(async () => ({ ok: false, status: 409, body: { error: 'conflict', detail: 'hashing' } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, sleep: async () => {}, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.complete.mock.calls.length).toBeGreaterThan(2);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // Kept, with a relaunch scheduled.
    expect(Object.values(readState(fx.stateFile).jobs)[0]).toMatchObject({ transferId: 'tr-1', stalls: 1 });
    expect(Object.values(readState(fx.stateFile).jobs)[0].uploaded).toBeUndefined();
  });

  it('a file rewritten between the hash and the re-hash (same size and mtime) is cancelled as changed', async () => {
    const fx = fixture();
    // A whole-second mtime, so putting it back is exact.
    const T = 1_700_000_000;
    utimesSync(fx.absPath, T, T);
    fx.mtimeMs = T * 1000;
    const client = fakeClient();
    const notify = vi.fn();
    let hashes = 0;
    const hashFile = vi.fn(async (p) => {
      const digest = crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
      if (++hashes === 1) {
        // Same length, mtime put back: only the bytes give it away.
        writeFileSync(p, 'zzzzbbbbccccdddd');
        utimesSync(p, T, T);
      }
      return digest;
    });
    const sender = createTransferSender({ client, scan: cleanScan, hashFile, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(cleanScan).toHaveBeenCalledWith(fx.absPath);
    expect(client.create).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^\[transfer of "notes\.txt" cancelled: .*changed/) }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('hashes again after the scan; an unchanged file goes on with that digest', async () => {
    const fx = fixture();
    const client = fakeClient();
    const order = [];
    const hashFile = vi.fn(async (p) => { order.push('hash'); return crypto.createHash('sha256').update(readFileSync(p)).digest('hex'); });
    const scan = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); order.push('scan'); return { verdict: 'clean', findings: [] }; });
    const sender = createTransferSender({ client, scan, hashFile, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(order).toEqual(['hash', 'scan', 'hash']);
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ sha256: sha(fx.bytes) }));
  });

  it('a scan that throws is not_scanned, and the error code is logged', async () => {
    const fx = fixture();
    const client = fakeClient();
    const log = { log() {}, warn: vi.fn(), error() {} };
    const scan = vi.fn(async () => { throw Object.assign(new Error('secret-looking text AKIA'), { code: 'EIO' }); });
    const sender = createTransferSender({ client, scan, stateFile: fx.stateFile, log, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ scan: { verdict: 'not_scanned', findings: [] } }));
    const warned = log.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toMatch(/EIO/);
    expect(warned).not.toMatch(/AKIA/);
  });

  it('onFrame declined drops the job and tells the sending session', async () => {
    const fx = fixture();
    const client = fakeClient();
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: '!s1', roomId: 'room-1', text: '[transfer of "notes.txt" declined: not needed]' }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('escapes " and ] in the name inside the room line, the same way the receiver does', async () => {
    const fx = fixture();
    const client = fakeClient();
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx, { name: 'a"b]c.txt' }));
    await sender.idle();
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: `[transfer of "a'b)c.txt" declined: not needed]` }));
  });

  it('onFrame delivered drops the job quietly; unknown transfers are ignored', async () => {
    const fx = fixture();
    const client = fakeClient();
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    sender.onFrame({ kind: 'transfer', event: 'failed', transfer_id: 'tr-other', reason: 'sha256_mismatch' });
    expect(Object.keys(readState(fx.stateFile).jobs)).toHaveLength(1);
    sender.onFrame({ kind: 'transfer', event: 'delivered', transfer_id: 'tr-1' });
    expect(notify).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).jobs).toEqual({});
    expect(sender.active()).toBe(0);
  });

  it('a decline mid-upload stops the chunk loop', async () => {
    const fx = fixture();
    const client = fakeClient();
    let sender;
    client.putChunk = vi.fn(async (id, n) => {
      if (n === 1) sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1' });
      return { ok: true, status: 200, body: {} };
    });
    sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify: () => {}, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.putChunk).toHaveBeenCalledTimes(2);
    expect(client.complete).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  it('resumeAll drops an uploaded job the journal has since ended, telling the session', async () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, JSON.stringify({ jobs: { 'job-1': {
      transferId: 'tr-1', absPath: fx.absPath, size: fx.size, mtimeMs: fx.mtimeMs, sha256: sha(fx.bytes),
      roomId: 'room-1', fromConvoId: 'convo-own', sessionKey: '!s1', name: 'notes.txt', uploaded: true,
    } } }));
    const client = fakeClient();
    client.status = vi.fn(async () => ({ ok: true, status: 200, body: { id: 'tr-1', phase: 'expired', upload: 'uploaded', received: [] } }));
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    await sender.resumeAll();
    expect(client.putChunk).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^\[transfer of "notes\.txt" expired/) }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  // POSIX file modes; Windows has none.
  it.skipIf(process.platform === 'win32')('writes its state file with mode 0600', async () => {
    const fx = fixture();
    const sender = createTransferSender({ client: fakeClient(), scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(statSync(fx.stateFile).mode & 0o777).toBe(0o600);
  });

  it('starts empty from a missing or corrupt state file', () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, '{not json');
    const sender = createTransferSender({ client: fakeClient(), scan: cleanScan, stateFile: fx.stateFile, log: silent });
    expect(sender.active()).toBe(0);
    expect(existsSync(fx.stateFile)).toBe(true);
  });

  it('sends a short last chunk at its real length', async () => {
    const fx = fixture({ content: 'aaaabbbbcc' });
    const client = fakeClient({ chunks: 3 });
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.putChunk).toHaveBeenCalledTimes(3);
    const last = client.putChunk.mock.calls[2];
    expect(last[1]).toBe(2);
    expect(last[2].length).toBe(2);
    expect(Buffer.from(last[2]).toString()).toBe('cc');
    expect(last[3]).toBe(sha('cc'));
  });

  it('a journal on another chunk size is a failed create: cancelled and reported', async () => {
    const fx = fixture();
    const client = fakeClient({ chunkBytes: 8, chunks: 2 });
    const notify = vi.fn();
    const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, chunkBytes: 4 });
    sender.start(startArgs(fx));
    await sender.idle();
    expect(client.putChunk).not.toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalledWith('tr-1');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^\[transfer of "notes\.txt" failed: .*chunk/) }));
    expect(readState(fx.stateFile).jobs).toEqual({});
  });

  describe('stalls', () => {
    afterEach(() => { vi.useRealTimers(); });
    const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    it('relaunches after a transient stop, backing off 1 min then 5 min', async () => {
      fakeTimers();
      const fx = fixture({ content: 'aaaa' });
      const client = fakeClient({ chunks: 1 });
      let fails = 2;
      client.create = vi.fn(async () => (fails-- > 0 ? { ok: false, status: 503, body: { error: 'HTTP 503' } } : { ok: true, status: 201, body: { transfer_id: 'tr-1', chunk_bytes: 4, chunks: 1 } }));
      const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
      sender.start(startArgs(fx));
      await sender.idle();
      expect(client.create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_000);
      await sender.idle();
      expect(client.create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await sender.idle();
      expect(client.create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await sender.idle();
      expect(client.create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      await sender.idle();
      expect(client.create).toHaveBeenCalledTimes(3);
      expect(client.complete).toHaveBeenCalledWith('tr-1', expect.anything());
      expect(Object.values(readState(fx.stateFile).jobs)[0]).toMatchObject({ uploaded: true, stalls: 0 });
    });

    it('gives up after 20 stops in a row: cancels on the journal and tells the session', async () => {
      fakeTimers();
      const fx = fixture({ content: 'aaaa' });
      const client = fakeClient({ chunks: 1 });
      client.putChunk = vi.fn(async () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } }));
      const notify = vi.fn();
      const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, sleep: async () => {}, chunkBytes: 4 });
      sender.start(startArgs(fx));
      await sender.idle();
      for (let i = 0; i < 19; i++) {
        expect(notify).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await sender.idle();
      }
      expect(client.cancel).toHaveBeenCalledWith('tr-1');
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: '[transfer of "notes.txt" stopped: the journal could not be reached]' }));
      expect(readState(fx.stateFile).jobs).toEqual({});
    });

    it('gives up after 24 h with no progress', async () => {
      fakeTimers();
      const fx = fixture({ content: 'aaaa' });
      let clock = 1_000_000;
      const client = fakeClient({ chunks: 1 });
      client.putChunk = vi.fn(async () => ({ ok: false, status: 502, body: { error: 'HTTP 502' } }));
      const notify = vi.fn();
      const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, notify, now: () => clock, sleep: async () => {}, chunkBytes: 4 });
      sender.start(startArgs(fx));
      await sender.idle();
      expect(notify).not.toHaveBeenCalled();
      clock += 24 * 60 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await sender.idle();
      expect(client.cancel).toHaveBeenCalledWith('tr-1');
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/stopped: the journal could not be reached/) }));
    });

    it('a throw is retried later; once the file is gone it is cancel-and-report', async () => {
      fakeTimers();
      const fx = fixture({ content: 'aaaa' });
      const client = fakeClient({ chunks: 1 });
      const ok = client.status;
      let calls = 0;
      client.status = vi.fn(async (id) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return ok(id);
      });
      const sender = createTransferSender({ client, scan: cleanScan, stateFile: fx.stateFile, log: silent, chunkBytes: 4 });
      sender.start(startArgs(fx));
      await sender.idle();
      expect(client.putChunk).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      await sender.idle();
      expect(client.complete).toHaveBeenCalledWith('tr-1', expect.anything());

      const fx2 = fixture({ content: 'aaaa' });
      const client2 = fakeClient({ chunks: 1 });
      client2.status = vi.fn(async () => { unlinkSync(fx2.absPath); throw new Error('ENOENT'); });
      const notify = vi.fn();
      const sender2 = createTransferSender({ client: client2, scan: cleanScan, stateFile: fx2.stateFile, log: silent, notify, chunkBytes: 4 });
      sender2.start(startArgs(fx2));
      await sender2.idle();
      expect(client2.cancel).toHaveBeenCalledWith('tr-1');
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^\[transfer of "notes\.txt" cancelled/) }));
      expect(readState(fx2.stateFile).jobs).toEqual({});
    });
  });

  it('uploads at most 2 jobs at once; the third starts when a slot frees', async () => {
    const fxs = [fixture(), fixture(), fixture()];
    const dir = mkdtempSync(path.join(tmpdir(), 'transfer-sender-'));
    const stateFile = path.join(dir, 'transfers.json');
    const gates = [];
    let n = 0;
    const client = fakeClient();
    client.create = vi.fn(() => new Promise((resolve) => {
      const id = `tr-${++n}`;
      gates.push(() => resolve({ ok: true, status: 201, body: { transfer_id: id, chunk_bytes: 4, chunks: 4 } }));
    }));
    const sender = createTransferSender({ client, scan: cleanScan, stateFile, log: silent, chunkBytes: 4 });
    for (const fx of fxs) sender.start(startArgs(fx));
    const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };
    await until(() => client.create.mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(Object.keys(readState(stateFile).jobs)).toHaveLength(3);
    gates[0]();
    await until(() => client.create.mock.calls.length >= 3);
    expect(client.create).toHaveBeenCalledTimes(3);
    gates[1]();
    gates[2]();
    await sender.idle();
    expect(client.complete).toHaveBeenCalledTimes(3);
  });
});
