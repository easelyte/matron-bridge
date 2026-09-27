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

// easelyte fork delta: compose the fork's print-session settings onto
// upstream's buildPrintSessionSettings (lib/permission-prompt.js).
//
//  - permissions.allow: union with the fork's full tool allow-list above (the
//    root-bridge posture), deduplicated.
//  - Permission cards (MATRON_PERMISSION_CARDS, hooks/permission-decision.sh):
//    added ONLY for bypass sessions. A gated (auto-mode) session already routes
//    every uncovered MCP call through upstream's permission-gate hook + the
//    permission_request card; adding the fork hook there too would double-gate
//    the same call. Bypass sessions have no other MCP gate, which is the case
//    the fork's cards exist for (IS_SANDBOX=1 root bridge).
//
// Upstream's Bash tee + PreCompact hooks are kept as-is (same scripts the fork
// registers), so nothing is registered twice.
export function withForkPrintSettings(base, { bypass } = {}) {
  const fork = buildSessionSettings('print');
  const allow = [...new Set([...(base?.permissions?.allow || []), ...fork.permissions.allow])];
  const preToolUse = [...(base?.hooks?.PreToolUse || [])];
  if (bypass) {
    const decision = fork.hooks.PreToolUse.find(h => h.matcher === 'mcp__.*');
    if (decision) preToolUse.push(decision);
  }
  return {
    ...base,
    permissions: { ...(base?.permissions || {}), allow },
    hooks: { ...(base?.hooks || {}), PreToolUse: preToolUse },
  };
}
