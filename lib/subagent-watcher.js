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
    // appears, and the watcher polls forever (Codex R2 F1).
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
    // revived to `running` showing no output for the rest of its life (Codex R2
    // F2). Reading the boundary off THIS descriptor also closes the stat→attach
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

  _attach(filename, { readFromStart = true, startOffset = null } = {}) {
    const filePath = path.join(this.dir, filename);
    const agentId = filename.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    const fallbackLabel = agentId.slice(0, 8);
    const meta = { label: fallbackLabel, agentType: null, fromFile: false };

    const tryReadMeta = () => {
      if (meta.fromFile) return;
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.agentType = parsed.agentType || null;
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

    const tail = new TranscriptTail(filePath, { readFromStart, startOffset });
    tail.on('event', event => {
      // Retry the meta read on each event until we get a real label —
      // the .meta.json is sometimes written a beat after the .jsonl.
      tryReadMeta();
      this.emit('subagent-event', { agentId, label: meta.label, agentType: meta.agentType, event });
    });
    tail.on('parseError', () => { /* ignore — same policy as parent tail */ });
    tail.start();
    this.tails.set(filename, { tail, label: meta.label, agentId });
    this.emit('subagent-start', { agentId, label: meta.label, agentType: meta.agentType });
  }
}
