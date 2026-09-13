#!/usr/bin/env node
// Interactive first-run setup: asks for the handful of values the bridge
// can't guess (journal URL, agent token, allowed user), tests the journal
// connection with a real hello handshake, and writes .env. Everything else
// keeps the .env.example defaults. Re-running is safe: existing answers
// become the defaults and the old .env is backed up first.
//
// Run with: npm run setup

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = path.join(REPO_DIR, '.env');
const EXAMPLE_PATH = path.join(REPO_DIR, '.env.example');
const TOKEN_PATH = path.join(REPO_DIR, '.journal-token');

let rl;

// Empty answers (or all-whitespace ones) keep the previous default, so every
// prompt behaves the same on Enter.
export function resolveAnswer(answer, def) {
  return answer.trim() || def || '';
}

// Prompts whose empty value is meaningful (the allowlist) can't be cleared by
// pressing Enter — that keeps the default. '-' is the documented sentinel for
// "clear this and go back to the empty value".
export function clearableAnswer(value) {
  return value === '-' ? '' : value;
}

// Any URL stored in .env is the user's real configuration — including the
// documented local default from .env.example — so it always pre-fills on
// re-run. First runs have no .env and correctly get no default.
export function previousJournalUrl(existing) {
  return existing.JOURNAL_WS_URL || '';
}

function ask(question, def) {
  const suffix = def ? ` [${def}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(resolveAnswer(answer, def));
    });
  });
}

// Hidden input for the token: readline's output is intercepted so the raw
// value is never echoed — the line always renders as the prompt plus stars.
function askHidden(question) {
  return new Promise((resolve) => {
    const orig = rl._writeToOutput;
    rl._writeToOutput = () => {
      process.stdout.write(`\x1b[2K\r${question}: ${'*'.repeat(rl.line.length)}`);
    };
    rl.question(`${question}: `, (answer) => {
      rl._writeToOutput = orig;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function askYesNo(question, defYes) {
  const def = defYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} (${def})`)).toLowerCase();
  if (!answer) return defYes;
  return answer.startsWith('y');
}

// Read a file that may legitimately not exist yet (a first run has no .env).
// Reading and handling ENOENT avoids the existsSync-then-read race.
function readIfExists(p) {
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

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
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

// One live-only hello against the journal: proves the URL resolves, TLS
// works, and the token is a valid agent token. Resolves to the agent name
// on success, throws with a readable reason otherwise.
function testConnection(url, token) {
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

async function main() {
  // Both ends must be a TTY: readline only masks askHidden's keystrokes in
  // terminal mode, which follows stdout, so a redirected stdout would echo
  // the token in cleartext even with an interactive stdin.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('setup/wizard.mjs needs an interactive terminal (stdin and stdout).');
    console.error('For non-interactive installs, copy .env.example to .env and edit it.');
    process.exit(1);
  }

  // historySize 0: readline keeps every answer in its up-arrow history, which
  // would let a later prompt in the same run recall the token askHidden hid.
  rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 0, terminal: true });

  console.log('');
  console.log('=== Matron Bridge setup ===');
  console.log('');
  console.log('You need a running matron-journal server and an agent token for this');
  console.log('machine (create one there with: node bin/matron-admin agent add <name>).');
  console.log('');

  const existing = parseEnv(readIfExists(ENV_PATH));
  const example = fs.readFileSync(EXAMPLE_PATH, 'utf8');

  // --- journal URL ---
  let journalUrl;
  for (;;) {
    const raw = await ask('Journal server URL (e.g. https://journal.example.com)', previousJournalUrl(existing));
    if (!raw) { console.log('The journal URL is required — the bridge cannot start without it.'); continue; }
    const url = normalizeJournalUrl(raw);
    if (!url) { console.log(`Could not parse ${JSON.stringify(raw)} as a URL — try again.`); continue; }
    if (url.protocol === 'ws:' && !isLocalHost(url.hostname)) {
      const upgrade = await askYesNo(`${url.host} is remote; plain ws:// sends the token in cleartext. Use wss:// instead?`, true);
      if (upgrade) url.protocol = 'wss:';
    }
    journalUrl = url.toString();
    break;
  }

  // --- agent token ---
  let token = '';
  const haveStoredToken = existing.JOURNAL_TOKEN_FILE && fs.existsSync(existing.JOURNAL_TOKEN_FILE);
  if (haveStoredToken) {
    const keep = await askYesNo(`Keep the agent token already stored in ${existing.JOURNAL_TOKEN_FILE}?`, true);
    if (keep) token = fs.readFileSync(existing.JOURNAL_TOKEN_FILE, 'utf8').trim();
  }
  while (!token) {
    token = await askHidden('Agent token (input hidden)');
    if (!token) console.log('The agent token is required — the bridge cannot start without it.');
  }

  // --- connection test ---
  process.stdout.write(`Testing ${journalUrl} ... `);
  let tested = false;
  try {
    const name = await testConnection(journalUrl, token);
    console.log(`ok — connected as agent "${name}"`);
    tested = true;
  } catch (err) {
    console.log('failed');
    console.log(`  ${err.message}`);
    if (/self.signed|unable to verify|certificate/i.test(String(err.message))) {
      console.log('  (self-signed TLS? the journal must present a certificate this machine trusts)');
    }
    const anyway = await askYesNo('Save this configuration anyway?', false);
    if (!anyway) { rl.close(); process.exit(1); }
  }

  // --- the rest ---
  console.log('');
  const prevAllowed = existing.ALLOWED_USER_IDS || '';
  const allowedPrompt = prevAllowed
    ? "Your Matron username (the user created with matron-admin; enter '-' to clear so any user is allowed)"
    : 'Your Matron username (the user created with matron-admin; empty allows any user)';
  const allowed = clearableAnswer(await ask(allowedPrompt, prevAllowed));
  const agent = (await ask('Default coding agent, claude or codex', existing.MATRON_DEFAULT_AGENT || 'claude'))
    .toLowerCase() === 'codex' ? 'codex' : 'claude';
  const workdir = await ask('Default working directory for new sessions', existing.DEFAULT_WORKDIR || '~/');
  const hmac = existing.HMAC_SECRET || randomBytes(32).toString('hex');

  // --- write files ---
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);

  const owned = {
    JOURNAL_WS_URL: journalUrl,
    JOURNAL_TOKEN_FILE: TOKEN_PATH,
    JOURNAL_TOKEN: '',
    ALLOWED_USER_IDS: allowed,
    MATRON_DEFAULT_AGENT: agent,
    DEFAULT_WORKDIR: workdir,
    HMAC_SECRET: hmac,
  };

  const env = buildEnv(example, existing, owned);

  // Copy and handle ENOENT rather than existsSync-then-copy: the check-then-
  // act pair is a race (CodeQL js/file-system-race), and "no previous .env"
  // is the only outcome the check was guarding.
  try {
    fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
    console.log(`(previous .env backed up to .env.bak)`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  console.log('');
  console.log(`Wrote ${ENV_PATH}`);
  console.log(`Agent token stored in ${TOKEN_PATH} (mode 600, gitignored)`);
  if (!tested) console.log('Note: the connection test failed — fix the URL/token and re-run npm run setup.');
  console.log('');
  console.log('Next steps:');
  console.log('  npm start                     # run the bridge in this terminal');
  console.log('  sudo bash setup/service.sh    # or install it as an always-on service');
  console.log('');
  rl.close();
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) await main();
