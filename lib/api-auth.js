// Who is calling the bridge's loopback API.
//
// The API listens on 127.0.0.1, which any local account can reach, and most
// routes name the session they act for in the request body (`roomId`, or
// `session_id` for the hooks). So the name alone proves nothing: each session
// gets a random token of its own, and a request that names a session must
// carry that session's token. Another account on the machine cannot act as
// any session, and a session's tools cannot name another session (the
// Coordinator included) by mistake or because a prompt told them to. It is
// not a wall between sessions of the same OS user: code running as that
// user can read every session's file, as it can read the bridge's memory.
//
// Children get the token the way they get the journal read-proxy capability:
// as a 0600 header FILE in a private directory, never as an env value or an
// argv entry, which other accounts can read from the process table. curl
// reads it with `-H @"$MATRON_BRIDGE_API_HEADER_FILE"`; the Node clients
// read the file and send the header.
//
// Scripts the box's owner runs outside any session (an update script asking
// whether sessions are busy) use the operator token: a per-boot value in an
// owner-only file under the user's state directory, good for listing
// sessions (POST /sessions) and nothing else.
//
// The file viewer is a separate service with no session. It shares the
// bridge's HMAC secret, so it proves itself with a key derived from that
// secret, and it is let through only on the routes it calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_HEADER = 'x-matron-session-token';
export const VIEWER_KEY_HEADER = 'x-matron-viewer-key';
export const SESSION_TOKEN_HEADER_NAME = 'X-Matron-Session-Token';
export const VIEWER_KEY_HEADER_NAME = 'X-Matron-Viewer-Key';
export const OPERATOR_TOKEN_HEADER = 'x-matron-operator-token';
export const OPERATOR_TOKEN_HEADER_NAME = 'X-Matron-Operator-Token';

// Where the operator token file lives: ${XDG_STATE_HOME:-$HOME/.local/state}/
// matron-bridge/api-operator.header (scripts read the same path).
export function operatorHeaderPath(env = process.env, home = os.homedir()) {
  const base = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'matron-bridge', 'api-operator.header');
}

// Routes the operator token opens.
export function isOperatorRoute(method, pathname) {
  return method === 'POST' && pathname === '/sessions';
}

// The viewer's key, derived from the HMAC secret both services share.
export function viewerApiKey(hmacSecret) {
  if (typeof hmacSecret !== 'string' || !hmacSecret) return null;
  return createHmac('sha256', hmacSecret).update('matron-bridge-api/viewer').digest('hex');
}

// Routes the viewer calls (viewer/server.js), and only those.
export function isViewerRoute(method, pathname) {
  if (method === 'POST' && (pathname === '/interrupt' || pathname === '/cancel-queued')) return true;
  if (method === 'POST' && /^\/secret\/[^/]+\/submit$/.test(pathname)) return true;
  if (method === 'GET' && /^\/sensitive\/[^/]+$/.test(pathname)) return true;
  return false;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function headerValue(headers, name) {
  const v = headers?.[name];
  return typeof v === 'string' ? v.trim() : null;
}

// dir: a private (0700) directory for the header files; null keeps tokens in
// memory only, and ensure() then returns '' (callers get no file).
export function createApiAuth({ dir = null, viewerKey = null, fsImpl = fs } = {}) {
  const byRoom = new Map();
  const byToken = new Map();
  const operatorToken = randomBytes(32).toString('hex');

  // Write the operator token file: the directory made (or tightened to)
  // 0700 and checked to be a real directory of ours, the file written under
  // a fresh name and renamed into place so an existing link is replaced, not
  // followed.
  function writeOperatorFile(file) {
    const d = path.dirname(file);
    fsImpl.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = fsImpl.lstatSync(d);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('operator token directory is not a directory');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('operator token directory is not ours');
    try { fsImpl.chmodSync(d, 0o700); } catch { /* best effort (Windows) */ }
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    fsImpl.writeFileSync(tmp, `${OPERATOR_TOKEN_HEADER_NAME}: ${operatorToken}\n`, { mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(tmp, file);
    return file;
  }

  function fileFor(roomId) {
    const name = createHash('sha256').update(String(roomId)).digest('hex').slice(0, 32);
    return path.join(dir, `${name}.header`);
  }

  // The session's header file, written on first use. The token stays the
  // same for the life of this bridge process, so a respawned child (a
  // restart, a model switch) keeps working.
  function ensure(roomId) {
    if (typeof roomId !== 'string' || !roomId) return '';
    let entry = byRoom.get(roomId);
    if (!entry) {
      const token = randomBytes(32).toString('hex');
      entry = { token, file: '' };
      byRoom.set(roomId, entry);
      byToken.set(token, roomId);
    }
    if (dir && !entry.file) {
      const file = fileFor(roomId);
      fsImpl.writeFileSync(file, `${SESSION_TOKEN_HEADER_NAME}: ${entry.token}\n`, { mode: 0o600 });
      entry.file = file;
    }
    return entry.file;
  }

  function tokenFor(roomId) {
    return byRoom.get(roomId)?.token ?? null;
  }

  // {kind:'session', roomId} | {kind:'operator'} | {kind:'viewer'} | null.
  function caller(headers) {
    const token = headerValue(headers, SESSION_TOKEN_HEADER);
    if (token) {
      const roomId = byToken.get(token);
      // A Map lookup by the presented value; compare once more in constant
      // time so the answer does not hinge on string equality shortcuts.
      if (roomId && sameSecret(token, byRoom.get(roomId)?.token)) return { kind: 'session', roomId };
    }
    const op = headerValue(headers, OPERATOR_TOKEN_HEADER);
    if (op && sameSecret(op, operatorToken)) return { kind: 'operator' };
    const key = headerValue(headers, VIEWER_KEY_HEADER);
    if (key && viewerKey && sameSecret(key, viewerKey)) return { kind: 'viewer' };
    return null;
  }

  // Remove the file only if it still holds this process's token: another
  // bridge may have written its own since.
  function removeOperatorFile(file) {
    let text;
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch { return false; }
    if (!text.includes(operatorToken)) return false;
    fsImpl.rmSync(file, { force: true });
    return true;
  }

  return { ensure, tokenFor, caller, writeOperatorFile, removeOperatorFile };
}

// The decision for one request. namedRoomId is the session the request acts
// for (from its body or query), or null when it names none. Returns null to
// let it through, or {status, error}.
export function apiAuthRefusal({ caller, method, pathname, namedRoomId = null }) {
  if (!caller) return { status: 401, error: 'Missing or unknown bridge session token' };
  if (caller.kind === 'viewer') {
    return isViewerRoute(method, pathname) ? null : { status: 403, error: 'Not a viewer route' };
  }
  if (caller.kind === 'operator') {
    return isOperatorRoute(method, pathname) ? null : { status: 403, error: 'The operator token only lists sessions' };
  }
  if (namedRoomId !== null && namedRoomId !== caller.roomId) {
    return { status: 403, error: 'This session token belongs to another session' };
  }
  return null;
}

// The session a request acts for: by roomId (most routes), by the hook's room
// query (/foreign-check), or by Claude session id (the Stop, PreCompact and
// plan hooks). Null when it names none, or names a Claude session no live
// session has (those routes do nothing then). A request whose fields name
// two different sessions gets a name no token matches.
export const NAMES_CONFLICT = '\u0000conflicting-sessions';
export function namedSessionRoom({ roomQuery = null, data = null, roomForClaudeSession = () => null } = {}) {
  const named = new Set();
  if (typeof roomQuery === 'string' && roomQuery) named.add(roomQuery);
  if (typeof data?.roomId === 'string') named.add(data.roomId);
  if (typeof data?.session_id === 'string' && data.session_id) {
    const room = roomForClaudeSession(data.session_id);
    if (room) named.add(room);
  }
  if (named.size > 1) return NAMES_CONFLICT;
  return named.size ? [...named][0] : null;
}
