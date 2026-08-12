import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { classifyContentType, createSendAttachmentHandler } from '../lib/send-attachment.js';

describe('classifyContentType', () => {
  it('classifies common image extensions as images', () => {
    expect(classifyContentType('shot.png')).toEqual({ contentType: 'image/png', isImage: true });
    expect(classifyContentType('IMG_001.JPG')).toEqual({ contentType: 'image/jpeg', isImage: true });
    expect(classifyContentType('anim.gif')).toEqual({ contentType: 'image/gif', isImage: true });
    expect(classifyContentType('pic.webp')).toEqual({ contentType: 'image/webp', isImage: true });
    expect(classifyContentType('photo.heic')).toEqual({ contentType: 'image/heic', isImage: true });
  });

  it('classifies documents and text as non-image files', () => {
    expect(classifyContentType('report.pdf')).toEqual({ contentType: 'application/pdf', isImage: false });
    expect(classifyContentType('build.log')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('notes.txt')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('README.md')).toEqual({ contentType: 'text/markdown', isImage: false });
    expect(classifyContentType('data.json')).toEqual({ contentType: 'application/json', isImage: false });
    expect(classifyContentType('data.csv')).toEqual({ contentType: 'text/csv', isImage: false });
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(classifyContentType('mystery.bin')).toEqual({ contentType: 'application/octet-stream', isImage: false });
    expect(classifyContentType('Makefile')).toEqual({ contentType: 'application/octet-stream', isImage: false });
  });
});

function makeFixture() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'send-attach-'));
  writeFileSync(path.join(workdir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(workdir, 'report.pdf'), 'pdf-bytes');
  const published = [];
  const uploads = [];
  const publisher = {
    uploadMedia: async ({ filePath, contentType, name }) => {
      uploads.push({ filePath, contentType, name });
      return { media_id: 'blob-123', content_type: contentType, size: 4 };
    },
    publishImage: (convoId, payload) => published.push({ kind: 'image', convoId, payload }),
    publishFile: (convoId, payload) => published.push({ kind: 'file', convoId, payload }),
  };
  const sessions = new Map([['!room1', { workdir }]]);
  const handler = createSendAttachmentHandler({
    sessions, publisher, journalConvoIdFor: () => 'convo-abc',
  });
  return { workdir, publisher, published, uploads, sessions, handler };
}

describe('createSendAttachmentHandler', () => {
  it('uploads and publishes an image event with caption', async () => {
    const { handler, published, workdir } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'shot.png', caption: 'the bug' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, kind: 'image', name: 'shot.png', size: 4 });
    expect(published).toEqual([{
      kind: 'image',
      convoId: 'convo-abc',
      payload: { blob_ref: 'blob-123', content_type: 'image/png', name: 'shot.png', size: 4, caption: 'the bug' },
    }]);
    expect(published[0].payload.name).toBe('shot.png');
    void workdir;
  });

  it('publishes non-images as file events and omits empty caption', async () => {
    const { handler, published } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'report.pdf', caption: '' });
    expect(res.status).toBe(200);
    expect(published[0].kind).toBe('file');
    expect('caption' in published[0].payload).toBe(false);
  });

  it('resolves relative paths against the session workdir and passes filePath to uploadMedia', async () => {
    const { handler, workdir, uploads } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'report.pdf' });
    expect(res.status).toBe(200);
    // The handler stats/uploads the realpath-resolved target (see the
    // symlink-guard fix below), so the expected filePath is realpath(workdir)
    // too — on macOS tmpdir() itself is a symlink (/var -> /private/var), so
    // this can differ from the raw `workdir` string even though it's the
    // same file.
    const realWorkdir = await realpath(workdir);
    expect(uploads).toEqual([{
      filePath: path.join(realWorkdir, 'report.pdf'),
      contentType: 'application/pdf',
      name: 'report.pdf',
    }]);
  });

  it('rejects an unknown roomId', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!nope', path: 'shot.png' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active session/i);
  });

  it('rejects when the journal conversation is not established', async () => {
    const { sessions, publisher } = makeFixture();
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => null });
    const res = await handler({ roomId: '!room1', path: 'shot.png' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/journal conversation/i);
  });

  it('refuses sensitive paths with guidance to share_sensitive_data', async () => {
    const { handler, workdir } = makeFixture();
    writeFileSync(path.join(workdir, '.env'), 'SECRET=1');
    const res = await handler({ roomId: '!room1', path: '.env' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/share_sensitive_data/);
  });

  it('refuses paths outside the session workdir', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!room1', path: '/etc/hosts' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/outside/i);
  });

  it('rejects missing files', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'no-such.png' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('rejects files over the size cap', async () => {
    const { workdir, sessions, publisher } = makeFixture();
    writeFileSync(path.join(workdir, 'big.bin'), Buffer.alloc(32));
    const handler = createSendAttachmentHandler({
      sessions, publisher, journalConvoIdFor: () => 'convo-abc', maxBytes: 16,
    });
    const res = await handler({ roomId: '!room1', path: 'big.bin' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/50 MB|too large/i);
  });

  it('surfaces upload failure when uploadMedia fails open with null', async () => {
    const { workdir, sessions } = makeFixture();
    const publisher = {
      uploadMedia: async () => null,
      publishImage: () => { throw new Error('must not publish'); },
      publishFile: () => { throw new Error('must not publish'); },
    };
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => 'convo-abc' });
    const res = await handler({ roomId: '!room1', path: 'shot.png' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/upload failed/i);
    void workdir;
  });

  it('rejects missing params', async () => {
    const { handler } = makeFixture();
    expect((await handler({ path: 'x.png' })).status).toBe(400);
    expect((await handler({ roomId: '!room1' })).status).toBe(400);
  });

  it('rejects non-string roomId/path instead of throwing', async () => {
    const { handler } = makeFixture();
    expect((await handler({ roomId: 123, path: 'x.png' })).status).toBe(400);
    expect((await handler({ roomId: '!room1', path: 42 })).status).toBe(400);
    expect((await handler({ roomId: '!room1', path: { evil: true } })).status).toBe(400);
  });

  it('fails closed for a session with no workdir, even for an absolute path', async () => {
    const { sessions, publisher } = makeFixture();
    sessions.set('!room2', {}); // no workdir at all
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => 'convo-abc' });
    const res = await handler({ roomId: '!room2', path: '/etc/hosts' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/working directory/i);
  });

  it('rejects zero-byte files', async () => {
    const { handler, workdir } = makeFixture();
    writeFileSync(path.join(workdir, 'empty.txt'), '');
    const res = await handler({ roomId: '!room1', path: 'empty.txt' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it('rejects a directory as not a regular file', async () => {
    const { handler, workdir } = makeFixture();
    mkdirSync(path.join(workdir, 'adir'));
    const res = await handler({ roomId: '!room1', path: 'adir' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a regular file/i);
  });

  it('accepts an absolute path that resolves inside the workdir', async () => {
    const { handler, workdir } = makeFixture();
    const res = await handler({ roomId: '!room1', path: path.join(workdir, 'shot.png') });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('image');
  });

  it('falls back to the classified content-type and stat size when the publisher omits them', async () => {
    const { sessions, workdir, published } = makeFixture();
    const publisher = {
      uploadMedia: async () => ({ media_id: 'blob-999', content_type: null, size: undefined }),
      publishImage: (convoId, payload) => published.push({ kind: 'image', convoId, payload }),
      publishFile: (convoId, payload) => published.push({ kind: 'file', convoId, payload }),
    };
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => 'convo-abc' });
    const res = await handler({ roomId: '!room1', path: 'shot.png' });
    expect(res.status).toBe(200);
    expect(published[0].payload.content_type).toBe('image/png'); // fell back to classifyContentType
    expect(published[0].payload.size).toBe(4); // fell back to stat().size — shot.png fixture is 4 bytes
    void workdir;
  });

  describe('chat_room_id room target', () => {
    function makeRoomFixture(roomRecord) {
      const fx = makeFixture();
      const rooms = { get: (id) => (id === 'room-1' ? roomRecord : null) };
      const handler = createSendAttachmentHandler({
        sessions: fx.sessions, publisher: fx.publisher, rooms,
        // The room target must not require the session's own convo.
        journalConvoIdFor: () => null,
      });
      return { ...fx, handler };
    }

    it('publishes into the room convo instead of the session convo', async () => {
      const { handler, published } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      const res = await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1', caption: 'evidence' });
      expect(res.status).toBe(200);
      expect(published).toHaveLength(1);
      expect(published[0].convoId).toBe('room-1');
      expect(published[0].payload.caption).toBe('evidence');
    });

    it('lets the owner post while the room is still pending', async () => {
      const { handler, published } = makeRoomFixture({ sessionRoomId: '!room1', role: 'owner', state: 'pending' });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(200);
      expect(published[0].convoId).toBe('room-1');
    });

    it('404s a room this session does not participate in', async () => {
      const { handler } = makeRoomFixture({ sessionRoomId: '!other', role: 'guest', state: 'joined' });
      expect((await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1' })).status).toBe(404);
      expect((await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-ghost' })).status).toBe(404);
    });

    it('409s a guest room that is not joined', async () => {
      const { handler } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'pending' });
      const res = await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pending/);
    });

    it('409s an owner who left/was refused/expired — same shared gate as agent_chat_send', async () => {
      for (const state of ['left', 'refused', 'expired']) {
        const { handler, published } = makeRoomFixture({ sessionRoomId: '!room1', role: 'owner', state });
        const res = await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1' });
        expect(res.status).toBe(409);
        expect(published).toHaveLength(0);
      }
    });

    it('400s a non-string chat_room_id', async () => {
      const { handler } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      expect((await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 42 })).status).toBe(400);
    });

    it('404s when no rooms registry is wired at all', async () => {
      const { sessions, publisher } = makeFixture();
      const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => 'convo-abc' });
      const res = await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1' });
      expect(res.status).toBe(404);
    });
  });

  describe('symlink escapes', () => {
    it('refuses a symlink that points at a sensitive file outside the workdir', async () => {
      const { handler, workdir, uploads } = makeFixture();
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'send-attach-outside-'));
      mkdirSync(path.join(outsideDir, 'secrets'));
      writeFileSync(path.join(outsideDir, 'secrets', 'id_rsa'), '-----BEGIN PRIVATE KEY-----');
      // Innocent-looking name INSIDE the workdir, but it's a symlink to a
      // sensitive file OUTSIDE the workdir. checkFileLink checks sensitivity
      // before containment, so a target that is both sensitive-named and
      // outside the workdir is refused for being sensitive; if it were
      // outside-but-not-sensitive-named it would be refused as
      // 'outside-workdir' instead (see the directory-escape test below).
      symlinkSync(path.join(outsideDir, 'secrets', 'id_rsa'), path.join(workdir, 'innocent.txt'));

      const res = await handler({ roomId: '!room1', path: 'innocent.txt' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/share_sensitive_data/);
      expect(uploads).toEqual([]); // uploadMedia was never called
    });

    it('refuses a directory symlink that escapes the workdir', async () => {
      const { handler, workdir } = makeFixture();
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'send-attach-outside-'));
      writeFileSync(path.join(outsideDir, 'plain.txt'), 'not sensitive');
      symlinkSync(outsideDir, path.join(workdir, 'linkdir'));

      const res = await handler({ roomId: '!room1', path: 'linkdir/plain.txt' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/outside/i);
    });
  });
});
