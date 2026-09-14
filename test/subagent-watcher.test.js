import { describe, it, expect, afterEach, vi } from 'vitest';
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
  // Used only for NEGATIVE assertions (nothing should arrive) — under load a
  // fixed sleep can only make those pass spuriously, never fail spuriously.
  const settle = () => new Promise(r => setTimeout(r, 350));

  // Positive assertions poll instead of sleeping: the tail's stat interval plus
  // a loaded CI worker is not a budget a fixed timeout can be trusted with.
  const waitForEvents = async (events, n, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (events.length < n && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    return events;
  };

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
    await waitForEvents(events, 1);
    expect(events).toHaveLength(1);
    expect(events[0].message.content[0].text).toBe('fresh work');
  });

  // Codex R1 F1: the agent is ALREADY RUNNING by the time task_started reaches
  // the bridge, so it can append records in that gap. Anchoring the tail at the
  // file's size NOW discards them — a fast resumed agent renders an empty card.
  // The boundary has to be the size recorded when the file was marked seen.
  it('emits output the resumed agent wrote between the snapshot and the attach', async () => {
    const { w, file, events } = mkResumedFixture('resumed-race', [
      assistantLine('history line 1'),
      assistantLine('history line 2'),
    ]);

    // The resumed run gets going before the bridge processes task_started.
    appendLine(file, assistantLine('written before the bridge noticed'));

    w.forceAttach('resumed-race');
    await waitForEvents(events, 1);

    // The in-gap record is the resumed run's output — it must NOT be treated
    // as history — and the earlier run is still not replayed.
    expect(events.map(e => e.message.content[0].text)).toEqual(['written before the bridge noticed']);

    appendLine(file, assistantLine('and the rest'));
    await waitForEvents(events, 2);
    expect(events.map(e => e.message.content[0].text)).toEqual([
      'written before the bridge noticed', 'and the rest',
    ]);
  });

  it('replays from the top when the same name is a DIFFERENT file than the one snapshotted', async () => {
    const { w, dir, file, events } = mkResumedFixture('resumed-swap', [assistantLine('history')]);
    // Rotation / replacement: same path, different file. Staged under a sibling
    // name and renamed over so the original inode is never freed (and so cannot
    // be handed straight back), making this a genuine identity change.
    const staged = path.join(dir, 'staged.jsonl.tmp');
    fs.writeFileSync(staged, JSON.stringify(assistantLine('all new')) + '\n');
    fs.renameSync(staged, file);

    w.forceAttach('resumed-swap');
    await waitForEvents(events, 1);

    expect(events.map(e => e.message.content[0].text)).toEqual(['all new']);
  });

  // Codex R1 F4: _scan() skips every `seen` name, so a force-attach that could
  // not read its transcript has no other recovery path. It must be retried, and
  // fail visibly rather than silently costing the whole resumed run.
  it('retries a force-attach whose transcript was not readable yet, then attaches it', async () => {
    const { w, dir, starts } = mkResumedFixture('resumed-late', [assistantLine('old')]);
    const file = path.join(dir, 'agent-resumed-late.jsonl');
    const stashed = fs.readFileSync(file);
    fs.rmSync(file); // transient: mid-rotation when task_started lands

    expect(w.forceAttach('resumed-late')).toBe(false);
    expect(starts).toEqual([]);
    expect(w.pendingForceAttach.has('resumed-late')).toBe(true);

    fs.writeFileSync(file, stashed);
    w._scan(); // the burst poll's retry vehicle

    expect(starts).toEqual(['resumed-late']);
    expect(w.pendingForceAttach.has('resumed-late')).toBe(false);
  });

  it('warns and gives up once the retry window expires', async () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir('expire');
    const dir = mkSubagentsDir(workdir, sessionId);
    fs.writeFileSync(path.join(dir, 'agent-gone.jsonl'), '');
    const warnings = [];
    const w = new SubagentWatcher({ workdir, sessionId, log: { warn: m => warnings.push(m) } });
    watchers.push(w);
    w.snapshot();
    fs.rmSync(path.join(dir, 'agent-gone.jsonl')); // never comes back

    w.forceAttach('gone');
    expect(w.pendingForceAttach.has('gone')).toBe(true);

    w.pendingForceAttach.set('gone', Date.now() - 1); // window closed
    w._scan();

    expect(w.pendingForceAttach.has('gone')).toBe(false);
    expect(warnings.join('\n')).toContain('gone');
    expect(warnings.join('\n')).toContain('will not be shown');
  });

  // Codex R2 F1: a missing/unreadable subagents dir is one of the conditions a
  // pending force-attach is waiting out, and the burst timer refuses to stop
  // while the queue is nonempty — so expiry must not sit behind the directory
  // enumeration, or the deadline never fires and nothing ever warns.
  it('still expires (and warns) when the subagents directory itself is gone', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir('nodir');
    const dir = mkSubagentsDir(workdir, sessionId);
    fs.writeFileSync(path.join(dir, 'agent-vanished.jsonl'), '');
    const warnings = [];
    const w = new SubagentWatcher({ workdir, sessionId, log: { warn: m => warnings.push(m) } });
    watchers.push(w);
    w.snapshot();

    fs.rmSync(dir, { recursive: true, force: true }); // whole dir gone
    w.forceAttach('vanished');
    expect(w.pendingForceAttach.has('vanished')).toBe(true);

    w._scan(); // readdirSync throws here
    expect(w.pendingForceAttach.has('vanished')).toBe(true); // still inside the window

    w.pendingForceAttach.set('vanished', Date.now() - 1);
    w._scan();

    expect(w.pendingForceAttach.has('vanished')).toBe(false);
    expect(warnings.join('\n')).toContain('vanished');
  });

  // Codex R2 F2: metadata is not readability. Declaring attachment off a stat
  // registers the filename in `tails` (so nothing can ever attach it again),
  // drops the retry, and leaves the child running with no output forever —
  // TranscriptTail swallows the open failure on every tick.
  it('does not declare attachment for a transcript it cannot open', () => {
    const { w, file, starts } = mkResumedFixture('resumed-eacces', [assistantLine('old')]);
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
      if (p === file) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return realOpen(p, ...rest);
    });
    try {
      expect(w.forceAttach('resumed-eacces')).toBe(false);
      expect(starts).toEqual([]);
      expect(w.tails.has('agent-resumed-eacces.jsonl')).toBe(false);
      // Queued, not abandoned — the denial may be transient.
      expect(w.pendingForceAttach.has('resumed-eacces')).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // Once it opens, the retry attaches it.
    w._scan();
    expect(starts).toEqual(['resumed-eacces']);
    expect(w.pendingForceAttach.has('resumed-eacces')).toBe(false);
  });

  it('does not queue a retry for the permanent no-op cases', () => {
    const { w } = mkResumedFixture('resumed-noqueue', [assistantLine('old')]);
    // Unknown agent (never snapshotted) — a fresh spawn, the scan's job.
    w.forceAttach('not-seen-at-all');
    expect(w.pendingForceAttach.size).toBe(0);
    // Already tailing — a duplicate task_started.
    w.forceAttach('resumed-noqueue');
    w.forceAttach('resumed-noqueue');
    expect(w.pendingForceAttach.size).toBe(0);
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
    // Two prior-instance transcripts present at snapshot time: one gets resumed,
    // the other is genuinely dead. Relaxing snapshot() would replay BOTH — that
    // is the intent forceAttach exists to preserve.
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir('ghost');
    const dir = mkSubagentsDir(workdir, sessionId);
    fs.writeFileSync(path.join(dir, 'agent-resumed5.jsonl'), JSON.stringify(assistantLine('old')) + '\n');
    fs.writeFileSync(path.join(dir, 'agent-deadghost.jsonl'), JSON.stringify(assistantLine('ghost')) + '\n');

    const w = new SubagentWatcher({ workdir, sessionId });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    w.on('subagent-start', p => starts.push(p.agentId));

    w._scan();
    expect(starts).toEqual([]);

    w.forceAttach('resumed5');

    // Only the explicitly-named agent came back. The ghost stays dead — and a
    // later scan must not resurrect it either.
    w._scan();
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
