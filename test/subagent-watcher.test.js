import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { subagentsDirFor } from '../lib/subagent-watcher.js';

// The subagents transcript dir is derived from the session workdir the exact
// way Claude Code encodes a project cwd: EVERY non-alphanumeric char becomes a
// dash — not just `/`. A `.` in the path must encode to `-`, so
// `/root/.openclaw/workspace` maps to `-root--openclaw-workspace` (double
// dash), NOT `-root-.openclaw-workspace`. The old `/`-only replacement made
// the watcher poll a nonexistent dir and never discover any agent-*.jsonl, so
// no subagent child conversations were ever created.
describe('subagentsDirFor', () => {
  it('encodes a DOTTED workdir with every non-alphanumeric char as a dash (dot → dash)', () => {
    const dir = subagentsDirFor('/root/.openclaw/workspace', 'sid-9');
    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'projects', '-root--openclaw-workspace', 'sid-9', 'subagents',
    ));
    // Regression pin: the dot must NOT survive as a literal `.` in the encoded
    // segment (the pre-fix `/`-only bug produced `-root-.openclaw-workspace`).
    expect(dir).not.toContain('-root-.openclaw-workspace');
  });

  it('still encodes a dot-free workdir exactly as before (no behavior change)', () => {
    const dir = subagentsDirFor('/home/danbarker/foo', 'abc-123');
    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'projects', '-home-danbarker-foo', 'abc-123', 'subagents',
    ));
  });
});
