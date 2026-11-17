import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadBridgePlugins } from '../lib/bridge-plugins.js';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

let home;
let sessionDir;
const warnings = [];
const log = { warn: (m) => warnings.push(m), info: () => {} };

const writePlugin = (dir, file, src, mode = 0o600) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, src, { mode });
  fs.chmodSync(p, mode);
  return p;
};
const okSrc = (name = 'demo', body = 'async () => ({ pong: true })') =>
  `export default () => ({ name: '${name}', handlers: { x_${name}_ping: ${body} } });\n`;
const load = (files, extra = {}) =>
  loadBridgePlugins({ env: { MATRON_BRIDGE_PLUGINS: [].concat(files).join(',') }, forbiddenDirs: [sessionDir], log, ...extra });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-home-'));
  sessionDir = path.join(home, 'work');
  fs.mkdirSync(sessionDir);
  warnings.length = 0;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

// Ownership checks need POSIX uids; on other platforms the loader refuses all.
const posix = typeof process.getuid === 'function';

describe('loadBridgePlugins', () => {
  it('is a no-op when the env is unset or empty', async () => {
    expect(await loadBridgePlugins({ env: {}, log })).toEqual([]);
    expect(await loadBridgePlugins({ env: { MATRON_BRIDGE_PLUGINS: ' , ' }, log })).toEqual([]);
  });

  it.skipIf(!posix)('loads a valid plugin', async () => {
    const file = writePlugin(path.join(home, 'plugins'), 'demo.mjs', okSrc());
    const [p] = await load(file);
    expect(p.name).toBe('demo');
    expect(Object.keys(p.handlers)).toEqual(['x_demo_ping']);
  });

  it('refuses a relative path', async () => {
    writePlugin(path.join(home, 'plugins'), 'demo.mjs', okSrc());
    expect(await load('plugins/demo.mjs')).toEqual([]);
    expect(warnings[0]).toMatch(/not absolute/);
  });

  it.skipIf(!posix)('refuses a file under a session folder, also through a symlink', async () => {
    const inside = writePlugin(path.join(sessionDir, 'sub'), 'demo.mjs', okSrc());
    const link = path.join(home, 'link.mjs');
    fs.symlinkSync(inside, link);
    expect(await load([inside, link])).toEqual([]);
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => /session folder/.test(w))).toBe(true);
  });

  it.skipIf(!posix)('refuses a file the bridge user does not own', async () => {
    const file = writePlugin(path.join(home, 'plugins'), 'demo.mjs', okSrc());
    expect(await load(file, { uid: process.getuid() + 1 })).toEqual([]);
    expect(warnings[0]).toMatch(/not owned/);
  });

  it.skipIf(!posix).each([0o620, 0o602, 0o666])('refuses mode %o', async (mode) => {
    const file = writePlugin(path.join(home, 'plugins'), 'demo.mjs', okSrc(), mode);
    expect(await load(file)).toEqual([]);
    expect(warnings[0]).toMatch(/writable/);
  });

  it.skipIf(!posix)('refuses a file under a group- or world-writable directory', async () => {
    const dir = path.join(home, 'plugins');
    const file = writePlugin(dir, 'demo.mjs', okSrc());
    fs.chmodSync(dir, 0o777);
    expect(await load(file)).toEqual([]);
    expect(warnings[0]).toMatch(/directory .* writable/);
    fs.chmodSync(dir, 0o770);
    expect(await load(file)).toEqual([]);
    fs.chmodSync(dir, 0o755);
    expect((await load(file)).length).toBe(1);
  });

  it.skipIf(!posix)('skips a plugin whose check throws and still loads the next', async () => {
    const a = writePlugin(path.join(home, 'plugins'), 'a.mjs', okSrc('aa'));
    const b = writePlugin(path.join(home, 'plugins'), 'b.mjs', okSrc('bb'));
    const missing = path.join(home, 'plugins', 'gone.mjs');
    const plugins = await load([missing, a, b]);
    expect(plugins.map((p) => p.name)).toEqual(['aa', 'bb']);
    expect(warnings[0]).toMatch(/gone\.mjs/);
  });

  it.skipIf(!posix)('skips a plugin whose import or register() hangs and still loads the next', async () => {
    const dir = path.join(home, 'plugins');
    const slowImport = writePlugin(dir, 'slow-import.mjs', 'await new Promise(() => {});\nexport default () => ({ name: \'si\', handlers: {} });\n');
    const slowRegister = writePlugin(dir, 'slow-register.mjs', 'export default () => new Promise(() => {});\n');
    const ok = writePlugin(dir, 'ok.mjs', okSrc('aa'));
    const plugins = await load([slowImport, slowRegister, ok], { timeoutMs: 100 });
    expect(plugins.map((p) => p.name)).toEqual(['aa']);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/slow-import\.mjs.*import timed out/);
    expect(warnings[1]).toMatch(/slow-register\.mjs.*register\(\) timed out/);
  });

  it.skipIf(!posix)('refuses a method without the x_<plugin>_ prefix', async () => {
    const file = writePlugin(path.join(home, 'plugins'), 'bad.mjs',
      "export default () => ({ name: 'demo', handlers: { start: () => ({}) } });\n");
    expect(await load(file)).toEqual([]);
    expect(warnings[0]).toMatch(/x_demo_/);
  });

  it.skipIf(!posix)('refuses a second plugin with the same name', async () => {
    const a = writePlugin(path.join(home, 'plugins'), 'a.mjs', okSrc());
    const b = writePlugin(path.join(home, 'plugins'), 'b.mjs', okSrc());
    expect((await load([a, b])).length).toBe(1);
  });
});

describe('plugin methods in the RPC handler', () => {
  const answers = [];
  let locked;
  let boxLockOn;
  const make = (handlers, { name = 'demo' } = {}) => createRpcRequestHandler({
    respondRpc: (a) => answers.push(a),
    startSession: () => ({}),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: sessionDir,
    accountLocked: () => locked,
    boxLock: { report: () => ({ on: boxLockOn }), inLockdown: () => false },
    plugins: [{ name, handlers }],
    log,
  });
  const call = (h, method) => h({ request_id: 'r1', from_device_id: 3, method, params: { a: 1 } });
  beforeEach(() => { answers.length = 0; locked = false; boxLockOn = false; });

  it('answers a handler result once and reports the methods', async () => {
    const h = make({ x_demo_ping: async (params) => ({ pong: params.a }) });
    call(h, 'x_demo_ping');
    await new Promise((r) => setTimeout(r, 10));
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ requestId: 'r1', ok: true, result: { pong: 1 } });
    expect(h.plugins).toEqual([{ name: 'demo', methods: ['x_demo_ping'] }]);
  });

  it('answers a sync throw and a rejection with exactly one error', async () => {
    const h = make({ x_demo_a: () => { throw new Error('boom'); }, x_demo_b: async () => { throw new Error('nope'); } });
    call(h, 'x_demo_a');
    call(h, 'x_demo_b');
    await new Promise((r) => setTimeout(r, 10));
    expect(answers).toHaveLength(2);
    expect(answers.every((a) => !a.ok && a.error.code === 'internal')).toBe(true);
  });

  it('refuses a plugin whose method is already a built-in', () => {
    const h = make({ start: () => ({}) });
    expect(h.plugins).toEqual([]);
    expect(warnings.at(-1)).toMatch(/already an RPC method/);
    call(h, 'start');
    expect(answers[0].error.code).not.toBe('internal');
  });

  it('enforces the account lock and the box lock', () => {
    const h = make({ x_demo_ping: () => ({}) });
    locked = true;
    call(h, 'x_demo_ping');
    expect(answers[0].error.code).toBe('account_locked');
    locked = false;
    boxLockOn = true;
    call(h, 'x_demo_ping');
    expect(answers[1].error.code).toBe('box_locked');
    expect(answers).toHaveLength(2);
  });
});
