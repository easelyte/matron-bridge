import { describe, it, expect, beforeEach } from 'vitest';
import {
  childConvoId,
  subagentTitle,
  createSubagentConvoTracker,
  CHILD_STATE_RUNNING,
  CHILD_STATE_FINISHED,
} from '../lib/subagent-convos.js';
import { modelFromEvent } from '../lib/model-aliases.js';

// A fake journal publisher recording every call, mirroring the real
// publisher's method surface (see lib/journal-publisher.js). Every method
// fails open in the real thing; here they just record.
function makePublisher() {
  const calls = { upsertConvo: [], publishStatus: [], publishText: [], publishDiff: [] };
  return {
    calls,
    upsertConvo(convoId, opts, options) {
      calls.upsertConvo.push({ convoId, opts });
      // Simulate immediate confirmed delivery so onDelivered-gated cleanup
      // (subagent finish() store removal) runs synchronously in tests.
      try { options?.onDelivered?.(); } catch { /* mirror publisher's swallow */ }
    },
    publishStatus(convoId, status) { calls.publishStatus.push({ convoId, status }); },
    publishText(convoId, payload) { calls.publishText.push({ convoId, payload }); },
    publishDiff(convoId, payload) { calls.publishDiff.push({ convoId, payload }); },
  };
}

// A subagent assistant transcript event: these are tagged isSidechain, which
// is exactly why modelFromEvent must return null for them — the child's model
// has to be read off the event directly, never through the parent's guard.
function subagentAssistantEvent({ model, text, usage } = {}) {
  return {
    type: 'assistant',
    isSidechain: true,
    message: {
      model: model ?? 'claude-haiku-4-5',
      usage: usage ?? { input_tokens: 100, cache_read_input_tokens: 900 },
      content: text ? [{ type: 'text', text }] : [],
    },
  };
}

describe('childConvoId', () => {
  it('is deterministic and stable for a given (parent, agentId)', () => {
    expect(childConvoId('parent-uuid', 'agent-1')).toBe('parent-uuid:sub:agent-1');
    // Same inputs -> same id every time (reconnects/restarts never mint dupes).
    expect(childConvoId('parent-uuid', 'agent-1')).toBe(childConvoId('parent-uuid', 'agent-1'));
    // Distinct agents under the same parent are distinct convos.
    expect(childConvoId('parent-uuid', 'agent-2')).not.toBe(childConvoId('parent-uuid', 'agent-1'));
  });

  it('keeps a real (36-char UUID parent + UUID agent) id well under the 128-char server cap', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(childConvoId(uuid, uuid).length).toBeLessThan(128);
  });
});

describe('subagentTitle', () => {
  it('prefers the label, falling back to agentType', () => {
    expect(subagentTitle('Explore the auth flow', 'code-explorer')).toBe('Explore the auth flow');
    expect(subagentTitle(null, 'code-explorer')).toBe('code-explorer');
    expect(subagentTitle('   ', 'code-explorer')).toBe('code-explorer');
    expect(subagentTitle(null, null)).toBeNull();
  });
});

describe('createSubagentConvoTracker', () => {
  let publisher;
  let tracker;
  beforeEach(() => {
    publisher = makePublisher();
    tracker = createSubagentConvoTracker({
      publisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
  });

  it('publishes a running child convo_upsert on discovery, linked to the parent', () => {
    tracker.discover('agent-1', { label: 'Explore auth', agentType: 'code-explorer' });

    expect(publisher.calls.upsertConvo).toHaveLength(1);
    const { convoId, opts } = publisher.calls.upsertConvo[0];
    expect(convoId).toBe('parent-uuid:sub:agent-1');
    expect(opts.parentConvoId).toBe('parent-uuid');
    expect(opts.sessionState).toBe(CHILD_STATE_RUNNING);
    expect(opts.title).toBe('Explore auth');
  });

  it('titles the child by agentType when no label is available yet', () => {
    tracker.discover('agent-1', { label: null, agentType: 'code-explorer' });
    expect(publisher.calls.upsertConvo[0].opts.title).toBe('code-explorer');
  });

  it('discovering the same agent twice does not mint a second convo', () => {
    tracker.discover('agent-1', { label: 'x', agentType: null });
    tracker.discover('agent-1', { label: 'x', agentType: null });
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('routes a subagent event to the child convo id and derives the child model from the event itself', () => {
    tracker.discover('agent-1', { label: 'Explore', agentType: 'code-explorer' });
    publisher.calls.publishStatus.length = 0; // ignore the discovery status

    const ev = subagentAssistantEvent({ model: 'claude-haiku-4-5' });
    const child = tracker.onEvent('agent-1', { label: 'Explore', agentType: 'code-explorer', event: ev });

    expect(child.convoId).toBe('parent-uuid:sub:agent-1');
    // Per-subagent status published to the CHILD, model taken off the event.
    const status = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-1');
    expect(status.status.model).toBe('claude-haiku-4-5');
    expect(status.status.context.tokens).toBe(1000);
  });

  it('isolates per-subagent status AND the parent model guard is never weakened', () => {
    tracker.discover('agent-1', { label: 'A', agentType: 'code-explorer' });
    tracker.discover('agent-2', { label: 'B', agentType: 'code-reviewer' });

    tracker.onEvent('agent-1', { event: subagentAssistantEvent({ model: 'claude-haiku-4-5' }) });
    tracker.onEvent('agent-2', { event: subagentAssistantEvent({ model: 'claude-opus-4-8' }) });

    const s1 = publisher.calls.publishStatus.filter(s => s.convoId === 'parent-uuid:sub:agent-1').at(-1);
    const s2 = publisher.calls.publishStatus.filter(s => s.convoId === 'parent-uuid:sub:agent-2').at(-1);
    expect(s1.status.model).toBe('claude-haiku-4-5');
    expect(s2.status.model).toBe('claude-opus-4-8');

    // Regression: the tracker reads the subagent's model off the event directly
    // because the parent-protecting guard (modelFromEvent) intentionally
    // returns null for these isSidechain events. If it didn't, the child model
    // would be unreachable AND the parent's model would be at risk.
    expect(modelFromEvent(subagentAssistantEvent({ model: 'claude-haiku-4-5' }))).toBeNull();
  });

  it('carries task_ref (the spawning Task tool_use_id) in the child status payload', () => {
    tracker.noteTaskStarted('toolu_task_abc');
    tracker.discover('agent-1', { label: 'A', agentType: 'code-explorer' });

    // task_ref rides the status frame from the very first (discovery) status.
    const first = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-1');
    expect(first.status.task_ref).toBe('toolu_task_abc');

    // ...and keeps riding subsequent status frames (server caches last-per-convo).
    tracker.onEvent('agent-1', { event: subagentAssistantEvent({ model: 'claude-haiku-4-5' }) });
    expect(publisher.calls.publishStatus.at(-1).status.task_ref).toBe('toolu_task_abc');
  });

  it('a nested Task ref (from a subagent stream) never pollutes the parent FIFO', () => {
    // Parent launches Task A; while agent-a runs it spawns a nested Task.
    tracker.noteTaskStarted('toolu_parent_a');
    tracker.discover('agent-a', { label: 'A', agentType: null });
    tracker.noteTaskStarted('toolu_nested', { nested: true });
    // Parent launches Task B; its child must pair to the PARENT's ref, not the
    // nested one (a nested Task's tool_result never surfaces in the parent
    // stream, so its ref could never be consumed — it would only mis-pair
    // siblings and let a parent tool_result finish the wrong child).
    tracker.noteTaskStarted('toolu_parent_b');
    tracker.discover('agent-nested', { label: 'N', agentType: null });
    tracker.discover('agent-b', { label: 'B', agentType: null });

    // Discovery order is not knowable, so the surviving guarantee is weaker but
    // exact: the nested ref appears in NO child's status, and the remaining
    // parent ref still pairs FIFO (here to the next discovery, agent-nested —
    // the acknowledged best-effort mispairing, without the nested cascade).
    const nested = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-nested');
    expect(nested.status.task_ref).toBe('toolu_parent_b');
    expect(publisher.calls.publishStatus.some(s => s.status.task_ref === 'toolu_nested')).toBe(false);
    // agent-b pairs nothing — an empty status frame is skipped entirely.
    expect(publisher.calls.publishStatus.some(s => s.convoId === 'parent-uuid:sub:agent-b')).toBe(false);

    // The nested ref finishes nothing.
    publisher.calls.upsertConvo.length = 0;
    tracker.noteTaskResult('toolu_nested');
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it('associates pending Task tool_use_ids to children FIFO', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.noteTaskStarted('toolu_2');
    tracker.discover('agent-a', { label: 'A', agentType: null });
    tracker.discover('agent-b', { label: 'B', agentType: null });

    const a = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-a');
    const b = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-b');
    expect(a.status.task_ref).toBe('toolu_1');
    expect(b.status.task_ref).toBe('toolu_2');
  });

  it('marks the child done when the spawning Task tool_result is observed', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('agent-1', { label: 'A', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.noteTaskResult('toolu_1');

    expect(publisher.calls.upsertConvo).toHaveLength(1);
    const { convoId, opts } = publisher.calls.upsertConvo[0];
    expect(convoId).toBe('parent-uuid:sub:agent-1');
    expect(opts.sessionState).toBe(CHILD_STATE_FINISHED);
  });

  it('an unrelated Task tool_result does not finish any child', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('agent-1', { label: 'A', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.noteTaskResult('toolu_unknown');
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it('a late title refresh on a done child never flips it back to running', () => {
    // Discovery with only the short-id fallback (meta.json not written yet).
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('agent-1', { label: 'deadbeef', agentType: null });
    tracker.noteTaskResult('toolu_1'); // parent tool_result -> done

    // Trailing tail events after completion are expected (the final answer
    // drains after the parent's tool_result) — now the real label arrives.
    publisher.calls.upsertConvo.length = 0;
    const child = tracker.onEvent('agent-1', { label: 'Explore auth', agentType: 'code-explorer', event: subagentAssistantEvent({}) });

    // Content may still route (index.js publishes the trailing text) ...
    expect(child.convoId).toBe('parent-uuid:sub:agent-1');
    // ... and the title refresh upsert must re-assert the child's ACTUAL
    // state, never resurrect 'running' (the tracker already thinks it is
    // finished, so nothing would ever set it back to done).
    const refresh = publisher.calls.upsertConvo.find(u => u.opts.title === 'Explore auth');
    expect(refresh).toBeTruthy();
    expect(refresh.opts.sessionState).toBe(CHILD_STATE_FINISHED);
    expect(publisher.calls.upsertConvo.some(u => u.opts.sessionState === CHILD_STATE_RUNNING)).toBe(false);
  });

  it('finishAll sweeps every still-running child to done exactly once', () => {
    tracker.discover('agent-1', { label: 'A', agentType: null });
    tracker.discover('agent-2', { label: 'B', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.finishAll();
    expect(publisher.calls.upsertConvo.map(u => u.opts.sessionState)).toEqual([
      CHILD_STATE_FINISHED, CHILD_STATE_FINISHED,
    ]);

    // Idempotent: a second sweep (or a late tool_result) does not re-emit.
    tracker.finishAll();
    tracker.noteTaskResult('anything');
    expect(publisher.calls.upsertConvo).toHaveLength(2);
  });

  it('does nothing (never throws) when the parent convo id is not yet known', () => {
    const t = createSubagentConvoTracker({
      publisher,
      getParentConvoId: () => null,
      log: { warn() {} },
    });
    expect(() => t.discover('agent-1', { label: 'A', agentType: null })).not.toThrow();
    expect(publisher.calls.upsertConvo).toHaveLength(0);
    expect(t.convoIdFor('agent-1')).toBeNull();
  });

  // Background agents (Agent tool with run_in_background) break both FIFO
  // assumptions the sync-Task flow rests on: the spawning tool_result
  // arrives INSTANTLY ("Async agent launched…"), long before the subagent
  // finishes — and often before the watcher even discovers its transcript.
  // The stream compensates with system events that carry an explicit
  // tool_use_id ↔ task_id pairing (task_id IS the watcher's agentId):
  // task_started at launch and task_notification at real completion.
  describe('background task lifecycle', () => {
    it('pairs the ref to its agent directly and removes it from the FIFO', () => {
      tracker.noteTaskStarted('toolu_bg');            // Agent tool_use in parent stream
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg'); // system task_started
      const child = tracker.discover('agent-bg', { label: 'BG', agentType: null });
      expect(child.taskRef).toBe('toolu_bg');
      // The ref must be OUT of the FIFO — the next sibling may not inherit it.
      const sibling = tracker.discover('agent-sib', { label: 'Sib', agentType: null });
      expect(sibling.taskRef).toBeNull();
    });

    it('ignores the instant launch tool_result — the child stays running', () => {
      tracker.noteTaskStarted('toolu_bg');
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      tracker.discover('agent-bg', { label: 'BG', agentType: null });
      publisher.calls.upsertConvo.length = 0;
      tracker.noteTaskResult('toolu_bg'); // "Async agent launched successfully"
      expect(publisher.calls.upsertConvo).toHaveLength(0);
    });

    it('finishes the child on noteTaskCompleted(taskId)', () => {
      tracker.noteTaskStarted('toolu_bg');
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      tracker.discover('agent-bg', { label: 'BG', agentType: null });
      publisher.calls.upsertConvo.length = 0;
      tracker.noteTaskCompleted('agent-bg');
      expect(publisher.calls.upsertConvo).toEqual([
        { convoId: 'parent-uuid:sub:agent-bg', opts: { sessionState: CHILD_STATE_FINISHED } },
      ]);
      // Idempotent — a duplicate notification or late finishAll never re-emits.
      tracker.noteTaskCompleted('agent-bg');
      tracker.finishAll();
      expect(publisher.calls.upsertConvo).toHaveLength(1);
    });

    it('survives the observed race: launch tool_result BEFORE discovery', () => {
      // 2026-07-15 live repro: tool_result beat the watcher's discovery, the
      // FIFO ref was never consumed, and the child sat 'running' forever.
      tracker.noteTaskStarted('toolu_bg');
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      tracker.noteTaskResult('toolu_bg');   // instant — no child exists yet
      const child = tracker.discover('agent-bg', { label: 'BG', agentType: null });
      expect(child.taskRef).toBe('toolu_bg');
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      tracker.noteTaskCompleted('agent-bg'); // real completion signal
      const done = publisher.calls.upsertConvo.filter(
        u => u.opts.sessionState === CHILD_STATE_FINISHED);
      expect(done).toHaveLength(1);
    });

    it('task_started arriving after discovery back-fills the task_ref on the child', () => {
      // Discovery burst (~100ms) can beat the system event. The child is
      // created ref-less (or FIFO-paired); the explicit pairing corrects it
      // and republishes status so the apps' Task-card link still works.
      const child = tracker.discover('agent-bg', { label: 'BG', agentType: null });
      expect(child.taskRef).toBeNull();
      publisher.calls.publishStatus.length = 0;
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      expect(child.taskRef).toBe('toolu_bg');
      expect(publisher.calls.publishStatus).toEqual([
        { convoId: 'parent-uuid:sub:agent-bg', status: { task_ref: 'toolu_bg' } },
      ]);
    });

    it('noteTaskCompleted for an unknown agent is a safe no-op', () => {
      expect(() => tracker.noteTaskCompleted('agent-ghost')).not.toThrow();
      expect(publisher.calls.upsertConvo).toHaveLength(0);
    });
  });

  // The tracker records every minted `running` child into a
  // persistent store and drops it the moment it finishes, so a bridge restart
  // can reconcile children that never reached `done` in-process.
  describe('runningStore integration', () => {
    function makeStore() {
      const map = new Map();
      return {
        map,
        calls: { add: [], remove: [] },
        add(childConvoId, meta) { this.calls.add.push({ childConvoId, meta }); map.set(childConvoId, meta); },
        remove(childConvoId) { this.calls.remove.push(childConvoId); map.delete(childConvoId); },
        list() { return [...map.entries()].map(([childConvoId, meta]) => ({ childConvoId, ...meta })); },
      };
    }

    it('records a child as running on mint and removes it on finish (terminal transitions)', () => {
      const publisher = makePublisher();
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher,
        getParentConvoId: () => 'parent-uuid',
        runningStore,
        log: { warn() {} },
      });

      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(runningStore.calls.add).toHaveLength(1);
      expect(runningStore.calls.add[0].childConvoId).toBe('parent-uuid:sub:agent-1');
      expect(runningStore.calls.add[0].meta).toMatchObject({ parentConvoId: 'parent-uuid', agentId: 'agent-1' });
      expect(runningStore.list()).toHaveLength(1);

      tracker.noteTaskResult('toolu_1'); // sync-Task tool_result → finish
      expect(runningStore.calls.remove).toEqual(['parent-uuid:sub:agent-1']);
      expect(runningStore.list()).toEqual([]);
    });

    it('does not re-add on repeat discovery of the same agent', () => {
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher: makePublisher(),
        getParentConvoId: () => 'parent-uuid',
        runningStore,
        log: { warn() {} },
      });
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(runningStore.calls.add).toHaveLength(1);
    });

    it('finishAll removes every still-running child from the store', () => {
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher: makePublisher(),
        getParentConvoId: () => 'parent-uuid',
        runningStore,
        log: { warn() {} },
      });
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.discover('agent-2', { label: 'B', agentType: null });
      expect(runningStore.list()).toHaveLength(2);
      tracker.finishAll();
      expect(runningStore.list()).toEqual([]);
      expect(runningStore.calls.remove.sort()).toEqual(['parent-uuid:sub:agent-1', 'parent-uuid:sub:agent-2']);
    });

    it('works without a runningStore (optional dependency)', () => {
      const tracker = createSubagentConvoTracker({
        publisher: makePublisher(),
        getParentConvoId: () => 'parent-uuid',
        log: { warn() {} },
      });
      expect(() => {
        tracker.discover('agent-1', { label: 'A', agentType: null });
        tracker.finishAll();
      }).not.toThrow();
    });
  });
});
