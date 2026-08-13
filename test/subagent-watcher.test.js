import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentWatcher, subagentsDirFor } from '../lib/subagent-watcher.js';

// subagentsDirFor is re-exported from the shared lib/transcript-dir.js encoder;
// this pins the watcher's public entry point. The subagents dir is derived from
// the session workdir the exact way Claude Code encodes a project cwd: EVERY
// non-alphanumeric char becomes a dash — not just `/`. A `.` must encode to `-`,
// so `/home/dan/.config/ws` maps to `-home-dan--config-ws` (double dash), NOT
// `-home-dan-.config-ws`. The old `/`-only replacement made the watcher poll a
// nonexistent dir and never discover any agent-*.jsonl, so no subagent child
// conversations were ever created.
describe('subagentsDirFor', () => {
  it('encodes a DOTTED workdir with every non-alphanumeric char as a dash (dot → dash)', () => {
    const dir = subagentsDirFor('/home/dan/.config/ws', 'sid-9');
    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'projects', '-home-dan--config-ws', 'sid-9', 'subagents',
    ));
    // Regression pin: the dot must NOT survive as a literal `.` in the encoded
    // segment (the pre-fix `/`-only bug produced `-home-dan-.config-ws`).
    expect(dir).not.toContain('-home-dan-.config-ws');
  });

  it('still encodes a dot-free workdir exactly as before (no behavior change)', () => {
    const dir = subagentsDirFor('/home/danbarker/foo', 'abc-123');
    expect(dir).toBe(path.join(
      os.homedir(), '.claude', 'projects', '-home-danbarker-foo', 'abc-123', 'subagents',
    ));
  });
});

// When a session changes cwd mid-flight (EnterWorktree), Claude Code re-homes
// the subagents dir to the NEW cwd's project encoding. The watcher must follow,
// or it keeps polling the stale spawn-cwd dir and subagent cards stop rendering
// (loop #631). repoint() recomputes this.dir, re-snapshots the new dir (so a
// prior instance's files there aren't replayed), and KEEPS the seen set so
// already-emitted cards don't duplicate.
describe('SubagentWatcher.repoint (cwd rehome / EnterWorktree)', () => {
  const watchers = [];
  const projectRoots = [];

  afterEach(async () => {
    for (const w of watchers.splice(0)) { try { await w.stop(); } catch { /* ignore */ } }
    for (const d of projectRoots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  const uniqueWorkdir = tag => `/tmp/bridge631-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`;

  // The real subagents dir for (workdir, sessionId), created on disk. Registers
  // the encoded project root (…/projects/<enc>) for teardown.
  const mkSubagentsDir = (workdir, sessionId) => {
    const dir = subagentsDirFor(workdir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // …/projects/<enc>/<sid>/subagents → up three to …/projects/<enc>
    projectRoots.push(path.dirname(path.dirname(path.dirname(dir))));
    return dir;
  };

  it('re-points this.dir to the new workdir and preserves the seen set', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const A = uniqueWorkdir('A');
    const B = uniqueWorkdir('B');
    const w = new SubagentWatcher({ workdir: A, sessionId });
    watchers.push(w);
    expect(w.dir).toBe(subagentsDirFor(A, sessionId));
    // Simulate a card already emitted while the session was at cwd A.
    w.seen.add('agent-old.jsonl');

    const moved = w.repoint(B);

    expect(moved).toBe(true);
    expect(w.dir).toBe(subagentsDirFor(B, sessionId));
    expect(w.workdir).toBe(B);
    // seen carried across the move → the old card never re-emits.
    expect(w.seen.has('agent-old.jsonl')).toBe(true);
  });

  it('is a no-op (returns false) when the encoded dir is unchanged', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const A = uniqueWorkdir('same');
    const w = new SubagentWatcher({ workdir: A, sessionId });
    watchers.push(w);
    const before = w.dir;
    expect(w.repoint(A)).toBe(false);
    expect(w.dir).toBe(before);
  });

  it('snapshots pre-existing files in the new dir but attaches genuinely-new ones', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const A = uniqueWorkdir('preA');
    const B = uniqueWorkdir('preB');
    mkSubagentsDir(A, sessionId);
    const dirB = mkSubagentsDir(B, sessionId);
    // A subagent file already sitting under B (e.g. a prior instance) must NOT
    // replay as a fresh card on re-point.
    fs.writeFileSync(path.join(dirB, 'agent-preexisting.jsonl'), '');

    const w = new SubagentWatcher({ workdir: A, sessionId });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    w.on('subagent-start', p => starts.push(p.agentId));

    w.repoint(B);
    expect(starts).toEqual([]);
    expect(w.seen.has('agent-preexisting.jsonl')).toBe(true);

    // A genuinely-new subagent appears under B after the move → picked up.
    fs.writeFileSync(path.join(dirB, 'agent-new.jsonl'), '');
    w._scan();
    expect(starts).toContain('new');
  });
});
