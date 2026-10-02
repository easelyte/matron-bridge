import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
// fork: the permission-card snapshot also carries the bridge's own
// session allow-list (show_file etc.), see lib/session-settings.js.
import { buildSessionSettings } from './session-settings.js';

export const PERMISSION_SOURCE_MAX_BYTES = 1024 * 1024;

// The directory Claude Code loads the project's `.claude/settings.local.json`
// from: the git toplevel of the working directory (the workdir itself when it
// is not inside a repository, or when git cannot answer). The CLI reads
// `settings.json` from the cwd, so that one stays under the workdir.
function settingsLocalRoot(workdir) {
  const result = spawnSync('git', ['-C', workdir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  const toplevel = result.status === 0 && !result.error ? result.stdout.trim() : '';
  return toplevel !== '' ? toplevel : workdir;
}

function productionSourcePaths(workdir) {
  return [
    path.join(workdir, '.claude', 'settings.json'),
    path.join(settingsLocalRoot(workdir), '.claude', 'settings.local.json'),
    path.join(homedir(), '.claude', 'settings.json'),
  ];
}

function addMcpRules(target, rules) {
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (typeof rule === 'string' && rule.startsWith('mcp__')) {
      target.add(rule);
    }
  }
}

function addPermissions(snapshot, permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return;
  addMcpRules(snapshot.mcpAllow, permissions.allow);
  addMcpRules(snapshot.mcpDeny, permissions.deny);
  addMcpRules(snapshot.mcpAsk, permissions.ask);
}

function warnUncertainSource(sourcePath, reason) {
  console.warn(`[permission-eval] Permission source ${sourcePath} is uncertain: ${reason}`);
}

function readPermissions(sourcePath) {
  let fd;
  try {
    // Open first, then validate on the FILE DESCRIPTOR (fstat), never on a
    // path stat taken beforehand — a path-based check-then-open is a TOCTOU
    // window (the path could be swapped between the check and the open). Opening
    // read-only + non-blocking follows a symlink to its target (settings files
    // may legitimately be symlinks); the fstat below authoritatively rejects
    // anything whose opened target is not a regular file (dir / fifo / device).
    fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      warnUncertainSource(sourcePath, 'source is not a regular file');
      return { permissions: null, uncertain: true };
    }
    if (openedStat.size > PERMISSION_SOURCE_MAX_BYTES) {
      warnUncertainSource(
        sourcePath,
        `source exceeds ${PERMISSION_SOURCE_MAX_BYTES} byte limit`,
      );
      return { permissions: null, uncertain: true };
    }

    const buffer = Buffer.allocUnsafe(PERMISSION_SOURCE_MAX_BYTES);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (fstatSync(fd).size > PERMISSION_SOURCE_MAX_BYTES) {
      warnUncertainSource(
        sourcePath,
        `source exceeds ${PERMISSION_SOURCE_MAX_BYTES} byte limit`,
      );
      return { permissions: null, uncertain: true };
    }

    const parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnUncertainSource(sourcePath, 'settings root is not an object');
      return { permissions: null, uncertain: true };
    }

    const permissions = parsed.permissions;
    if (permissions === undefined) {
      return { permissions: null, uncertain: false };
    }
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      warnUncertainSource(sourcePath, 'permissions is not an object');
      return { permissions: null, uncertain: true };
    }

    const invalidRuleLists = ['allow', 'deny', 'ask'].flatMap(name => {
      const rules = permissions[name];
      if (rules === undefined) return [];
      if (!Array.isArray(rules)) return [`${name} is not an array`];
      if (rules.some(rule => typeof rule !== 'string')) {
        return [`${name} contains a non-string rule`];
      }
      return [];
    });
    if (invalidRuleLists.length > 0) {
      warnUncertainSource(sourcePath, invalidRuleLists.join('; '));
    }
    return { permissions, uncertain: invalidRuleLists.length > 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { permissions: null, uncertain: false };
    }
    const reason = error instanceof SyntaxError
      ? 'invalid JSON'
      : `read failed (${error?.code ?? error?.name ?? 'unknown error'})`;
    warnUncertainSource(sourcePath, reason);
    return { permissions: null, uncertain: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Capture the MCP-relevant permission rules that apply when a print session
 * starts. Explicit sourcePaths keep tests and other callers independent of
 * live workspace/user settings; omitting them uses Claude's layered defaults.
 */
export function buildPermissionSnapshot({ workdir = process.cwd(), sourcePaths } = {}) {
  const mutable = {
    mcpAllow: new Set(),
    mcpDeny: new Set(),
    mcpAsk: new Set(),
  };
  let uncertain = false;

  addPermissions(mutable, buildSessionSettings('print').permissions);
  for (const sourcePath of sourcePaths ?? productionSourcePaths(workdir)) {
    const source = readPermissions(sourcePath);
    uncertain ||= source.uncertain;
    addPermissions(mutable, source.permissions);
  }

  return Object.freeze({
    mcpAllow: Object.freeze([...mutable.mcpAllow]),
    mcpDeny: Object.freeze([...mutable.mcpDeny]),
    mcpAsk: Object.freeze([...mutable.mcpAsk]),
    uncertain,
  });
}

function serverRuleNames(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return [];
  const serverEnd = toolName.indexOf('__', 'mcp__'.length);
  if (serverEnd < 0 || serverEnd === 'mcp__'.length) return [];

  const serverName = toolName.slice(0, serverEnd);
  return [serverName, `${serverName}__*`];
}

function hasRule(rules, name) {
  return Array.isArray(rules) && rules.includes(name);
}

function hasAnyRule(rules, names) {
  return names.some(name => hasRule(rules, name));
}

/**
 * Classify one fully-qualified MCP tool name against a spawn-time snapshot.
 * Server-wide allow rules deliberately remain default-gated because the
 * bridge only auto-allows exact tool names; server-wide deny/ask rules retain
 * their restrictive effect.
 */
export function classifyPermission(snapshot, toolName) {
  if (!snapshot || typeof toolName !== 'string') return 'default-gated';

  const serverRules = serverRuleNames(toolName);
  if (hasRule(snapshot.mcpDeny, toolName) || hasAnyRule(snapshot.mcpDeny, serverRules)) {
    return 'deny';
  }
  if (hasRule(snapshot.mcpAsk, toolName) || hasAnyRule(snapshot.mcpAsk, serverRules)) {
    return 'ask';
  }
  if (
    !snapshot.uncertain
    && serverRules.length > 0
    && !toolName.endsWith('__*')
    && hasRule(snapshot.mcpAllow, toolName)
  ) {
    return 'allow';
  }
  return 'default-gated';
}
