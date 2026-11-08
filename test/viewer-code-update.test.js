import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startViewerCodeUpdateWatcher, viewerPreflight } from '../viewer/code-update.js';
import { RESTART_EXIT_CODE } from '../lib/code-update-restart.js';

// The viewer follows the bridge onto new code. Without this, an update that
// changes the viewer→bridge contract (the viewer key) leaves the old viewer
// talking to the new bridge, and every secret form and one-time link fails
// with 401 until the machine reboots.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const dirs = [];

function checkout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-cu-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.git', 'logs'), { recursive: true });
  writeReflog(dir, lines);
  return dir;
}

function writeReflog(dir, lines) {
  const text = lines.map(([from, to, ts]) => `${from} ${to} alice <alice@example.com> ${ts} +0000\tmerge`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.git', 'logs', 'HEAD'), text);
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function harness(dir, env = {}) {
  let tick = null;
  const exit = vi.fn();
  const close = vi.fn();
  const preflight = vi.fn(async () => ({ ok: true }));
  const logs = [];
  const timer = startViewerCodeUpdateWatcher({
    checkoutDir: dir,
    httpServer: { close },
    env: { MATRON_CODE_UPDATE_SETTLE_MS: '1', ...env },
    exit,
    preflight,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; },
  });
  return { timer, exit, close, preflight, logs, tick: async () => { tick(); await new Promise(r => setTimeout(r, 20)); } };
}

describe('viewer restart onto new code', () => {
  it('stays put while HEAD is where it booted', async () => {
    const dir = checkout([['0'.repeat(40), SHA_A, 1000]]);
    const h = harness(dir);
    await h.tick();
    expect(h.preflight).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('closes the server and exits non-zero once new code has landed and passes its preflight', async () => {
    const dir = checkout([['0'.repeat(40), SHA_A, 1000]]);
    const h = harness(dir);
    writeReflog(dir, [['0'.repeat(40), SHA_A, 1000], [SHA_A, SHA_B, 2000]]);
    await h.tick();
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).not.toBe(0);
  });

  it('does not exit onto a tree whose preflight fails', async () => {
    const dir = checkout([['0'.repeat(40), SHA_A, 1000]]);
    const h = harness(dir);
    h.preflight.mockResolvedValue({ ok: false, error: 'boom' });
    writeReflog(dir, [['0'.repeat(40), SHA_A, 1000], [SHA_A, SHA_B, 2000]]);
    await h.tick();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).toMatch(/\[viewer code-update\].*failed its preflight/);
  });

  it('waits for a fresh update to settle', async () => {
    const dir = checkout([['0'.repeat(40), SHA_A, 1000]]);
    const h = harness(dir, { MATRON_CODE_UPDATE_SETTLE_MS: '600000' });
    writeReflog(dir, [['0'.repeat(40), SHA_A, 1000], [SHA_A, SHA_B, Math.floor(Date.now() / 1000)]]);
    await h.tick();
    expect(h.preflight).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('is off with MATRON_CODE_UPDATE_RESTART=0, or without a reflog', () => {
    const dir = checkout([['0'.repeat(40), SHA_A, 1000]]);
    expect(harness(dir, { MATRON_CODE_UPDATE_RESTART: '0' }).timer).toBeNull();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-cu-'));
    dirs.push(bare);
    expect(harness(bare).timer).toBeNull();
  });

  it('start.js starts the watcher on the server it started, from the repository root', () => {
    const start = fs.readFileSync(new URL('../viewer/start.js', import.meta.url), 'utf8');
    expect(start).toMatch(/const httpServer = startServer\(\);/);
    expect(start).toMatch(/startViewerCodeUpdateWatcher\(\{\n\s*checkoutDir: path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\),\n\s*httpServer,/);
  });
});

describe('viewerPreflight', () => {
  it('loads the viewer module from the checkout', async () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    expect(await viewerPreflight(repo)).toEqual({ ok: true });
  });

  it('reports a tree that cannot load it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-cu-'));
    dirs.push(dir);
    const r = await viewerPreflight(dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^viewer import:/);
  });
});
