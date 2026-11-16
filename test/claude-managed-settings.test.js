import { describe, it, expect } from 'vitest';
import {
  managedSettingsLocations, readManagedSettings, managedHookPolicy, foreignGateBlockedReason, MANAGED_GATE_HOOK,
} from '../lib/claude-managed-settings.js';

// A fake file system holding just the managed settings files.
function fakeFs(files) {
  return {
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    readdirSync: (dir) => {
      const names = Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
      if (!names.length) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return names;
    },
  };
}
const BASE = '/etc/claude-code/managed-settings.json';
const DROP = '/etc/claude-code/managed-settings.d';
const opts = (files) => ({ platform: 'linux', fsImpl: fakeFs(files) });
const gateHook = (matcher = '*') => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `node /opt/bridge/hooks/${MANAGED_GATE_HOOK}.mjs --port 9802` }] }] } });

describe('managedSettingsLocations', () => {
  it('names the file and drop-in directory per platform', () => {
    expect(managedSettingsLocations('linux')).toEqual({ file: BASE, dropInDir: DROP });
    expect(managedSettingsLocations('darwin').file).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(managedSettingsLocations('win32', { ProgramFiles: 'C:\\Program Files' }).file).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  });
});

describe('readManagedSettings', () => {
  it('reads the base file, then drop-ins in name order, skipping what does not parse', () => {
    const got = readManagedSettings(opts({
      [BASE]: '{"a":1}',
      [`${DROP}/20-b.json`]: '{"b":2}',
      [`${DROP}/10-a.json`]: '{"c":3}',
      [`${DROP}/30-bad.json`]: 'nope',
      [`${DROP}/notes.txt`]: '{"d":4}',
    }));
    expect(got).toEqual([{ a: 1 }, { c: 3 }, { b: 2 }]);
  });

  it('is empty when there are no managed settings', () => {
    expect(readManagedSettings(opts({}))).toEqual([]);
  });
});

describe('foreignGateBlockedReason', () => {
  it('nothing managed: the bridge hooks run and the gate is there', () => {
    expect(foreignGateBlockedReason(opts({}))).toBe(null);
    expect(managedHookPolicy(opts({}))).toEqual({ allHooksOff: false, bridgeHooksRun: true, managedGate: false });
  });

  it('managed hooks only, without the managed gate: blocked', () => {
    const o = opts({ [BASE]: JSON.stringify({ allowManagedHooksOnly: true, hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/tool-guard' }] }] } }) });
    expect(foreignGateBlockedReason(o)).toMatch(/allowManagedHooksOnly/);
    expect(managedHookPolicy(o).bridgeHooksRun).toBe(false);
  });

  it('managed hooks only, with the managed gate for every tool: not blocked', () => {
    expect(foreignGateBlockedReason(opts({ [BASE]: JSON.stringify({ allowManagedHooksOnly: true, ...gateHook() }) }))).toBe(null);
    expect(foreignGateBlockedReason(opts({ [BASE]: JSON.stringify({ allowManagedHooksOnly: true, ...gateHook('.*') }) }))).toBe(null);
  });

  it('the gate may come from a drop-in file', () => {
    expect(foreignGateBlockedReason(opts({
      [BASE]: JSON.stringify({ allowManagedHooksOnly: true }),
      [`${DROP}/50-gate.json`]: JSON.stringify(gateHook()),
    }))).toBe(null);
  });

  it('a gate that only covers some tools does not count', () => {
    expect(foreignGateBlockedReason(opts({ [BASE]: JSON.stringify({ allowManagedHooksOnly: true, ...gateHook('Bash') }) }))).toMatch(/allowManagedHooksOnly/);
  });

  it('counts the exec form, where the script is an argument', () => {
    const exec = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node.exe', args: [`C:\\bridge\\hooks\\${MANAGED_GATE_HOOK}.mjs`] }] }] } };
    expect(foreignGateBlockedReason(opts({ [BASE]: JSON.stringify({ allowManagedHooksOnly: true, ...exec }) }))).toBe(null);
  });

  it('all hooks off: blocked, even with the managed gate', () => {
    expect(foreignGateBlockedReason(opts({ [BASE]: JSON.stringify({ disableAllHooks: true, ...gateHook() }) }))).toMatch(/disableAllHooks/);
  });
});
