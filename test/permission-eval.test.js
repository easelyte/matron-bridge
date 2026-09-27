import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  buildPermissionSnapshot,
  classifyPermission,
  PERMISSION_SOURCE_MAX_BYTES,
} from '../lib/permission-eval.js';

const WEBFLOW_SETTINGS_FIXTURE = path.resolve('test/fixtures/webflow-settings.local.json');
// Same `~` expansion + resolve as index.js applies to DEFAULT_WORKDIR.
function expandWorkdir(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
const PRODUCTION_WORKDIR = expandWorkdir(process.env.DEFAULT_WORKDIR || '/root/.openclaw/workspace');
const PRODUCTION_SETTINGS_LOCAL = path.join(PRODUCTION_WORKDIR, '.claude', 'settings.local.json');

// Which settings file the live-allowlist test reads: the live file when readable, the
// committed fixture when the live file is absent, and a skip (with the reason) when the
// live file exists but this user cannot read it (e.g. a non-root runner and root's file).
// Only ENOENT/ENOTDIR count as absent; any other access error (EACCES on the file or on a
// parent directory) is a skip, never a silent fall-back to the fixture.
function resolveLiveSettingsSource(livePath, { access = accessSync } = {}) {
  try {
    access(livePath, fsConstants.R_OK);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { sourcePath: WEBFLOW_SETTINGS_FIXTURE };
    }
    return { skipReason: `live settings ${livePath} unreadable (${err?.code ?? err?.message})` };
  }
  return { sourcePath: livePath };
}

function webflowAllowRules(settings) {
  return settings.permissions.allow.filter(rule => (
    typeof rule === 'string' && rule.startsWith('mcp__webflow__')
  ));
}

let fixtureDir;

function writeSettings(filename, permissions) {
  const filePath = path.join(fixtureDir, filename);
  writeFileSync(filePath, JSON.stringify({ permissions }));
  return filePath;
}

beforeEach(() => {
  // Under the OS temp dir, outside any git repository: the default source
  // lookup resolves the git toplevel of the workdir, and a fixture inside this
  // repository would resolve to the bridge's own .claude directory.
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'permission-eval-'));
});

function gitInit(dir) {
  const result = spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('permission snapshot', () => {
  it('classifies the committed production Webflow fixture without allowing the absent repro tool', () => {
    const settings = JSON.parse(readFileSync(WEBFLOW_SETTINGS_FIXTURE, 'utf8'));
    const webflowTools = webflowAllowRules(settings);
    const snapshot = buildPermissionSnapshot({ sourcePaths: [WEBFLOW_SETTINGS_FIXTURE] });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.mcpAllow)).toBe(true);
    expect(Object.isFrozen(snapshot.mcpDeny)).toBe(true);
    expect(Object.isFrozen(snapshot.mcpAsk)).toBe(true);
    expect(webflowTools).toHaveLength(28);
    expect(webflowTools).not.toContain('mcp__webflow__data_scripts_tool');
    for (const toolName of webflowTools) {
      expect(classifyPermission(snapshot, toolName), toolName).toBe('allow');
    }
    expect(classifyPermission(snapshot, 'mcp__webflow__data_scripts_tool')).toBe('default-gated');
  });

  it('resolves the live settings source: live when readable, fixture when absent, skip when unreadable', () => {
    const live = '/srv/workspace/.claude/settings.local.json';
    const failWith = code => () => { throw Object.assign(new Error(code), { code }); };
    expect(resolveLiveSettingsSource(live, { access: () => {} })).toEqual({ sourcePath: live });
    expect(resolveLiveSettingsSource(live, { access: failWith('ENOENT') }))
      .toEqual({ sourcePath: WEBFLOW_SETTINGS_FIXTURE });
    expect(resolveLiveSettingsSource(live, { access: failWith('ENOTDIR') }))
      .toEqual({ sourcePath: WEBFLOW_SETTINGS_FIXTURE });
    // EACCES covers both an unreadable file and an untraversable parent directory.
    expect(resolveLiveSettingsSource(live, { access: failWith('EACCES') }))
      .toEqual({ skipReason: `live settings ${live} unreadable (EACCES)` });
  });

  it('expands ~ in DEFAULT_WORKDIR the way the bridge does', () => {
    expect(expandWorkdir('~')).toBe(os.homedir());
    expect(expandWorkdir('~/')).toBe(os.homedir());
    expect(expandWorkdir('~/ws')).toBe(path.join(os.homedir(), 'ws'));
    expect(expandWorkdir('/root/.openclaw/workspace')).toBe('/root/.openclaw/workspace');
  });

  it('classifies the live Webflow allowlist when present, otherwise the committed fixture', ({ skip }) => {
    const { sourcePath, skipReason } = resolveLiveSettingsSource(PRODUCTION_SETTINGS_LOCAL);
    if (skipReason) skip(skipReason);
    const fixtureSettings = JSON.parse(readFileSync(WEBFLOW_SETTINGS_FIXTURE, 'utf8'));
    const settings = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const fixtureWebflowTools = webflowAllowRules(fixtureSettings);
    const webflowTools = webflowAllowRules(settings);
    const snapshot = buildPermissionSnapshot({ sourcePaths: [sourcePath] });

    expect(webflowTools).toEqual(fixtureWebflowTools);
    for (const toolName of webflowTools) {
      expect(classifyPermission(snapshot, toolName), toolName).toBe('allow');
    }
    expect(classifyPermission(snapshot, 'mcp__webflow__data_scripts_tool')).toBe('default-gated');
  });

  it('discovers workspace, local, and user permission layers by default (workdir not in a repository)', () => {
    const workdir = path.join(fixtureDir, 'workspace');
    const homeDir = path.join(fixtureDir, 'home');
    mkdirSync(path.join(workdir, '.claude'), { recursive: true });
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    writeFileSync(path.join(workdir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__workspace__settings_tool'] },
    }));
    writeFileSync(path.join(workdir, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['mcp__workspace__local_tool'] },
    }));
    writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__user__settings_tool'] },
    }));
    vi.stubEnv('HOME', homeDir);

    const snapshot = buildPermissionSnapshot({ workdir });

    expect(classifyPermission(snapshot, 'mcp__workspace__settings_tool')).toBe('allow');
    expect(classifyPermission(snapshot, 'mcp__workspace__local_tool')).toBe('allow');
    expect(classifyPermission(snapshot, 'mcp__user__settings_tool')).toBe('allow');
  });

  it('reads settings.local.json from the git toplevel when the workdir is inside a repository', () => {
    // Claude Code loads the project settings.local.json from the git root of
    // the working directory (settings.json from the cwd). The classifier must
    // see the same allow/deny rules the CLI does, or a rule the CLI honours is
    // invisible to the gate.
    const repo = path.join(fixtureDir, 'repo');
    const workdir = path.join(repo, 'packages', 'app');
    const homeDir = path.join(fixtureDir, 'home');
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    mkdirSync(path.join(workdir, '.claude'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    gitInit(repo);
    writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['mcp__root__local_tool'], deny: ['mcp__root__denied_tool'] },
    }));
    writeFileSync(path.join(workdir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__workspace__settings_tool'] },
    }));
    writeFileSync(path.join(workdir, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['mcp__workspace__local_tool'] },
    }));
    vi.stubEnv('HOME', homeDir);

    const snapshot = buildPermissionSnapshot({ workdir });

    expect(classifyPermission(snapshot, 'mcp__root__local_tool')).toBe('allow');
    expect(classifyPermission(snapshot, 'mcp__root__denied_tool')).toBe('deny');
    expect(classifyPermission(snapshot, 'mcp__workspace__settings_tool')).toBe('allow');
    // The CLI does not read a subdirectory's settings.local.json, so neither do we.
    expect(classifyPermission(snapshot, 'mcp__workspace__local_tool')).toBe('default-gated');
    expect(snapshot.uncertain).toBe(false);
  });

  it('fails closed when the git-toplevel settings.local.json is malformed', () => {
    const repo = path.join(fixtureDir, 'repo');
    const workdir = path.join(repo, 'sub');
    const homeDir = path.join(fixtureDir, 'home');
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    mkdirSync(path.join(workdir, '.claude'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    gitInit(repo);
    writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{ not json');
    writeFileSync(path.join(workdir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__workspace__settings_tool'] },
    }));
    vi.stubEnv('HOME', homeDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = buildPermissionSnapshot({ workdir });

    expect(snapshot.uncertain).toBe(true);
    expect(classifyPermission(snapshot, 'mcp__workspace__settings_tool')).toBe('default-gated');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join(repo, '.claude', 'settings.local.json')));
  });

  it('ignores non-MCP permission rules in every rule list', () => {
    const source = writeSettings('non-mcp-rules.json', {
      allow: ['Bash(*)'],
      deny: ['Read(/restricted/**)'],
      ask: ['Write(*)'],
    });

    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(snapshot.mcpAllow).not.toContain('Bash(*)');
    expect(snapshot.mcpDeny).not.toContain('Read(/restricted/**)');
    expect(snapshot.mcpAsk).not.toContain('Write(*)');
  });

  it.each(['mcp__webflow', 'mcp__webflow__*'])(
    'treats server-level allow %s as default-gated uncertainty',
    serverRule => {
      const source = writeSettings('server-allow.json', { allow: [serverRule] });
      const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

      expect(classifyPermission(snapshot, 'mcp__webflow__data_sites_tool')).toBe('default-gated');
    },
  );

  it('does not treat an incoming wildcard name as an exact allow', () => {
    const source = writeSettings('wildcard-name.json', {
      allow: ['mcp__webflow__*'],
    });
    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(classifyPermission(snapshot, 'mcp__webflow__*')).toBe('default-gated');
  });

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

  it('fails closed when a source is malformed while retaining policy from valid sources', () => {
    const malformedPath = path.join(fixtureDir, 'malformed.json');
    writeFileSync(malformedPath, '{not json');
    const policyPath = writeSettings('deny.json', {
      deny: ['mcp__server__denied_tool'],
      ask: ['mcp__server__asked_tool'],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let snapshot;
    expect(() => {
      snapshot = buildPermissionSnapshot({
        sourcePaths: [malformedPath, policyPath],
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(malformedPath));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    expect(snapshot.uncertain).toBe(true);
    expect(classifyPermission(snapshot, 'mcp__webflow__data_sites_tool')).toBe('default-gated');
    expect(classifyPermission(snapshot, 'mcp__server__denied_tool')).toBe('deny');
    expect(classifyPermission(snapshot, 'mcp__server__asked_tool')).toBe('ask');
  });

  it('treats a missing optional settings file as an absent layer', () => {
    const allowPath = writeSettings('allow.json', {
      allow: ['mcp__server__allowed_tool'],
    });
    const missingPath = path.join(fixtureDir, '.claude', 'settings.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = buildPermissionSnapshot({ sourcePaths: [missingPath, allowPath] });

    expect(warn).not.toHaveBeenCalled();
    expect(snapshot.uncertain).toBe(false);
    expect(classifyPermission(snapshot, 'mcp__server__allowed_tool')).toBe('allow');
  });

  it('rejects a FIFO as uncertain without hanging', () => {
    const fifoPath = path.join(fixtureDir, 'settings.fifo');
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    expect(mkfifo.error).toBeUndefined();
    expect(mkfifo.status).toBe(0);

    const script = `
      import { buildPermissionSnapshot } from './lib/permission-eval.js';
      const snapshot = buildPermissionSnapshot({ sourcePaths: [${JSON.stringify(fifoPath)}] });
      process.stdout.write(JSON.stringify(snapshot));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      // Generous ceiling, not a performance assertion: buildPermissionSnapshot
      // rejects a non-regular file via fstat before any read, so this returns
      // promptly. A 1 s cap flaked under load (node startup + ESM load alone can
      // exceed it); 30 s still catches a genuine regression that blocks on the
      // FIFO read while never tripping on a busy CI host.
      timeout: 30000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).uncertain).toBe(true);
    expect(result.stderr).toContain('source is not a regular file');
  });

  it('rejects an oversized source as uncertain without reading it', () => {
    const source = path.join(fixtureDir, 'oversized.json');
    writeFileSync(source, Buffer.alloc(PERMISSION_SOURCE_MAX_BYTES + 1, 0x20));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(snapshot.uncertain).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('byte limit'));
  });

  it('rejects another non-regular source as uncertain', () => {
    const source = path.join(fixtureDir, 'settings-directory');
    mkdirSync(source);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(snapshot.uncertain).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a regular file'));
  });

  it('still classifies permissions from a bounded regular file', () => {
    const source = writeSettings('regular.json', {
      allow: ['mcp__server__allowed_tool'],
    });

    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(snapshot.uncertain).toBe(false);
    expect(classifyPermission(snapshot, 'mcp__server__allowed_tool')).toBe('allow');
  });

  it('suppresses an exact allow after a non-ENOENT read failure', () => {
    const allowPath = writeSettings('allow.json', {
      allow: ['mcp__server__allowed_tool'],
    });
    const notDirectoryPath = path.join(fixtureDir, 'not-a-directory');
    writeFileSync(notDirectoryPath, 'file');

    const snapshot = buildPermissionSnapshot({
      sourcePaths: [allowPath, path.join(notDirectoryPath, 'settings.json')],
    });

    expect(snapshot.uncertain).toBe(true);
    expect(classifyPermission(snapshot, 'mcp__server__allowed_tool')).toBe('default-gated');
  });

  it('does not auto-allow an exact match when another source is malformed', () => {
    const allowPath = writeSettings('allow.json', {
      allow: ['mcp__server__allowed_tool'],
    });
    const malformedPath = path.join(fixtureDir, 'malformed.json');
    writeFileSync(malformedPath, '{not json');

    const snapshot = buildPermissionSnapshot({ sourcePaths: [allowPath, malformedPath] });

    expect(snapshot.uncertain).toBe(true);
    expect(classifyPermission(snapshot, 'mcp__server__allowed_tool')).toBe('default-gated');
  });

  it('cannot be mutated after creation to change a classification', () => {
    const source = writeSettings('immutable.json', {
      allow: ['mcp__server__allowed_tool'],
    });
    const snapshot = buildPermissionSnapshot({ sourcePaths: [source] });

    expect(() => snapshot.mcpAllow.push('mcp__server__injected_tool')).toThrow(TypeError);
    expect(() => snapshot.mcpDeny.push('mcp__server__allowed_tool')).toThrow(TypeError);
    expect(classifyPermission(snapshot, 'mcp__server__injected_tool')).toBe('default-gated');
    expect(classifyPermission(snapshot, 'mcp__server__allowed_tool')).toBe('allow');
  });

  it('includes the bridge print-mode MCP permission in every snapshot (fork: lib/session-settings.js allow-list)', () => {
    const snapshot = buildPermissionSnapshot({ sourcePaths: [] });

    expect(snapshot.mcpDeny).toEqual([]);
    expect(snapshot.mcpAsk).toEqual([]);
    expect(snapshot.uncertain).toBe(false);
    expect(classifyPermission(snapshot, 'mcp__show-file__show_file')).toBe('allow');
    // Anything else is still default-gated (fail-closed).
    expect(classifyPermission(snapshot, 'mcp__other__tool')).toBe('default-gated');
  });
});

describe('print-session snapshot wiring (source inspection)', () => {
  const indexSource = readFileSync(path.resolve('index.js'), 'utf8');
  const printSpawn = indexSource.slice(
    indexSource.indexOf('function createSession('),
    indexSource.indexOf('// --- Codex programmatic sessions ---'),
  );

  it('builds one immutable snapshot per print session (read by both the card hook and the classifier)', () => {
    expect(printSpawn).toContain('permissionSnapshot: buildPermissionSnapshot({ workdir: cwd })');
    expect((printSpawn.match(/permissionSnapshot[,:]/g) || [])).toHaveLength(1);
  });
});
