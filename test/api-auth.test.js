import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiAuth, apiAuthRefusal, viewerApiKey, isViewerRoute, namedSessionRoom, NAMES_CONFLICT, operatorHeaderPath } from '../lib/api-auth.js';
import { readApiHeaderFile } from '../lib/api-header-file.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'api-auth-'));

describe('createApiAuth', () => {
  it('writes one owner-only header file per session and keeps the token for the life of the process', () => {
    const dir = tmp();
    try {
      const auth = createApiAuth({ dir });
      const file = auth.ensure('room-a');
      expect(auth.ensure('room-a')).toBe(file);
      expect(auth.ensure('room-b')).not.toBe(file);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
      const headers = readApiHeaderFile(file);
      expect(headers['X-Matron-Session-Token']).toBe(auth.tokenFor('room-a'));
      expect(auth.caller({ 'x-matron-session-token': auth.tokenFor('room-a') })).toEqual({ kind: 'session', roomId: 'room-a' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('knows nobody without a valid token or key', () => {
    const auth = createApiAuth({ viewerKey: viewerApiKey('s3cret') });
    auth.ensure('room-a');
    expect(auth.caller({})).toBe(null);
    expect(auth.caller({ 'x-matron-session-token': 'nope' })).toBe(null);
    expect(auth.caller({ 'x-matron-viewer-key': viewerApiKey('other') })).toBe(null);
    expect(auth.caller({ 'x-matron-viewer-key': viewerApiKey('s3cret') })).toEqual({ kind: 'viewer' });
  });

  it('has no viewer key without an HMAC secret', () => {
    expect(viewerApiKey('')).toBe(null);
    const auth = createApiAuth({ viewerKey: viewerApiKey('') });
    expect(auth.caller({ 'x-matron-viewer-key': '' })).toBe(null);
  });
});

describe('apiAuthRefusal', () => {
  const a = { kind: 'session', roomId: 'room-a' };
  it('refuses a request with no credential', () => {
    expect(apiAuthRefusal({ caller: null, method: 'POST', pathname: '/send', namedRoomId: 'room-a' }).status).toBe(401);
  });
  it('lets a session act for itself, or on a route that names no session', () => {
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/send', namedRoomId: 'room-a' })).toBe(null);
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/sessions', namedRoomId: null })).toBe(null);
  });
  it('refuses a session acting as another', () => {
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/consent/decide', namedRoomId: 'room-coord' }).status).toBe(403);
  });
  it('lets the viewer in only on its own routes', () => {
    const v = { kind: 'viewer' };
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/interrupt', namedRoomId: 'room-a' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/secret/abc/submit' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'GET', pathname: '/sensitive/abc' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/send', namedRoomId: 'room-a' }).status).toBe(403);
    expect(isViewerRoute('GET', '/interrupt')).toBe(false);
  });
});

describe('readApiHeaderFile', () => {
  it('returns {} for a missing, empty or malformed file', () => {
    const dir = tmp();
    try {
      expect(readApiHeaderFile('')).toEqual({});
      expect(readApiHeaderFile(path.join(dir, 'missing'))).toEqual({});
      fs.writeFileSync(path.join(dir, 'bad'), 'not a header');
      expect(readApiHeaderFile(path.join(dir, 'bad'))).toEqual({});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('namedSessionRoom', () => {
  const lookup = (id) => ({ 'sid-a': 'room-a', 'sid-b': 'room-b' })[id] ?? null;
  it('takes the session from roomId, the room query or the Claude session id', () => {
    expect(namedSessionRoom({ data: { roomId: 'room-a' } })).toBe('room-a');
    expect(namedSessionRoom({ roomQuery: 'room-a', data: {} })).toBe('room-a');
    expect(namedSessionRoom({ data: { session_id: 'sid-b' }, roomForClaudeSession: lookup })).toBe('room-b');
    expect(namedSessionRoom({ data: { session_id: 'sid-x' }, roomForClaudeSession: lookup })).toBe(null);
    expect(namedSessionRoom({ data: {} })).toBe(null);
  });
  it('a request naming two sessions matches neither', () => {
    const named = namedSessionRoom({ data: { roomId: 'room-a', session_id: 'sid-b' }, roomForClaudeSession: lookup });
    expect(named).toBe(NAMES_CONFLICT);
    expect(apiAuthRefusal({ caller: { kind: 'session', roomId: 'room-a' }, method: 'POST', pathname: '/turn-end', namedRoomId: named }).status).toBe(403);
    expect(namedSessionRoom({ data: { roomId: 'room-a', session_id: 'sid-a' }, roomForClaudeSession: lookup })).toBe('room-a');
  });
});

describe('operator token', () => {
  it('is written owner-only under the state directory and opens only POST /sessions', () => {
    const base = tmp();
    try {
      const auth = createApiAuth();
      const file = operatorHeaderPath({ XDG_STATE_HOME: base }, '/nowhere');
      expect(file).toBe(path.join(base, 'matron-bridge', 'api-operator.header'));
      auth.writeOperatorFile(file);
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o077).toBe(0);
        expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
      }
      const h = readApiHeaderFile(file);
      const caller = auth.caller(Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])));
      expect(caller).toEqual({ kind: 'operator' });
      expect(apiAuthRefusal({ caller, method: 'POST', pathname: '/sessions' })).toBe(null);
      expect(apiAuthRefusal({ caller, method: 'POST', pathname: '/send', namedRoomId: 'room-a' }).status).toBe(403);
      // A second boot replaces the file rather than writing through it.
      createApiAuth().writeOperatorFile(file);
      expect(auth.caller(Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])))).toEqual({ kind: 'operator' });
      expect(readApiHeaderFile(file)).not.toEqual(h);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('replaces a planted link instead of following it', () => {
    if (process.platform === 'win32') return;
    const base = tmp();
    try {
      const file = operatorHeaderPath({ XDG_STATE_HOME: base });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const victim = path.join(base, 'victim');
      fs.writeFileSync(victim, 'keep');
      fs.symlinkSync(victim, file);
      createApiAuth().writeOperatorFile(file);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe('operator token file ownership', () => {
  it('removes the file only while it holds this process\'s token', () => {
    const base = tmp();
    try {
      const file = operatorHeaderPath({ XDG_STATE_HOME: base });
      const first = createApiAuth();
      const second = createApiAuth();
      first.writeOperatorFile(file);
      second.writeOperatorFile(file);
      expect(first.removeOperatorFile(file)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
      expect(second.removeOperatorFile(file)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
