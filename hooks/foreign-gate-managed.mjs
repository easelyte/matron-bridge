#!/usr/bin/env node
// The foreign-turn gate (lib/foreign-turn.js) as a hook an administrator
// installs in Claude Code's MANAGED settings, for machines whose managed
// settings set `allowManagedHooksOnly`. There Claude Code ignores the hooks
// the bridge passes each session in --settings, hooks/foreign-gate.* among
// them, so without this one a turn started by another person would run
// ungated (the bridge refuses to deliver such turns until it sees this hook
// in the managed settings; lib/claude-managed-settings.js).
//
// A managed hook is one command for every session on the machine, so
// nothing per-session is baked into it. Instead:
//   - the session is named by the `session_id` Claude Code puts in the hook
//     input, and the bridge maps it to its own session in memory;
//   - the token is the session's own API token file, from the
//     MATRON_BRIDGE_API_HEADER_FILE the bridge set when it spawned Claude;
//   - when the bridge cannot be reached or refuses the call, a flag file
//     named after that same session id decides (present -> deny). The
//     bridge writes it for the length of a turn another person started.
// Neither the session nor the fallback flag comes from the environment (the
// flag's directory is fixed: lib/foreign-turn.js claudeSessionFlagDir), so
// an environment the session changed can at worst make the bridge refuse
// the call, and then the flag decides.
//
// A Claude session the bridge did not start gets a 401 and has no flag, so
// the hook prints nothing and the call goes on as usual.
//
// Usage in managed settings (PreToolUse, matcher "*"):
//   node /path/to/matron-bridge/hooks/foreign-gate-managed.mjs --port 9802
// --port defaults to MATRON_BRIDGE_API_PORT, then 9802.
import fs from 'node:fs';
import { readApiHeaderFile } from '../lib/api-header-file.js';
import { claudeSessionFlagPath } from '../lib/foreign-turn.js';
import { readStdinText, bridgePort } from './hook-util.mjs';

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'This turn was started by another person and the Matron bridge could not confirm this call is allowed, so it is blocked. Reply in the room, or ask your user with foreign_action_request.',
  },
};

function portFrom(argv, env) {
  const i = argv.indexOf('--port');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : bridgePort(env);
}

export async function decide({ input, argv = [], env = process.env, fetchImpl = fetch, exists = fs.existsSync } = {}) {
  let sessionId = null;
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed?.session_id === 'string' && parsed.session_id) sessionId = parsed.session_id;
  } catch { /* no session id: nothing to name a flag by */ }
  const fallback = () => (sessionId && exists(claudeSessionFlagPath(sessionId)) ? DENY : null);
  if (!sessionId) return null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${portFrom(argv, env)}/foreign-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...readApiHeaderFile(env.MATRON_BRIDGE_API_HEADER_FILE) },
      body: input,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    if (data && typeof data === 'object' && Object.keys(data).length === 0) return null;
    return data?.hookSpecificOutput?.permissionDecision === 'deny' ? data : fallback();
  } catch {
    return fallback();
  }
}

// Run as a hook (not when imported by a test).
if (process.argv[1]?.endsWith('foreign-gate-managed.mjs')) {
  let output;
  try { output = await decide({ input: await readStdinText(), argv: process.argv.slice(2) }); } catch { output = DENY; }
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
