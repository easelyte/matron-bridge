import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SubagentWatcher } from '../lib/subagent-watcher.js';
import { createSubagentConvoTracker } from '../lib/subagent-convos.js';
import { makeSubagentsDir, removeProjectRoots } from './helpers/project-root.js';

// A finished subagent's transcript must stop being polled ten times a second.
// The watcher stops its tail a grace period after the agent is reported
// finished (once the file has been quiet for that long), and from then on only
// looks at the file's size on a slow shared check, so output written later is
// still shown, once, and nothing already shown is replayed.

const GRACE_MS = 1000;
const PARKED_CHECK_MS = 5000;
const RUN_ID = 'wf_abc123-def456';

const line = text => JSON.stringify({
  type: 'assistant',
  message: { model: 'm', usage: {}, content: [{ type: 'text', text }] },
}) + '\n';
const textOf = p => p.event.message.content[0].text;

describe('SubagentWatcher: tails of finished subagents', () => {
  const watchers = [];
  const projectRoots = [];

  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(async () => {
    for (const w of watchers.splice(0)) { try { await w.stop(); } catch { /* ignore */ } }
    vi.useRealTimers();
    removeProjectRoots(projectRoots);
  });

  const mk = () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = `/tmp/subagent-tails-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const dir = makeSubagentsDir(workdir, sessionId, projectRoots, { prefix: '-tmp-subagent-tails-' });
    const w = new SubagentWatcher({
      workdir, sessionId, log: { warn() {} },
      finishedTailGraceMs: GRACE_MS, parkedCheckMs: PARKED_CHECK_MS,
    });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    const texts = [];
    w.on('subagent-start', p => starts.push(p.agentId));
    w.on('subagent-event', p => texts.push(textOf(p)));
    return { w, dir, starts, texts };
  };

  // A discovered, attached agent with one line already shown.
  const attachAgent = (ctx, id = 'aaa') => {
    const file = path.join(ctx.dir, `agent-${id}.jsonl`);
    fs.writeFileSync(file, line('first'));
    ctx.w._scan();
    expect(ctx.w.tails.has(`agent-${id}.jsonl`)).toBe(true);
    expect(ctx.texts).toEqual(['first']);
    return file;
  };

  it('stops polling a finished subagent once its transcript has been quiet for the grace period', () => {
    const ctx = mk();
    attachAgent(ctx);
    const { tail } = ctx.w.tails.get('agent-aaa.jsonl');

    ctx.w.noteAgentFinished('aaa');
    // Still tailing inside the grace period: a final answer can land late.
    vi.advanceTimersByTime(GRACE_MS - 100);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
    expect(tail.started).toBe(false);
    expect(tail.timer).toBeNull();
  });

  it('keeps tailing an unfinished subagent however long it stays quiet', () => {
    const ctx = mk();
    attachAgent(ctx);
    vi.advanceTimersByTime(GRACE_MS * 20);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);
  });

  it('keeps tailing a finished subagent while output is still arriving', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(GRACE_MS - 100);
      fs.appendFileSync(file, line(`late ${i}`));
    }
    vi.advanceTimersByTime(200);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);
    expect(ctx.texts).toEqual(['first', 'late 0', 'late 1', 'late 2', 'late 3', 'late 4']);

    // Quiet at last: one more full grace period stops it.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
  });

  it('shows a line written after the tail stopped, once, without replaying earlier lines', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);

    fs.appendFileSync(file, line('very late'));
    vi.advanceTimersByTime(PARKED_CHECK_MS + 100);
    expect(ctx.texts).toEqual(['first', 'very late']);

    // The agent is still finished, so its tail stops again when quiet, and a
    // second late line is still picked up.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
    fs.appendFileSync(file, line('later still'));
    vi.advanceTimersByTime(PARKED_CHECK_MS + 100);
    expect(ctx.texts).toEqual(['first', 'very late', 'later still']);
  });

  it('a resumed agent is re-attached where its tail stopped: only new output, once', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);

    // The resumed run has already written by the time the resume is announced.
    fs.appendFileSync(file, line('resumed'));
    expect(ctx.w.forceAttach('aaa')).toBe(true);
    expect(ctx.texts).toEqual(['first', 'resumed']);

    // Running again: it is not stopped until it is reported finished again, and
    // the slow check does not show the same bytes a second time.
    vi.advanceTimersByTime(PARKED_CHECK_MS * 3);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);
    fs.appendFileSync(file, line('still going'));
    vi.advanceTimersByTime(200);
    expect(ctx.texts).toEqual(['first', 'resumed', 'still going']);
  });

  it('a resumed agent keeps its stopped offset when the session directory has moved', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);

    // The resumed run writes, then the session changes directory (its
    // transcripts move with it) before the resume is announced.
    fs.appendFileSync(file, line('resumed'));
    const nextWorkdir = `/tmp/subagent-tails-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const nextDir = makeSubagentsDir(nextWorkdir, ctx.w.sessionId, projectRoots, { prefix: '-tmp-subagent-tails-' });
    fs.renameSync(file, path.join(nextDir, 'agent-aaa.jsonl'));
    expect(ctx.w.repoint(nextWorkdir)).toBe(true);

    expect(ctx.w.forceAttach('aaa')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(ctx.texts).toEqual(['first', 'resumed']);
  });

  it('does not stop a tail while its transcript cannot be read', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');

    // The file is out of reach for a while (moved, or not readable).
    fs.renameSync(file, `${file}.away`);
    vi.advanceTimersByTime(GRACE_MS * 3);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);

    // Back again, with a line written meanwhile: shown, then the tail stops.
    fs.appendFileSync(`${file}.away`, line('late'));
    fs.renameSync(`${file}.away`, file);
    vi.advanceTimersByTime(GRACE_MS * 2 + 100);
    expect(ctx.texts).toEqual(['first', 'late']);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
    expect(ctx.w.parked.has('agent-aaa.jsonl')).toBe(true);
  });

  it('an agent that finishes while its resume is still waiting for the transcript is stopped once attached', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);

    // Resumed while the transcript is out of reach: the attach is retried.
    fs.renameSync(file, `${file}.away`);
    expect(ctx.w.forceAttach('aaa')).toBe(false);
    // It finishes again before the retry succeeds.
    ctx.w.noteAgentFinished('aaa');
    fs.appendFileSync(`${file}.away`, line('resumed'));
    fs.renameSync(`${file}.away`, file);
    ctx.w._retryPendingForceAttach();
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);

    vi.advanceTimersByTime(GRACE_MS * 2 + 100);
    expect(ctx.texts).toEqual(['first', 'resumed']);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
  });

  it('a resume announced inside the grace period keeps the tail', () => {
    const ctx = mk();
    attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS / 2);
    ctx.w.forceAttach('aaa');
    vi.advanceTimersByTime(GRACE_MS * 5);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);
    expect(ctx.starts).toEqual(['aaa']);
  });

  it('a burst scan does not re-attach a stopped tail from the top', () => {
    const ctx = mk();
    attachAgent(ctx);
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100);
    ctx.w._scan();
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(false);
    expect(ctx.texts).toEqual(['first']);
  });

  it('does not stop a tail in the middle of a half-written line', () => {
    const ctx = mk();
    const file = attachAgent(ctx);
    const full = line('split');
    fs.appendFileSync(file, full.slice(0, 20));
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS * 3);
    expect(ctx.w.tails.has('agent-aaa.jsonl')).toBe(true);
    fs.appendFileSync(file, full.slice(20));
    vi.advanceTimersByTime(200);
    expect(ctx.texts).toEqual(['first', 'split']);
  });

  it('stops the tail of a workflow agent once the run journal reports its result', () => {
    const ctx = mk();
    const runDir = path.join(ctx.dir, 'workflows', RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'agent-wf1.jsonl');
    fs.writeFileSync(file, line('first'));
    ctx.w.watchWorkflowRun(RUN_ID);
    const key = `workflows/${RUN_ID}/agent-wf1.jsonl`;
    expect(ctx.w.tails.has(key)).toBe(true);

    fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'result', agentId: 'wf1' }) + '\n');
    vi.advanceTimersByTime(1100); // the run's own poll reads the journal
    vi.advanceTimersByTime(GRACE_MS + 100);
    expect(ctx.w.tails.has(key)).toBe(false);

    fs.appendFileSync(file, line('very late'));
    vi.advanceTimersByTime(PARKED_CHECK_MS + 100);
    expect(ctx.texts).toEqual(['first', 'very late']);
  });

  it('stop() leaves no timers behind', async () => {
    const ctx = mk();
    attachAgent(ctx, 'aaa');
    attachAgentQuiet(ctx, 'bbb');
    ctx.w.noteAgentFinished('aaa');
    vi.advanceTimersByTime(GRACE_MS + 100); // aaa stopped, slow check running
    ctx.w.noteAgentFinished('bbb'); // bbb inside its grace period
    await ctx.w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  function attachAgentQuiet(ctx, id) {
    fs.writeFileSync(path.join(ctx.dir, `agent-${id}.jsonl`), '');
    ctx.w._scan();
  }
});

describe('subagent convo tracker: onChildFinished', () => {
  const mkTracker = onChildFinished => createSubagentConvoTracker({
    publisher: { upsertConvo() {}, publishStatus() {} },
    getParentConvoId: () => 'parent-uuid',
    log: { warn() {} },
    onChildFinished,
  });

  it('names the agent when its Task result arrives, once', () => {
    const finished = [];
    const tracker = mkTracker(id => finished.push(id));
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('aaa', { label: 'x', agentType: null });
    expect(finished).toEqual([]);
    tracker.noteTaskResult('toolu_1');
    tracker.noteTaskResult('toolu_1');
    expect(finished).toEqual(['aaa']);
  });

  it('names a background agent on its completion notification, not its launch result', () => {
    const finished = [];
    const tracker = mkTracker(id => finished.push(id));
    tracker.noteTaskStarted('toolu_2');
    tracker.noteBackgroundTaskStarted('toolu_2', 'bbb');
    tracker.discover('bbb', { label: 'x', agentType: null });
    tracker.noteTaskResult('toolu_2');
    expect(finished).toEqual([]);
    tracker.noteTaskCompleted('bbb', 'toolu_2');
    expect(finished).toEqual(['bbb']);
  });

  it('a throwing callback does not break finishing', () => {
    const tracker = mkTracker(() => { throw new Error('boom'); });
    tracker.noteTaskStarted('toolu_3');
    tracker.discover('ccc', { label: 'x', agentType: null });
    expect(() => tracker.noteTaskResult('toolu_3')).not.toThrow();
    expect(tracker.runningCount()).toBe(0);
  });
});
