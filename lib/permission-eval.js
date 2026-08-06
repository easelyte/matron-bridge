import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildSessionSettings } from './session-settings.js';

function productionSourcePaths(workdir) {
  return [
    path.join(workdir, '.claude', 'settings.json'),
    path.join(workdir, '.claude', 'settings.local.json'),
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
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
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
