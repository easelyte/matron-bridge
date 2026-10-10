// fork delta: withForkPrintSettings composes the fork's print-session
// settings (tool allow-list + permission-card hook) onto upstream's
// buildPrintSessionSettings without double-gating a gated session.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { withForkPrintSettings } from '../lib/session-settings.js';
import { buildPrintSessionSettings } from '../lib/permission-prompt.js';

const hooksDir = path.resolve('hooks');
const compose = (bypass) => withForkPrintSettings(
  buildPrintSessionSettings({ bypass, hooksDir, apiPort: 8787, roomId: '!r:x' }),
  { bypass },
);
const mcpHooks = (settings) => settings.hooks.PreToolUse
  .filter(h => h.matcher === 'mcp__.*')
  .flatMap(h => h.hooks.map(x => x.command));

describe('withForkPrintSettings', () => {
  it('bypass: adds the permission-card hook as the only MCP gate', () => {
    const cmds = mcpHooks(compose(true));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBe(path.join(hooksDir, 'permission-decision.sh'));
  });

  it('gated: keeps only upstream\'s permission-gate hook (no double gate)', () => {
    const cmds = mcpHooks(compose(false));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('permission-gate.mjs');
    expect(cmds.join(' ')).not.toContain('permission-decision.sh');
  });

  it('unions the allow-lists without duplicates and keeps upstream\'s infra MCP allows', () => {
    for (const bypass of [true, false]) {
      const allow = compose(bypass).permissions.allow;
      expect(new Set(allow).size).toBe(allow.length);
      expect(allow).toContain('mcp__show-file__show_file');
      expect(allow).toContain('Bash(*)');
      expect(allow.some(a => a.startsWith('mcp__ask-user'))).toBe(true);
    }
  });

  it('keeps the Bash tee + PreCompact hooks exactly once and preserves disableAllHooks on gated', () => {
    for (const bypass of [true, false]) {
      const s = compose(bypass);
      expect(s.hooks.PreToolUse.filter(h => h.matcher === 'Bash')).toHaveLength(1);
      expect(s.hooks.PreCompact).toHaveLength(1);
      if (!bypass) expect(s.disableAllHooks).toBe(false);
    }
  });
});
