import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptTail } from './transcript-tail.js';
import { subagentsDirFor } from './transcript-dir.js';

// Re-exported so existing importers (and tests) can keep pulling it from here.
export { subagentsDirFor };

// Subagent transcripts live alongside the parent transcript:
//
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl          (parent)
//   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/     (one file per subagent)
//       agent-<id>.jsonl
//       agent-<id>.meta.json   { agentType, description }
//
// Discovery is event-triggered: the parent's stream emits a `Task` tool_use
// event the instant a subagent kicks off. The bridge calls
// notifyTaskStarted() at that moment; we poll the subagents directory for a
// brief window (default 5s) until the new agent-<id>.jsonl appears, then
// attach a TranscriptTail. After the window expires we stop polling. Idle
// sessions never poll anything.

const DEFAULT_BURST_WINDOW_MS = 5000;
const DEFAULT_BURST_INTERVAL_MS = 200;
// How long a force-attach that could not yet read its transcript stays queued
// for retry. Longer than the discovery burst so a brief rotation / EACCES /
// not-yet-flushed file still recovers; bounded so a genuinely-gone file warns
// instead of being retried forever.
const FORCE_ATTACH_RETRY_WINDOW_MS = 15000;

// Workflow-tool runs (loop #798). A Workflow spawns its agents over minutes to
// hours, one level deeper than Agent subagents:
//
//   <sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl
//   <sessionId>/subagents/workflows/<runId>/agent-<id>.meta.json
//       { agentType: 'workflow-subagent', description, workflowPhase, ... }
//   <sessionId>/subagents/workflows/<runId>/journal.jsonl
//       {type:'started',agentId,label,phase} / {type:'result',agentId,...}
//
// so the 5s burst after one tool call can never find them. Each run gets its
// own long-lived poll from the Workflow tool call until the run's completion
// notification. A quiet run (every started agent has a result, nothing new for
// WORKFLOW_IDLE_STOP_MS) may just be between phases, so it is never stopped —
// it backs off to one scan per WORKFLOW_IDLE_INTERVAL_MS. A lost notification
// is bounded by the hard WORKFLOW_MAX_LIFETIME_MS cap.
const WORKFLOW_POLL_INTERVAL_MS = 1000;
const WORKFLOW_IDLE_STOP_MS = 10 * 60 * 1000;
const WORKFLOW_IDLE_INTERVAL_MS = 30 * 1000;
// How long a completion keeps retrying a final scan that could not read the
// run dir (EACCES, EIO, a transient rename) before warning and giving up.
const WORKFLOW_FINAL_SCAN_RETRY_MS = 15000;
const WORKFLOW_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Run ids are `wf_<hex>-<hex>`; anything else is refused so a malformed id can
// never become a path segment outside the workflows dir.
const WORKFLOW_RUN_ID_RE = /^wf_[A-Za-z0-9-]{1,64}$/;
const WORKFLOW_LABEL_MAX = 40;

export function isWorkflowRunId(runId) {
  return typeof runId === 'string' && WORKFLOW_RUN_ID_RE.test(runId);
}

// The Workflow tool_result is plain text carrying `Run ID: wf_...` and
// `Task ID: <id>` lines (the task id is what the completion task_notification
// names). Accepts the string or content-block-array forms of a tool_result.
export function parseWorkflowLaunchResult(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  if (!text) return null;
  const run = /^Run ID:\s*(\S+)\s*$/m.exec(text);
  if (!run || !isWorkflowRunId(run[1])) return null;
  const task = /\bTask ID:\s*(\S+)/.exec(text);
  return { runId: run[1], taskId: task ? task[1] : null };
}

// Card label for a workflow agent: its meta description, with the workflow
// phase appended so a multi-phase run reads as phase groups in the child strip.
export function workflowAgentLabel(description, phase) {
  const base = typeof description === 'string' && description.trim() ? description.trim() : null;
  const ph = typeof phase === 'string' && phase.trim() ? phase.trim() : null;
  if (!base) return null;
  const full = ph ? `${base} · ${ph}` : base;
  return full.length > WORKFLOW_LABEL_MAX ? full.slice(0, WORKFLOW_LABEL_MAX - 1) + '…' : full;
}

export class SubagentWatcher extends EventEmitter {
  constructor({ workdir, sessionId, log = console } = {}) {
    super();
    this.workdir = workdir;
    this.sessionId = sessionId;
    this.log = log;
    this.dir = subagentsDirFor(workdir, sessionId);
    this.seen = new Set();
    // filename -> { size, ino, dev } as of the moment we marked it seen. A
    // resumed agent's tail must start at THAT boundary, not at the file's size
    // when the resume finally reaches us — see forceAttach. Identity is the full
    // tuple: a same-named file with a different inode is a different file, and
    // its recorded size means nothing.
    this.seenBoundaries = new Map();
    // agentId -> deadline. Force-attaches whose transcript wasn't readable yet;
    // retried by the burst poll, warned about when the deadline passes.
    this.pendingForceAttach = new Map();
    this.tails = new Map(); // filename -> { tail, label, agentId }
    this.burstTimer = null;
    this.snapshotTaken = false;
    // runId -> run record (see watchWorkflowRun).
    this.workflowRuns = new Map();
    // Workflow tool_use_id -> runId / task id -> runId, so the completion
    // notification (which names the tool_use_id and task id, not the run) can
    // stop the right run's poll.
    this.workflowRunByToolUse = new Map();
    this.workflowRunByTask = new Map();
    // Workflow tool_use ids awaiting their launch tool_result. Only these
    // tool_results are parsed for a run id. Bounded: a tool_use whose result
    // never arrives (denied, crashed turn) is evicted oldest-first.
    this.pendingWorkflowToolUses = new Set();
  }

  _warn(msg) {
    try { this.log?.warn?.(msg); } catch { /* logging must never throw */ }
  }

  // Mark a pre-existing transcript seen AND record the byte boundary a resume
  // would have to start from. Best-effort: an unstattable file records no
  // boundary, and forceAttach then replays from the top rather than risk
  // dropping the resumed run.
  _markSeen(name) {
    this.seen.add(name);
    try {
      const st = fs.statSync(path.join(this.dir, name));
      // birthtime as well as ino/dev: a freed inode is commonly reused within
      // seconds, so ino alone can say "same file" about a replacement.
      this.seenBoundaries.set(name, {
        size: st.size, ino: st.ino, dev: st.dev, birthtimeMs: st.birthtimeMs,
      });
    } catch {
      this.seenBoundaries.delete(name);
    }
  }

  // Record any existing agent-*.jsonl files as "seen" so we don't replay
  // subagents from a prior (now-dead) instance of this session. Safe to call
  // even if the dir doesn't exist yet.
  snapshot() {
    if (this.snapshotTaken) return;
    this.snapshotTaken = true;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.jsonl')) this._markSeen(name);
      }
    } catch { /* dir doesn't exist yet — fine, will be created when first task fires */ }
  }

  // Re-home the watcher when the session changes cwd mid-flight (EnterWorktree
  // is the common case). Claude Code relocates the subagents dir to the NEW
  // cwd's project encoding, so a watcher frozen on the spawn cwd polls a stale
  // path and subagent cards stop rendering. Recompute this.dir for the new
  // workdir and re-snapshot it so pre-existing files there (e.g. from a prior
  // instance) aren't replayed — but KEEP the `seen` set so already-emitted
  // cards under the old path don't duplicate, and genuinely-new subagents under
  // the new path (new filenames, not in `seen`) still get picked up. No-op when
  // the encoded dir is unchanged (a symlinked/realpath-equivalent workdir),
  // so callers can invoke it cheaply. Returns true when the dir actually moved.
  repoint(newWorkdir) {
    const nextDir = subagentsDirFor(newWorkdir, this.sessionId);
    if (nextDir === this.dir) {
      this.workdir = newWorkdir;
      return false;
    }
    this.workdir = newWorkdir;
    this.dir = nextDir;
    // Boundaries are per-DIRECTORY (they are sizes+inodes of files under the old
    // path). `seen` is deliberately kept — it is what stops already-emitted cards
    // duplicating — but the boundaries it refers to are now meaningless, so drop
    // them and re-record against the new dir. A `seen` name with no boundary
    // replays from the top on force-attach: the safe direction.
    this.seenBoundaries.clear();
    // Mark whatever already exists in the new dir as seen (mirrors snapshot()),
    // then scan for anything new. Additive to `seen` — never cleared.
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.jsonl')) this._markSeen(name);
      }
    } catch { /* new dir not created yet — fine, _scan tolerates a missing dir */ }
    this._scan();
    return true;
  }

  // Called by the bridge when it sees a `Task` tool_use in the parent stream.
  // Briefly polls for new agent-*.jsonl files and attaches a TranscriptTail
  // to each. Multiple Task calls within the same window share a single burst.
  notifyTaskStarted({ windowMs = DEFAULT_BURST_WINDOW_MS, intervalMs = DEFAULT_BURST_INTERVAL_MS } = {}) {
    this.snapshot();
    this._scan();
    this.burstUntil = Date.now() + windowMs;
    if (this.burstTimer) return; // already burst-polling — windowMs is extended
    this.burstTimer = setInterval(() => {
      this._scan();
      // Keep polling while a force-attach is still waiting on its transcript —
      // _scan() can never recover those (it skips every `seen` name), so the
      // burst is their only retry vehicle. _retryPendingForceAttach expires them,
      // so this cannot spin forever.
      if (Date.now() >= this.burstUntil && this.pendingForceAttach.size === 0) {
        clearInterval(this.burstTimer);
        this.burstTimer = null;
      }
    }, intervalMs);
    if (typeof this.burstTimer.unref === 'function') this.burstTimer.unref();
  }

  async stop() {
    if (this.burstTimer) {
      clearInterval(this.burstTimer);
      this.burstTimer = null;
    }
    this.pendingForceAttach.clear();
    for (const run of [...this.workflowRuns.values()]) this._finishWorkflowRun(run);
    for (const { tail } of this.tails.values()) {
      try { await tail.stop(); } catch { /* ignore */ }
    }
    this.tails.clear();
  }

  _scan() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      entries = null; // dir doesn't exist yet
    }
    for (const name of entries || []) {
      if (!name.endsWith('.jsonl')) continue;
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      this._attach(name);
    }
    // Deliberately OUTSIDE the enumeration guard. A missing/unreadable dir is
    // one of the very conditions a pending force-attach is waiting out, and the
    // burst timer refuses to stop while the queue is nonempty — returning early
    // here would mean the deadline never fires, the promised warning never
    // appears, and the watcher polls forever.
    this._retryPendingForceAttach();
  }

  // Retry force-attaches whose transcript wasn't readable when task_started
  // arrived, and fail VISIBLY once the window closes. Without this a transient
  // rotation / permission error / not-yet-flushed file silently costs the whole
  // resumed run: _scan() skips every `seen` name, so nothing else would ever
  // pick it up.
  _retryPendingForceAttach() {
    if (this.pendingForceAttach.size === 0) return;
    const now = Date.now();
    for (const [agentId, deadline] of [...this.pendingForceAttach]) {
      if (this._tryForceAttach(agentId)) {
        this.pendingForceAttach.delete(agentId);
        continue;
      }
      if (now >= deadline) {
        this.pendingForceAttach.delete(agentId);
        this._warn(`[subagent-watcher] resumed agent ${agentId}: transcript ${path.join(this.dir, `agent-${agentId}.jsonl`)} never became readable within ${FORCE_ATTACH_RETRY_WINDOW_MS}ms — its output will not be shown`);
      }
    }
  }

  // Attach a tail to an agent transcript the snapshot already marked "seen".
  //
  // A subagent RESUMED via SendMessage comes back to life under its ORIGINAL
  // agent id, and therefore its ORIGINAL agent-<id>.jsonl. snapshot() marks
  // every pre-existing transcript seen so a genuinely-dead prior instance is
  // never replayed — right for an agent that stays dead, but it also
  // permanently blinds _scan() to a resumed one: the transcript is APPENDED to,
  // never re-created, so the burst poll has nothing new to find and the resumed
  // agent runs its whole life with no tail, no `subagent-start`, and no card.
  //
  // The stream's task_started names the agent explicitly (task_id IS the
  // filename stem), so we re-attach that ONE file rather than relaxing
  // snapshot() and replaying every dead agent in the directory.
  //
  // Deliberately narrow — each guard is the reason it is safe:
  //   - already tailing -> no-op. A duplicate task_started must not emit a
  //     second card or run two tails over one file.
  //   - not in `seen`   -> no-op. That is a brand-new agent, which belongs to
  //     the burst scan; that path must keep readFromStart:true (a fresh
  //     transcript can already have content by the time the burst polls).
  //
  // If the transcript is not readable yet (rotation, EACCES, task_started
  // beating the file to disk) the request is QUEUED for the burst poll to retry
  // rather than dropped: _scan() skips every `seen` name, so it could never
  // recover on its own. The queue is bounded and warns on expiry.
  //
  // Returns true when a tail was actually attached.
  forceAttach(agentId) {
    if (typeof agentId !== 'string' || !agentId) return false;
    if (this._tryForceAttach(agentId)) return true;
    // Only worth retrying if this is a `seen` transcript we haven't tailed —
    // the two permanent no-ops above must not accumulate queue entries.
    const filename = `agent-${agentId}.jsonl`;
    if (this.seen.has(filename) && !this.tails.has(filename) && !this.pendingForceAttach.has(agentId)) {
      this.pendingForceAttach.set(agentId, Date.now() + FORCE_ATTACH_RETRY_WINDOW_MS);
    }
    return false;
  }

  // The single attach attempt behind forceAttach() and its retry loop.
  _tryForceAttach(agentId) {
    const filename = `agent-${agentId}.jsonl`;
    if (this.tails.has(filename)) return false;
    if (!this.seen.has(filename)) return false;
    // Open, don't just stat. A stat-able but UNOPENABLE transcript (EACCES, ACL
    // denial, EIO) would otherwise be declared attached: TranscriptTail swallows
    // open failures on every tick, the filename is registered in `tails` so
    // nothing can attach it again, the retry queue drops it, and the child is
    // revived to `running` showing no output for the rest of its life.
    // Reading the boundary off THIS descriptor also closes the stat→attach
    // TOCTOU: size and identity now describe the file we proved we can read.
    let fd;
    let st;
    try {
      fd = fs.openSync(path.join(this.dir, filename), fs.constants.O_RDONLY);
      st = fs.fstatSync(fd);
    } catch {
      return false; // not readable yet — caller queues a retry
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
    }
    if (!st.isFile()) return false;
    // Resume from the boundary recorded when this file was marked seen, NOT
    // from its size now. The agent is already running by the time task_started
    // reaches us, so records written in that gap are the resumed run's own
    // output; anchoring at EOF would silently discard them and a fast agent
    // would render an empty card. The boundary is only trusted when the file is
    // still the same inode AND has not shrunk below it — otherwise the name now
    // points at different content and every byte of it is new, so replay it all.
    // A missing boundary replays too: losing the resumed run is strictly worse
    // than re-showing a prior one.
    const boundary = this.seenBoundaries.get(filename);
    const sameFile = boundary
      && boundary.ino === st.ino && boundary.dev === st.dev
      && boundary.birthtimeMs === st.birthtimeMs
      && st.size >= boundary.size;
    if (sameFile) {
      this._attach(filename, { readFromStart: false, startOffset: boundary.size });
    } else {
      this._attach(filename, { readFromStart: true });
    }
    return true;
  }

  // Attach a TranscriptTail to one agent transcript. `dir`/`key` default to the
  // Agent-subagent layout (this.dir, keyed by bare filename — forceAttach relies
  // on that key); a workflow agent passes its run dir and a run-scoped key so it
  // can never collide with, or be mistaken for, a main-dir agent. `workflow`
  // ({ runId }) switches the label source to the meta's description + phase.
  _attach(filename, { readFromStart = true, startOffset = null, dir = this.dir, key = filename, workflow = null } = {}) {
    const filePath = path.join(dir, filename);
    const agentId = filename.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    const fallbackLabel = agentId.slice(0, 8);
    const meta = {
      label: fallbackLabel,
      agentType: null,
      fromFile: false,
      workflowRunId: workflow?.runId ?? null,
      workflowPhase: null,
    };

    const tryReadMeta = () => {
      if (meta.fromFile) return;
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.agentType = parsed.agentType || null;
        if (workflow) {
          meta.workflowPhase = typeof parsed.workflowPhase === 'string' ? parsed.workflowPhase : null;
          const wfLabel = workflowAgentLabel(parsed.description, meta.workflowPhase);
          if (wfLabel) {
            meta.label = wfLabel;
            meta.fromFile = true;
            return;
          }
        }
        if (parsed.description) {
          meta.label = parsed.description.length > 40
            ? parsed.description.slice(0, 37) + '…'
            : parsed.description;
          meta.fromFile = true;
        } else if (parsed.agentType) {
          meta.label = parsed.agentType;
          meta.fromFile = true;
        }
      } catch { /* not yet written — retry on next event */ }
    };

    tryReadMeta();

    const extra = () => (workflow
      ? { workflowRunId: meta.workflowRunId, workflowPhase: meta.workflowPhase }
      : {});
    const tail = new TranscriptTail(filePath, { readFromStart, startOffset });
    tail.on('event', event => {
      // Retry the meta read on each event until we get a real label —
      // the .meta.json is sometimes written a beat after the .jsonl.
      tryReadMeta();
      this.emit('subagent-event', { agentId, label: meta.label, agentType: meta.agentType, ...extra(), event });
    });
    tail.on('parseError', () => { /* ignore — same policy as parent tail */ });
    tail.start();
    this.tails.set(key, { tail, label: meta.label, agentId });
    this.emit('subagent-start', { agentId, label: meta.label, agentType: meta.agentType, ...extra() });
    return agentId;
  }

  // ---------------------------------------------------------------------------
  // Workflow-tool runs (loop #798)
  // ---------------------------------------------------------------------------

  // Parent stream saw a `Workflow` tool_use. A RESUME (input.resumeFromRunId)
  // reuses the run's directory, whose completed agents return cached results
  // and never run again — so start watching NOW, before the run writes
  // anything new, and snapshot what is already there so those cached agents
  // are not replayed as fresh cards. A fresh run's id is only known from the
  // tool_result (noteWorkflowResult).
  noteWorkflowToolUse(toolUseId, input) {
    try {
      if (typeof toolUseId === 'string' && toolUseId) {
        this.pendingWorkflowToolUses.add(toolUseId);
        if (this.pendingWorkflowToolUses.size > 64) {
          this.pendingWorkflowToolUses.delete(this.pendingWorkflowToolUses.values().next().value);
        }
      }
      const resumeId = input?.resumeFromRunId;
      if (!isWorkflowRunId(resumeId)) return null;
      if (typeof toolUseId === 'string' && toolUseId) this.workflowRunByToolUse.set(toolUseId, resumeId);
      this.watchWorkflowRun(resumeId, { snapshotExisting: true });
      return resumeId;
    } catch (e) {
      this._warn(`[subagent-watcher] noteWorkflowToolUse failed: ${e.message}`);
      return null;
    }
  }

  // Parent stream saw a tool_result. If it answers a Workflow tool_use we
  // recorded, parse its `Run ID: wf_...` and start watching that run. Every
  // other tool_result is a Set lookup and out — and never parsed, so a Bash
  // result that merely prints "Run ID: wf_..." cannot start a phantom watch.
  noteWorkflowResult(toolUseId, content) {
    try {
      if (!this.pendingWorkflowToolUses.delete(toolUseId)) return null;
      const parsed = parseWorkflowLaunchResult(content);
      if (!parsed) {
        // A Workflow call whose result names no run: an error/denied result, or
        // the launch text format changed. Say so — silence here means a fresh
        // run's agents simply never appear.
        this._warn(`[subagent-watcher] Workflow tool_result ${toolUseId} carried no parsable "Run ID: wf_..." — its agents will not be discovered`);
        return null;
      }
      if (typeof toolUseId === 'string' && toolUseId) this.workflowRunByToolUse.set(toolUseId, parsed.runId);
      if (parsed.taskId) this.workflowRunByTask.set(parsed.taskId, parsed.runId);
      // A resumed run is already watched (snapshot taken at tool_use time);
      // watchWorkflowRun is idempotent, so this only starts fresh runs.
      this.watchWorkflowRun(parsed.runId, { snapshotExisting: false });
      return parsed.runId;
    } catch (e) {
      this._warn(`[subagent-watcher] noteWorkflowResult failed: ${e.message}`);
      return null;
    }
  }

  // System task_notification: a background task finished. If it is one of our
  // Workflow runs (matched by the Workflow's tool_use_id or its task id), do a
  // final scan, settle its agents, and stop the run's poll. No-op otherwise.
  noteWorkflowCompleted(toolUseId, taskId) {
    const runId = (toolUseId && this.workflowRunByToolUse.get(toolUseId))
      || (taskId && this.workflowRunByTask.get(taskId))
      || null;
    if (!runId) return false;
    if (toolUseId) this.workflowRunByToolUse.delete(toolUseId);
    if (taskId) this.workflowRunByTask.delete(taskId);
    return this._stopWorkflowRun(runId, { finalScan: true });
  }

  // Start (idempotently) the long-lived poll for one workflow run.
  watchWorkflowRun(runId, {
    snapshotExisting = false,
    intervalMs = WORKFLOW_POLL_INTERVAL_MS,
    idleStopMs = WORKFLOW_IDLE_STOP_MS,
    idleIntervalMs = WORKFLOW_IDLE_INTERVAL_MS,
    maxLifetimeMs = WORKFLOW_MAX_LIFETIME_MS,
    finalRetryMs = WORKFLOW_FINAL_SCAN_RETRY_MS,
  } = {}) {
    if (!isWorkflowRunId(runId)) return false;
    if (this.workflowRuns.has(runId)) return false;
    const now = Date.now();
    const run = {
      runId,
      // Fixed at watch time: the run writes to the directory it launched in,
      // even if the session later re-points (EnterWorktree).
      dir: path.join(this.dir, 'workflows', runId),
      seen: new Set(),
      // agentIds attached for this run -> true once settled (result seen / run end).
      agents: new Map(),
      // agentIds whose journal `result` arrived before (or without) an attach.
      resulted: new Set(),
      started: new Set(),
      journalOffset: 0,
      journalPartial: '',
      lastActivityAt: now,
      deadline: now + maxLifetimeMs,
      idleStopMs,
      idleEvery: Math.max(1, Math.round(idleIntervalMs / intervalMs)),
      ticks: 0,
      lastScanOk: true,
      lastScanError: null,
      completing: false,
      completingUntil: 0,
      finalRetryMs,
      timer: null,
    };
    if (snapshotExisting) {
      try {
        for (const name of fs.readdirSync(run.dir)) {
          if (name.startsWith('agent-') && name.endsWith('.jsonl')) run.seen.add(name);
        }
      } catch { /* no dir yet — nothing to snapshot */ }
      // Skip the journal history too: its results belong to the cached agents.
      try { run.journalOffset = fs.statSync(path.join(run.dir, 'journal.jsonl')).size; } catch { /* none yet */ }
    }
    this.workflowRuns.set(runId, run);
    this._scanWorkflowRun(run);
    run.timer = setInterval(() => this._tickWorkflowRun(runId), intervalMs);
    if (typeof run.timer.unref === 'function') run.timer.unref();
    return true;
  }

  _tickWorkflowRun(runId) {
    const run = this.workflowRuns.get(runId);
    if (!run) return;
    const now = Date.now();
    run.ticks += 1;
    // A completion that arrived while the run dir was unreadable: keep retrying
    // the final scan until it succeeds or its bounded window closes.
    if (run.completing) {
      if (this._scanWorkflowRun(run) || now >= run.completingUntil) {
        if (now >= run.completingUntil && !run.lastScanOk) {
          this._warn(`[subagent-watcher] workflow run ${runId}: final scan of ${run.dir} kept failing (${run.lastScanError}) — agents spawned after the last good scan will not be shown`);
        }
        this._finishWorkflowRun(run);
      }
      return;
    }
    if (now >= run.deadline) {
      this._warn(`[subagent-watcher] workflow run ${runId}: no completion notification within the lifetime cap — stopped watching`);
      this._finishWorkflowRun(run);
      return;
    }
    // Quiet run (every started agent has a result, nothing moved for
    // idleStopMs): it may be between phases, so never STOP — only the
    // completion notification or the lifetime cap ends a run — but back off to
    // one scan per idleEvery ticks. Any new file or journal line restores the
    // fast cadence (lastActivityAt moves).
    const allDone = run.started.size > 0 && [...run.started].every(id => run.resulted.has(id));
    const idle = allDone && now - run.lastActivityAt >= run.idleStopMs;
    if (idle && run.ticks % run.idleEvery !== 0) return;
    this._scanWorkflowRun(run);
  }

  // Returns false when the run dir exists but could not be read (anything but
  // ENOENT, which just means the run has not written yet).
  _scanWorkflowRun(run) {
    let entries = null;
    try {
      entries = fs.readdirSync(run.dir);
      run.lastScanOk = true;
      run.lastScanError = null;
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        run.lastScanOk = false;
        run.lastScanError = e?.code || e?.message || 'error';
      } else {
        run.lastScanOk = true;
      }
    }
    for (const name of entries || []) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      if (run.seen.has(name)) continue;
      run.seen.add(name);
      run.lastActivityAt = Date.now();
      const agentId = this._attach(name, {
        readFromStart: true,
        dir: run.dir,
        key: `workflows/${run.runId}/${name}`,
        workflow: { runId: run.runId },
      });
      run.agents.set(agentId, false);
      // The agent may have finished before we attached (fast agent, slow poll).
      if (run.resulted.has(agentId)) this._settleWorkflowAgent(run, agentId);
    }
    this._readWorkflowJournal(run);
    return run.lastScanOk;
  }

  // Incrementally read the run's journal.jsonl for per-agent lifecycle lines.
  // A `result` line is the agent's own completion signal — the run as a whole
  // may continue for hours, so cards settle one by one rather than all at once.
  _readWorkflowJournal(run) {
    const jp = path.join(run.dir, 'journal.jsonl');
    let st;
    try { st = fs.statSync(jp); } catch { return; }
    if (st.size < run.journalOffset) { run.journalOffset = 0; run.journalPartial = ''; } // replaced/truncated
    if (st.size === run.journalOffset) return;
    let chunk;
    let fd;
    try {
      fd = fs.openSync(jp, 'r');
      const len = st.size - run.journalOffset;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, run.journalOffset);
      run.journalOffset += n;
      chunk = buf.subarray(0, n).toString('utf8');
    } catch {
      return;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
    }
    run.lastActivityAt = Date.now();
    const lines = (run.journalPartial + chunk).split('\n');
    run.journalPartial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const agentId = typeof rec?.agentId === 'string' ? rec.agentId : null;
      if (!agentId) continue;
      if (rec.type === 'started') run.started.add(agentId);
      else if (rec.type === 'result') {
        run.started.add(agentId);
        run.resulted.add(agentId);
        if (run.agents.has(agentId)) this._settleWorkflowAgent(run, agentId);
      }
    }
  }

  _settleWorkflowAgent(run, agentId) {
    if (run.agents.get(agentId) === true) return;
    run.agents.set(agentId, true);
    this.emit('subagent-done', { agentId, workflowRunId: run.runId });
  }

  // Stop one run's poll and settle every agent it attached. Tails stay attached
  // (a final answer can drain after the run reports done), exactly like Agent
  // subagents; watcher.stop() closes them with the session. With finalScan, a
  // run dir that cannot be read right now is NOT taken as "no new agents": the
  // run stays registered and its poll retries the final scan for a bounded
  // window (see _tickWorkflowRun), warning if it never succeeds.
  _stopWorkflowRun(runId, { finalScan = true } = {}) {
    const run = this.workflowRuns.get(runId);
    if (!run) return false;
    if (run.completing) return true;
    if (finalScan) {
      let ok = false;
      try { ok = this._scanWorkflowRun(run); } catch (e) { run.lastScanError = e?.message || 'error'; }
      if (!ok && run.timer) {
        run.completing = true;
        run.completingUntil = Date.now() + run.finalRetryMs;
        return true;
      }
    }
    this._finishWorkflowRun(run);
    return true;
  }

  _finishWorkflowRun(run) {
    const { runId } = run;
    if (run.timer) { clearInterval(run.timer); run.timer = null; }
    this.workflowRuns.delete(runId);
    for (const agentId of run.agents.keys()) this._settleWorkflowAgent(run, agentId);
    for (const [k, v] of this.workflowRunByToolUse) if (v === runId) this.workflowRunByToolUse.delete(k);
    for (const [k, v] of this.workflowRunByTask) if (v === runId) this.workflowRunByTask.delete(k);
  }
}

// Route one PARENT stream event (handleClaudeEvent, after the sidechain guard)
// to the watcher's workflow hooks: the `Workflow` tool_use, its launch
// tool_result, and the run's task_notification. Kept out of index.js so the
// whole parent-stream path is exercised by tests with real event shapes; the
// bridge calls it at one seam. Never throws.
export function routeWorkflowStreamEvent(watcher, event) {
  try {
    if (!watcher || !event || typeof event !== 'object') return;
    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Workflow') {
          watcher.noteWorkflowToolUse(block.id, block.input || {});
        }
      }
    } else if (event.type === 'user') {
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          watcher.noteWorkflowResult(block.tool_use_id, block.content);
        }
      }
    } else if (event.type === 'system' && event.subtype === 'task_notification') {
      watcher.noteWorkflowCompleted(event.tool_use_id, event.task_id);
    }
  } catch (e) {
    try { watcher?._warn?.(`[subagent-watcher] routeWorkflowStreamEvent failed: ${e.message}`); } catch { /* ignore */ }
  }
}
