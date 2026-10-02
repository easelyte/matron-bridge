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

  it('idle backstop: stops once every started agent has a result and the run is quiet', async () => {
    const { w, runDir, done } = mk();
    addAgent(runDir, 'x1', { description: 'x', phase: 'P' });
    journal(runDir, { type: 'started', agentId: 'x1' });
    journal(runDir, { type: 'result', agentId: 'x1' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20, idleStopMs: 0 });
    expect(await waitFor(() => w.workflowRuns.size === 0)).toBe(true);
    expect(done).toEqual(['x1']);
  });

  it('idle backstop does not fire while a started agent has no result', async () => {
    const { w, runDir } = mk();
    addAgent(runDir, 'y1', { description: 'y', phase: 'P' });
    journal(runDir, { type: 'started', agentId: 'y1' });
    w.watchWorkflowRun(RUN_ID, { intervalMs: 20, idleStopMs: 0 });
    await settle(150);
    expect(w.workflowRuns.has(RUN_ID)).toBe(true);
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

describe('index.js workflow wiring (source inspection)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8');
  it('routes the Workflow tool_use, its tool_result, task_notification and subagent-done', () => {
    expect(src).toMatch(/toolName === 'Workflow'\) \{[\s\S]{0,400}noteWorkflowToolUse\(block\.id, input\)/);
    expect(src).toMatch(/noteWorkflowResult\(block\.tool_use_id, block\.content\)/);
    expect(src).toMatch(/subtype === 'task_notification'[\s\S]{0,1200}noteWorkflowCompleted\(event\.tool_use_id, event\.task_id\)/);
    expect(src).toMatch(/on\('subagent-done', \(\{ agentId \}\) => session\.subagentConvos\?\.finishAgent\(agentId\)\)/);
  });
});
