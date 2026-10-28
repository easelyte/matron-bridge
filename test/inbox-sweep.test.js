import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { sweepInbox, INBOX_MAX_AGE_MS, INBOX_HARD_MAX_AGE_MS } from '../lib/inbox-sweep.js';
import { createTransferReceiver } from '../lib/transfer-receiver.js';

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const ID_A = `tr_${'a'.repeat(32)}`;
const ID_B = `tr_${'b'.repeat(32)}`;
const ID_C = `tr_${'c'.repeat(32)}`;
const silent = { log() {}, warn() {}, error() {} };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-sweep-'));
  const files = path.join(root, 'files');
  const inbox = path.join(files, 'session-1', 'inbox');
  mkdirSync(inbox, { recursive: true });
  return { root, files, roots: [files], inbox, stateFile: path.join(root, 'inbox-state.json') };
}

// A file whose mtime is `at` (what the receiver leaves: the .part's last
// write, or the copy's time, never later than the arrival it records).
function fileAt(p, at, body = 'x') {
  writeFileSync(p, body);
  utimesSync(p, new Date(at), new Date(at));
  return p;
}
const writeState = (f, state) => writeFileSync(f, JSON.stringify(state));
const readState = (f) => JSON.parse(readFileSync(f, 'utf-8'));

describe('inbox sweep', () => {
  it('deletes a recorded file at 7 days + 1 ms and keeps it at 7 days − 1 ms, pruning only the swept record', () => {
    const fx = fixture();
    const old = fileAt(path.join(fx.inbox, 'old.log'), NOW - INBOX_MAX_AGE_MS - 1);
    const young = fileAt(path.join(fx.inbox, 'young.log'), NOW - INBOX_MAX_AGE_MS + 1);
    writeState(fx.stateFile, { pending: {}, arrived: [
      { path: old, arrivedAt: NOW - INBOX_MAX_AGE_MS - 1, transferId: ID_A },
      { path: young, arrivedAt: NOW - INBOX_MAX_AGE_MS + 1, transferId: ID_B },
    ] });
    expect(INBOX_MAX_AGE_MS).toBe(7 * DAY);
    const r = sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots });
    expect(r.deleted).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(readState(fx.stateFile).arrived.map((a) => a.path)).toEqual([young]);
  });

  it('never deletes a file the receiver did not record, however old', () => {
    const fx = fixture();
    const recorded = fileAt(path.join(fx.inbox, 'sent.log'), NOW - 30 * DAY);
    const mine = fileAt(path.join(fx.inbox, 'notes.txt'), NOW - 30 * DAY);
    const stray = fileAt(path.join(fx.inbox, 'other.part'), NOW - 30 * DAY);
    writeState(fx.stateFile, { pending: {}, arrived: [{ path: recorded, arrivedAt: NOW - 30 * DAY, transferId: ID_A }] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([recorded]);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });

  it('tolerates a recorded file that is already gone, and prunes its record', () => {
    const fx = fixture();
    const gone = path.join(fx.inbox, 'gone.log');
    writeState(fx.stateFile, { pending: {}, arrived: [{ path: gone, arrivedAt: NOW - 8 * DAY, transferId: ID_A }] });
    const r = sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots });
    expect(r.deleted).toEqual([]);
    expect(readState(fx.stateFile).arrived).toEqual([]);
  });

  it('a missing or corrupt state file deletes nothing and never throws', () => {
    const fx = fixture();
    expect(sweepInbox(path.join(fx.root, 'nope.json'), { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    writeFileSync(fx.stateFile, '{not json');
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
  });

  it('never follows a symlink at a recorded path: the link and its target stay', () => {
    const fx = fixture();
    const target = fileAt(path.join(fx.root, 'precious.txt'), NOW - 30 * DAY);
    const link = path.join(fx.inbox, 'sent.log');
    symlinkSync(target, link);
    writeState(fx.stateFile, { pending: {}, arrived: [{ path: link, arrivedAt: NOW - 30 * DAY, transferId: ID_A }] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it('keeps a file changed since it arrived until that change is 7 days old', () => {
    const fx = fixture();
    const edited = fileAt(path.join(fx.inbox, 'edited.log'), NOW - DAY);
    writeState(fx.stateFile, { pending: {}, arrived: [{ path: edited, arrivedAt: NOW - 10 * DAY, transferId: ID_A }] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    expect(existsSync(edited)).toBe(true);
    expect(readState(fx.stateFile).arrived).toHaveLength(1);
  });

  it('deletes a file still being edited once it is 30 days past its arrival', () => {
    const fx = fixture();
    expect(INBOX_HARD_MAX_AGE_MS).toBe(30 * DAY);
    const edited = fileAt(path.join(fx.inbox, 'edited.log'), NOW - DAY);
    const younger = fileAt(path.join(fx.inbox, 'younger.log'), NOW - DAY);
    writeState(fx.stateFile, { pending: {}, arrived: [
      { path: edited, arrivedAt: NOW - INBOX_HARD_MAX_AGE_MS - 1, transferId: ID_A },
      { path: younger, arrivedAt: NOW - INBOX_HARD_MAX_AGE_MS + 1, transferId: ID_B },
    ] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([edited]);
    expect(existsSync(younger)).toBe(true);
  });

  it('never deletes a recorded file outside an inbox under the downloads root', () => {
    const fx = fixture();
    // Under the root but not in an inbox directory.
    const notInbox = path.join(fx.files, 'session-1', 'notes.log');
    fileAt(notInbox, NOW - 30 * DAY);
    // Outside the root altogether, even in a directory called inbox.
    const otherInbox = path.join(fx.root, 'other', 'inbox');
    mkdirSync(otherInbox, { recursive: true });
    const outside = fileAt(path.join(otherInbox, 'precious.log'), NOW - 30 * DAY);
    // A path that climbs out with '..' from an inbox.
    const precious = fileAt(path.join(fx.root, 'precious.txt'), NOW - 30 * DAY);
    const climbing = `${fx.inbox}/../../../precious.txt`;
    writeState(fx.stateFile, { pending: {}, arrived: [notInbox, outside, climbing].map((p, i) => ({ path: p, arrivedAt: NOW - 30 * DAY, transferId: [ID_A, ID_B, ID_C][i] })) });
    // No roots given: nothing is ever deleted.
    expect(sweepInbox(fx.stateFile, { now: NOW }).deleted).toEqual([]);
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    for (const p of [notInbox, outside, precious]) expect(existsSync(p), p).toBe(true);
  });

  it('never follows a symlinked inbox directory out of the root, for recorded files or .part files', () => {
    const fx = fixture();
    const away = path.join(fx.root, 'away');
    mkdirSync(away);
    const target = fileAt(path.join(away, 'precious.log'), NOW - 30 * DAY);
    const part = fileAt(path.join(away, `x.${ID_B}.part`), NOW - 30 * DAY);
    mkdirSync(path.join(fx.files, 'session-2'));
    const linkedInbox = path.join(fx.files, 'session-2', 'inbox');
    symlinkSync(away, linkedInbox);
    writeState(fx.stateFile, { pending: {}, arrived: [{ path: path.join(linkedInbox, 'precious.log'), arrivedAt: NOW - 30 * DAY, transferId: ID_A }] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(part)).toBe(true);
  });

  it('a path reused by a later arrival is kept while that arrival is young', () => {
    const fx = fixture();
    const p = fileAt(path.join(fx.inbox, 'build.log'), NOW - 8 * DAY);
    writeState(fx.stateFile, { pending: {}, arrived: [
      { path: p, arrivedAt: NOW - 9 * DAY, transferId: ID_A },
      { path: p, arrivedAt: NOW - DAY, transferId: ID_B },
    ] });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it('deletes an orphaned .part older than 7 days in a known inbox, never one a pending entry still owns', () => {
    const fx = fixture();
    const recorded = fileAt(path.join(fx.inbox, 'young.log'), NOW - DAY);
    const orphan = fileAt(path.join(fx.inbox, `dump.sql.${ID_A}.part`), NOW - 8 * DAY);
    const fresh = fileAt(path.join(fx.inbox, `new.bin.${ID_C}.part`), NOW - DAY);
    const owned = fileAt(path.join(fx.inbox, `big.tar.${ID_B}.part`), NOW - 8 * DAY);
    const notOurs = fileAt(path.join(fx.inbox, 'tool.tr_short.part'), NOW - 30 * DAY);
    // A .part in a directory the state does not name is never looked at.
    const elsewhere = path.join(fx.root, 'elsewhere');
    mkdirSync(elsewhere);
    const outside = fileAt(path.join(elsewhere, `x.${ID_A}.part`), NOW - 30 * DAY);
    writeState(fx.stateFile, {
      pending: { [ID_B]: { transfer: { id: ID_B, room_id: 'room-1', name: 'big.tar', size: 9, sha256: 'f'.repeat(64) }, dir: fx.inbox } },
      arrived: [{ path: recorded, arrivedAt: NOW - DAY, transferId: ID_C }],
    });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([orphan]);
    for (const p of [recorded, fresh, owned, notOurs, outside]) expect(existsSync(p), p).toBe(true);
  });

  it('never deletes a saved copy a pending entry is still delivering', () => {
    const fx = fixture();
    const p = fileAt(path.join(fx.inbox, 'slow.log'), NOW - 9 * DAY);
    writeState(fx.stateFile, {
      pending: { [ID_A]: { transfer: { id: ID_A }, saved: [{ key: '!s', path: p }] } },
      arrived: [{ path: p, arrivedAt: NOW - 9 * DAY, transferId: ID_A }],
    });
    expect(sweepInbox(fx.stateFile, { now: NOW, roots: fx.roots }).deleted).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it('uses the injected fs: lstat, unlink and readdir only', () => {
    const calls = [];
    // Built with path, so they are absolute on every platform.
    const root = path.resolve('/dl');
    const inboxDir = path.join(root, 's', 'inbox');
    const file = path.join(inboxDir, 'a.log');
    const stateFile = path.resolve('/state.json');
    const fsImpl = {
      readFileSync: () => JSON.stringify({ pending: {}, arrived: [{ path: file, arrivedAt: NOW - 8 * DAY, transferId: ID_A }] }),
      realpathSync: (p) => p,
      lstatSync: (p) => { calls.push(['lstat', p]); return { isFile: () => true, isSymbolicLink: () => false, mtimeMs: NOW - 8 * DAY }; },
      unlinkSync: (p) => calls.push(['unlink', p]),
      readdirSync: (d) => { calls.push(['readdir', d]); return []; },
    };
    const save = vi.fn();
    expect(sweepInbox(stateFile, { now: NOW, fsImpl, save, roots: [root] }).deleted).toEqual([file]);
    expect(calls).toContainEqual(['unlink', file]);
    expect(calls).toContainEqual(['readdir', inboxDir]);
    expect(save).toHaveBeenCalledWith(stateFile, { pending: {}, arrived: [] });
  });
});

describe('receiver sweep', () => {
  const CONTENT = Buffer.from('hello from box-a\n');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

  it('sweeps its own state in memory, so a later save never brings a pruned record back', async () => {
    const fx = fixture();
    let clock = NOW;
    const client = {
      download: vi.fn(async () => new Response(CONTENT, { status: 200 })),
      received: vi.fn(async () => ({ ok: true, status: 200 })),
      listPending: vi.fn(async () => ({ ok: true, status: 200, body: { transfers: [] } })),
    };
    const session = { roomId: '!guest' };
    const receiver = createTransferReceiver({
      client, dirFor: () => fx.inbox, sessionsForRoom: () => [session], stateFile: fx.stateFile, inboxRoots: fx.roots,
      log: silent, now: () => clock, sleep: async () => {},
    });
    receiver.onReady({ id: ID_A, room_id: 'room-1', name: 'build.log', size: CONTENT.length, sha256: sha(CONTENT) });
    await receiver.idle();
    const saved = path.join(fx.inbox, 'build.log');
    utimesSync(saved, new Date(NOW), new Date(NOW));
    expect(receiver.sweep().deleted).toEqual([]);

    clock = NOW + INBOX_MAX_AGE_MS + 1;
    expect(receiver.sweep().deleted).toEqual([saved]);
    expect(existsSync(saved)).toBe(false);
    expect(readState(fx.stateFile).arrived).toEqual([]);

    // The next transfer's save writes the in-memory state: the swept record stays gone.
    receiver.onReady({ id: ID_B, room_id: 'room-1', name: 'next.log', size: CONTENT.length, sha256: sha(CONTENT) });
    await receiver.idle();
    expect(readState(fx.stateFile).arrived.map((a) => a.transferId)).toEqual([ID_B]);
  });

  it('records the inbox of a download in progress, so its .part is known and protected', async () => {
    const fx = fixture();
    let release;
    const client = {
      download: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      received: vi.fn(async () => ({ ok: true, status: 200 })),
      listPending: vi.fn(),
    };
    const receiver = createTransferReceiver({
      client, dirFor: () => fx.inbox, sessionsForRoom: () => [{ roomId: '!guest' }], stateFile: fx.stateFile, inboxRoots: fx.roots,
      log: silent, now: () => NOW + 30 * DAY, sleep: async () => {},
    });
    const t = { id: ID_A, room_id: 'room-1', name: 'big.tar', size: CONTENT.length, sha256: sha(CONTENT) };
    receiver.onReady(t);
    await vi.waitFor(() => expect(client.download).toHaveBeenCalled());
    expect(readState(fx.stateFile).pending[ID_A].dir).toBe(fx.inbox);
    const part = receiver.partPathFor(fx.inbox, t);
    fileAt(part, NOW, 'partial');
    expect(receiver.sweep().deleted).toEqual([]);
    expect(existsSync(part)).toBe(true);
    release(new Response(CONTENT, { status: 200 }));
    await receiver.idle();
    rmSync(fx.root, { recursive: true, force: true });
  });
});
