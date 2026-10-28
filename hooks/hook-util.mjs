import { readApiHeaderFile } from '../lib/api-header-file.js';

// Shared bits for the Node ports of the bridge's hooks (used on Windows, where
// the .sh versions would need Git Bash + jq + curl). Same contract as the shell
// scripts: read the hook JSON from stdin, never fail the tool call — anything
// unexpected means exit 0 with no (or empty) output.
export async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function readStdinJson() {
  let text;
  try {
    text = await readStdinText();
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function bridgePort(env = process.env) {
  const n = Number.parseInt(env.MATRON_BRIDGE_API_PORT || '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 9802;
}

// POST JSON to the bridge's loopback API; swallow every failure (the shell
// hooks run curl -s … > /dev/null and exit 0 regardless).
export async function postBridge(pathname, body, { port = bridgePort(), timeoutMs = 5000, env = process.env } = {}) {
  try {
    await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      // The session's API token header, from its 0600 file (lib/api-auth.js).
      headers: { 'Content-Type': 'application/json', ...readApiHeaderFile(env.MATRON_BRIDGE_API_HEADER_FILE) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // unreachable bridge: the hook is best-effort
  }
}
