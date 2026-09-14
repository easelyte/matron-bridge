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

export class SubagentWatcher extends EventEmitter {
  constructor({ workdir, sessionId } = {}) {
    super();
    this.workdir = workdir;
    this.sessionId = sessionId;
    this.dir = subagentsDirFor(workdir, sessionId);
    this.seen = new Set();
    this.tails = new Map(); // filename -> { tail, label, agentId }
    this.burstTimer = null;
    this.snapshotTaken = false;
  }

  // Record any existing agent-*.jsonl files as "seen" so we don't replay
  // subagents from a prior (now-dead) instance of this session. Safe to call
  // even if the dir doesn't exist yet.
  snapshot() {
    if (this.snapshotTaken) return;
    this.snapshotTaken = true;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.jsonl')) this.seen.add(name);
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
    // Mark whatever already exists in the new dir as seen (mirrors snapshot()),
    // then scan for anything new. Additive to `seen` — never cleared.
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.jsonl')) this.seen.add(name);
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
      if (Date.now() >= this.burstUntil) {
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
      return; // dir doesn't exist yet
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      this._attach(name);
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
  //   - file absent     -> no-op. task_started can beat the transcript to disk;
  //     the burst will pick it up when it lands.
  //
  // `seen` is deliberately NOT cleared: _attach() doesn't add to it, so dropping
  // the name would let the very next _scan() attach the same file a second time.
  //
  // Returns true when a tail was actually attached.
  forceAttach(agentId) {
    if (typeof agentId !== 'string' || !agentId) return false;
    const filename = `agent-${agentId}.jsonl`;
    if (this.tails.has(filename)) return false;
    if (!this.seen.has(filename)) return false;
    try {
      if (!fs.statSync(path.join(this.dir, filename)).isFile()) return false;
    } catch {
      return false; // not on disk yet (or unreadable) — leave it to the burst scan
    }
    // EOF, not readFromStart: a resumed transcript IS the earlier run's history
    // (observed at 180-290KB), and replaying it would dump that entire prior run
    // into the card. Only what the resumed agent writes from here is new.
    this._attach(filename, { readFromStart: false });
    return true;
  }

  _attach(filename, { readFromStart = true } = {}) {
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

    const tail = new TranscriptTail(filePath, { readFromStart });
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
