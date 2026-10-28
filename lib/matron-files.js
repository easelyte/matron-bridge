import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ivUploadDir, sanitizeRoomId } from './iv-uploads.js';

// Root directory for files the user sends from Matron to an SDK-mode session.
// Kept OUTSIDE the session workdir so received files never clutter a
// project/git tree (the iv-mode counterpart is lib/iv-uploads.js, rooted at
// ~/.claude-matrix-uploads, a historical name). Overridable via
// MATRON_FILES_DIR.
export function matronFilesRoot() {
  return process.env.MATRON_FILES_DIR || path.join(os.homedir(), 'matron-files');
}

// Per-project directory under the root, keyed on the workdir's basename so
// the folder name tells you which repo the files belong to. Created on
// demand unless mkdir is false. Sanitization mirrors sanitizeRoomId in
// lib/iv-uploads.js; basename('/') is '' and '.'/'..' would resolve to a
// directory inside path.join, so all three fold into the 'project' fallback.
//
// `conversation` adds one more segment for that conversation's own files:
// ~/matron-files/<repo>/<conversation>/. Sessions that share a repo name
// share the project folder, so the conversation folder is what lets a
// session attach what the bridge saved for it without reaching a sibling's.
export function matronFilesDir(workdir, { mkdir = true, conversation = null } = {}) {
  const base = path.basename(String(workdir || ''));
  const safe =
    base === '' || base === '.' || base === '..'
      ? 'project'
      : base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  let dir = path.join(matronFilesRoot(), safe);
  if (conversation) dir = path.join(dir, conversationSegment(conversation));
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A conversation id as one safe path segment. sanitizeRoomId keeps only
// [A-Za-z0-9_-], so nothing can be '.' or '..'; an id that sanitizes to
// nothing gets a fixed name rather than collapsing into the project folder.
function conversationSegment(conversation) {
  return sanitizeRoomId(conversation) || 'conversation';
}

// Where the bridge saves files it downloads for one session: chat uploads,
// tracker-item attachments and video frames. A PTY (iv) session uses its
// per-room upload dir; every other session gets its own conversation folder
// under ~/matron-files/<repo>/. Returns null for a session with no room id —
// there is no conversation to scope to, and the attachment guard treats null
// as "no extra directory allowed".
export function sessionDownloadDir(session, { mkdir = true } = {}) {
  if (!session?.roomId) return null;
  if (session.iv) return ivUploadDir(session.roomId, { mkdir });
  return matronFilesDir(session.workdir, { mkdir, conversation: session.roomId });
}
