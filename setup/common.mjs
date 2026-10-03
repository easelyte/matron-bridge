// Shared by setup/wizard.mjs (npm run setup) and setup/pair.mjs (npm run pair):
// .env parsing/rendering/writing, journal URL normalisation, the live hello
// connection test, and the terminal side of QR agent pairing. Kept free of
// prompts so both entry points drive their own readline.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import qrcode from 'qrcode-terminal';
import { pairAgent, pairHttpBase, PairingError } from '../lib/journal-pairing.js';

export const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENV_PATH = path.join(REPO_DIR, '.env');
export const EXAMPLE_PATH = path.join(REPO_DIR, '.env.example');
export const TOKEN_PATH = path.join(REPO_DIR, '.journal-token');

// Read a file that may legitimately not exist yet (a first run has no .env).
// Reading and handling ENOENT avoids the existsSync-then-read race.
export function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Accepts https://journal.example.com, wss://…/ws, or a bare hostname, and
// normalizes to the wss://host[:port]/ws form the bridge expects.
export function normalizeJournalUrl(input) {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(s)) s = `wss://${s}`;
  s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
  return url;
}

export function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

// The wizard's answers layered over the previous .env, rendered onto the
// .env.example template so comments and unrelated keys survive.
export function buildEnv(example, existing, owned) {
  let env = example;
  const applied = { ...existing, ...owned };
  for (const [key, value] of Object.entries(applied)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    // Function replacement: a string replacement interprets `$&`, `$$`, `$'`
    // and friends inside the value, silently rewriting a secret or path that
    // contains them on every re-run.
    env = re.test(env) ? env.replace(re, () => line) : `${env}${line}\n`;
  }
  return env;
}

// Keep the existing HMAC secret (rotating it would invalidate every link the
// bridge has handed out) or mint one on a first run.
export function hmacSecretFor(existing) {
  return existing.HMAC_SECRET || randomBytes(32).toString('hex');
}

// The .env keys a token setup owns: point the bridge at the token file and
// clear any raw JOURNAL_TOKEN so the two can't disagree.
export function tokenEnv(journalUrl) {
  return { JOURNAL_WS_URL: journalUrl, JOURNAL_TOKEN_FILE: TOKEN_PATH, JOURNAL_TOKEN: '' };
}

// Render `owned` over the previous .env onto the template, back the previous
// .env up to .env.bak, and write the new one mode 0600. Returns whether a
// backup was made.
export function writeEnvFile(existing, owned) {
  const example = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  const env = buildEnv(example, existing, owned);
  // Copy and handle ENOENT rather than existsSync-then-copy: the check-then-
  // act pair is a race (CodeQL js/file-system-race), and "no previous .env"
  // is the only outcome the check was guarding.
  let backedUp = false;
  try {
    fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
    backedUp = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  return backedUp;
}

// The token the bridge would boot with from this .env — same rule as
// index.js resolveJournalToken: a set JOURNAL_TOKEN_FILE wins outright (an
// unreadable file means no token, not a fall-back to JOURNAL_TOKEN).
export function currentToken(existing) {
  if (existing.JOURNAL_TOKEN_FILE) {
    try { return fs.readFileSync(existing.JOURNAL_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
  }
  return (existing.JOURNAL_TOKEN || '').trim();
}

// A token in <repo>/.journal-token that .env doesn't reference: left behind
// when a first-run wizard paired (pairing stores the token immediately) and
// was then interrupted before it wrote .env. Returns TOKEN_PATH when .env
// names no token at all and that file holds one, '' otherwise — so it never
// overrides a JOURNAL_TOKEN_FILE or JOURNAL_TOKEN the operator chose.
export function strandedTokenFile(existing, tokenPath = TOKEN_PATH) {
  if (existing.JOURNAL_TOKEN_FILE || existing.JOURNAL_TOKEN) return '';
  return readIfExists(tokenPath).trim() ? tokenPath : '';
}

// One live-only hello against the journal: proves the URL resolves, TLS
// works, and the token is a valid agent token. Resolves to the agent name
// on success, throws with a readable reason otherwise.
export function testConnection(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already down */ }
      reject(new Error('timed out waiting for the journal to answer'));
    }, 10000);
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch { /* closing */ } fn(arg); };
    ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', token, cursor: null })));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && msg.op === 'hello_ok') done(resolve, msg.name || '(unnamed agent)');
      else if (msg && msg.op === 'error') done(reject, new Error(`journal rejected the hello (${msg.code || 'unknown error'}) — check the agent token`));
    });
    ws.on('close', (code) => done(reject, new Error(`connection closed (code ${code}) — usually a bad or revoked agent token`)));
    ws.on('error', (err) => done(reject, err));
  });
}

function renderQr(uri) {
  let out = '';
  qrcode.generate(uri, { small: true }, (qr) => { out = qr; });
  return out;
}

// Terminal side of QR pairing: prints each code as a QR plus text, waits for
// the app to approve it, and resolves to the agent token (never printed).
// Rejects with AbortError when `signal` fires, PairingError on a journal
// refusal, or a network error from /pair/start.
export async function pairWithApp({ journalUrl, signal, print = console.log, fetch: fetchFn = fetch }) {
  // The claim response carries the agent token: never fetch it in cleartext
  // from anything but this machine.
  const { protocol, hostname } = new URL(journalUrl);
  if (protocol === 'ws:' && !isLocalHost(hostname)) {
    throw new PairingError(`${hostname} is remote; pairing over plain ws:// would send the agent token in cleartext — use https:// or wss://`);
  }
  const httpBase = pairHttpBase(journalUrl);
  const suggested = os.hostname().split('.')[0];
  let waitNoted = false;
  const { token } = await pairAgent({
    httpBase,
    fetch: fetchFn,
    signal,
    onCode: ({ pairCode, uri, expiresInMs }) => {
      waitNoted = false;
      print('');
      print(renderQr(uri));
      print(`Pairing code: ${pairCode}`);
      print('');
      print('In the Matron app: Settings -> Devices -> Add Agent -> Scan QR (or type the code),');
      print(`then name the agent (for example "${suggested}").`);
      print(`Journal: ${httpBase}`);
      print(`The code expires in ${Math.round(expiresInMs / 60000)} minutes. Waiting for approval (Ctrl-C to cancel)...`);
    },
    onExpired: () => {
      print('');
      print('That code expired before it was approved — here is a fresh one.');
    },
    onWait: ({ reason, retryAfterMs }) => {
      // One note per stall, not one per poll.
      if (waitNoted) return;
      waitNoted = true;
      if (reason === 'rate_limited') print(`The journal is rate-limiting pairing requests; retrying in ${Math.ceil(retryAfterMs / 1000)} s...`);
      else print('Lost contact with the journal; still trying...');
    },
  });
  return token;
}
