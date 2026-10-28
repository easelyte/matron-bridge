#!/usr/bin/env node
// Windows port of hooks/foreign-gate.sh (same contract): ask the bridge
// (POST /foreign-check); `{}` -> no output, a deny -> print it; bridge
// unreachable -> deny while the turn's flag file exists, nothing otherwise.
import fs from 'node:fs';
import { readApiHeaderFile } from '../lib/api-header-file.js';
import { readStdinText } from './hook-util.mjs';

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'This turn was started by another person and the Matron bridge could not confirm this call is allowed, so it is blocked. Reply in the room, or ask your user with foreign_action_request.',
  },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--port') out.port = argv[i + 1];
    if (argv[i] === '--room') out.room = argv[i + 1];
    if (argv[i] === '--flag') out.flag = argv[i + 1];
    if (argv[i] === '--auth') out.auth = argv[i + 1];
  }
  return out;
}

async function main() {
  const { port, room, flag, auth } = parseArgs(process.argv.slice(2));
  const input = await readStdinText();
  // The bridge's answer is the truth; the flag file decides only when the
  // bridge cannot be reached (present -> deny, absent -> nothing).
  const fallback = () => (!flag || fs.existsSync(flag) ? DENY : null);
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || !room) return fallback();
  try {
    const res = await fetch(`http://127.0.0.1:${portNum}/foreign-check?room=${encodeURIComponent(room)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...readApiHeaderFile(auth) }, body: input, signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    if (data && typeof data === 'object' && Object.keys(data).length === 0) return null;
    return data?.hookSpecificOutput?.permissionDecision === 'deny' ? data : fallback();
  } catch {
    return fallback();
  }
}

let output;
try { output = await main(); } catch { output = DENY; }
if (output) process.stdout.write(JSON.stringify(output));
process.exit(0);
