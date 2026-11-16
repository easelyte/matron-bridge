// Claude Code's managed settings, as far as the foreign-turn gate needs them.
//
// The gate (lib/foreign-turn.js) is a PreToolUse hook the bridge passes each
// Claude session in --settings. An administrator's managed settings can stop
// those hooks from running:
//   - `disableAllHooks: true` turns every hook off, managed ones included;
//   - `allowManagedHooksOnly: true` runs only the hooks the managed settings
//     list themselves.
// In the second case the gate can still run as a managed hook
// (hooks/foreign-gate-managed.mjs). With neither the bridge's own hook nor a
// managed one, a turn started by another person would run ungated, so the
// bridge does not start such turns (index.js foreignGateBlocked).
//
// This module only reads files; it decides nothing about any one session.
// It reads the file-based managed settings only. Claude Code can also take
// managed settings from a macOS configuration profile or the Windows
// registry; a policy set only there is not seen, and the bridge then behaves
// as it did before it read managed settings at all.
import fs from 'node:fs';
import path from 'node:path';

// The name a managed PreToolUse hook command must contain to count as the
// gate.
export const MANAGED_GATE_HOOK = 'foreign-gate-managed';

// Where Claude Code looks for managed settings: one file, plus drop-in JSON
// files in a directory beside it.
export function managedSettingsLocations(platform = process.platform, env = process.env) {
  let dir;
  if (platform === 'darwin') dir = '/Library/Application Support/ClaudeCode';
  else if (platform === 'win32') dir = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode');
  else dir = '/etc/claude-code';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return { file: join(dir, 'managed-settings.json'), dropInDir: join(dir, 'managed-settings.d') };
}

// Every managed settings object found, base file first, then the drop-ins in
// name order. A file that cannot be read or parsed is skipped.
export function readManagedSettings({ platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  const { file, dropInDir } = managedSettingsLocations(platform, env);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const out = [];
  const readOne = (p) => {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch { /* missing or unreadable: not a setting */ }
  };
  readOne(file);
  let names;
  try { names = fsImpl.readdirSync(dropInDir).filter((n) => n.endsWith('.json')).sort(); } catch { names = []; }
  for (const n of names) readOne(join(dropInDir, n));
  return out;
}

// Does any PreToolUse hook in these settings run the managed gate, for every
// tool? Only a matcher that covers every tool counts: a gate that skips some
// tools gates nothing for them.
function hasManagedGate(settings) {
  for (const s of settings) {
    const entries = Array.isArray(s?.hooks?.PreToolUse) ? s.hooks.PreToolUse : [];
    for (const e of entries) {
      const matcher = e?.matcher;
      if (!(matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*')) continue;
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        const words = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].filter((w) => typeof w === 'string');
        if (h?.type === 'command' && words.some((w) => w.includes(MANAGED_GATE_HOOK))) return true;
      }
    }
  }
  return false;
}

// What the managed settings allow: whether the hooks the bridge passes in
// --settings run at all, and whether the managed gate stands in for them.
export function managedHookPolicy(opts = {}) {
  const settings = readManagedSettings(opts);
  const allHooksOff = settings.some((s) => s.disableAllHooks === true);
  const managedOnly = settings.some((s) => s.allowManagedHooksOnly === true);
  return { allHooksOff, bridgeHooksRun: !allHooksOff && !managedOnly, managedGate: !allHooksOff && hasManagedGate(settings) };
}

// Why the gate cannot run here, in words for a notice, or null when it can.
export function foreignGateBlockedReason(opts = {}) {
  const p = managedHookPolicy(opts);
  if (p.allHooksOff) return "Claude Code's managed settings turn off all hooks (disableAllHooks)";
  if (!p.bridgeHooksRun && !p.managedGate) {
    return `Claude Code's managed settings run only managed hooks (allowManagedHooksOnly), and none of them is the bridge's ${MANAGED_GATE_HOOK} hook`;
  }
  return null;
}
