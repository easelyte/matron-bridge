// The gated-session MCP permission gate: the PreToolUse hook the bridge adds in
// its inline --settings (hooks/permission-gate.mjs), the /permission-check
// decision it asks for, and a behavioural check that a gated session still
// loads the on-disk settings sources (CLAUDE.md, env, settings hooks).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  permissionSpawnArgs,
  buildPrintSessionSettings,
  isGatedMcpTool,
  resolvePermissionCheck,
  permissionGateHookOutput,
  DENY_MESSAGE,
} from '../lib/permission-prompt.js';

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const GATE_HOOK = path.join(HOOKS_DIR, 'permission-gate.mjs');

function snapshot({ allow = [], deny = [], ask = [], uncertain = false } = {}) {
  return Object.freeze({
    mcpAllow: Object.freeze([...allow]),
    mcpDeny: Object.freeze([...deny]),
    mcpAsk: Object.freeze([...ask]),
    uncertain,
  });
}

function gateCommand(settings) {
  const entry = settings.hooks.PreToolUse.find(e => e.matcher === 'mcp__.*');
  return entry?.hooks[0];
}

describe('buildPrintSessionSettings', () => {
  it('gated: adds the MCP permission gate hook next to the bridge hooks', () => {
    const settings = buildPrintSessionSettings({ bypass: false, hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room-1', platform: 'linux' });
    // Pinned on: the inline --settings layer outranks the project and user
    // settings files, so an on-disk `disableAllHooks: true` cannot switch the
    // gate off (verified against the real CLI below).
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.permissions.allow).toEqual(['mcp__ask-user', 'mcp__show-file']);
    expect(settings.hooks.PreCompact[0].hooks[0].command).toBe(path.posix.join(HOOKS_DIR, 'compact-notify.sh'));
    expect(settings.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: path.posix.join(HOOKS_DIR, 'matron-bash-tee.sh') }],
    });
    const gate = gateCommand(settings);
    expect(gate.type).toBe('command');
    expect(gate.command).toBe(`node '${path.posix.join(HOOKS_DIR, 'permission-gate.mjs')}' --port '9802' --room 'room-1'`);
    expect(gate.timeout).toBeGreaterThan(10);
  });

  it('win32: every bridge hook is exec form — node.exe + the .mjs port + literal args, no shell', () => {
    const settings = buildPrintSessionSettings({ bypass: false, hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'room 1', platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
    expect(settings.hooks.PreCompact[0].hooks[0]).toEqual({ type: 'command', command: 'C:\\nodejs\\node.exe', args: [path.win32.join(HOOKS_DIR, 'compact-notify.mjs')], timeout: 5 });
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'C:\\nodejs\\node.exe', args: [path.win32.join(HOOKS_DIR, 'matron-bash-tee.mjs')] });
    const gate = gateCommand(settings);
    expect(gate.command).toBe('C:\\nodejs\\node.exe');
    expect(gate.args).toEqual([path.win32.join(HOOKS_DIR, 'permission-gate.mjs'), '--port', '9802', '--room', 'room 1']);
  });

  it('bypass: no gate hook (nothing is gated)', () => {
    const settings = buildPrintSessionSettings({ bypass: true, hooksDir: HOOKS_DIR, apiPort: 9802, roomId: 'r' });
    expect(gateCommand(settings)).toBeUndefined();
    // Nothing to protect in a bypass session: leave the user's hooks setting alone.
    expect(settings).not.toHaveProperty('disableAllHooks');
  });

  it('quotes the hooks dir and room id for the shell', () => {
    const settings = buildPrintSessionSettings({ bypass: false, hooksDir: "/opt/it's here/hooks", apiPort: 9802, roomId: "!a'b;$(x)", platform: 'linux' });
    expect(gateCommand(settings).command)
      .toBe(`node '/opt/it'\\''s here/hooks/permission-gate.mjs' --port '9802' --room '!a'\\''b;$(x)'`);
  });

  it('gated spawn args no longer drop the settings sources', () => {
    expect(permissionSpawnArgs(false)).not.toContain('--setting-sources');
  });
});

describe('isGatedMcpTool', () => {
  it('gates third-party MCP tools only', () => {
    expect(isGatedMcpTool('mcp__webflow__pages_update')).toBe(true);
    expect(isGatedMcpTool('mcp__ask-user__permission_request')).toBe(false);
    expect(isGatedMcpTool('mcp__show-file__show_file')).toBe(false);
    expect(isGatedMcpTool('mcp__ask-user')).toBe(false);
    expect(isGatedMcpTool('Bash')).toBe(false);
    expect(isGatedMcpTool('mcp__')).toBe(false);
    expect(isGatedMcpTool(undefined)).toBe(false);
  });
});

describe('resolvePermissionCheck (POST /permission-check)', () => {
  const snap = snapshot({
    allow: ['mcp__webflow__pages_get'],
    deny: ['mcp__webflow__pages_delete'],
    ask: ['mcp__webflow__pages_update'],
  });

  it('a session grant allows before the classifier', () => {
    const out = resolvePermissionCheck({
      permAllowedTools: new Set(['mcp__webflow__pages_delete']),
      snapshot: snap,
      toolName: 'mcp__webflow__pages_delete',
    });
    expect(out).toEqual({ body: { decision: 'allow' } });
  });

  it('classifier allow → allow, no notice', () => {
    expect(resolvePermissionCheck({ permAllowedTools: new Set(), snapshot: snap, toolName: 'mcp__webflow__pages_get' }))
      .toEqual({ body: { decision: 'allow' } });
  });

  it('classifier deny → deny with the policy message and a room notice', () => {
    const out = resolvePermissionCheck({ permAllowedTools: new Set(), snapshot: snap, toolName: 'mcp__webflow__pages_delete' });
    expect(out.body).toEqual({ decision: 'deny', message: DENY_MESSAGE });
    expect(out.notice).toBe('⛔ blocked `mcp__webflow__pages_delete` by policy');
  });

  it('ask rule, unlisted tool, or uncertain snapshot → ask (never a card here)', () => {
    expect(resolvePermissionCheck({ permAllowedTools: new Set(), snapshot: snap, toolName: 'mcp__webflow__pages_update' }).body)
      .toEqual({ decision: 'ask' });
    expect(resolvePermissionCheck({ permAllowedTools: new Set(), snapshot: snap, toolName: 'mcp__other__x' }).body)
      .toEqual({ decision: 'ask' });
    const uncertain = snapshot({ allow: ['mcp__webflow__pages_get'], uncertain: true });
    expect(resolvePermissionCheck({ permAllowedTools: new Set(), snapshot: uncertain, toolName: 'mcp__webflow__pages_get' }).body)
      .toEqual({ decision: 'ask' });
  });
});

describe('permissionGateHookOutput', () => {
  const decision = (data) => permissionGateHookOutput(data).hookSpecificOutput.permissionDecision;
  it('maps allow / deny / ask and fails closed to ask on anything else', () => {
    expect(decision({ decision: 'allow' })).toBe('allow');
    expect(decision({ decision: 'deny', message: 'no' })).toBe('deny');
    expect(permissionGateHookOutput({ decision: 'deny', message: 'no' }).hookSpecificOutput.permissionDecisionReason).toBe('no');
    expect(permissionGateHookOutput({ decision: 'deny' }).hookSpecificOutput.permissionDecisionReason).toBe(DENY_MESSAGE);
    expect(decision({ decision: 'ask' })).toBe('ask');
    for (const bad of [null, undefined, 'allow', {}, { decision: 'ALLOW' }, { behavior: 'allow' }]) {
      expect(decision(bad)).toBe('ask');
    }
  });
});

// Run the real hook script the way the CLI does: JSON on stdin, env from the
// spawned session, decision JSON on stdout.
function runGateHook(input, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE_HOOK, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, json: out ? JSON.parse(out) : null }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// A stand-in for the bridge's loopback API that decides with the SAME
// resolvePermissionCheck the real /permission-check route uses.
describe('permission-gate hook → bridge decision (end to end)', () => {
  let server;
  let port;
  const notices = [];
  const requests = [];
  let mode = 'normal';
  const sessionState = {
    permAllowedTools: new Set(['mcp__granted__tool']),
    snapshot: snapshot({ allow: ['mcp__webflow__pages_get'], deny: ['mcp__webflow__pages_delete'] }),
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const data = JSON.parse(body || '{}');
        requests.push({ url: req.url, data });
        if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
        if (mode === 'garbage') { res.writeHead(200); res.end('not json'); return; }
        if (req.url !== '/permission-check' || data.roomId !== 'room-1') { res.writeHead(404); res.end('{}'); return; }
        const check = resolvePermissionCheck({ ...sessionState, toolName: data.toolName });
        if (check.notice) notices.push(check.notice);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(check.body));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterAll(() => new Promise(r => server.close(r)));

  const args = () => ['--port', String(port), '--room', 'room-1'];
  const decide = async (toolName) => (await runGateHook({ tool_name: toolName, tool_input: {} }, args())).json
    ?.hookSpecificOutput.permissionDecision;

  it('the bridge classifier decides a gated MCP call: allow, deny (with notice), ask', async () => {
    mode = 'normal';
    expect(await decide('mcp__webflow__pages_get')).toBe('allow');
    expect(await decide('mcp__granted__tool')).toBe('allow');
    expect(await decide('mcp__webflow__pages_delete')).toBe('deny');
    expect(notices).toContain('⛔ blocked `mcp__webflow__pages_delete` by policy');
    expect(await decide('mcp__unlisted__tool')).toBe('ask');
    expect(requests.filter(r => r.url === '/permission-check').map(r => r.data.toolName))
      .toEqual(['mcp__webflow__pages_get', 'mcp__granted__tool', 'mcp__webflow__pages_delete', 'mcp__unlisted__tool']);
  });

  it('infra MCP tools and non-MCP tools pass through without asking the bridge', async () => {
    mode = 'normal';
    const before = requests.length;
    for (const name of ['mcp__ask-user__permission_request', 'mcp__show-file__show_file', 'Bash']) {
      const r = await runGateHook({ tool_name: name }, args());
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
    }
    expect(requests.length).toBe(before);
  });

  it('fails closed to ask when the bridge is unreachable', async () => {
    const dead = createServer();
    await new Promise(r => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise(r => dead.close(r));
    const r = await runGateHook({ tool_name: 'mcp__webflow__pages_get' }, ['--port', String(deadPort), '--room', 'room-1']);
    expect(r.code).toBe(0);
    expect(r.json.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('ignores environment overrides of the bridge address (pinned at spawn)', async () => {
    mode = 'normal';
    const rogue = createServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ decision: 'allow' })); });
    await new Promise(r => rogue.listen(0, '127.0.0.1', r));
    const rogueUrl = `http://127.0.0.1:${rogue.address().port}`;
    try {
      const r = await runGateHook({ tool_name: 'mcp__unlisted__tool' }, args(), {
        BRIDGE_API_URL: rogueUrl, MATRON_BRIDGE_API_PORT: String(rogue.address().port), BRIDGE_ROOM_ID: 'x',
      });
      expect(r.json.hookSpecificOutput.permissionDecision).toBe('ask');
    } finally {
      await new Promise(r => rogue.close(r));
    }
  });

  it('fails closed to ask on an HTTP error, a non-JSON body, a missing room, or bad hook input', async () => {
    mode = 'error';
    expect(await decide('mcp__webflow__pages_get')).toBe('ask');
    mode = 'garbage';
    expect(await decide('mcp__webflow__pages_get')).toBe('ask');
    mode = 'normal';
    const noRoom = await runGateHook({ tool_name: 'mcp__webflow__pages_get' }, ['--port', String(port)]);
    expect(noRoom.json.hookSpecificOutput.permissionDecision).toBe('ask');
    const badPort = await runGateHook({ tool_name: 'mcp__webflow__pages_get' }, ['--port', 'nope', '--room', 'room-1']);
    expect(badPort.json.hookSpecificOutput.permissionDecision).toBe('ask');
    const badInput = await runGateHook('{not json', args());
    expect(badInput.json.hookSpecificOutput.permissionDecision).toBe('ask');
  });
});

// Behavioural: spawn the real Claude Code CLI with the exact gated spawn args
// and inline settings the bridge uses, in a project that has a CLAUDE.md and a
// .claude/settings.json with an `env` block and hooks. The project's
// UserPromptSubmit hook blocks the prompt (exit 2), so no model call is made.
// Skipped where the `claude` binary is not installed (e.g. CI).
const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasClaude)('gated session keeps the on-disk settings sources (real CLI)', () => {
  it('loads the project CLAUDE.md, the settings env block and settings hooks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-gate-behaviour-'));
    try {
      const proj = path.join(dir, 'proj');
      const marks = path.join(dir, 'marks');
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
      fs.mkdirSync(marks);
      fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'Project instructions sentinel.\n');
      fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
        env: { PERM_GATE_SENTINEL: 'from-settings-env' },
        // The bridge's inline settings must outrank this, or the gate is off.
        // (The hooks below only run if they do.)
        disableAllHooks: true,
        hooks: {
          InstructionsLoaded: [{ hooks: [{ type: 'command', command: `cat > '${marks}'/instructions-$$.json` }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo "$PERM_GATE_SENTINEL" > '${marks}/prompt-hook.txt'; echo blocked-by-test >&2; exit 2` }] }],
        },
      }));
      const args = [
        '--print', 'hello',
        ...permissionSpawnArgs(false),
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
        '--settings', JSON.stringify(buildPrintSessionSettings({ bypass: false, hooksDir: HOOKS_DIR, apiPort: 9, roomId: 'behaviour' })),
      ];
      const env = { ...process.env, CLAUDECODE: '' };
      delete env.PERM_GATE_SENTINEL;
      const run = spawnSync('claude', args, { cwd: proj, env, encoding: 'utf8', timeout: 90_000, input: '' });
      expect(run.error).toBeUndefined();

      // Settings hook ran, and saw the settings `env` block.
      expect(fs.readFileSync(path.join(marks, 'prompt-hook.txt'), 'utf8').trim()).toBe('from-settings-env');
      // The project CLAUDE.md was loaded into the session.
      const loaded = fs.readdirSync(marks)
        .filter(f => f.startsWith('instructions-'))
        .map(f => JSON.parse(fs.readFileSync(path.join(marks, f), 'utf8')).file_path);
      expect(loaded).toContain(fs.realpathSync(path.join(proj, 'CLAUDE.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
