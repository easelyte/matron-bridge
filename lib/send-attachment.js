import path from 'path';
import { stat, realpath } from 'fs/promises';
import { checkFileLink } from './file-link-guard.js';
import { roomAccessError } from './agent-chat.js';

// Agent-outbound attachment support for the send_attachment MCP tool.
// classifyContentType is extension-based: the agent is sending a file it
// just produced (screenshot, plot, PDF), so the extension is trustworthy
// enough and avoids a content-sniffing dependency.

const EXT_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

export function classifyContentType(fileName) {
  const ext = path.extname(String(fileName)).toLowerCase();
  const contentType = EXT_CONTENT_TYPES[ext] || 'application/octet-stream';
  return { contentType, isImage: contentType.startsWith('image/') };
}

// Journal server's POST /media per-file cap. Enforced client-side so the
// agent gets a crisp error instead of a failed-open null from uploadMedia.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const GUARD_ERRORS = {
  sensitive: 'Refused: that file looks sensitive (keys/credentials/env). Use share_sensitive_data instead.',
  'outside-workdir': 'Refused: path is outside the session workdir.',
  'relative-path': 'Refused: could not resolve the path to an absolute location.',
};

// HTTP-agnostic so it is fully unit-testable; index.js mounts it as a thin
// adapter on the loopback API server. Same shape as the other loopback
// routes: takes the parsed POST body, returns {status, body}.
export function createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor, rooms = null, maxBytes = MAX_ATTACHMENT_BYTES }) {
  return async function handleSendAttachment(data) {
    const { roomId, path: reqPath, caption, chat_room_id: chatRoomId } = data || {};
    if (!roomId || typeof roomId !== 'string' || !reqPath || typeof reqPath !== 'string') {
      return { status: 400, body: { error: 'roomId and path are required' } };
    }

    const session = sessions.get(roomId);
    if (!session) return { status: 404, body: { error: `no active session for chat ${roomId}` } };

    // Optional agent-chat room target (spec: agent chat phase 3): when
    // chat_room_id is given the attachment is published into that room's
    // convo instead of the session's own — the SAME shared gate as
    // agent_chat_send (lib/agent-chat.js roomAccessError, mode 'send'), so
    // the posting rules can never drift between the two surfaces.
    let convoId;
    if (chatRoomId !== undefined) {
      if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'chat_room_id must be a room id string' } };
      const gateErr = roomAccessError(rooms, chatRoomId, roomId);
      if (gateErr) return gateErr;
      convoId = chatRoomId;
    } else {
      convoId = journalConvoIdFor(session);
      if (!convoId) return { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } };
    }

    // Fail closed: a session with no workdir has no containment boundary at
    // all, which would otherwise let it send any absolute non-sensitive path
    // on the box. This also covers the relative-path-with-no-workdir case,
    // since a relative path can't be resolved without one either.
    const absWorkdir = session.workdir ? path.resolve(session.workdir) : null;
    if (!absWorkdir) {
      return { status: 400, body: { error: 'session has no working directory — cannot send attachments' } };
    }
    const absTarget = path.isAbsolute(reqPath) ? path.resolve(reqPath) : path.resolve(absWorkdir, reqPath);

    // checkFileLink is purely lexical, but here it gates a real read+upload —
    // resolve symlinks BEFORE gating so a symlink can't present an
    // innocent-looking path to the guard while the real read lands outside
    // the workdir or on a sensitive file. Everything downstream (stat,
    // upload, reported name) uses the resolved real path too.
    let realTarget;
    try {
      realTarget = await realpath(absTarget);
    } catch {
      return { status: 404, body: { error: `file not found: ${absTarget}` } };
    }
    // tmpdir (and other paths) can themselves be symlinks (e.g. macOS
    // /var -> /private/var), so resolve the workdir the same way before
    // comparing — otherwise a real, in-bounds file can look "outside" the
    // workdir purely because one side was resolved and the other wasn't.
    const realWorkdir = absWorkdir ? await realpath(absWorkdir).catch(() => absWorkdir) : null;

    const gate = checkFileLink(realTarget, realWorkdir);
    if (!gate.ok) return { status: 403, body: { error: GUARD_ERRORS[gate.reason] || `Refused: ${gate.reason}` } };

    let info;
    try {
      info = await stat(realTarget);
    } catch {
      return { status: 404, body: { error: `file not found: ${realTarget}` } };
    }
    if (!info.isFile()) return { status: 400, body: { error: `not a regular file: ${realTarget}` } };

    const name = path.basename(realTarget);
    if (info.size === 0) return { status: 400, body: { error: `file is empty: ${name}` } };
    if (info.size > maxBytes) {
      return { status: 413, body: { error: `file too large (${info.size} bytes; the journal caps attachments at 50 MB)` } };
    }

    const { contentType, isImage } = classifyContentType(name);

    // Publishes via the injected publisher directly, bypassing index.js's
    // journalPublish upsert-first choke point. Safe today only because every
    // session-spawn path upserts the convo before an agent can reach an MCP
    // tool call — if that invariant ever changes, this needs to route
    // through the same choke point.
    const media = await publisher.uploadMedia({ filePath: realTarget, contentType, name });
    if (!media) {
      return { status: 502, body: { error: 'upload failed — journal unreachable, over quota, or rejected the file' } };
    }

    const payload = {
      blob_ref: media.media_id,
      content_type: media.content_type || contentType,
      name,
      size: media.size ?? info.size,
    };
    if (caption) payload.caption = caption;

    if (isImage) publisher.publishImage(convoId, payload);
    else publisher.publishFile(convoId, payload);

    return { status: 200, body: { ok: true, kind: isImage ? 'image' : 'file', name, size: payload.size } };
  };
}
