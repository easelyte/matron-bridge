// The memory-recall hook (hooks/memory-recall.mjs): a Claude Code
// UserPromptSubmit hook that asks the bridge which of the user's on-demand
// memories bear on the message a turn starts with, and adds them to that
// turn as context. It is how a session hears about a rule it was only told
// the name of, without having to know to ask (lib/memory-tools.js
// recallTurn; journal docs/protocol.md "Recall").
//
// Best effort, always: anything unexpected (no bridge, a slow journal, bad
// input) adds nothing and never holds the turn past the hook's limit.
import { nodeHookEntry } from './hook-command.js';
import { formatRecallContext } from './memory-format.js';

// Claude Code's limit on the hook, in seconds. The bridge gives the journal
// RECALL_TURN_TIMEOUT_MS (2.5 s) and the hook waits a little longer for it.
export const MEMORY_RECALL_HOOK_TIMEOUT_S = 5;
export const MEMORY_RECALL_FETCH_TIMEOUT_MS = 3500;

// The settings entry. Port, room and token file are baked into the command
// (never env), as for the foreign-turn gate.
export function memoryRecallEntry({ hooksDir, apiPort, roomId, apiHeaderFile = '', platform = process.platform, execPath = process.execPath }) {
  return {
    hooks: [nodeHookEntry({
      hooksDir,
      name: 'memory-recall',
      args: ['--port', String(apiPort), '--room', String(roomId), ...(apiHeaderFile ? ['--auth', String(apiHeaderFile)] : [])],
      timeout: MEMORY_RECALL_HOOK_TIMEOUT_S,
      platform,
      execPath,
    })],
  };
}

// The hook's stdout for the bridge's answer: a UserPromptSubmit
// additionalContext block, or null (print nothing) when nothing matched.
export function memoryRecallHookOutput(data) {
  const context = formatRecallContext(data);
  if (!context) return null;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}
