// Workflow-tool subagent discovery (loop #798).
//
// Agents launched by Claude Code's Workflow tool write to
//   <session>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json, journal.jsonl)
// one level below Agent subagents, and spawn over the whole run rather than in a
// burst after one tool call. The fixture under test/fixtures/workflow-run/ is a
// trimmed copy of a real run (wf_2d973288-cf2): two agents' meta files verbatim,
// the first few transcript records of each, and the run journal with one agent's
// result. Tests copy it into a throwaway project dir; nothing reads real sessions.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SubagentWatcher,
  parseWorkflowLaunchResult,
  workflowAgentLabel,
  isWorkflowRunId,
  routeWorkflowStreamEvent,
} from '../lib/subagent-watcher.js';
import { createSubagentConvoTracker } from '../lib/subagent-convos.js';
import { makeSubagentsDir, removeProjectRoots } from './helpers/project-root.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'workflow-run');
const RUN_ID = 'wf_2d973288-cf2';
const A1 = 'a52c8df92c72f79d6'; // b1-type-primitives — has a journal result
const A2 = 'ad9f6e2caf6fcfc05'; // b2-tables-pills    — still running in the fixture
const LAUNCH_TEXT = fs.readFileSync(path.join(FIXTURE, 'launch-tool-result.txt'), 'utf8');

const waitFor = async (pred, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  return pred();
};
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));

describe('parseWorkflowLaunchResult', () => {
  it('reads the run id and the mid-line task id from a real launch result', () => {
    expect(parseWorkflowLaunchResult(LAUNCH_TEXT)).toEqual({ runId: RUN_ID, taskId: 'wjug1ouu0' });
  });

  it('accepts the content-block array form', () => {
    expect(parseWorkflowLaunchResult([{ type: 'text', text: LAUNCH_TEXT }]))
      .toEqual({ runId: RUN_ID, taskId: 'wjug1ouu0' });
  });

  it('returns null without a well-formed run id', () => {
    expect(parseWorkflowLaunchResult('no run here')).toBeNull();
    expect(parseWorkflowLaunchResult('Run ID: wf_../../etc')).toBeNull();
    expect(parseWorkflowLaunchResult('Run ID: notawf')).toBeNull();
    expect(parseWorkflowLaunchResult(null)).toBeNull();
  });

  it('isWorkflowRunId refuses path-like ids', () => {
    expect(isWorkflowRunId(RUN_ID)).toBe(true);
    expect(isWorkflowRunId('wf_a/b')).toBe(false);
    expect(isWorkflowRunId('wf_..')).toBe(false);
  });
});

describe('workflowAgentLabel', () => {
  it('joins description and phase', () => {
    expect(workflowAgentLabel('b1-type-primitives', 'Fix batches')).toBe('b1-type-primitives · Fix batches');
  });
  it('omits a missing phase and truncates long labels to 40 chars', () => {
    expect(workflowAgentLabel('solo', null)).toBe('solo');
    const long = workflowAgentLabel('x'.repeat(50), 'Phase');
    expect(long.length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });
  it('returns null without a description', () => {
    expect(workflowAgentLabel('', 'Phase')).toBeNull();
  });
});

describe('SubagentWatcher workflow runs', () => {
  const watchers = [];
  const projectRoots = [];

  afterEach(async () => {
    for (const w of watchers.splice(0)) { try { await w.stop(); } catch { /* ignore */ } }
    removeProjectRoots(projectRoots);
  });

  const uniqueWorkdir = () => `/tmp/bridge798-${process.pid}-${Math.random().toString(36).slice(2)}`;

  // A watcher whose subagents dir exists; copyRun copies the fixture run in.
  const mk = ({ copyRun = false } = {}) => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = uniqueWorkdir();
    const dir = makeSubagentsDir(workdir, sessionId, projectRoots, { prefix: '-tmp-bridge798-' });
    const runDir = path.join(dir, 'workflows', RUN_ID);
    if (copyRun) fs.cpSync(path.join(FIXTURE, RUN_ID), runDir, { recursive: true });
    const warnings = [];
    const w = new SubagentWatcher({ workdir, sessionId, log: { warn: m => warnings.push(m) } });
    watchers.push(w);
    w.snapshot();
    const starts = [];
    const events = [];
    const done = [];
    w.on('subagent-start', p => starts.push(p));
    w.on('subagent-event', p => events.push(p));
    w.on('subagent-done', p => done.push(p.agentId));
    return { w, dir, runDir, starts, events, done, warnings };
  };

  const addAgent = (runDir, agentId, { description, phase, lines = [] }) => {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, `agent-${agentId}.meta.json`), JSON.stringify({
      agentType: 'workflow-subagent', description, workflowPhase: phase, spawnDepth: 1,
    }));
    fs.writeFileSync(path.join(runDir, `agent-${agentId}.jsonl`),
      lines.map(l => JSON.stringify(l) + '\n').join(''));
  };
  const journal = (runDir, rec) => {
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(path.join(runDir, 'journal.jsonl'), JSON.stringify(rec) + '\n');
  };
  const assistant = (agentId, text) => ({
    type: 'assistant', isSidechain: true, agentId,
    message: { model: 'claude-opus-5-5', usage: {}, content: [{ type: 'text', text }] },
  });

  it('the main-dir burst scan never sees workflow agents (the original bug)', () => {
    const { w, starts } = mk({ copyRun: true });
    w.notifyTaskStarted();
    w._scan();
    expect(starts).toEqual([]);
  });

  it('a Workflow tool_use + launch result attaches every run agent with label, phase and run id', async () => {
    const { w, starts, events, done } = mk({ copyRun: true });
    expect(w.noteWorkflowToolUse('toolu_wf1', { script: 'export const meta = {}' })).toBeNull();
    expect(w.workflowRuns.size).toBe(0); // fresh run: id only known from the result

    expect(w.noteWorkflowResult('toolu_wf1', LAUNCH_TEXT)).toBe(RUN_ID);
    const byId = Object.fromEntries(starts.map(s => [s.agentId, s]));
    expect(Object.keys(byId).sort()).toEqual([A1, A2].sort());
    expect(byId[A1]).toMatchObject({
      label: 'b1-type-primitives · Fix batches',
      agentType: 'workflow-subagent',
      workflowRunId: RUN_ID,
      workflowPhase: 'Fix batches',
    });
    expect(byId[A2].label).toBe('b2-tables-pills · Fix batches');
    // Run-scoped tail keys: no collision with the main-dir agent-<id>.jsonl keys.
    expect(w.tails.has(`workflows/${RUN_ID}/agent-${A1}.jsonl`)).toBe(true);
    expect(w.tails.has(`agent-${A1}.jsonl`)).toBe(false);
    // The journal's result line settles A1 only; A2 is still running.
    expect(done).toEqual([A1]);
    // Transcript records flow as subagent-events carrying the workflow fields.
    expect(await waitFor(() => events.some(e => e.agentId === A2 && e.event.type === 'assistant'))).toBe(true);
    expect(events.find(e => e.agentId === A2).workflowRunId).toBe(RUN_ID);
  });

  it('ignores a "Run ID:" tool_result that does not answer a Workflow tool_use', () => {
    const { w, starts } = mk({ copyRun: true });
    expect(w.noteWorkflowResult('toolu_bash', LAUNCH_TEXT)).toBeNull();
    expect(w.workflowRuns.size).toBe(0);
    expect(starts).toEqual([]);
  });

  it('keeps discovering agents that spawn long after launch, and settles them from the journal', async () => {
    const { w, runDir, starts, done } = mk();
    expect(w.watchWorkflowRun(RUN_ID, { intervalMs: 20 })).toBe(true);
    expect(w.watchWorkflowRun(RUN_ID)).toBe(false); // idempotent
    journal(runDir, { type: 'launched' });

    await settle(150); // well past the 5s-burst model's assumptions in spirit: a quiet gap
    addAgent(runDir, 'late1', { description: 'verify', phase: 'Review', lines: [assistant('late1', 'hi')] });
    journal(runDir, { type: 'started', agentId: 'late1', label: 'verify', phase: 'Review' });
    expect(await waitFor(() => starts.some(s => s.agentId === 'late1'))).toBe(true);
    expect(starts.find(s => s.agentId === 'late1').label).toBe('verify · Review');
    expect(done).toEqual([]);

    journal(runDir, { type: 'result', agentId: 'late1', result: 'ok' });
    expect(await waitFor(() => done.includes('late1'))).toBe(true);
  });

  it('settles an agent whose result landed before its transcript was attached', async () => {
    const { w, runDir, done } = mk();
    fs.mkdirSync(runDir, { recursive: true });
    journal(runDir, { type: 'started', agentId: 'fast', label: 'f', phase: 'P' });
    journal(runDir, { type: 'result', agentId: 'fast', result: 'ok' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20 });
    await settle(80);
    expect(done).toEqual([]); // nothing attached yet — no card to settle
    addAgent(runDir, 'fast', { description: 'f', phase: 'P' });
    expect(await waitFor(() => done.includes('fast'))).toBe(true);
  });

  it('the completion notification (by tool_use_id) does a final scan, settles every agent and stops the poll', () => {
    const { w, runDir, starts, done } = mk({ copyRun: true });
    w.noteWorkflowToolUse('toolu_wf2', {});
    w.noteWorkflowResult('toolu_wf2', LAUNCH_TEXT);
    // An agent that appeared after the last tick is still picked up by the final scan.
    addAgent(runDir, 'last1', { description: 'tail', phase: 'Fix batches' });
    expect(w.noteWorkflowCompleted('toolu_wf2', 'wjug1ouu0')).toBe(true);
    expect(starts.map(s => s.agentId)).toContain('last1');
    expect(new Set(done)).toEqual(new Set([A1, A2, 'last1']));
    expect(w.workflowRuns.size).toBe(0);
    // Idempotent / unrelated notifications are no-ops.
    expect(w.noteWorkflowCompleted('toolu_wf2', 'wjug1ouu0')).toBe(false);
    expect(w.noteWorkflowCompleted('toolu_other', 'bg-bash-1')).toBe(false);
  });

  it('the completion notification also matches by task id alone', () => {
    const { w } = mk({ copyRun: true });
    w.noteWorkflowToolUse('toolu_wf3', {});
    w.noteWorkflowResult('toolu_wf3', LAUNCH_TEXT);
    expect(w.noteWorkflowCompleted(undefined, 'wjug1ouu0')).toBe(true);
    expect(w.workflowRuns.size).toBe(0);
  });

  it('a resumed run (resumeFromRunId) does not replay its cached agents but attaches new ones', async () => {
    const { w, runDir, starts, done } = mk({ copyRun: true });
    expect(w.noteWorkflowToolUse('toolu_wf4', { scriptPath: '/x.js', resumeFromRunId: RUN_ID })).toBe(RUN_ID);
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
    expect(starts).toEqual([]);
    expect(done).toEqual([]); // old journal results are history, not this run's
    // The launch result for the resume is idempotent with the early watch.
    expect(w.noteWorkflowResult('toolu_wf4', LAUNCH_TEXT)).toBe(RUN_ID);
    expect(starts).toEqual([]);

    addAgent(runDir, 'rerun1', { description: 'b2-retry', phase: 'Fix batches' });
    w._tickWorkflowRun(RUN_ID);
    expect(starts.map(s => s.agentId)).toEqual(['rerun1']);
  });

  it('a quiet run between phases backs off but keeps discovering (never idle-stops)', async () => {
    const { w, runDir, starts, done } = mk();
    addAgent(runDir, 'p1', { description: 'phase-one', phase: 'One' });
    journal(runDir, { type: 'started', agentId: 'p1' });
    journal(runDir, { type: 'result', agentId: 'p1' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20, idleStopMs: 0, idleIntervalMs: 100 });
    expect(await waitFor(() => done.includes('p1'))).toBe(true);
    await settle(300); // well past the idle threshold
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
    // Next phase spawns after the quiet gap: still discovered.
    addAgent(runDir, 'p2', { description: 'phase-two', phase: 'Two' });
    expect(await waitFor(() => starts.some(s => s.agentId === 'p2'))).toBe(true);
    expect(starts.find(s => s.agentId === 'p2').label).toBe('phase-two · Two');
  });

  it('idle back-off: a quiet run scans only once per idleIntervalMs', () => {
    const { w, runDir } = mk();
    addAgent(runDir, 'q1', { description: 'q', phase: 'P' });
    journal(runDir, { type: 'started', agentId: 'q1' });
    journal(runDir, { type: 'result', agentId: 'q1' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 100000, idleStopMs: 0, idleIntervalMs: 500000 });
    const run = w.workflowRuns.get(RUN_ID);
    let scans = 0;
    const orig = w._scanWorkflowRun.bind(w);
    w._scanWorkflowRun = r => { scans += 1; return orig(r); };
    for (let i = 0; i < 4; i++) w._tickWorkflowRun(RUN_ID);
    expect(run.idleEvery).toBe(5);
    expect(scans).toBe(0);
    w._tickWorkflowRun(RUN_ID); // 5th tick
    expect(scans).toBe(1);
  });

  it('a completion whose final scan cannot read the run dir retries, then discovers the late agent', async () => {
    const { w, dir, runDir, starts, done } = mk();
    fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
    fs.writeFileSync(runDir, 'not a dir'); // readdir -> ENOTDIR
    w.noteWorkflowToolUse('toolu_wf5', {});
    w.noteWorkflowResult('toolu_wf5', LAUNCH_TEXT);
    w.workflowRuns.get(RUN_ID).timer && clearInterval(w.workflowRuns.get(RUN_ID).timer);
    w.workflowRuns.get(RUN_ID).timer = setInterval(() => w._tickWorkflowRun(RUN_ID), 20);
    expect(w.noteWorkflowCompleted('toolu_wf5', 'wjug1ouu0')).toBe(true);
    expect(w.workflowRuns.get(RUN_ID)?.completing).toBe(true); // not taken as "no agents"
    fs.rmSync(runDir);
    addAgent(runDir, 'late9', { description: 'late', phase: 'P' });
    expect(await waitFor(() => w.workflowRuns.size === 0)).toBe(true);
    expect(starts.map(s => s.agentId)).toEqual(['late9']);
    expect(done).toEqual(['late9']);
  });

  it('a final scan that never recovers warns and stops after its retry window', async () => {
    const { w, dir, runDir, warnings } = mk();
    fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
    fs.writeFileSync(runDir, 'not a dir');
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20, finalRetryMs: 60 });
    w.workflowRunByTask.set('t9', RUN_ID);
    expect(w.noteWorkflowCompleted(undefined, 't9')).toBe(true);
    expect(await waitFor(() => w.workflowRuns.size === 0)).toBe(true);
    expect(warnings.some(m => m.includes('final scan') && m.includes('ENOTDIR'))).toBe(true);
  });

  it('a run dir that vanishes before the completion scan is retried, not taken as "no more agents"', async () => {
    const { w, runDir, starts } = mk({ copyRun: true });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20 });
    const tmp = runDir + '.moved';
    fs.renameSync(runDir, tmp);
    w.workflowRunByTask.set('t10', RUN_ID);
    expect(w.noteWorkflowCompleted(undefined, 't10')).toBe(true);
    expect(w.workflowRuns.get(RUN_ID)?.completing).toBe(true);
    fs.renameSync(tmp, runDir);
    addAgent(runDir, 'back1', { description: 'b', phase: 'P' });
    expect(await waitFor(() => w.workflowRuns.size === 0)).toBe(true);
    expect(starts.map(s => s.agentId)).toContain('back1');
  });

  it('a run that never wrote anything completes immediately (ENOENT before first sight is not a failure)', () => {
    const { w } = mk();
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20 });
    w.workflowRunByTask.set('t11', RUN_ID);
    expect(w.noteWorkflowCompleted(undefined, 't11')).toBe(true);
    expect(w.workflowRuns.size).toBe(0);
  });

  it('bounds journal ingestion: an oversized result is never buffered whole, and still settles its agent', () => {
    const { w, runDir, done, warnings } = mk();
    addAgent(runDir, 'big1', { description: 'big', phase: 'P' });
    addAgent(runDir, 'after1', { description: 'after', phase: 'P' });
    const huge = 'x'.repeat(3 * 1024 * 1024); // 3 MB result
    journal(runDir, { type: 'started', agentId: 'big1' });
    journal(runDir, { type: 'result', key: 'k', agentId: 'big1', result: huge });
    journal(runDir, { type: 'result', agentId: 'after1', result: 'ok' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 100000 });
    const run = w.workflowRuns.get(RUN_ID);
    let maxPartial = 0;
    for (let i = 0; i < 40 && run.journalOffset < fs.statSync(path.join(runDir, 'journal.jsonl')).size; i++) {
      w._tickWorkflowRun(RUN_ID);
      maxPartial = Math.max(maxPartial, run.journalPartial.length);
    }
    expect(maxPartial).toBeLessThanOrEqual(64 * 1024);
    expect(done).toContain('big1');
    expect(done).toContain('after1'); // the record after the oversized one still parses
    expect(warnings.some(m => m.includes('journal record over'))).toBe(true);
  });

  it('reassembles a multibyte character split across journal chunks', () => {
    const { w, runDir, done } = mk();
    addAgent(runDir, 'utf1', { description: 'u', phase: 'P' });
    // Pad so a 3-byte char straddles the 256 KB chunk boundary.
    const prefix = JSON.stringify({ type: 'started', agentId: 'pad', note: 'a'.repeat(50000) }) + '\n';
    let body = prefix.repeat(5);
    const need = 256 * 1024 - Buffer.byteLength(body) - 30;
    body += JSON.stringify({ type: 'started', agentId: 'pad2', n: 'b'.repeat(Math.max(0, need)) + '€€€€' }) + '\n';
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), body);
    journal(runDir, { type: 'result', agentId: 'utf1' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 100000 });
    for (let i = 0; i < 5; i++) w._tickWorkflowRun(RUN_ID);
    const run = w.workflowRuns.get(RUN_ID);
    expect(run.started.has('pad2')).toBe(true);
    expect(done).toContain('utf1');
  });

  it('a completion that beats its launch result is final: the late result does not re-open the run', () => {
    const { w, starts } = mk({ copyRun: true });
    // Resume: watched from the tool_use with a snapshot (no cards for cached agents).
    w.noteWorkflowToolUse('toolu_wf7', { resumeFromRunId: RUN_ID });
    expect(w.noteWorkflowCompleted('toolu_wf7', 'wjug1ouu0')).toBe(true);
    expect(w.workflowRuns.size).toBe(0);
    // The launch result arrives late: no fresh, un-snapshotted watch.
    expect(w.noteWorkflowResult('toolu_wf7', LAUNCH_TEXT)).toBeNull();
    expect(w.workflowRuns.size).toBe(0);
    expect(starts).toEqual([]);
    // A later deliberate resume of the same run is watched again.
    expect(w.noteWorkflowToolUse('toolu_wf8', { resumeFromRunId: RUN_ID })).toBe(RUN_ID);
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
  });

  it('a fast fresh run whose completion beats its launch result still gets its cards, then stops', () => {
    const { w, starts, done } = mk({ copyRun: true });
    w.noteWorkflowToolUse('toolu_wf9', {});
    expect(w.noteWorkflowCompleted('toolu_wf9', 'wjug1ouu0')).toBe(false); // run id not known yet
    expect(w.noteWorkflowResult('toolu_wf9', LAUNCH_TEXT)).toBe(RUN_ID);
    expect(starts.map(s => s.agentId).sort()).toEqual([A1, A2].sort());
    expect(new Set(done)).toEqual(new Set([A1, A2])); // run is over: every card settles
    expect(w.workflowRuns.size).toBe(0);
    // A duplicate late result does nothing more.
    expect(w.noteWorkflowResult('toolu_wf9', LAUNCH_TEXT)).toBeNull();
    expect(starts.length).toBe(2);
  });

  it('a task-id-only completion that beats its launch result: the late result gets its cards, then stops', () => {
    const { w, starts, done } = mk({ copyRun: true });
    w.noteWorkflowToolUse('toolu_wf20', {});
    // No tool_use_id on the notice, and the run id is not known yet.
    expect(w.noteWorkflowCompleted(undefined, 'wjug1ouu0')).toBe(false);
    expect(w.noteWorkflowResult('toolu_wf20', LAUNCH_TEXT)).toBe(RUN_ID);
    expect(starts.map(s => s.agentId).sort()).toEqual([A1, A2].sort());
    expect(new Set(done)).toEqual(new Set([A1, A2]));
    expect(w.workflowRuns.size).toBe(0); // not left watching until the 24h cap
    expect(w.workflowRunByTask.size).toBe(0);
    expect(w.workflowRunByToolUse.size).toBe(0);
    // The tombstone is consumed: a duplicate late result does nothing more.
    expect(w.noteWorkflowResult('toolu_wf20', LAUNCH_TEXT)).toBeNull();
    expect(starts.length).toBe(2);
  });

  it('a task-id-only completion that beats the launch result of a resumed run stops the watch', () => {
    const { w, starts } = mk({ copyRun: true });
    w.noteWorkflowToolUse('toolu_wf21', { resumeFromRunId: RUN_ID });
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
    expect(w.noteWorkflowCompleted(undefined, 'wjug1ouu0')).toBe(false);
    expect(w.noteWorkflowResult('toolu_wf21', LAUNCH_TEXT)).toBe(RUN_ID);
    expect(w.workflowRuns.size).toBe(0);
    expect(starts).toEqual([]); // cached agents were snapshotted, never replayed
    // The finished run is tombstoned: a stray re-delivered result cannot re-open it.
    w.noteWorkflowToolUse('toolu_wf22', {});
    expect(w.noteWorkflowResult('toolu_wf22', LAUNCH_TEXT)).toBeNull();
    expect(w.workflowRuns.size).toBe(0);
  });

  it('task-id tombstones are only taken while a Workflow launch is pending, and are bounded', () => {
    const { w, warnings } = mk({ copyRun: true });
    // Background Bash/Agent notices with no Workflow in flight leave no trace.
    expect(w.noteWorkflowCompleted(undefined, 'bg-bash-1')).toBe(false);
    expect(w.completedWorkflowTasks.size).toBe(0);
    w.noteWorkflowToolUse('toolu_wf23', {});
    for (let i = 0; i < 300; i++) w.noteWorkflowCompleted(undefined, `bg-${i}`);
    expect(w.completedWorkflowTasks.size).toBeLessThanOrEqual(256);
    // Overflow is never silent.
    expect(warnings.some(m => /tombstone full/.test(m) && m.includes('bg-0'))).toBe(true);
    // Notices that carry a tool_use_id (real background Agent/Bash ones) never
    // occupy the task tombstone.
    w.completedWorkflowTasks.clear();
    w.noteWorkflowCompleted('toolu_bash', 'bg-bash-2');
    expect(w.completedWorkflowTasks.size).toBe(0);
    // A launch whose task id was never tombstoned starts a normal live watch.
    expect(w.noteWorkflowResult('toolu_wf23', LAUNCH_TEXT)).toBe(RUN_ID);
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
  });

  it('warns when a Workflow tool_result names no run', () => {
    const { w, warnings } = mk();
    w.noteWorkflowToolUse('toolu_wf6', {});
    expect(w.noteWorkflowResult('toolu_wf6', 'Error: workflow script failed to parse')).toBeNull();
    expect(warnings.some(m => m.includes('toolu_wf6') && m.includes('Run ID'))).toBe(true);
  });

  it('lifetime cap: stops and warns when no completion ever arrives', async () => {
    const { w, warnings } = mk();
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20, maxLifetimeMs: 0 });
    expect(await waitFor(() => w.workflowRuns.size === 0)).toBe(true);
    expect(warnings.some(m => m.includes(RUN_ID) && m.includes('lifetime cap'))).toBe(true);
  });

  it('refuses a malformed run id', () => {
    const { w } = mk();
    expect(w.watchWorkflowRun('wf_../../x')).toBe(false);
    expect(w.noteWorkflowToolUse('t', { resumeFromRunId: '../etc' })).toBeNull();
    expect(w.workflowRuns.size).toBe(0);
  });

  it('forceAttach never touches a workflow agent', () => {
    const { w } = mk({ copyRun: true });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 1000 });
    expect(w.forceAttach(A1)).toBe(false);
    expect(w.pendingForceAttach.size).toBe(0);
  });

  it('stop() clears every run poll', async () => {
    const { w } = mk({ copyRun: true });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20 });
    await w.stop();
    expect(w.workflowRuns.size).toBe(0);
    expect(w.tails.size).toBe(0);
  });
});

describe('subagent convo tracker finishAgent', () => {
  it('finishes a discovered workflow child and is a no-op for unknown ids', () => {
    const upserts = [];
    const publisher = {
      upsertConvo: (convoId, opts) => { upserts.push({ convoId, ...opts }); return true; },
      publishStatus: () => true,
    };
    const t = createSubagentConvoTracker({ publisher, getParentConvoId: () => 'parent-1', log: { warn() {} } });
    t.discover(A1, { label: 'b1-type-primitives · Fix batches', agentType: 'workflow-subagent' });
    expect(upserts.at(-1)).toMatchObject({ sessionState: 'running', title: 'b1-type-primitives · Fix batches', parentConvoId: 'parent-1' });
    t.finishAgent(A1);
    expect(upserts.at(-1)).toMatchObject({ sessionState: 'done', parentConvoId: 'parent-1' });
    const n = upserts.length;
    t.finishAgent(A1);
    t.finishAgent('nope');
    t.finishAgent(undefined);
    expect(upserts.length).toBe(n);
  });
});

describe('routeWorkflowStreamEvent: parent stream -> sidebar child cards', () => {
  const projectRoots = [];
  const watchers = [];
  afterEach(async () => {
    for (const w of watchers.splice(0)) { try { await w.stop(); } catch { /* ignore */ } }
    removeProjectRoots(projectRoots);
  });

  it('drives a real Workflow tool_use, launch result and task_notification to published running/done children', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = `/tmp/bridge798r-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const dir = makeSubagentsDir(workdir, sessionId, projectRoots, { prefix: '-tmp-bridge798r-' });
    fs.cpSync(path.join(FIXTURE, RUN_ID), path.join(dir, 'workflows', RUN_ID), { recursive: true });

    const upserts = [];
    const publisher = { upsertConvo: (id, o) => { upserts.push({ id, ...o }); return true; }, publishStatus: () => true };
    const conv = createSubagentConvoTracker({ publisher, getParentConvoId: () => 'parent-x', log: { warn() {} } });
    const w = new SubagentWatcher({ workdir, sessionId, log: { warn() {} } });
    watchers.push(w);
    // Same wiring as setupSubagentWatcher in index.js.
    w.on('subagent-start', p => conv.discover(p.agentId, p));
    w.on('subagent-done', ({ agentId }) => conv.finishAgent(agentId));
    w.snapshot();

    // Stream-json shapes as Claude Code emits them on the parent stream.
    routeWorkflowStreamEvent(w, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_R', name: 'Workflow', input: { script: 'x' } }] },
    });
    routeWorkflowStreamEvent(w, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: LAUNCH_TEXT }] },
    });
    const state = () => {
      const last = {};
      for (const u of upserts) last[u.id] = { ...(last[u.id] || {}), ...u };
      return last;
    };
    expect(state()[`parent-x:sub:${A1}`]).toMatchObject({ title: 'b1-type-primitives · Fix batches', sessionState: 'done', parentConvoId: 'parent-x' });
    expect(state()[`parent-x:sub:${A2}`]).toMatchObject({ title: 'b2-tables-pills · Fix batches', sessionState: 'running' });

    // An unrelated background task's notification leaves the run alone.
    routeWorkflowStreamEvent(w, { type: 'system', subtype: 'task_notification', task_id: 'bgbash', tool_use_id: 'toolu_bash', status: 'completed' });
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);

    routeWorkflowStreamEvent(w, { type: 'system', subtype: 'task_notification', task_id: 'wjug1ouu0', tool_use_id: 'toolu_R', status: 'completed' });
    expect(w.workflowRuns.size).toBe(0);
    expect(state()[`parent-x:sub:${A2}`].sessionState).toBe('done');
  });

  it('a task_notification without tool_use_id that beats the launch result still ends the run (stream shapes)', () => {
    const sessionId = `sid-${Math.random().toString(36).slice(2)}`;
    const workdir = `/tmp/bridge798r-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const dir = makeSubagentsDir(workdir, sessionId, projectRoots, { prefix: '-tmp-bridge798r-' });
    fs.cpSync(path.join(FIXTURE, RUN_ID), path.join(dir, 'workflows', RUN_ID), { recursive: true });
    const w = new SubagentWatcher({ workdir, sessionId, log: { warn() {} } });
    watchers.push(w);
    const done = new Set();
    w.on('subagent-done', ({ agentId }) => done.add(agentId));
    w.snapshot();
    routeWorkflowStreamEvent(w, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_T', name: 'Workflow', input: { script: 'x' } }] },
    });
    // The real run's notice (task id = the launch text's `Task ID:`), minus its tool_use_id.
    routeWorkflowStreamEvent(w, { type: 'system', subtype: 'task_notification', task_id: 'wjug1ouu0', status: 'completed' });
    routeWorkflowStreamEvent(w, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_T', content: LAUNCH_TEXT }] },
    });
    expect(w.workflowRuns.size).toBe(0);
    expect(done).toEqual(new Set([A1, A2]));
  });

  it('never throws on junk and ignores a null watcher', () => {
    expect(() => routeWorkflowStreamEvent(null, { type: 'user' })).not.toThrow();
    const w = new SubagentWatcher({ workdir: '/tmp/x798', sessionId: 's', log: { warn() {} } });
    expect(() => routeWorkflowStreamEvent(w, null)).not.toThrow();
    expect(() => routeWorkflowStreamEvent(w, { type: 'assistant', message: { content: 'str' } })).not.toThrow();
    expect(() => routeWorkflowStreamEvent(w, { type: 'user', message: { content: [null] } })).not.toThrow();
  });
});

describe('index.js workflow seam (source inspection)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8');
  it('handleClaudeEvent routes every non-sidechain parent event through routeWorkflowStreamEvent, and subagent-done finishes the child', () => {
    const body = src.slice(src.indexOf('function handleClaudeEvent('));
    const guard = body.indexOf('if (isSidechainEvent(event)) return;');
    // Statement level of handleClaudeEvent (two-space indent, previous
    // non-comment line closes a statement) — not nested in a conditional.
    const seam = body.indexOf('\n  routeWorkflowStreamEvent(session.subagentWatcher, event);\n');
    const sw = body.indexOf('switch (event.type)');
    expect(guard).toBeGreaterThan(-1);
    expect(seam).toBeGreaterThan(guard);
    expect(seam).toBeLessThan(sw);
    expect(src).toMatch(/on\('subagent-done', \(\{ agentId \}\) => session\.subagentConvos\?\.finishAgent\(agentId\)\)/);
  });
});
