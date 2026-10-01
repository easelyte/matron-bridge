// Graceful shutdown over loopback HTTP, for platforms with no SIGTERM.
//
// On Linux and macOS the service manager stops the bridge with SIGTERM and
// index.js's handler kills every session and flushes the journal outbox
// before exiting. Windows has nothing equivalent for a hidden background
// process: Stop-ScheduledTask and Stop-Process are TerminateProcess, no
// handler runs, the claude trees are orphaned and the outbox is left to the
// next boot's reconciliation. So on win32 the bridge also accepts
// `POST /shutdown` on its loopback API and runs the same gracefulShutdown.
//
// The route is gated by a per-boot token written to a file only the bridge's
// user can read (the same capability-file pattern as the journal read proxy
// header), so a stray POST from a session's tool call cannot take the box's
// bridge down; restart.ps1 reads the file. Registered on win32 only: POSIX
// keeps signals as the one shutdown path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SHUTDOWN_TOKEN_HEADER = 'x-matron-shutdown-token';

// Bridge-owned state on Windows (logs, the shutdown token) lives under
// %LOCALAPPDATA%\matron-bridge, the per-user non-roaming app-data dir.
export function bridgeStateDir({ env = process.env, homedir = os.homedir } = {}) {
  const base = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(base, 'matron-bridge');
}

export function shutdownTokenPath(opts = {}) {
  return path.join(bridgeStateDir(opts), 'shutdown.token');
}

// Mint the token and write it. Returns { token, file } or null (with a
// warning) when the file cannot be written — the route then stays closed.
export function installShutdownToken({
  file = shutdownTokenPath(),
  mkdir = (d) => fs.mkdirSync(d, { recursive: true }),
  writeFile = (f, data) => fs.writeFileSync(f, data, { mode: 0o600 }),
  random = () => randomBytes(32).toString('hex'),
  warn = (m) => console.warn(m),
} = {}) {
  const token = random();
  try {
    mkdir(path.dirname(file));
    writeFile(file, `${token}\n`);
    return { token, file };
  } catch (e) {
    warn(`[shutdown] could not write the shutdown token file ${file}: ${e?.message ?? e}. POST /shutdown is disabled.`);
    return null;
  }
}

// Decide a POST /shutdown: { status, body, shutdown } — `shutdown` is true
// only for an accepted request. Constant-time compare so the token cannot be
// guessed byte by byte.
export function decideShutdown({ headers = {}, token } = {}) {
  if (!token) return { status: 503, body: { error: 'shutdown endpoint disabled' }, shutdown: false };
  const presented = String(headers[SHUTDOWN_TOKEN_HEADER] ?? '').trim();
  if (!presented || presented.length !== token.length || !timingSafeEqualStr(presented, token)) {
    return { status: 403, body: { error: 'bad shutdown token' }, shutdown: false };
  }
  return { status: 202, body: { ok: true, shutting_down: true }, shutdown: true };
}

function timingSafeEqualStr(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
