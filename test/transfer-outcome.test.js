import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { createTransferOutcomeNotify } from '../lib/transfer-outcome.js';
import { createTransferSender } from '../lib/transfer-sender.js';

const silent = { log() {}, warn() {}, error() {} };
const room = { sessionRoomId: '!owner', guestSessionRoomId: '!guest', title: 'Build room' };

describe('transfer outcome notify', () => {
  it('delivers through the room path with the sending session as the binding, live or not', () => {
    const deliverRoomFrameTo = vi.fn();
    const notify = createTransferOutcomeNotify({ getRoom: (id) => (id === 'room-1' ? room : null), deliverRoomFrameTo, log: silent, now: () => 42 });
    expect(notify({ sessionKey: '!guest', roomId: 'room-1', text: '[transfer of "x" declined: no]' })).toBe(true);
    expect(deliverRoomFrameTo).toHaveBeenCalledTimes(1);
    const [binding, frame] = deliverRoomFrameTo.mock.calls[0];
    expect(binding).toMatchObject({ sessionRoomId: '!guest', title: 'Build room' });
    expect(frame).toEqual({ convo_id: 'room-1', type: 'text', sender: 'bridge', payload: { body: '[transfer of "x" declined: no]' }, ts: 42 });
  });

  it('drops a line for a session the room no longer binds, or a room that is gone', () => {
    const deliverRoomFrameTo = vi.fn();
    const notify = createTransferOutcomeNotify({ getRoom: (id) => (id === 'room-1' ? room : null), deliverRoomFrameTo, log: silent });
    expect(notify({ sessionKey: '!other', roomId: 'room-1', text: 't' })).toBe(false);
    expect(notify({ sessionKey: '!owner', roomId: 'room-2', text: 't' })).toBe(false);
    expect(notify({ sessionKey: null, roomId: 'room-1', text: 't' })).toBe(false);
    expect(deliverRoomFrameTo).not.toHaveBeenCalled();
  });

  it('a declined outcome reaches a sleeping sender session, once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'transfer-outcome-'));
    const absPath = path.join(dir, 'notes.txt');
    writeFileSync(absPath, 'aaaabbbb');
    const st = statSync(absPath);
    // No live sessions at all: index.js's deliverRoomFrameTo resumes the
    // reaped conversation from its persisted record. Stand in for it.
    const woken = [];
    const deliverRoomFrameTo = vi.fn((binding, frame) => { woken.push([binding.sessionRoomId, frame.payload.body]); });
    const client = {
      create: vi.fn(async () => ({ ok: true, status: 201, body: { transfer_id: 'tr-1', chunk_bytes: 4, chunks: 2 } })),
      status: vi.fn(async () => ({ ok: true, status: 200, body: { phase: 'open', upload: 'uploading', received: [] } })),
      putChunk: vi.fn(async () => ({ ok: true, status: 200 })),
      complete: vi.fn(async () => ({ ok: true, status: 200, body: { upload: 'uploaded' } })),
      cancel: vi.fn(async () => ({ ok: true, status: 200 })),
    };
    const sender = createTransferSender({
      client, scan: async () => ({ verdict: 'clean', findings: [] }), stateFile: path.join(dir, 's.json'), log: silent, chunkBytes: 4,
      notify: createTransferOutcomeNotify({ getRoom: () => room, deliverRoomFrameTo, log: silent }),
    });
    sender.start({ sessionKey: '!owner', roomId: 'room-1', fromConvoId: 'c-1', absPath, name: 'notes.txt', size: st.size, mtimeMs: st.mtimeMs });
    await sender.idle();
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    sender.onFrame({ kind: 'transfer', event: 'declined', transfer_id: 'tr-1', reason: 'not needed' });
    expect(woken).toEqual([['!owner', '[transfer of "notes.txt" declined: not needed]']]);
  });
});
