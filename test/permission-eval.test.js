import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildPermissionSnapshot,
  classifyPermission,
} from '../lib/permission-eval.js';

const WEBFLOW_EXACT_TOOLS = [
  'mcp__webflow__webflow_guide_tool',
  'mcp__webflow__ask_webflow_ai',
  'mcp__webflow__data_element_tool',
  'mcp__webflow__data_element_builder',
  'mcp__webflow__data_element_settings_tool',
  'mcp__webflow__data_style_tool',
  'mcp__webflow__data_component_tool',
  'mcp__webflow__data_component_builder',
  'mcp__webflow__data_component_props_tool',
  'mcp__webflow__data_component_variants_tool',
  'mcp__webflow__data_cms_tool',
  'mcp__webflow__data_assets_tool',
  'mcp__webflow__asset_tool',
  'mcp__webflow__get_asset_preview',
  'mcp__webflow__data_fonts_tool',
  'mcp__webflow__data_variable_tool',
  'mcp__webflow__data_forms_tool',
  'mcp__webflow__data_localization_tool',
  'mcp__webflow__data_whtml_builder',
  'mcp__webflow__data_agent_instructions_tool',
  'mcp__webflow__designer_tool',
  'mcp__webflow__element_snapshot_tool',
  'mcp__webflow__data_sitemap_tool',
  'mcp__webflow__data_analyze_tool',
  'mcp__webflow__data_comments_tool',
  'mcp__webflow__get_more_tools',
];

let fixtureDir;

function writeSettings(filename, permissions) {
  const filePath = path.join(fixtureDir, filename);
  writeFileSync(filePath, JSON.stringify({ permissions }));
  return filePath;
}

beforeEach(() => {
  fixtureDir = mkdtempSync(path.resolve('test/fixtures/permission-eval-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('permission snapshot', () => {
  it('classifies the hermetic Webflow exact-name allowlist without allowing the absent repro tool', () => {
    const settingsLocal = writeSettings('settings.local.json', {
      allow: ['Bash(*)', ...WEBFLOW_EXACT_TOOLS],
      deny: ['Read(/restricted/**)'],
      ask: ['Write(*)'],
    });

    const snapshot = buildPermissionSnapshot({ sourcePaths: [settingsLocal] });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.mcpAllow).toBeInstanceOf(Set);
    expect(snapshot.mcpDeny).toBeInstanceOf(Set);
    expect(snapshot.mcpAsk).toBeInstanceOf(Set);
    expect(snapshot.mcpAllow.has('Bash(*)')).toBe(false);
    expect(snapshot.mcpDeny.has('Read(/restricted/**)')).toBe(false);
    expect(snapshot.mcpAsk.has('Write(*)')).toBe(false);
    for (const toolName of WEBFLOW_EXACT_TOOLS) {
      expect(classifyPermission(snapshot, toolName), toolName).toBe('allow');
    }
    expect(classifyPermission(snapshot, 'mcp__webflow__data_sites_tool')).toBe('default-gated');
  });

  it.each(['mcp__webflow', 'mcp__webflow__*'])(
    'treats server-level allow %s as default-gated uncertainty',
    serverRule => {
      const source = writeSettings('server-allow.json', { allow: [serverRule] });
      const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

      expect(classifyPermission(snapshot, 'mcp__webflow__data_sites_tool')).toBe('default-gated');
    },
  );

  it('returns deny or ask for exact matches, with both taking precedence over allow', () => {
    const source = writeSettings('policy.json', {
      allow: ['mcp__server__denied_tool', 'mcp__server__asked_tool'],
      deny: ['mcp__server__denied_tool'],
      ask: ['mcp__server__asked_tool'],
    });
    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(classifyPermission(snapshot, 'mcp__server__denied_tool')).toBe('deny');
    expect(classifyPermission(snapshot, 'mcp__server__asked_tool')).toBe('ask');
  });

  it('applies server-level deny and ask rules without treating server-level allow as permission', () => {
    const source = writeSettings('server-policy.json', {
      allow: ['mcp__allowed', 'mcp__allowed__*'],
      deny: ['mcp__denied'],
      ask: ['mcp__asked__*'],
    });
    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(classifyPermission(snapshot, 'mcp__denied__tool')).toBe('deny');
    expect(classifyPermission(snapshot, 'mcp__asked__tool')).toBe('ask');
    expect(classifyPermission(snapshot, 'mcp__allowed__tool')).toBe('default-gated');
  });

  it('fails closed when a source is unreadable or malformed while retaining policy from valid sources', () => {
    const malformedPath = path.join(fixtureDir, 'malformed.json');
    writeFileSync(malformedPath, '{not json');
    const policyPath = writeSettings('deny.json', {
      deny: ['mcp__server__denied_tool'],
      ask: ['mcp__server__asked_tool'],
    });
    const unreadablePath = path.join(fixtureDir, 'missing.json');

    expect(() => buildPermissionSnapshot({
      sourcePaths: [unreadablePath, malformedPath, policyPath],
    })).not.toThrow();

    const snapshot = buildPermissionSnapshot({
      sourcePaths: [unreadablePath, malformedPath, policyPath],
    });
    expect(classifyPermission(snapshot, 'mcp__webflow__data_sites_tool')).toBe('default-gated');
    expect(classifyPermission(snapshot, 'mcp__server__denied_tool')).toBe('deny');
    expect(classifyPermission(snapshot, 'mcp__server__asked_tool')).toBe('ask');
  });

  it('includes the bridge print-mode MCP permission in every snapshot', () => {
    const snapshot = buildPermissionSnapshot({ sourcePaths: [] });

    expect(classifyPermission(snapshot, 'mcp__show-file__show_file')).toBe('allow');
  });
});

describe('print-session snapshot wiring (source inspection)', () => {
  const indexSource = readFileSync(path.resolve('index.js'), 'utf8');
  const printSpawn = indexSource.slice(
    indexSource.indexOf('function createSession('),
    indexSource.indexOf('// --- Codex programmatic sessions ---'),
  );

  it('builds the snapshot from the print session workdir and stores it on the session', () => {
    expect(printSpawn).toContain('buildPermissionSnapshot({ workdir: cwd })');
    expect(printSpawn).toContain('permissionSnapshot,');
  });
});
