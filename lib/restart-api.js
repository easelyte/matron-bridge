// Loopback `POST /restart`: ask the bridge for a planned restart. The request
// is only recorded; the gate (lib/planned-restart.js) decides when the bridge
// exits, and nothing in this route can force that.
//
// The route is gated by a per-boot capability token in a file only the
// bridge's user can read (the pattern of lib/shutdown-endpoint.js and the
// journal read proxy). That stops stray HTTP from other users and processes on
// the box; it does not stop an agent running as the same user, so who may
// call it is the deployment's policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicWriteFileSync } from './atomic-write.js';

export const RESTART_TOKEN_HEADER = 'x-matron-restart-token';
const TOKEN_RE = /^[a-f0-9]{64}$/;
export const MAX_BODY_BYTES = 64 * 1024;

export function restartTokenFile({ homedir = os.homedir } = {}) {
  return path.join(homedir(), '.matron-bridge-restart.env');
}

const tokenFileText = (token, port) => `MATRON_RESTART_TOKEN=${token}\nMATRON_BRIDGE_API_PORT=${port}\n`;

// Mint a token and write it with the API port. Returns { token, file }, or null
// when the file cannot be written (the route then stays closed).
export function installRestartToken({
  file = restartTokenFile(), port, random = () => randomBytes(32).toString('hex'),
  write = (target, data) => atomicWriteFileSync(target, data, { mode: 0o600 }),
} = {}) {
  const token = random();
  try { write(file, tokenFileText(token, port)); }
  catch { return null; }
  return { token, file, port };
}

// Remove the file at exit, but only if it is still ours: a newer bridge may
// have replaced it.
export function removeRestartToken({ token, file, port }, { readFile = f => fs.readFileSync(f, 'utf8'), unlink = fs.unlinkSync } = {}) {
  try {
    if (readFile(file) === tokenFileText(token, port)) unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Decide a request: { status, body }. `body` is the parsed JSON object.
export function decideRestartRequest({ headers = {}, token, body, stateStore, makeKey = randomUUID }) {
  const presented = headers[RESTART_TOKEN_HEADER];
  if (!token || typeof presented !== 'string' || !TOKEN_RE.test(presented)
    || !timingSafeEqual(Buffer.from(presented), Buffer.from(token))) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const data = body ?? {};
  if (!object(data) || typeof data.reason !== 'string' || !data.reason.trim()
    || (data.sha !== undefined && (typeof data.sha !== 'string' || !data.sha || data.sha.startsWith('-')))
    || (data.request_key !== undefined && (typeof data.request_key !== 'string' || !data.request_key))) {
    return { status: 400, body: { error: 'Invalid restart request' } };
  }
  try {
    const result = stateStore.addRequest({
      reason: data.reason.trim().slice(0, 500),
      ...(data.sha === undefined ? {} : { sha: data.sha }),
      request_key: data.request_key ?? makeKey(),
    });
    if (result.busy) return { status: 503, body: { error: 'restarting', id: result.id } };
    return { status: 200, body: result };
  } catch {
    // Fixed text: filesystem details stay out of the response. Not 503, which
    // means "restarting, retry after back"; a failed write is not that.
    return { status: 500, body: { error: 'restart state unavailable' } };
  }
}
