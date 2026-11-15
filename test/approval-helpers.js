// Test helpers for approval keys: sign statements with the throwaway key in
// test/fixtures/approval-vectors.json, and write a pinned keys file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../lib/vendor/approval-verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const vectors = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'approval-vectors.json'), 'utf8'));
export const KEY_ID = vectors.key_id;
// When the fixture's statements were signed.
export const SIGNED_AT = 1790000000000;
export const PINNED = { keys: [{ key_id: vectors.key_id, public_key: vectors.public_key, name: 'test phone' }] };

// The gate needs Unix user ids and file modes; its suites skip on Windows,
// where the bridge refuses to start with a keys file at all.
export const UNIX = process.platform !== 'win32';

export const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

let counter = 0;
// A signed approval over `subject`. Each call gets its own nonce unless one
// is given. `privateKeyPem` signs with another key (a forgery).
export function sign({ type = 'account', subject = {}, journal = 'journal.example', user = 'alice', signedAt = SIGNED_AT, nonce, keyId = KEY_ID, privateKeyPem = vectors.private_key_pem, tap = null } = {}) {
  const st = { v: 1, type, journal, user, key_id: keyId, nonce: nonce ?? `nonce-${++counter}`, signed_at: signedAt, subject, ...(tap || {}) };
  const statement = canonicalize(st);
  const signature = crypto.sign('sha256', Buffer.from(statement, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64url');
  return { statement, signature };
}

export function otherKeyPem() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
}

// A temp directory with a keys file in it, mode 0644. Tests cannot chown, so
// they tell the gate it runs as another uid (`uid`), which makes this file
// "owned by a different user".
export function tempKeys(keys = PINNED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-'));
  const keysFile = path.join(dir, 'approval-keys.json');
  fs.writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o644 });
  fs.chmodSync(keysFile, 0o644);
  return { dir, keysFile, uid: typeof process.getuid === 'function' ? process.getuid() + 1 : 1, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
