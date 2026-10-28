import path from 'path';
import { stat, realpath } from 'fs/promises';
import { checkFileLink, buildFilesDeepLink, appendFilesDeepLink } from './file-link-guard.js';
import { roomAccessError } from './agent-chat.js';
import { sessionDownloadDir } from './matron-files.js';
import { causesForAsk } from './turn-cause.js';

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
  'outside-workdir': 'Refused: path is outside the session workdir and this conversation\'s downloads.',
  'relative-path': 'Refused: could not resolve the path to an absolute location.',
};

// Resolves a session-relative (or absolute) path against the session's
// workdir, guards it (path escape / symlink / sensitive-file protection),
// size-checks it, and uploads it via the injected publisher. Extracted from
// createSendAttachmentHandler so the items tools (which need the same
// guarded upload but publish a different event) can reuse it without
// duplicating the security-relevant ordering: guard before any read, size
// check before upload.
//
// Besides the workdir, a path may sit in the session's own download
// directory (lib/matron-files.js sessionDownloadDir): the files the bridge
// itself saved for THIS conversation — chat uploads, item attachments. Those
// live outside the workdir on purpose (never committed), and an agent with no
// file tools (the Coordinator) could not copy one in, so without this it
// could never pass a user's upload on to an item or a room. The directory is
// scoped to the conversation, so another conversation's downloads stay out of
// reach. `downloadDirFor` is injectable for tests.
//
// validateOnly (multi-attachment atomicity): run every local gate and return
// the resolved path WITHOUT uploading, so a caller sending several
// attachments validates them all first and a bad one among them never leaves
// the others' blobs orphaned (retention.js never reaps them).
export async function resolveAndUploadLocalFile({ session, reqPath, publisher, maxBytes = MAX_ATTACHMENT_BYTES, validateOnly = false, downloadDirFor = defaultDownloadDirFor }) {
  const file = await resolveLocalFile({ session, reqPath, downloadDirFor });
  if (!file.ok) return file;
  const { realTarget, realWorkdir, name, size } = file;
  if (size > maxBytes) {
    return { ok: false, status: 413, body: { error: `file too large (${size} bytes; the journal caps attachments at 50 MB)` } };
  }

  const { contentType, isImage } = classifyContentType(name);

  if (validateOnly) {
    return { ok: true, media: { name, size, isImage, absPath: realTarget, workdir: realWorkdir } };
  }

  // Publishes via the injected publisher directly, bypassing index.js's
  // journalPublish upsert-first choke point. Safe today only because every
  // session-spawn path upserts the convo before an agent can reach an MCP
  // tool call — if that invariant ever changes, this needs to route
  // through the same choke point.
  const media = await publisher.uploadMedia({ filePath: realTarget, contentType, name });
  if (!media) {
    return { ok: false, status: 502, body: { error: 'upload failed — journal unreachable, over quota, or rejected the file' } };
  }

  return {
    ok: true,
    media: {
      blob_ref: media.media_id,
      mime: media.content_type || contentType,
      name,
      size: media.size ?? size,
      isImage,
      // Resolved absolute path (already gated within workdir + non-sensitive above), so callers can
      // mint a Files deep link for it without re-resolving an untrusted argument.
      absPath: realTarget,
      // The realpath'd workdir the gate used — the containment boundary a deep link must re-check.
      workdir: realWorkdir,
    },
  };
}

// The guard half of resolveAndUploadLocalFile, shared with the room-file
// path (journal transfers): resolve, realpath, gate, stat, non-empty. No
// size cap here — each caller has its own.
// -> {ok:true, realTarget, realWorkdir, name, size, mtimeMs} | {ok:false, status, body}
export async function resolveLocalFile({ session, reqPath, downloadDirFor = defaultDownloadDirFor }) {
  // Fail closed: a session with no workdir has no containment boundary at
  // all, which would otherwise let it send any absolute non-sensitive path
  // on the box. This also covers the relative-path-with-no-workdir case,
  // since a relative path can't be resolved without one either.
  const absWorkdir = session?.workdir ? path.resolve(session.workdir) : null;
  if (!absWorkdir) {
    return { ok: false, status: 400, body: { error: 'session has no working directory — cannot send attachments' } };
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
    return { ok: false, status: 404, body: { error: `file not found: ${absTarget}` } };
  }
  // tmpdir (and other paths) can themselves be symlinks (e.g. macOS
  // /var -> /private/var), so resolve the workdir the same way before
  // comparing — otherwise a real, in-bounds file can look "outside" the
  // workdir purely because one side was resolved and the other wasn't.
  const realWorkdir = absWorkdir ? await realpath(absWorkdir).catch(() => absWorkdir) : null;

  let gate = checkFileLink(realTarget, realWorkdir);
  if (!gate.ok && gate.reason === 'outside-workdir') {
    // Second root, same guard (the sensitive-file check runs again). The
    // download dir is resolved too, so a symlinked root compares like the
    // workdir does; a symlink INSIDE it was already followed by realpath
    // above, so it can only pass if its target is in one of the two roots.
    const downloadDir = downloadDirFor(session);
    const realDownloadDir = downloadDir ? await realpath(downloadDir).catch(() => null) : null;
    if (realDownloadDir) {
      const viaDownloads = checkFileLink(realTarget, realDownloadDir);
      if (viaDownloads.ok || viaDownloads.reason !== 'outside-workdir') gate = viaDownloads;
    }
  }
  if (!gate.ok) return { ok: false, status: 403, body: { error: GUARD_ERRORS[gate.reason] || `Refused: ${gate.reason}` } };

  let info;
  try {
    info = await stat(realTarget);
  } catch {
    return { ok: false, status: 404, body: { error: `file not found: ${realTarget}` } };
  }
  if (!info.isFile()) return { ok: false, status: 400, body: { error: `not a regular file: ${realTarget}` } };

  const name = path.basename(realTarget);
  if (info.size === 0) return { ok: false, status: 400, body: { error: `file is empty: ${name}` } };
  return { ok: true, realTarget, realWorkdir, name, size: info.size, mtimeMs: info.mtimeMs };
}

// Never creates the directory: a guard has no business making folders, and
// one that does not exist yet holds nothing to attach.
function defaultDownloadDirFor(session) {
  return sessionDownloadDir(session, { mkdir: false });
}

// Room files go through journal transfers (lib/transfer-sender.js), capped
// per file at MATRON_TRANSFER_MAX_BYTES (index.js passes it in).
export const DEFAULT_TRANSFER_MAX_BYTES = 10737418240;
const PERSON_ROOM_ERROR = "files do not cross into rooms with another person's agent";
const PENDING_APPROVAL_NOTE = 'The user has an approval card for this file. It uploads in the background and reaches the other session after approval. Do not wait or resend; the outcome arrives in the room.';

// A room with another person's agent: the owner side records `person` on
// the room (lib/agent-chat.js startTalk / chatStart). index.js passes a
// predicate that also knows the guest side (the journal's person-room row).
const defaultIsPersonRoom = (_id, room) => typeof room?.person === 'string' && room.person !== '';

// HTTP-agnostic so it is fully unit-testable; index.js mounts it as a thin
// adapter on the loopback API server. Same shape as the other loopback
// routes: takes the parsed POST body, returns {status, body}.
//
// With chat_room_id the file does NOT go up as a media blob: it becomes a
// journal transfer (an approval card for the user, chunked upload in the
// background), started through `sender` and answered at once with
// status 'pending_approval'. The receiving bridge delivers it, the
// same-bridge case included, so there is no local hop here.
export function createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor, rooms = null, sender = null, isPersonRoom = defaultIsPersonRoom, maxBytes = MAX_ATTACHMENT_BYTES, transferMaxBytes = DEFAULT_TRANSFER_MAX_BYTES, downloadDirFor = defaultDownloadDirFor, webBaseUrl = '' }) {
  return async function handleSendAttachment(data) {
    const { roomId, path: reqPath, caption, chat_room_id: chatRoomId } = data || {};
    if (!roomId || typeof roomId !== 'string' || !reqPath || typeof reqPath !== 'string') {
      return { status: 400, body: { error: 'roomId and path are required' } };
    }

    const session = sessions.get(roomId);
    if (!session) return { status: 404, body: { error: `no active session for chat ${roomId}` } };

    if (chatRoomId !== undefined) return sendIntoRoom({ session, sessionKey: roomId, chatRoomId, reqPath, caption });

    const convoId = journalConvoIdFor(session);
    if (!convoId) return { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } };

    const up = await resolveAndUploadLocalFile({ session, reqPath, publisher, maxBytes, downloadDirFor });
    if (!up.ok) return { status: up.status, body: up.body };
    const { blob_ref, mime, name, size, isImage, absPath, workdir } = up.media;

    const payload = { blob_ref, content_type: mime, name, size };
    // Append a Files deep link so the operator can open the doc in the browsable web Files tab
    // instead of hunting a raw path. Null when WEB_BASE_URL is unset or the target is out-of-root /
    // sensitive (the latter cannot happen here — such a file was already refused above) → caption
    // stays exactly what the agent passed (plain-path fallback).
    const deepLink = buildFilesDeepLink(absPath, workdir, webBaseUrl);
    const finalCaption = appendFilesDeepLink(caption, deepLink, name);
    if (finalCaption) payload.caption = finalCaption;

    if (isImage) publisher.publishImage(convoId, payload);
    else publisher.publishFile(convoId, payload);

    return { status: 200, body: { ok: true, kind: isImage ? 'image' : 'file', name, size } };
  };

  async function sendIntoRoom({ session, sessionKey, chatRoomId, reqPath, caption }) {
    // The SAME shared gate as agent_chat_send (lib/agent-chat.js
    // roomAccessError, mode 'send'), so the posting rules can never drift
    // between the two surfaces.
    if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'chat_room_id must be a room id string' } };
    const gateErr = roomAccessError(rooms, chatRoomId, sessionKey);
    if (gateErr) return gateErr;
    // The transfer names its session and turn causes, as an agent_chat_send
    // does (lib/agent-chat.js provenance), and the journal shows them on the
    // card — read now, before the first await, so a turn that begins
    // meanwhile is not credited with an ask it did not make.
    const causes = causesForAsk(session);
    // Before the file is even looked at: nothing is read or sent for a
    // person room (the journal refuses one too, 403 person_room).
    let person;
    try { person = await isPersonRoom(chatRoomId, rooms.get(chatRoomId)); } catch { person = false; }
    if (person) return { status: 403, body: { error: PERSON_ROOM_ERROR } };
    // The transfer is "from" this session's own journal conversation (the
    // card names it); the journal 404s anything this device does not own.
    const fromConvoId = journalConvoIdFor(session);
    if (!fromConvoId) return { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } };
    if (!sender) return { status: 503, body: { error: 'file transfers into rooms are not available on this bridge' } };

    const file = await resolveLocalFile({ session, reqPath, downloadDirFor });
    if (!file.ok) return { status: file.status, body: file.body };
    const { realTarget, name, size, mtimeMs } = file;
    // The journal refuses a name with a backslash (it reads as a path on
    // some systems); say so here rather than fail the transfer later.
    if (name.includes('\\')) {
      return { status: 400, body: { error: `the file name "${name}" contains a backslash, which room files cannot have; rename the file (or copy it) without backslashes and send that` } };
    }
    if (size > transferMaxBytes) {
      return { status: 413, body: { error: `file too large (${size} bytes; room files are capped at ${humanCap(transferMaxBytes)})` } };
    }
    const { contentType } = classifyContentType(name);
    sender.start({ sessionKey, roomId: chatRoomId, fromConvoId, absPath: realTarget, name, size, mtimeMs, contentType, caption: caption || null, causes });
    return { status: 200, body: { ok: true, status: 'pending_approval', name, size, note: PENDING_APPROVAL_NOTE } };
  }
}

function humanCap(bytes) {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 && Number.isInteger(gb) ? `${gb} GB` : `${bytes} bytes`;
}
