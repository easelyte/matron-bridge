// The viewer's entry point reads `.env` from its working directory, as the
// bridge's does. A supervisor that passes no environment (the Windows
// Scheduled Task) relies on it; one that does (a systemd EnvironmentFile, a
// launchd plist) keeps the values it passed.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'start.js');
const SETTINGS = ['HMAC_SECRET', 'MATRON_VIEWER_PORT', 'MATRIX_VIEWER_PORT', 'MATRON_CODE_UPDATE_RESTART'];

const children = [];
const dirs = [];
afterEach(async () => {
  // Wait for each viewer to exit before removing its working directory:
  // Windows refuses to remove a directory a live process still has as its cwd.
  await Promise.all(children.splice(0).map((c) => new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('close', resolve);
    c.kill();
  })));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Run viewer/start.js in a directory holding `dotenv` as its `.env`. Resolves
// once the viewer listens or exits: { listening, code, out }.
function startViewer(dotenv, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-start-env-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), dotenv);
  const env = { ...process.env };
  for (const k of SETTINGS) delete env[k];
  const child = spawn(process.execPath, [START], {
    cwd: dir, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      if (/listening on 127\.0\.0\.1:\d+/.test(out)) resolve({ listening: true, code: null, out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => resolve({ listening: false, code, out }));
  });
}

describe('viewer/start.js', () => {
  it('starts with the settings in .env when the environment has none', async () => {
    // CRLF line endings: what a Windows editor saves.
    const r = await startViewer('HMAC_SECRET=fixture-secret\r\nMATRON_VIEWER_PORT=0\r\nMATRON_CODE_UPDATE_RESTART=off\r\n');
    expect(r.out).not.toContain('HMAC_SECRET env var is required');
    expect(r.listening).toBe(true);
    expect(r.out).toContain('restart onto new code: OFF (MATRON_CODE_UPDATE_RESTART)');
  }, 30_000);

  it('keeps a value the environment already sets', async () => {
    const r = await startViewer(
      'HMAC_SECRET=fixture-secret\nMATRON_VIEWER_PORT=0\nMATRON_CODE_UPDATE_RESTART=on\n',
      { MATRON_CODE_UPDATE_RESTART: 'off' },
    );
    expect(r.listening).toBe(true);
    expect(r.out).toContain('restart onto new code: OFF (MATRON_CODE_UPDATE_RESTART)');
  }, 30_000);

  it('still refuses to start when neither has HMAC_SECRET', async () => {
    const r = await startViewer('MATRON_VIEWER_PORT=0\n');
    expect(r.listening).toBe(false);
    expect(r.code).toBe(1);
    expect(r.out).toContain('HMAC_SECRET env var is required');
  }, 30_000);
});
