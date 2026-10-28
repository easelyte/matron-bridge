#!/usr/bin/env node
// PreToolUse hook the bridge adds (inline --settings) to gated print-mode
// sessions, on `mcp__.*`. It asks the bridge's permission classifier
// (POST /permission-check) whether this MCP call is allowed, denied, or needs
// the user, and prints the matching permissionDecision. Fail CLOSED: any error,
// timeout, or odd response prints "ask", never "allow". Infra MCP tools
// (ask-user, show-file) and non-MCP tools pass through with no output.
import {
  isGatedMcpTool,
  permissionGateHookOutput,
  PERMISSION_GATE_FETCH_TIMEOUT_MS,
} from '../lib/permission-prompt.js';
import { readApiHeaderFile } from '../lib/api-header-file.js';
import { readStdinText } from './hook-util.mjs';

// The bridge bakes `--port <n> --room <id>` into the hook command at spawn.
// Deliberately NOT read from the environment: a settings `env` block reaches
// hooks and must not be able to point the gate at another server. The target is
// always loopback.
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
  let toolName;
  try {
    toolName = JSON.parse(await readStdinText())?.tool_name;
  } catch {
    // Unparseable hook input: we cannot tell what is being called. Ask.
    return permissionGateHookOutput(null);
  }
  if (!isGatedMcpTool(toolName)) return null;
  const { port, room, auth } = parseArgs(process.argv.slice(2));
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || !room) {
    return permissionGateHookOutput(null);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${portNum}/permission-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...readApiHeaderFile(auth) },
      body: JSON.stringify({ roomId: room, toolName }),
      signal: AbortSignal.timeout(PERMISSION_GATE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return permissionGateHookOutput(null);
    return permissionGateHookOutput(await res.json());
  } catch {
    return permissionGateHookOutput(null);
  }
}

let output;
try {
  output = await main();
} catch {
  output = permissionGateHookOutput(null);
}
if (output) process.stdout.write(JSON.stringify(output));
process.exit(0);
