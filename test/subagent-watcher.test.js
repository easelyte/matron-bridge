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

// A subagent RESUMED via SendMessage comes back to life under its ORIGINAL
// agent id, and therefore its ORIGINAL agent-<id>.jsonl. snapshot() marks every
// pre-existing transcript "seen" so a dead prior instance is never replayed —
// correct for an agent that stays dead, but it also permanently blinds _scan()
// to the resumed one: the file is appended to, never re-created, so the burst
// poll has nothing new to find. The resumed agent then runs its whole life with
// no tail, no `subagent-start`, and no card in the web UI.
//
// task_started carries task_id, and task_id IS the filename stem, so the bridge
// can target that exact agent — no need to relax snapshot() and risk replaying
// agents that really are dead.
describe('SubagentWatcher.forceAttach (resumed agent under an already-seen transcript)', () => {
  const watchers = [];
  const projectRoots = [];

  afterEach(async () => {
    for (const w of watchers.splice(0)) { try { await w.stop(); } catch { /* ignore */ } }
    for (const d of projectRoots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  const uniqueWorkdir = tag => `/tmp/bridge-resume-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`;

  const mkSubagentsDir = (workdir, sessionId) => {
    const dir = subagentsDirFor(workdir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    projectRoots.push(path.dirname(path.dirname(path.dirname(dir))));
    return dir;
  };

  // A watcher over a subagents dir that already holds `agent-<id>.jsonl` with
  // `priorLines` of history — the post-restart state: the transcript is the
  // earlier run's, and snapshot() has marked it seen.
  const mkResumedFixture = (agentId, priorLines = []) => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir('resume');
    const dir = mkSubagentsDir(workdir, sessionId);
    const file = path.join(dir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(file, priorLines.map(l => JSON.stringify(l) + '\n').join(''));
    const w = new SubagentWatcher({ workdir, sessionId });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    const events = [];
    w.on('subagent-start', p => starts.push(p.agentId));
    w.on('subagent-event', p => events.push(p.event));
    return { w, dir, file, starts, events };
  };

  const assistantLine = text => ({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: {}, content: [{ type: 'text', text }] },
  });

  const appendLine = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

  // Give the tail's 100ms stat poll a couple of ticks to notice the append.
  const settle = () => new Promise(r => setTimeout(r, 350));

  it('attaches and emits a card for an agent the snapshot already marked seen', async () => {
    const { w, starts } = mkResumedFixture('resumed1', [assistantLine('old work')]);

    // The bug: the burst scan can never re-find it.
    w._scan();
    expect(starts).toEqual([]);

    expect(w.forceAttach('resumed1')).toBe(true);
    expect(starts).toEqual(['resumed1']);
    expect(w.tails.has('agent-resumed1.jsonl')).toBe(true);
  });

  it('starts the resumed tail at EOF — the earlier run is not replayed into the card', async () => {
    const { w, file, events } = mkResumedFixture('resumed2', [
      assistantLine('history line 1'),
      assistantLine('history line 2'),
    ]);

    w.forceAttach('resumed2');
    await settle();
    // Nothing from before the resume.
    expect(events).toEqual([]);

    // ...but the tail IS live: what the resumed agent writes from now on lands.
    appendLine(file, assistantLine('fresh work'));
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0].message.content[0].text).toBe('fresh work');
  });

  it('is idempotent — a duplicate task_started neither double-attaches nor emits a second card', async () => {
    const { w, starts } = mkResumedFixture('resumed3', [assistantLine('old')]);

    expect(w.forceAttach('resumed3')).toBe(true);
    const tail = w.tails.get('agent-resumed3.jsonl').tail;

    expect(w.forceAttach('resumed3')).toBe(false);
    expect(starts).toEqual(['resumed3']);
    expect(w.tails.size).toBe(1);
    expect(w.tails.get('agent-resumed3.jsonl').tail).toBe(tail);
  });

  it('leaves the filename seen, so a later burst scan does not attach it a second time', async () => {
    const { w, starts } = mkResumedFixture('resumed4', [assistantLine('old')]);

    w.forceAttach('resumed4');
    w._scan();
    w._scan();

    expect(starts).toEqual(['resumed4']);
    expect(w.tails.size).toBe(1);
  });

  it('does NOT replay a pre-existing agent that was never resumed', async () => {
    const { w, dir, starts } = mkResumedFixture('resumed5', [assistantLine('old')]);
    // A second, genuinely-dead prior-instance transcript sitting in the dir.
    fs.writeFileSync(path.join(dir, 'agent-deadghost.jsonl'), JSON.stringify(assistantLine('ghost')) + '\n');
    w.snapshot();          // already taken — the dead file is marked by _scan below
    w._scan();
    expect(starts).toEqual([]);

    w.forceAttach('resumed5');

    // Only the explicitly-named agent came back. The ghost stays dead.
    expect(starts).toEqual(['resumed5']);
    expect(w.tails.has('agent-deadghost.jsonl')).toBe(false);
  });

  it('no-ops for a fresh spawn (transcript not yet on disk) — the burst scan owns that path', async () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir('fresh');
    const dir = mkSubagentsDir(workdir, sessionId);
    const w = new SubagentWatcher({ workdir, sessionId });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    w.on('subagent-start', p => starts.push(p.agentId));

    // task_started can beat the transcript to disk.
    expect(w.forceAttach('brandnew')).toBe(false);
    expect(starts).toEqual([]);

    // The file lands; the ordinary scan picks it up WITH replay (a fresh agent's
    // first lines may already be written by the time the burst polls).
    fs.writeFileSync(path.join(dir, 'agent-brandnew.jsonl'), JSON.stringify(assistantLine('first')) + '\n');
    w._scan();
    expect(starts).toEqual(['brandnew']);
    const { tail } = w.tails.get('agent-brandnew.jsonl');
    expect(tail.readFromStart).toBe(true);

    // And a forceAttach arriving after the scan does not double it.
    expect(w.forceAttach('brandnew')).toBe(false);
    expect(starts).toEqual(['brandnew']);
  });

  it('rejects a junk agent id without throwing', () => {
    const { w } = mkResumedFixture('resumed6', []);
    expect(w.forceAttach('')).toBe(false);
    expect(w.forceAttach(null)).toBe(false);
    expect(w.forceAttach(undefined)).toBe(false);
  });
});

// The bridge must actually CALL the above on a local_agent task_started, and
// must revive the child convo alongside it — otherwise the tail streams into a
// card the server still believes is `done`.
describe('index.js subagent-resume wiring (source inspection)', () => {
  const indexSrc = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('force-attaches the named agent and revives its child convo in the local_agent task_started branch', () => {
    const branch = indexSrc.slice(indexSrc.indexOf("event.task_type === 'local_agent'"));
    const body = branch.slice(0, branch.indexOf('task_notification'));
    expect(body).toContain('noteBackgroundTaskStarted(event.tool_use_id, event.task_id)');
    expect(body).toContain('notifyTaskStarted()');
    expect(body).toContain('forceAttach(event.task_id)');
    expect(body).toContain('revive(event.task_id)');
  });
});
