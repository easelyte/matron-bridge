#!/usr/bin/env node
// PreToolUse hook for Bash commands (Node port of matron-bash-tee.sh) —
// rewrites the command to tee its output into the live log via matron-tee.
// Only active when MATRON_BASH_TEE_ENABLED=1. Passes through (exit 0, no
// output) on any unexpected input.
//
// The rewritten command is executed by Claude Code's Bash tool — Git Bash on
// Windows — so it is a bash command line: node, the tee script and the log
// path are double-quoted with forward slashes (valid for bash and for Node),
// and the original command is POSIX single-quoted for `bash -c`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson } from './hook-util.mjs';
import { liveLogPath } from '../lib/live-log-dir.js';

// Paths go in bash double quotes with forward slashes (Node and Git Bash both
// accept them); the characters bash still interprets inside double quotes
// (" $ ` and \) are escaped. The original command is POSIX single-quoted.
export function bashDoubleQuotePath(p) {
  return `"${String(p).replace(/\\/g, '/').replace(/["$`\\]/g, (c) => `\\${c}`)}"`;
}

export function rewriteCommand({ command, nodeBin, teeBin, logPath }) {
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `${bashDoubleQuotePath(nodeBin)} ${bashDoubleQuotePath(teeBin)} ${bashDoubleQuotePath(logPath)} -- bash -c ${sq(command)}`;
}

export function hookOutput(input, { env = process.env, nodeBin = process.execPath, hooksDir } = {}) {
  if (env.MATRON_BASH_TEE_ENABLED !== '1') return null;
  if (!input || input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  const toolUseId = input.tool_use_id;
  if (typeof command !== 'string' || !command || typeof toolUseId !== 'string' || !toolUseId) return null;
  // Defense-in-depth: tool_use_id is API-generated as `toolu_[A-Za-z0-9_]+`.
  // Reject anything else so the log path and the rewritten command cannot
  // carry path traversal or shell metacharacters.
  if (!/^toolu_[A-Za-z0-9_]+$/.test(toolUseId)) return null;
  const teeBin = path.join(hooksDir, 'matron-tee');
  const logPath = liveLogPath(toolUseId);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { command: rewriteCommand({ command, nodeBin, teeBin, logPath }) },
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = await readStdinJson();
  const out = hookOutput(input, { hooksDir: path.dirname(fileURLToPath(import.meta.url)) });
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
