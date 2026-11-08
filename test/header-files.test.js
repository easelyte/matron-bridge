import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bridgeStateDir, headerRunRoot, createRunDir, sweepDeadRunDirs, writeHeaderFile, healHeaderFile } from '../lib/header-files.js';
import { createApiAuth, operatorHeaderPath } from '../lib/api-auth.js';
import { readApiHeaderFile, apiHeaderFileProblem, explainUnauthorized } from '../lib/api-header-file.js';
import { warnIfNoApiHeaderFile } from '../hooks/hook-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'header-files-'));
const posix = process.platform !== 'win32';

describe('where the header files live', () => {
  it('is the state directory, not the temp folder', () => {
    expect(bridgeStateDir({ XDG_STATE_HOME: '/s' }, '/h')).toBe(path.join('/s', 'matron-bridge'));
    expect(bridgeStateDir({}, '/h')).toBe(path.join('/h', '.local', 'state', 'matron-bridge'));
    expect(headerRunRoot({}, '/h')).toBe(path.join('/h', '.local', 'state', 'matron-bridge', 'run'));
    expect(path.dirname(operatorHeaderPath({}, '/h'))).toBe(bridgeStateDir({}, '/h'));
  });

  it('makes a private per-process directory and sweeps dead processes\' leftovers', () => {
    const base = tmp();
    try {
      const root = path.join(base, 'run');
      fs.mkdirSync(path.join(root, 'bridge-111-aaaaaa'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bridge-111-aaaaaa', 'x.header'), 'X: y\n');
      fs.mkdirSync(path.join(root, 'bridge-222-bbbbbb'));
      fs.mkdirSync(path.join(root, 'something-else'));
      const alive = (pid) => pid === 222;
      const dir = createRunDir(root, { pid: 333, alive });
      expect(path.basename(dir)).toMatch(/^bridge-333-/);
      if (posix) {
        expect(fs.statSync(root).mode & 0o077).toBe(0);
        expect(fs.statSync(dir).mode & 0o077).toBe(0);
      }
      expect(fs.readdirSync(root).sort()).toEqual([path.basename(dir), 'bridge-222-bbbbbb', 'something-else'].sort());
      // Its own directory survives a later sweep by the same process.
      expect(sweepDeadRunDirs(root, { alive: () => false, selfPid: 333 })).toEqual(['bridge-222-bbbbbb']);
      expect(fs.existsSync(dir)).toBe(true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('writes owner-only files and rewrites one only when it is missing', () => {
    const base = tmp();
    try {
      const file = path.join(base, 'd', 'journal-proxy.header');
      writeHeaderFile(file, 'X-Test: abc');
      expect(readApiHeaderFile(file)).toEqual({ 'X-Test': 'abc' });
      if (posix) expect(fs.statSync(file).mode & 0o077).toBe(0);
      expect(healHeaderFile(file, 'X-Test: abc')).toBe(false);
      fs.writeFileSync(file, '');
      expect(healHeaderFile(file, 'X-Test: abc')).toBe(true);
      fs.rmSync(path.join(base, 'd'), { recursive: true });
      expect(healHeaderFile(file, 'X-Test: abc')).toBe(true);
      expect(readApiHeaderFile(file)).toEqual({ 'X-Test': 'abc' });
      expect(healHeaderFile('', 'X-Test: abc')).toBe(false);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['journal-proxy.header']);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe('a session token file that something deleted', () => {
  it('is rewritten with the same token at the next ensure (a respawn)', () => {
    const dir = tmp();
    try {
      const auth = createApiAuth({ dir });
      const file = auth.ensure('room-a');
      const token = auth.tokenFor('room-a');
      fs.rmSync(file);
      expect(auth.ensure('room-a')).toBe(file);
      expect(readApiHeaderFile(file)['X-Matron-Session-Token']).toBe(token);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is rewritten by heal(), even when its directory went too', () => {
    const base = tmp();
    try {
      const dir = path.join(base, 'run');
      fs.mkdirSync(dir);
      const auth = createApiAuth({ dir });
      const a = auth.ensure('room-a');
      const b = auth.ensure('room-b');
      expect(auth.heal()).toEqual([]);
      fs.rmSync(a);
      expect(auth.heal()).toEqual(['room-a']);
      fs.rmSync(dir, { recursive: true });
      expect(auth.heal().sort()).toEqual(['room-a', 'room-b']);
      expect(readApiHeaderFile(a)['X-Matron-Session-Token']).toBe(auth.tokenFor('room-a'));
      expect(readApiHeaderFile(b)['X-Matron-Session-Token']).toBe(auth.tokenFor('room-b'));
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('is rewritten when something emptied it', () => {
    const dir = tmp();
    try {
      const auth = createApiAuth({ dir });
      const file = auth.ensure('room-a');
      fs.writeFileSync(file, '');
      expect(auth.heal()).toEqual(['room-a']);
      fs.writeFileSync(file, 'X-Matron-Session-Token: \n');
      auth.ensure('room-a');
      expect(readApiHeaderFile(file)['X-Matron-Session-Token']).toBe(auth.tokenFor('room-a'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps handing out a known path when a rewrite fails, and none when the first write fails', () => {
    const dir = tmp();
    try {
      let failing = false;
      const fsImpl = { ...fs, writeFileSync: (...a) => { if (failing) throw new Error('disk full'); return fs.writeFileSync(...a); } };
      const auth = createApiAuth({ dir, fsImpl });
      const file = auth.ensure('room-a');
      fs.rmSync(file);
      failing = true;
      expect(auth.ensure('room-a')).toBe(file);
      expect(() => auth.ensure('room-b')).toThrow(/disk full/);
      failing = false;
      expect(auth.heal()).toEqual(['room-a']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('has nothing to heal when tokens stay in memory', () => {
    const auth = createApiAuth();
    expect(auth.ensure('room-a')).toBe('');
    expect(auth.heal()).toEqual([]);
  });
});

describe('a missing token file is a loud, specific error', () => {
  it('names the file and the fix', () => {
    const base = tmp();
    try {
      const file = path.join(base, 'gone.header');
      expect(apiHeaderFileProblem(file)).toMatch(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is missing.*/restart`));
      expect(apiHeaderFileProblem('')).toMatch(/MATRON_BRIDGE_API_HEADER_FILE is not set.*\/restart/);
      fs.writeFileSync(file, 'garbage');
      expect(apiHeaderFileProblem(file)).toMatch(/does not hold a token/);
      fs.writeFileSync(file, 'X-Matron-Session-Token: abc\n');
      expect(apiHeaderFileProblem(file)).toBe(null);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('adds the problem to the bridge\'s 401 and keeps its text', async () => {
    const file = path.join(os.tmpdir(), `no-such-${process.pid}.header`);
    const res = await explainUnauthorized(new Response(JSON.stringify({ error: 'Missing or unknown bridge session token' }), { status: 401 }), file);
    expect(res.status).toBe(401);
    const { error } = await res.json();
    expect(error).toMatch(/^Missing or unknown bridge session token: This session's bridge token file .*no-such-.* is missing\. A \/restart/);
  });

  it('leaves other responses, and 401s with a good file, alone', async () => {
    const ok = new Response('{}', { status: 200 });
    expect(await explainUnauthorized(ok, '')).toBe(ok);
    const base = tmp();
    try {
      const file = path.join(base, 'ok.header');
      fs.writeFileSync(file, 'X-Matron-Session-Token: abc\n');
      const denied = new Response('{"error":"x"}', { status: 401 });
      expect(await explainUnauthorized(denied, file)).toBe(denied);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe('the hooks with a missing token file', () => {
  const run = (script, env, input = '{"session_id":"s"}') => spawnSync('bash', [path.join(__dirname, '..', 'hooks', script)], {
    input, encoding: 'utf8', env: { ...process.env, MATRON_BRIDGE_API_PORT: '1', ...env },
  });
  it.skipIf(!posix)('stop and compact hooks say so on stderr, naming the file', () => {
    for (const script of ['stop-notify.sh', 'compact-notify.sh']) {
      const r = run(script, { MATRON_BRIDGE_API_HEADER_FILE: '/nonexistent/s.header' });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/bridge token file \/nonexistent\/s\.header is missing, unreadable or empty.*401 Missing or unknown bridge session token.*\/restart/);
    }
  });
  it('the Node hooks say so on stderr too', () => {
    const lines = [];
    expect(warnIfNoApiHeaderFile('/nonexistent/s.header', { write: (s) => lines.push(s) })).toMatch(/is missing/);
    expect(lines.join('')).toMatch(/^matron-bridge: .*\/nonexistent\/s\.header is missing.*\/restart.*401/);
  });
});
