#!/usr/bin/env node
// Pair this bridge with a matron-journal by scanning a QR code in the Matron
// app — no matron-admin, no copy-pasted token. Prints a pairing code as a
// terminal QR plus text, waits for the app to approve it, then stores the
// agent token in <repo>/.journal-token (mode 600) and points .env at it
// (JOURNAL_TOKEN_FILE set, JOURNAL_TOKEN cleared), exactly like npm run setup.
//
// Run with: npm run pair [-- --server <journal url>] [-- --force]

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeTokenFile, PairingError } from '../lib/journal-pairing.js';
import {
  ENV_PATH,
  TOKEN_PATH,
  readIfExists,
  parseEnv,
  normalizeJournalUrl,
  isLocalHost,
  tokenEnv,
  hmacSecretFor,
  writeEnvFile,
  currentToken,
  strandedTokenFile,
  testConnection,
  pairWithApp,
} from './common.mjs';

const USAGE = `Usage: npm run pair [-- --server <journal url>] [-- --force]

  --server <url>  Journal to pair with (https://host, wss://host/ws, or a bare
                  hostname). Defaults to JOURNAL_WS_URL from .env.
  --force         Replace the agent token even if the current one still works.`;

// Pure argv parser (exported for tests). Accepts --server=<url> too.
export function parseArgs(argv) {
  const opts = { server: '', force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--server') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--server needs a URL');
      opts.server = v;
    } else if (a.startsWith('--server=')) {
      opts.server = a.slice('--server='.length);
      if (!opts.server) throw new Error('--server needs a URL');
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// Validate a journal URL for pairing. The claim response carries the agent
// token, so a remote journal must be reached over TLS. Returns the wss form
// or throws a readable Error.
export function pairingJournalUrl(raw) {
  const url = normalizeJournalUrl(raw);
  if (!url) throw new Error(`could not parse ${JSON.stringify(raw)} as a journal URL`);
  if (url.protocol === 'ws:' && !isLocalHost(url.hostname)) {
    throw new Error(`${url.host} is remote; pairing over plain ws:// would send the agent token in cleartext — use https:// or wss://`);
  }
  return url.toString();
}

// Point .env at the token file. The token itself is already safe on disk, so
// a failure here only needs the operator to finish the edit by hand.
function saveEnv(existing, journalUrl) {
  let backedUp;
  try {
    backedUp = writeEnvFile(existing, { ...tokenEnv(journalUrl), HMAC_SECRET: hmacSecretFor(existing) });
  } catch (e) {
    console.error(`Could not update ${ENV_PATH}: ${e.message}`);
    console.error(`The token is saved; set JOURNAL_WS_URL=${journalUrl} and JOURNAL_TOKEN_FILE=${TOKEN_PATH} in .env by hand.`);
    process.exit(1);
  }
  console.log(`Updated ${ENV_PATH}${backedUp ? ' (previous .env backed up to .env.bak)' : ''}.`);
}

function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) { console.log(USAGE); return; }

  const existing = parseEnv(readIfExists(ENV_PATH));

  let raw = opts.server || existing.JOURNAL_WS_URL || '';
  if (!raw) {
    if (!process.stdin.isTTY) {
      console.error('No journal URL: set JOURNAL_WS_URL in .env or pass --server <url>.');
      process.exit(2);
    }
    raw = await askLine('Journal server URL (e.g. https://journal.example.com)');
  }
  let journalUrl;
  try { journalUrl = pairingJournalUrl(raw); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  // Refuse to replace a token that still works: pairing mints a NEW agent
  // device in the journal, and the old one would be orphaned (still listed,
  // still valid) until someone revokes it in the app.
  // A token a first-run wizard paired and stored before it was interrupted
  // (so .env never pointed at it) is adopted rather than re-paired.
  const stranded = strandedTokenFile(existing);
  const oldToken = currentToken(existing) || (stranded ? readIfExists(stranded).trim() : '');
  if (oldToken && !opts.force) {
    process.stdout.write(`Checking the current agent token against ${journalUrl} ... `);
    try {
      const name = await testConnection(journalUrl, oldToken);
      console.log('ok');
      if (stranded) {
        saveEnv(existing, journalUrl);
        console.log(`Found agent "${name}" already paired in ${stranded}; .env now points at it.`);
        return;
      }
      console.log(`This bridge is already paired as agent "${name}". Nothing to do.`);
      console.log('To pair it again anyway (e.g. as a different agent), re-run with --force:');
      console.log('  npm run pair -- --force');
      return;
    } catch (e) {
      console.log('failed');
      console.log(`  ${e.message}`);
      console.log('Pairing a new agent token.');
    }
  }

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);
  let token;
  try {
    token = await pairWithApp({ journalUrl, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('\nPairing cancelled.');
      process.exit(130);
    }
    const hint = e instanceof PairingError ? '' : ' (is the journal URL right, and is the server reachable?)';
    console.error(`\nPairing failed: ${e.message}${hint}`);
    process.exit(1);
  } finally {
    process.off('SIGINT', onSigint);
  }

  // The journal handed the token over exactly once: if it can't be saved,
  // the new agent exists with no way to use it, so say how to clean up.
  try {
    writeTokenFile(TOKEN_PATH, token);
  } catch (e) {
    console.error(`\nPaired, but saving the token to ${TOKEN_PATH} failed: ${e.message}`);
    console.error('Revoke the new agent in the Matron app (Settings -> Devices), fix the problem, and re-run npm run pair.');
    process.exit(1);
  }
  const hadEnv = Object.keys(existing).length > 0;
  console.log('');
  console.log(`Paired. Agent token stored in ${TOKEN_PATH} (mode 600, gitignored).`);
  saveEnv(existing, journalUrl);

  process.stdout.write(`Testing ${journalUrl} ... `);
  try {
    const name = await testConnection(journalUrl, token);
    console.log(`ok — connected as agent "${name}"`);
  } catch (e) {
    console.log('failed');
    console.log(`  ${e.message}`);
  }

  console.log('');
  if (!hadEnv) {
    console.log('This was a fresh .env: run npm run setup to set your Matron username and');
    console.log('the other basics (it will keep the token you just paired).');
  }
  console.log('Restart the bridge to pick up the new token:');
  console.log('  npm start                     # in this terminal');
  if (process.platform === 'win32') {
    console.log('  setup\\service.ps1             # or, if it runs as a Scheduled Task, re-run its installer');
  } else {
    console.log('  setup/service.sh              # or, if it runs as a service, re-run its installer');
    console.log('                                # (sudo on Linux; macOS inlines .env into the plist)');
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) await main();
