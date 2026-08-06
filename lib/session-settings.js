import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function hookPath(filename) {
  return path.join(BRIDGE_DIR, 'hooks', filename);
}

export function buildSessionSettings(mode) {
  if (mode !== 'print' && mode !== 'iv') {
    throw new RangeError(`Unknown session settings mode: ${mode}`);
  }

  // easelyte fork delta: the bridge runs as root on the VPS, where Claude
  // refuses --dangerously-skip-permissions. Match the live
  // claude-matrix-bridge config with a full tool allow-list via --settings.
  const permissions = {
    allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'MultiEdit(*)', 'Glob(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)', 'Skill', 'Agent(*)', 'Task(*)', 'NotebookEdit(*)', 'mcp__show-file__show_file'],
    deny: [],
  };

  const preToolUse = [{
    matcher: 'Bash',
    hooks: [{
      type: 'command',
      command: hookPath('matron-bash-tee.sh'),
    }],
  }];

  if (mode === 'print') {
    preToolUse.push({
      // Matcher mcp__.* is POC-confirmed to fire this PreToolUse hook on a
      // gated MCP call in CC 2.1.222 --print (2026-08-06: a stub server's
      // mcp__ping__ping call was intercepted and denied; no fallback to the
      // literal `mcp__` needed). Full round-trip acceptance smoke: T-4.2.
      matcher: 'mcp__.*',
      hooks: [{
        type: 'command',
        command: hookPath('permission-decision.sh'),
        timeout: 1800,
      }],
    });
  }

  const hooks = {
    PreCompact: [{
      hooks: [{
        type: 'command',
        command: hookPath('compact-notify.sh'),
        timeout: 5,
      }],
    }],
    PreToolUse: preToolUse,
  };

  if (mode === 'iv') {
    hooks.Stop = [{
      hooks: [{
        type: 'command',
        command: hookPath('stop-notify.sh'),
        timeout: 10,
      }],
    }];
  }

  return { permissions, hooks };
}
