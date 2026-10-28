import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js boots the bridge, so its transfer-receiver wiring is pinned by
// source, like the other *-wiring tests.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fnBody = (sig) => {
  const start = index.indexOf(sig);
  expect(start, sig).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start));
};

describe('transfer receiver wiring', () => {
  it('a ready frame goes to the receiver; the sender outcomes still go to the sender', () => {
    const body = fnBody('function journalHandleTransferFrame(');
    expect(body).toMatch(/case 'ready':\s*transferReceiver\?\.onReady\(frame\.transfer\);\s*return;/);
    expect(body).toMatch(/case 'delivered':\s*transferSender\?\.onFrame\(frame\);/);
  });

  it('every journal hello catches up on missed transfers and resumes uploads', () => {
    const body = fnBody('function handleJournalReconnect()');
    expect(body).toContain('transferSender?.resumeAll()');
    expect(body).toContain('transferReceiver?.catchUp()');
  });

  it('a room file event that names a transfer is left to the receiver', () => {
    const body = fnBody('function deliverRoomFrameTo(');
    const skip = body.indexOf("if (frame.type === 'file' && payload.transfer_id) return;");
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(body.indexOf('roomDelivery.deliver('));
  });

  it('targets skip the sending session by journal conversation id and only take joined bindings', () => {
    const body = fnBody('function transferTargetsFor(');
    expect(body).toContain("if (key == null || state !== 'joined') return;");
    expect(body).toContain('if (fromConvoId && convoId === fromConvoId) return;');
    expect(body).toContain('consider(room.guestSessionRoomId, room.guestState);');
  });

  it('the inbox is the session download dir, and the line goes through deliverRoomFrameTo', () => {
    const start = index.indexOf('transferReceiver = createTransferReceiver({');
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf('\n});\n', start));
    expect(body).toContain("path.join(sessionDownloadDir(target) || matronFilesDir(target?.workdir), 'inbox')");
    expect(body).toContain('deliverRoomFrameTo({ ...room, sessionRoomId: target.roomId }');
    expect(body).toContain('agentRooms.isMuted(roomId, target?.roomId)');
  });

  it("the sender's outcome lines go through the wake-capable room path, not a live-only notify", () => {
    const start = index.indexOf('transferSender = createTransferSender({');
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf('\n});\n', start));
    expect(body).toMatch(/notify: createTransferOutcomeNotify\(\{\s*getRoom: \(roomId\) => agentRooms\.get\(roomId\),\s*deliverRoomFrameTo,/);
    expect(body).not.toContain('.alive');
    expect(body).not.toContain('roomDelivery.deliver(');
  });
});
