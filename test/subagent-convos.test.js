import { describe, it, expect, beforeEach } from 'vitest';
import {
  childConvoId,
  subagentTitle,
  createSubagentConvoTracker,
  CHILD_STATE_RUNNING,
  CHILD_STATE_FINISHED,
  TASK_STARTED_STARTED_NEW,
  TASK_STARTED_RESUMED,
  TASK_STARTED_REJECTED_REPLAY,
  TASK_STARTED_IGNORED,
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
      // Simulate immediate confirmed delivery so onLocalSendComplete-gated cleanup
      // (subagent finish() store removal) runs synchronously in tests.
      try { options?.onLocalSendComplete?.(); } catch { /* mirror publisher's swallow */ }
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
    // Hardening: the terminal frame must carry parentConvoId. finish() normally
    // runs after the row already exists (UPDATE ignores parentage), but if the
    // `running` upsert was lost this `done` frame becomes the INSERT — and
    // parent_convo_id is INSERT-only. Omitting it would mint a root orphan.
    expect(opts.parentConvoId).toBe('parent-uuid');
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
        {
          convoId: 'parent-uuid:sub:agent-bg',
          opts: { sessionState: CHILD_STATE_FINISHED, parentConvoId: 'parent-uuid' },
        },
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

  // Loop #751: a duplicated / replayed task_notification for a PRIOR run must
  // not finish the run currently in flight. The completion is gated on the
  // notification's tool_use_id matching the child's CURRENT taskRef.
  describe('completion gated on tool_use_id (loop #751)', () => {
    it('finishes on a matching tool_use_id', () => {
      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      publisher.calls.upsertConvo.length = 0;

      tracker.noteTaskCompleted('agent-1', 'toolu_1');

      expect(publisher.calls.upsertConvo.at(-1).opts.sessionState).toBe(CHILD_STATE_FINISHED);
    });

    it('falls back to finish-by-task_id when no tool_use_id is supplied (never-resumed run)', () => {
      // Streams that don't carry a tool_use_id on the notification must still
      // complete a never-resumed run: generation 0 has exactly one incarnation,
      // so an uncorrelated completion is unambiguous.
      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      publisher.calls.upsertConvo.length = 0;

      tracker.noteTaskCompleted('agent-1');

      expect(publisher.calls.upsertConvo.at(-1).opts.sessionState).toBe(CHILD_STATE_FINISHED);
    });

    it('ignores an uncorrelated (id-less) notification for a RESUMED run — cannot risk killing the live incarnation', () => {
      // Codex F1: for a producer that omits tool_use_id, a stale run-N
      // notification arriving after run N+1 has started must not blindly finish
      // the live resumed run. generation >= 1 means multiple incarnations exist,
      // so an uncorrelated completion is ambiguous and is ignored (finishAll
      // settles the child at teardown).
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      const child = tracker.discover('agent-x', { label: 'X', agentType: null });
      tracker.noteTaskCompleted('agent-x', 'toolu_runN'); // run N finishes
      tracker.revive('agent-x');                          // run N+1 (generation -> 1)
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      publisher.calls.upsertConvo.length = 0;

      tracker.noteTaskCompleted('agent-x'); // id-less stale/uncorrelated notification
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(publisher.calls.upsertConvo).toHaveLength(0);
    });

    it('a replayed run-N task_started must not regress taskRef and let a stale completion finish run N+1', () => {
      // R2 F2: the completion gate reads child.taskRef, but noteBackgroundTaskStarted
      // otherwise overwrites it unconditionally. A delayed replay of run N's
      // task_started could restore the retired ref and let the replayed run-N
      // completion match and finish the live resumed run.
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      const child = tracker.discover('agent-x', { label: 'X', agentType: null });
      tracker.noteTaskCompleted('agent-x', 'toolu_runN'); // run N finishes

      // Run N+1 resumes under a new ref.
      tracker.noteBackgroundTaskStarted('toolu_runN1', 'agent-x');
      tracker.revive('agent-x');
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(child.taskRef).toBe('toolu_runN1');

      // A DELAYED REPLAY of run N's task_started arrives while N+1 runs — must
      // NOT regress the ref back to the retired run-N value.
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      expect(child.taskRef).toBe('toolu_runN1');

      publisher.calls.upsertConvo.length = 0;
      // The replayed run-N completion is therefore still rejected.
      tracker.noteTaskCompleted('agent-x', 'toolu_runN');
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(publisher.calls.upsertConvo).toHaveLength(0);

      // And the correct run-N+1 completion still finishes it.
      tracker.noteTaskCompleted('agent-x', 'toolu_runN1');
      expect(child.state).toBe(CHILD_STATE_FINISHED);
    });

    it('a late explicit task_started still corrects a reverse-discovery FIFO mispairing on a running child', () => {
      // Delta-gate F1: the replay guard must not reject a VALID authoritative
      // pairing. Two agents' refs are queued FIFO; discovery happens in REVERSE
      // order so each running child provisionally gets the OTHER's ref. The
      // later explicit task_started events must still correct them (documented
      // discovery-beats-system-event contract), and both must then complete.
      tracker.noteTaskStarted('ref-A');
      tracker.noteTaskStarted('ref-B');
      const b = tracker.discover('agent-B', { label: 'B', agentType: null }); // FIFO -> ref-A (wrong)
      const a = tracker.discover('agent-A', { label: 'A', agentType: null }); // FIFO -> ref-B (wrong)
      expect(b.taskRef).toBe('ref-A');
      expect(a.taskRef).toBe('ref-B');

      // Authoritative pairings correct the provisional refs on the RUNNING children.
      tracker.noteBackgroundTaskStarted('ref-B', 'agent-B');
      tracker.noteBackgroundTaskStarted('ref-A', 'agent-A');
      expect(b.taskRef).toBe('ref-B');
      expect(a.taskRef).toBe('ref-A');

      // Correctly correlated completions now finish BOTH — no stranded children.
      tracker.noteTaskCompleted('agent-B', 'ref-B');
      tracker.noteTaskCompleted('agent-A', 'ref-A');
      expect(b.state).toBe(CHILD_STATE_FINISHED);
      expect(a.state).toBe(CHILD_STATE_FINISHED);
    });

    it('ignores a replayed run-N notification after run N+1 has started, then finishes on run N+1', () => {
      // Run N: background spawn under toolu_runN, discovered, then completes.
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      const child = tracker.discover('agent-x', { label: 'X', agentType: null });
      tracker.noteTaskCompleted('agent-x', 'toolu_runN'); // run N finishes
      expect(child.state).toBe(CHILD_STATE_FINISHED);

      // Run N+1: SendMessage resume — a fresh task_started carries a NEW
      // tool_use_id (advances taskRef), then revive flips the child running.
      tracker.noteBackgroundTaskStarted('toolu_runN1', 'agent-x');
      tracker.revive('agent-x');
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(child.taskRef).toBe('toolu_runN1');
      publisher.calls.upsertConvo.length = 0;

      // A LATE / duplicated run-N notification (stale tool_use_id) arrives.
      tracker.noteTaskCompleted('agent-x', 'toolu_runN');
      // Must NOT finish the live resumed run.
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(publisher.calls.upsertConvo).toHaveLength(0);

      // The correct run-N+1 notification still finishes it.
      tracker.noteTaskCompleted('agent-x', 'toolu_runN1');
      expect(child.state).toBe(CHILD_STATE_FINISHED);
      expect(publisher.calls.upsertConvo.at(-1).opts.sessionState).toBe(CHILD_STATE_FINISHED);
    });
  });

  // Loop #764: noteBackgroundTaskStarted returns a disposition so index.js can
  // gate revive/forceAttach. A REPLAYED task_started for an already-finished run
  // must report 'rejected-replay' — reviving unconditionally flipped the
  // completed child back to a phantom 'running' in every client.
  describe('task_started disposition gates revive (loop #764)', () => {
    it('a fresh background spawn (no child yet) reports started-new', () => {
      expect(tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg'))
        .toBe(TASK_STARTED_STARTED_NEW);
    });

    it('a same-ref start on a live child reports started-new (harmless echo)', () => {
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      tracker.discover('agent-bg', { label: 'BG', agentType: null });
      expect(tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg'))
        .toBe(TASK_STARTED_STARTED_NEW);
    });

    it('a SAME-REF replay of a FINISHED run reports rejected-replay (the ghost-revive bug)', () => {
      tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      const child = tracker.discover('agent-bg', { label: 'BG', agentType: null });
      tracker.noteTaskCompleted('agent-bg', 'toolu_bg'); // run finishes
      expect(child.state).toBe(CHILD_STATE_FINISHED);
      const gen = child.generation;
      publisher.calls.upsertConvo.length = 0;

      // The replayed task_started for the same, already-finished run.
      const disp = tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      expect(disp).toBe(TASK_STARTED_REJECTED_REPLAY);
      // Gate honored by index.js means revive is NOT called; the tracker itself
      // must also not have mutated the finished child's state or generation.
      expect(child.state).toBe(CHILD_STATE_FINISHED);
      expect(child.generation).toBe(gen);
      expect(publisher.calls.upsertConvo).toHaveLength(0);
    });

    it('a genuine resume (finished child, NEW ref) reports resumed and advances taskRef', () => {
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      const child = tracker.discover('agent-x', { label: 'X', agentType: null });
      tracker.noteTaskCompleted('agent-x', 'toolu_runN');
      expect(child.state).toBe(CHILD_STATE_FINISHED);

      const disp = tracker.noteBackgroundTaskStarted('toolu_runN1', 'agent-x');
      expect(disp).toBe(TASK_STARTED_RESUMED);
      expect(child.taskRef).toBe('toolu_runN1');
      // The disposition tells index.js to revive; doing so still works.
      tracker.revive('agent-x');
      expect(child.state).toBe(CHILD_STATE_RUNNING);
    });

    it('a replay of a RETIRED ref (after a resume) reports rejected-replay', () => {
      tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x');
      const child = tracker.discover('agent-x', { label: 'X', agentType: null });
      tracker.noteTaskCompleted('agent-x', 'toolu_runN');
      tracker.noteBackgroundTaskStarted('toolu_runN1', 'agent-x'); // resume, retires runN
      tracker.revive('agent-x');
      expect(child.state).toBe(CHILD_STATE_RUNNING);

      const disp = tracker.noteBackgroundTaskStarted('toolu_runN', 'agent-x'); // replay
      expect(disp).toBe(TASK_STARTED_REJECTED_REPLAY);
      expect(child.taskRef).toBe('toolu_runN1'); // not regressed
    });

    it('a reverse-discovery FIFO correction on a RUNNING child reports started-new', () => {
      tracker.noteTaskStarted('ref-A');
      tracker.noteTaskStarted('ref-B');
      const b = tracker.discover('agent-B', { label: 'B', agentType: null }); // FIFO -> ref-A
      tracker.discover('agent-A', { label: 'A', agentType: null }); // FIFO -> ref-B
      // Authoritative pairing corrects the provisional ref on the RUNNING child.
      const disp = tracker.noteBackgroundTaskStarted('ref-B', 'agent-B');
      expect(disp).toBe(TASK_STARTED_STARTED_NEW);
      expect(b.taskRef).toBe('ref-B');
    });

    it('invalid input reports ignored', () => {
      expect(tracker.noteBackgroundTaskStarted('', 'agent-x')).toBe(TASK_STARTED_IGNORED);
      expect(tracker.noteBackgroundTaskStarted('toolu', '')).toBe(TASK_STARTED_IGNORED);
    });

    it('a late FIRST task_started still revives a child finished by a premature launch tool_result (Codex F1)', () => {
      // Race: discovery FIFO-pairs the queued ref onto the child, THEN the instant
      // launch tool_result finishes it (noteTaskResult, before backgroundRefs is
      // populated). The child is now 'done' carrying the ref — but its real
      // task_started has not fired yet. That first start must NOT be mistaken for
      // a replay: it is the genuine start of a live agent.
      tracker.noteTaskStarted('toolu_bg');                                 // queue ref
      const child = tracker.discover('agent-bg', { label: 'BG', agentType: null }); // FIFO-pair
      expect(child.taskRef).toBe('toolu_bg');
      tracker.noteTaskResult('toolu_bg');                                  // premature finish
      expect(child.state).toBe(CHILD_STATE_FINISHED);

      // First task_started for the ref: not a replay -> started-new, so index.js revives.
      const disp = tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg');
      expect(disp).toBe(TASK_STARTED_STARTED_NEW);
      tracker.revive('agent-bg');
      expect(child.state).toBe(CHILD_STATE_RUNNING);

      // A subsequent same-ref replay (now that the start has been seen) is rejected.
      tracker.noteTaskCompleted('agent-bg', 'toolu_bg'); // real completion
      expect(child.state).toBe(CHILD_STATE_FINISHED);
      expect(tracker.noteBackgroundTaskStarted('toolu_bg', 'agent-bg'))
        .toBe(TASK_STARTED_REJECTED_REPLAY);
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

    it('does not publish a running child when the write-ahead record fails, and re-mints on retry', () => {
      const publisher = makePublisher();
      let addResult = false; // store can't durably persist yet
      const store = {
        calls: { add: [], remove: [] },
        add(childConvoId, meta) { this.calls.add.push({ childConvoId, meta }); return addResult; },
        remove(childConvoId) { this.calls.remove.push(childConvoId); },
        list() { return []; },
      };
      const tracker = createSubagentConvoTracker({
        publisher,
        getParentConvoId: () => 'parent-uuid',
        runningStore: store,
        log: { warn() {} },
      });

      // Write-ahead failed → the child must NOT be published (no server-visible
      // running child with no recovery record).
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(store.calls.add).toHaveLength(1);
      expect(publisher.calls.upsertConvo).toHaveLength(0);

      // The mint rolled back, so a later watcher poll re-discovers the agent;
      // once the store can persist, it mints and publishes normally.
      addResult = true;
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(store.calls.add).toHaveLength(2);
      expect(publisher.calls.upsertConvo).toHaveLength(1);
    });

    it('restores the consumed FIFO Task ref on write-ahead failure so the retry re-pairs it', () => {
      const publisher = makePublisher();
      let addResult = false;
      const store = {
        calls: { add: [], remove: [] },
        add(childConvoId, meta) { this.calls.add.push({ childConvoId, meta }); return addResult; },
        remove(childConvoId) { this.calls.remove.push(childConvoId); },
        list() { return []; },
      };
      const tracker = createSubagentConvoTracker({
        publisher,
        getParentConvoId: () => 'parent-uuid',
        runningStore: store,
        log: { warn() {} },
      });

      tracker.noteTaskStarted('toolu_1'); // queues a sync-Task FIFO ref
      // First discover fails to persist → rolls back AND returns the FIFO ref.
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(publisher.calls.upsertConvo).toHaveLength(0);

      // Retry persists → the restored FIFO ref must re-pair, so the child's later
      // Task result can find it and drive finish() (store removal on delivery).
      addResult = true;
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(publisher.calls.upsertConvo).toHaveLength(1);
      tracker.noteTaskResult('toolu_1');
      expect(store.calls.remove).toEqual(['parent-uuid:sub:agent-1']);
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

    it('keeps the write-ahead record when the done frame is never confirmed delivered', () => {
      // The real journal publisher only fires onLocalSendComplete on CONFIRMED socket
      // delivery. A crash-before-flush / queue-overflow drop means it never
      // fires — the write-ahead record must survive so the next startup/reconnect
      // reconcile re-publishes `done`. The default fake publisher confirms
      // synchronously, so this NON-confirming publisher is what actually
      // exercises the central "clear the store ONLY on delivery" invariant.
      const neverConfirms = {
        calls: { upsertConvo: [] },
        upsertConvo(convoId, opts /* , options */) {
          // Deliberately drop `options.onLocalSendComplete` on the floor (never call it).
          this.calls.upsertConvo.push({ convoId, opts });
        },
        publishStatus() {},
        publishText() {},
        publishDiff() {},
      };
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher: neverConfirms,
        getParentConvoId: () => 'parent-uuid',
        runningStore,
        log: { warn() {} },
      });

      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      expect(runningStore.list()).toHaveLength(1);

      tracker.noteTaskResult('toolu_1'); // → finish(): publishes done, gates removal on delivery
      // The done frame was published...
      expect(neverConfirms.calls.upsertConvo.some(
        u => u.opts.sessionState === CHILD_STATE_FINISHED)).toBe(true);
      // ...but delivery was never confirmed, so the record MUST survive for retry.
      expect(runningStore.calls.remove).toEqual([]);
      expect(runningStore.list()).toHaveLength(1);
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

  // A subagent RESUMED via SendMessage runs again under the SAME agentId, so it
  // reuses the SAME deterministic child convo. If the tracker already finished
  // that child, its card renders `done` for the entire resumed run — a live
  // agent that looks dead in every client. revive() puts it back to `running`.
  describe('revive (resumed subagent)', () => {
    function makeStore() {
      const map = new Map();
      return {
        map,
        calls: { add: [], remove: [] },
        add(childConvoId, meta) { this.calls.add.push({ childConvoId, meta }); map.set(childConvoId, meta); return true; },
        remove(childConvoId) { this.calls.remove.push(childConvoId); map.delete(childConvoId); return true; },
        list() { return [...map.entries()].map(([childConvoId, meta]) => ({ childConvoId, ...meta })); },
      };
    }

    it('flips a finished child back to running and re-arms its write-ahead record', () => {
      const publisher = makePublisher();
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore, log: { warn() {} },
      });

      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskResult('toolu_1');
      expect(runningStore.list()).toEqual([]);

      const child = tracker.revive('agent-1');

      expect(child).toBeTruthy();
      expect(child.state).toBe(CHILD_STATE_RUNNING);
      // Re-published as running, carrying parentage (the row may have been lost).
      const last = publisher.calls.upsertConvo.at(-1);
      expect(last.convoId).toBe('parent-uuid:sub:agent-1');
      expect(last.opts).toMatchObject({ sessionState: CHILD_STATE_RUNNING, parentConvoId: 'parent-uuid' });
      // Reconciliation can find it again if the bridge dies mid-resume.
      expect(runningStore.list()).toHaveLength(1);
    });

    it('lets the resumed run finish normally afterwards', () => {
      const publisher = makePublisher();
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore, log: { warn() {} },
      });
      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskCompleted('agent-1', 'toolu_1');
      tracker.revive('agent-1');
      tracker.noteTaskCompleted('agent-1', 'toolu_1');

      expect(publisher.calls.upsertConvo.at(-1).opts.sessionState).toBe(CHILD_STATE_FINISHED);
      expect(runningStore.list()).toEqual([]);
    });

    // Codex R2 F4: a refused write-ahead record must not be terminal. Without a
    // retry, one transient store hiccup leaves the whole resumed run rendered
    // `done`, with no durable record either — the worst of both.
    it('retries a refused revive on the next event, then publishes running', () => {
      const publisher = makePublisher();
      let allowAdd = false;
      const store = {
        map: new Map(),
        add(childConvoId, meta) {
          if (!allowAdd) return false;
          this.map.set(childConvoId, meta);
          return true;
        },
        remove(childConvoId) { this.map.delete(childConvoId); return true; },
        list() { return [...this.map.entries()].map(([childConvoId, meta]) => ({ childConvoId, ...meta })); },
      };
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore: store, log: { warn() {} },
      });

      allowAdd = true;
      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskCompleted('agent-1');

      allowAdd = false;
      expect(tracker.revive('agent-1')).toBeNull();
      const afterRefusal = publisher.calls.upsertConvo.length;

      // The resumed agent's transcript events keep coming; the store recovers.
      allowAdd = true;
      const child = tracker.onEvent('agent-1', { label: 'A', event: subagentAssistantEvent({ text: 'hi' }) });

      expect(child.state).toBe(CHILD_STATE_RUNNING);
      expect(publisher.calls.upsertConvo.length).toBeGreaterThan(afterRefusal);
      expect(publisher.calls.upsertConvo.at(-1).opts.sessionState).toBe(CHILD_STATE_RUNNING);
      expect(store.list()).toHaveLength(1);
    });

    it('does not resurrect a genuinely-done child on a trailing event (no revive was requested)', () => {
      const publisher = makePublisher();
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore, log: { warn() {} },
      });
      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskResult('toolu_1');
      const after = publisher.calls.upsertConvo.length;

      // The final answer drains late — normal, and must NOT flip it back.
      const child = tracker.onEvent('agent-1', { label: 'A', event: subagentAssistantEvent({ text: 'late' }) });

      expect(child.state).toBe(CHILD_STATE_FINISHED);
      expect(publisher.calls.upsertConvo).toHaveLength(after);
      expect(runningStore.list()).toEqual([]);
    });

    it('stops retrying a refused revive once the resumed run has ended anyway', () => {
      const publisher = makePublisher();
      const store = {
        map: new Map(), allow: true,
        add(id, meta) { if (!this.allow) return false; this.map.set(id, meta); return true; },
        remove(id) { this.map.delete(id); return true; },
        list() { return [...this.map.keys()]; },
      };
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore: store, log: { warn() {} },
      });
      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskCompleted('agent-1');

      store.allow = false;
      tracker.revive('agent-1');
      tracker.noteTaskCompleted('agent-1'); // the resumed run finished regardless

      store.allow = true;
      const after = publisher.calls.upsertConvo.length;
      const child = tracker.onEvent('agent-1', { label: 'A', event: subagentAssistantEvent({ text: 'x' }) });

      // `done` is now the truthful state — don't revive it retroactively.
      expect(child.state).toBe(CHILD_STATE_FINISHED);
      expect(publisher.calls.upsertConvo).toHaveLength(after);
      expect(store.list()).toEqual([]);
    });

    it('is a no-op for an unknown agent and for one already running', () => {
      const publisher = makePublisher();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', log: { warn() {} },
      });

      expect(tracker.revive('never-seen')).toBeNull();
      expect(publisher.calls.upsertConvo).toHaveLength(0);

      tracker.discover('agent-1', { label: 'A', agentType: null });
      const before = publisher.calls.upsertConvo.length;
      expect(tracker.revive('agent-1')).toBeNull();
      expect(publisher.calls.upsertConvo).toHaveLength(before);
    });

    it('does not publish running when the write-ahead record cannot be re-armed', () => {
      const publisher = makePublisher();
      const store = {
        added: 0,
        add() { this.added += 1; return this.added > 1 ? false : true; },
        remove() { return true; },
        list() { return []; },
      };
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore: store, log: { warn() {} },
      });
      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskResult('toolu_1');
      const before = publisher.calls.upsertConvo.length;

      expect(tracker.revive('agent-1')).toBeNull();
      expect(publisher.calls.upsertConvo).toHaveLength(before);
    });

    // Codex R1 F2: state alone cannot separate incarnations. Run 1's ack arriving
    // after run 2 has ALSO finished sees state === done and would clear run 2's
    // write-ahead record — which is still gated on run 2's own (unlanded) ack.
    it('a stale ack from the PREVIOUS run must not erase the resumed run\'s record', () => {
      const deliveries = [];
      const publisher = {
        calls: { upsertConvo: [] },
        upsertConvo(convoId, opts, options) {
          this.calls.upsertConvo.push({ convoId, opts });
          if (options?.onLocalSendComplete) deliveries.push(options.onLocalSendComplete);
        },
        publishStatus() {}, publishText() {}, publishDiff() {},
      };
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore, log: { warn() {} },
      });

      tracker.noteBackgroundTaskStarted('toolu_1', 'agent-1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskCompleted('agent-1', 'toolu_1');   // run 1 done — ack pending
      const run1Ack = deliveries.at(-1);

      tracker.revive('agent-1');              // resumed
      tracker.noteTaskCompleted('agent-1', 'toolu_1');   // run 2 done — its own ack pending
      const run2Ack = deliveries.at(-1);
      expect(run2Ack).not.toBe(run1Ack);
      expect(runningStore.list()).toHaveLength(1);

      run1Ack(); // the stale one finally lands
      // Run 2's record survives: its own frame has not been confirmed yet, so
      // losing it would leave the server `running` with nothing to reconcile.
      expect(runningStore.list()).toHaveLength(1);

      run2Ack();
      expect(runningStore.list()).toEqual([]);
    });

    it('a late done-frame delivery must not erase the record the revive just re-armed', () => {
      // The finish() frame's onLocalSendComplete fires AFTER the resume — removing then
      // would discard the live child's only reconciliation record.
      const deliveries = [];
      const publisher = {
        calls: { upsertConvo: [], publishStatus: [], publishText: [], publishDiff: [] },
        upsertConvo(convoId, opts, options) {
          this.calls.upsertConvo.push({ convoId, opts });
          if (options?.onLocalSendComplete) deliveries.push(options.onLocalSendComplete);
        },
        publishStatus() {}, publishText() {}, publishDiff() {},
      };
      const runningStore = makeStore();
      const tracker = createSubagentConvoTracker({
        publisher, getParentConvoId: () => 'parent-uuid', runningStore, log: { warn() {} },
      });

      tracker.noteTaskStarted('toolu_1');
      tracker.discover('agent-1', { label: 'A', agentType: null });
      tracker.noteTaskResult('toolu_1');   // done published, delivery pending
      tracker.revive('agent-1');           // resumed before the ack landed
      expect(runningStore.list()).toHaveLength(1);

      for (const ack of deliveries) ack();  // the stale ack finally arrives

      expect(runningStore.list()).toHaveLength(1);
    });
  });
});
