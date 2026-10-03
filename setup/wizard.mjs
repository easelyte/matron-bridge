#!/usr/bin/env node
// Interactive first-run setup: asks for the handful of values the bridge
// can't guess (journal URL, agent token, allowed user), tests the journal
// connection with a real hello handshake, and writes .env. The agent token
// comes from QR pairing with the Matron app (default) or is pasted after
// minting it with matron-admin. Everything else
// keeps the .env.example defaults. Re-running is safe: existing answers
// become the defaults and the old .env is backed up first.
//
// Run with: npm run setup

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeTokenFile, PairingError } from '../lib/journal-pairing.js';
import {
  ENV_PATH,
  TOKEN_PATH,
  readIfExists,
  parseEnv,
  buildEnv,
  normalizeJournalUrl,
  isLocalHost,
  tokenEnv,
  strandedTokenFile,
  hmacSecretFor,
  writeEnvFile,
  testConnection,
  pairWithApp,
} from './common.mjs';

// Re-exported: the wizard's unit tests (and anything else that grew up
// importing them from here) keep working after the move to common.mjs.
export { parseEnv, buildEnv, normalizeJournalUrl };

let rl;
// Set while QR pairing is waiting, so Ctrl-C cancels the pairing (back to the
// token menu) instead of quitting the whole wizard.
let pairAbort = null;

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

// Token source menu answer -> 'pair' | 'paste' | null (unrecognised).
// Enter takes the default, pairing.
export function tokenMethod(answer) {
  const a = answer.trim().toLowerCase();
  if (a === '' || a === '1' || a === 'p' || a === 'pair') return 'pair';
  if (a === '2' || a === 'paste' || a === 't' || a === 'token') return 'paste';
  return null;
}

// Pair with the Matron app; resolves to the token, or '' when the user
// cancelled with Ctrl-C or the journal refused (the reason is printed).
async function pairToken(journalUrl) {
  pairAbort = new AbortController();
  try {
    const token = await pairWithApp({ journalUrl, signal: pairAbort.signal });
    // Store it right away: the journal hands the token over exactly once,
    // and a Ctrl-C at a later prompt must not lose a freshly minted agent.
    try {
      writeTokenFile(TOKEN_PATH, token);
    } catch (e) {
      console.log(`\nPaired, but saving the token to ${TOKEN_PATH} failed: ${e.message}`);
      console.log('Revoke the new agent in the Matron app (Settings -> Devices), fix the problem, and pair again.');
      return '';
    }
    console.log('');
    console.log(`Paired. Agent token stored in ${TOKEN_PATH}.`);
    return token;
  } catch (e) {
    if (e.name === 'AbortError') console.log('\nPairing cancelled.');
    else {
      const hint = e instanceof PairingError ? '' : ' (is the journal URL right, and is the server reachable?)';
      console.log(`\nPairing failed: ${e.message}${hint}`);
    }
    return '';
  } finally {
    pairAbort = null;
  }
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
  // In terminal mode readline swallows Ctrl-C itself: cancel a waiting
  // pairing, otherwise quit (without a listener readline would just close,
  // stranding the pairing poll loop with no way to stop it).
  rl.on('SIGINT', () => {
    if (pairAbort) { pairAbort.abort(); return; }
    process.stdout.write('\n');
    rl.close();
    process.exit(130);
  });

  console.log('');
  console.log('=== Matron Bridge setup ===');
  console.log('');
  console.log('You need a running matron-journal server. This machine gets its agent');
  console.log('token by pairing with the Matron app (scan a QR code), or you can paste one');
  console.log('minted on the journal server with: matron-admin agent add <user> <name>.');
  console.log('');

  const existing = parseEnv(readIfExists(ENV_PATH));

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
  // A token paired by an earlier run that was interrupted before .env was
  // written counts as stored too: re-pairing would mint a second agent.
  const storedTokenFile = existing.JOURNAL_TOKEN_FILE || strandedTokenFile(existing);
  if (storedTokenFile && fs.existsSync(storedTokenFile)) {
    const keep = await askYesNo(`Keep the agent token already stored in ${storedTokenFile}?`, true);
    if (keep) token = fs.readFileSync(storedTokenFile, 'utf8').trim();
  }
  while (!token) {
    console.log('How should this machine get its agent token?');
    console.log('  1) Pair with the Matron app — scan a QR code (default)');
    console.log('  2) Paste a token minted with matron-admin');
    const method = tokenMethod(await ask('Choose 1 or 2', '1'));
    if (!method) { console.log('Please answer 1 or 2.'); continue; }
    if (method === 'pair') {
      token = await pairToken(journalUrl);
      continue;
    }
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
  const hmac = hmacSecretFor(existing);

  // --- write files ---
  writeTokenFile(TOKEN_PATH, token);

  const owned = {
    ...tokenEnv(journalUrl),
    ALLOWED_USER_IDS: allowed,
    MATRON_DEFAULT_AGENT: agent,
    DEFAULT_WORKDIR: workdir,
    HMAC_SECRET: hmac,
  };

  if (writeEnvFile(existing, owned)) console.log('(previous .env backed up to .env.bak)');
  console.log('');
  console.log(`Wrote ${ENV_PATH}`);
  console.log(`Agent token stored in ${TOKEN_PATH} (mode 600, gitignored)`);
  if (!tested) console.log('Note: the connection test failed — fix the URL/token and re-run npm run setup.');
  console.log('');
  console.log('Next steps:');
  console.log('  npm start                     # run the bridge in this terminal');
  if (process.platform === 'win32') {
    console.log('  setup\\service.ps1             # or register it to start at logon (Scheduled Task)');
  } else {
    console.log('  sudo bash setup/service.sh    # or install it as an always-on service');
  }
  console.log('');
  rl.close();
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) await main();
