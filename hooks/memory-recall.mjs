#!/usr/bin/env node
// UserPromptSubmit hook: add the user's on-demand memories that bear on this
// message to the turn (lib/memory-recall-hook.js). Never fails the prompt:
// any problem prints nothing and exits 0.
import { memoryRecallHookOutput, MEMORY_RECALL_FETCH_TIMEOUT_MS } from '../lib/memory-recall-hook.js';
import { readApiHeaderFile } from '../lib/api-header-file.js';
import { readStdinJson } from './hook-util.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--port') out.port = argv[i + 1];
    if (argv[i] === '--room') out.room = argv[i + 1];
    if (argv[i] === '--auth') out.auth = argv[i + 1];
  }
  return out;
}

async function main() {
  const input = await readStdinJson();
  const text = typeof input?.prompt === 'string' ? input.prompt : '';
  if (!text.trim()) return null;
  const { port, room, auth } = parseArgs(process.argv.slice(2));
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || !room) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${portNum}/memory/recall-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...readApiHeaderFile(auth) },
      body: JSON.stringify({ roomId: room, text }),
      signal: AbortSignal.timeout(MEMORY_RECALL_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return memoryRecallHookOutput(await res.json());
  } catch {
    return null;
  }
}

try {
  const out = await main();
  if (out) process.stdout.write(JSON.stringify(out));
} catch {
  // best effort: never fail the prompt
}
process.exit(0);
