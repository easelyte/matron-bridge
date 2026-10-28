import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { classifyContentType, createSendAttachmentHandler, resolveAndUploadLocalFile } from '../lib/send-attachment.js';

// Every temp dir a test creates is tracked and removed after it, so the suite
// leaves nothing behind in the machine's /tmp.
const tmpDirs = [];
function mkTmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Shared by the handler tests (via makeFixture) and the resolveAndUploadLocalFile
// tests below: a temp workdir with a small real PNG plus a fake publisher whose
// uploadMedia/publishImage/publishFile match the exact method names the handler
// (and now the extracted helper) call.
function makeUploadFixture() {
  const dir = mktempWorkdir();
  const publisher = {
    uploadMedia: vi.fn(async ({ contentType }) => ({ media_id: 'blob-1', content_type: contentType, size: 4 })),
    publishImage: vi.fn(),
    publishFile: vi.fn(),
  };
  return { dir, publisher };
}

function mktempWorkdir() {
  const dir = mkTmp('send-attach-');
  writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, 'report.pdf'), 'pdf-bytes');
  return dir;
}

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
  const workdir = mkTmp('send-attach-');
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
    function makeRoomFixture(roomRecord, extra = {}) {
      const fx = makeFixture();
      const rooms = { get: (id) => (id === 'room-1' ? roomRecord : null) };
      const sender = { start: vi.fn(() => ({ jobId: 'job-1' })) };
      const uploadMedia = vi.spyOn(fx.publisher, 'uploadMedia');
      const handler = createSendAttachmentHandler({
        sessions: fx.sessions, publisher: fx.publisher, rooms, sender,
        // The transfer is "from" the session's own journal conversation.
        journalConvoIdFor: () => 'convo-abc',
        ...extra,
      });
      return { ...fx, handler, sender, uploadMedia };
    }

    it('starts a journal transfer instead of uploading media', async () => {
      const { handler, published, sender, uploadMedia, workdir } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1', caption: 'evidence' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'pending_approval', name: 'report.pdf', size: 9 });
      expect(res.body.note).toMatch(/approval card/);
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(published).toHaveLength(0);
      const realWorkdir = await realpath(workdir);
      expect(sender.start).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: '!room1', roomId: 'room-1', fromConvoId: 'convo-abc',
        absPath: path.join(realWorkdir, 'report.pdf'), name: 'report.pdf', size: 9,
        mtimeMs: expect.any(Number), contentType: 'application/pdf', caption: 'evidence',
      }));
    });

    it('refuses a file name with a backslash with a readable 400, before starting anything', async () => {
      const { handler, sender, workdir } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      writeFileSync(path.join(workdir, 'build\\log.txt'), 'x');
      const res = await handler({ roomId: '!room1', path: 'build\\log.txt', chat_room_id: 'room-1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/backslash/);
      expect(res.body.error).toMatch(/rename/);
      expect(sender.start).not.toHaveBeenCalled();
    });

    it('lets the owner send while the room is still pending', async () => {
      const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'owner', state: 'pending' });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(200);
      expect(sender.start).toHaveBeenCalledTimes(1);
    });

    it('refuses a file over 10 GB with 413 before starting anything', async () => {
      const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { transferMaxBytes: 5 });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/too large/);
      expect(sender.start).not.toHaveBeenCalled();
    });

    it('caps room files at 10 GB by default, not 50 MB', async () => {
      const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { maxBytes: 1 });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(200);
      expect(sender.start).toHaveBeenCalled();
    });

    it("refuses a room with another person's agent with 403", async () => {
      const { handler, sender, uploadMedia } = makeRoomFixture({ sessionRoomId: '!room1', role: 'owner', state: 'joined', person: 'bob' });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("files do not cross into rooms with another person's agent");
      expect(sender.start).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
    });

    it("passes the asking turn's causes, read before any await, and a null when the turn has none", async () => {
      const asked = [{ kind: 'user_message', ref: 'convo-abc:41', at: 1 }];
      let release;
      const gate = new Promise((r) => { release = r; });
      const isPersonRoom = vi.fn(() => gate.then(() => false));
      const { handler, sender, sessions } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { isPersonRoom });
      const session = sessions.get('!room1');
      session.currentTurn = { causes: asked };
      const pending = handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      // A new turn begins while the person-room check is still out.
      session.currentTurn = { causes: [{ kind: 'room_message', ref: 'room:room-1', at: 2 }] };
      release();
      expect((await pending).status).toBe(200);
      expect(sender.start).toHaveBeenCalledWith(expect.objectContaining({ fromConvoId: 'convo-abc', causes: asked }));

      session.currentTurn = null;
      await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(sender.start.mock.calls[1][0].causes).toBeNull();
    });

    it('asks the injected predicate about a guest-side person room', async () => {
      const isPersonRoom = vi.fn(async (id) => id === 'room-1');
      const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { isPersonRoom });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(403);
      expect(isPersonRoom).toHaveBeenCalledWith('room-1', expect.objectContaining({ role: 'guest' }));
      expect(sender.start).not.toHaveBeenCalled();
    });

    it('409s when the session has no journal conversation yet', async () => {
      const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { journalConvoIdFor: () => null });
      const res = await handler({ roomId: '!room1', path: 'report.pdf', chat_room_id: 'room-1' });
      expect(res.status).toBe(409);
      expect(sender.start).not.toHaveBeenCalled();
    });

    it('still guards the path for room files', async () => {
      const { handler, sender, workdir } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      writeFileSync(path.join(workdir, '.env'), 'SECRET=1');
      expect((await handler({ roomId: '!room1', path: '.env', chat_room_id: 'room-1' })).status).toBe(403);
      expect((await handler({ roomId: '!room1', path: '/etc/hosts', chat_room_id: 'room-1' })).status).toBe(403);
      expect((await handler({ roomId: '!room1', path: 'nope.pdf', chat_room_id: 'room-1' })).status).toBe(404);
      expect(sender.start).not.toHaveBeenCalled();
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
        const { handler, sender } = makeRoomFixture({ sessionRoomId: '!room1', role: 'owner', state });
        const res = await handler({ roomId: '!room1', path: 'shot.png', chat_room_id: 'room-1' });
        expect(res.status).toBe(409);
        expect(sender.start).not.toHaveBeenCalled();
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

    it('the own-conversation path still uploads media under the 50 MB cap', async () => {
      const { handler, sender, uploadMedia, published } = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' });
      const res = await handler({ roomId: '!room1', path: 'report.pdf' });
      expect(res.status).toBe(200);
      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(published[0].convoId).toBe('convo-abc');
      expect(sender.start).not.toHaveBeenCalled();
      const capped = makeRoomFixture({ sessionRoomId: '!room1', role: 'guest', state: 'joined' }, { maxBytes: 5 });
      expect((await capped.handler({ roomId: '!room1', path: 'report.pdf' })).status).toBe(413);
    });
  });

  describe('symlink escapes', () => {
    it('refuses a symlink that points at a sensitive file outside the workdir', async () => {
      const { handler, workdir, uploads } = makeFixture();
      const outsideDir = mkTmp('send-attach-outside-');
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
      const outsideDir = mkTmp('send-attach-outside-');
      writeFileSync(path.join(outsideDir, 'plain.txt'), 'not sensitive');
      symlinkSync(outsideDir, path.join(workdir, 'linkdir'));

      const res = await handler({ roomId: '!room1', path: 'linkdir/plain.txt' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/outside/i);
    });
  });
});

describe('resolveAndUploadLocalFile', () => {
  it('uploads a file inside the workdir and returns the media descriptor', async () => {
    const { dir, publisher } = makeUploadFixture();
    const r = await resolveAndUploadLocalFile({ session: { workdir: dir }, reqPath: 'shot.png', publisher });
    expect(r.ok).toBe(true);
    expect(r.media).toMatchObject({ blob_ref: expect.any(String), mime: 'image/png', name: 'shot.png', isImage: true });
    expect(publisher.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('returns the guard error shape for a path outside the workdir', async () => {
    const { dir, publisher } = makeUploadFixture();
    const r = await resolveAndUploadLocalFile({ session: { workdir: dir }, reqPath: '/etc/hosts', publisher });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('returns a 502 failure shape without touching the publish surface when uploadMedia fails open', async () => {
    const { dir } = makeUploadFixture();
    const publisher = { uploadMedia: vi.fn(async () => null), publishImage: vi.fn(), publishFile: vi.fn() };
    const r = await resolveAndUploadLocalFile({ session: { workdir: dir }, reqPath: 'shot.png', publisher });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(publisher.publishImage).not.toHaveBeenCalled();
    expect(publisher.publishFile).not.toHaveBeenCalled();
  });
});

describe('createSendAttachmentHandler Files deep link', () => {
  const WEB = 'https://matron.example.com';

  function fixtureWithWeb(webBaseUrl) {
    const { workdir, publisher, published, uploads, sessions } = makeFixture();
    const handler = createSendAttachmentHandler({
      sessions, publisher, journalConvoIdFor: () => 'convo-abc', webBaseUrl,
    });
    return { workdir, publisher, published, uploads, sessions, handler };
  }

  it('appends a Files deep link to the caption when webBaseUrl is set', async () => {
    const { handler, published, workdir } = fixtureWithWeb(WEB);
    const res = await handler({ roomId: '!room1', path: 'shot.png', caption: 'the bug' });
    expect(res.status).toBe(200);
    const realWorkdir = await realpath(workdir);
    const abs = path.join(realWorkdir, 'shot.png');
    expect(published[0].payload.caption).toBe(
      `the bug\n\n📁 Open shot.png in Files: ${WEB}/#files=${encodeURIComponent(abs)}`,
    );
  });

  it('produces a caption from just the link when the agent passed none', async () => {
    const { handler, published, workdir } = fixtureWithWeb(WEB);
    const res = await handler({ roomId: '!room1', path: 'report.pdf' });
    expect(res.status).toBe(200);
    const realWorkdir = await realpath(workdir);
    const abs = path.join(realWorkdir, 'report.pdf');
    expect(published[0].payload.caption).toBe(
      `📁 Open report.pdf in Files: ${WEB}/#files=${encodeURIComponent(abs)}`,
    );
  });

  it('leaves the caption untouched (plain-path fallback) when webBaseUrl is unset', async () => {
    const { handler, published } = fixtureWithWeb('');
    await handler({ roomId: '!room1', path: 'shot.png', caption: 'the bug' });
    expect(published[0].payload.caption).toBe('the bug');
  });

  it('omits an empty caption entirely when there is no link', async () => {
    const { handler, published } = fixtureWithWeb('');
    await handler({ roomId: '!room1', path: 'report.pdf', caption: '' });
    expect('caption' in published[0].payload).toBe(false);
  });
});

// A file the bridge downloaded for this conversation (a chat upload, an item
// attachment) lives outside the workdir, in the session's own download folder
// (lib/matron-files.js sessionDownloadDir). These run the real default
// wiring, with MATRON_FILES_DIR pointed at a temp root.
describe("the conversation's own downloads", () => {
  let prevRoot;
  let root;
  beforeEach(() => {
    prevRoot = process.env.MATRON_FILES_DIR;
    root = mkdtempSync(path.join(tmpdir(), 'send-attach-files-'));
    process.env.MATRON_FILES_DIR = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.MATRON_FILES_DIR;
    else process.env.MATRON_FILES_DIR = prevRoot;
  });

  // A session in a repo folder called "repo", plus a file the bridge saved
  // for it and one it saved for another conversation in the same repo.
  function downloadsFixture() {
    const parent = mkdtempSync(path.join(tmpdir(), 'send-attach-wd-'));
    const workdir = path.join(parent, 'repo');
    mkdirSync(workdir);
    const own = path.join(root, 'repo', 'convo-own');
    const other = path.join(root, 'repo', 'convo-other');
    mkdirSync(own, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(own, 'scan.zip'), 'zip-bytes');
    writeFileSync(path.join(other, 'theirs.zip'), 'zip-bytes');
    writeFileSync(path.join(root, 'repo', 'loose.txt'), 'shared project folder');
    const session = { roomId: 'convo-own', workdir };
    const { publisher } = makeUploadFixture();
    return { session, workdir, own, other, publisher };
  }

  it('uploads a file the bridge saved for this conversation', async () => {
    const { session, own, publisher } = downloadsFixture();
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(own, 'scan.zip'), publisher });
    expect(r.ok).toBe(true);
    expect(r.media).toMatchObject({ name: 'scan.zip', mime: 'application/zip', isImage: false });
    expect(publisher.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ filePath: await realpath(path.join(own, 'scan.zip')) }));
  });

  it("refuses another conversation's download in the same repo", async () => {
    const { session, other, publisher } = downloadsFixture();
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(other, 'theirs.zip'), publisher });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/outside/i);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses a file in the shared project folder above the conversation folder', async () => {
    const { session, publisher } = downloadsFixture();
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(root, 'repo', 'loose.txt'), publisher });
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses a ../ path that climbs out of the download folder', async () => {
    const { session, own, publisher } = downloadsFixture();
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(own, '..', 'convo-other', 'theirs.zip'), publisher });
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('still refuses a sensitive-looking file in the download folder', async () => {
    const { session, own, publisher } = downloadsFixture();
    writeFileSync(path.join(own, '.env'), 'SECRET=1');
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(own, '.env'), publisher });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/share_sensitive_data/);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses a symlink in the download folder that points outside it', async () => {
    const { session, own, other, publisher } = downloadsFixture();
    symlinkSync(path.join(other, 'theirs.zip'), path.join(own, 'mine.zip'));
    const r = await resolveAndUploadLocalFile({ session, reqPath: path.join(own, 'mine.zip'), publisher });
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('allows nothing extra for a session with no room id', async () => {
    const { workdir, own, publisher } = downloadsFixture();
    const r = await resolveAndUploadLocalFile({ session: { workdir }, reqPath: path.join(own, 'scan.zip'), publisher });
    expect(r.status).toBe(403);
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it("send_attachment posts this conversation's download into a room", async () => {
    const { session, own, publisher } = downloadsFixture();
    const rooms = { get: (id) => (id === 'room-1' ? { sessionRoomId: 'convo-own', role: 'guest', state: 'joined' } : null) };
    const sender = { start: vi.fn(() => ({ jobId: 'job-1' })) };
    const handler = createSendAttachmentHandler({
      sessions: new Map([['convo-own', session]]), publisher, rooms, sender, journalConvoIdFor: () => 'convo-own',
    });
    const res = await handler({ roomId: 'convo-own', path: path.join(own, 'scan.zip'), chat_room_id: 'room-1' });
    expect(res.status).toBe(200);
    expect(sender.start).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1', name: 'scan.zip' }));
    expect(publisher.uploadMedia).not.toHaveBeenCalled();
  });
});
