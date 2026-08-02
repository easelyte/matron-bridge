import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isValidCodexRunId } from './codex-convos.js';
import { isWrapperAlive, pastDeadline } from './codex-liveness.js';
import { codexRunsDirFor } from './codex-paths.js';
import { TranscriptTail } from './transcript-tail.js';

export const DEFAULT_CODEX_POLL_INTERVAL_MS = 2000;
export const DEFAULT_CODEX_TRANSCRIPT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CODEX_META_MAX_BYTES = 64 * 1024;
export const DEFAULT_CODEX_META_SCAN_COUNT = 256;
export const DEFAULT_CODEX_DRAIN_WINDOW_MS = 1000;

export function createCodexWatcherIfEnabled(options, {
  env = process.env,
  WatcherClass = CodexWatcher,
} = {}) {
  return env.MATRON_CODEX_VIZ === '0' ? null : new WatcherClass(options);
}

export function startCodexWatcherIfEnabled(options, {
  env = process.env,
  WatcherClass = CodexWatcher,
  log = console,
  onFailure = () => {},
  beforeStart = () => {},
} = {}) {
  let watcher;
  try {
    watcher = createCodexWatcherIfEnabled(options, { env, WatcherClass });
    if (!watcher) return null;
    beforeStart(watcher);
    Promise.resolve(watcher.start()).catch(error => {
      try { log.warn(`[codex-watcher] startup failed (${errorKind(error)})`); } catch { /* fail open */ }
      try { onFailure(error, watcher); } catch { /* fail open */ }
    });
    return watcher;
  } catch (error) {
    try { log.warn(`[codex-watcher] construction failed (${errorKind(error)})`); } catch { /* fail open */ }
    try { onFailure(error, watcher); } catch { /* fail open */ }
    return null;
  }
}

export const DEFAULT_CODEX_BREAKER_THRESHOLD = 5;

const BREAKER_NOTE = '⚙ codex live-view disabled after repeated errors — reviews unaffected';

function errorKind(error) {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Per-session failure boundary shared by every Codex watcher entry point.
 * The filesystem watcher itself is introduced by T-4.1; keeping this policy
 * separate lets construction, callbacks, decoding, publishing, watchdogs,
 * and reconciliation all use the same breaker and audit state.
 */
export function createCodexWatcherIsolation({
  sessionId,
  publisher,
  getParentConvoId,
  terminalize,
  terminalizeAll,
  hasPendingCapNote,
  retryCapNote,
  isAdmittedRun,
  log = console,
  breakerThreshold = DEFAULT_CODEX_BREAKER_THRESHOLD,
} = {}) {
  const threshold = Number.isInteger(breakerThreshold) && breakerThreshold > 0
    ? breakerThreshold
    : DEFAULT_CODEX_BREAKER_THRESHOLD;
  const auditedStarts = new Set();
  const auditedTerminals = new Set();
  const failedRuns = new Map();
  const pendingTerminalizations = new Map();
  let errorCount = 0;
  let disabled = false;
  let breakerNoted = false;

  function warn(message) {
    try { log.warn(message); } catch { /* logging must never throw */ }
  }

  function emitAudit(record) {
    try {
      log.info('[codex-watcher-audit]', record);
      return true;
    } catch {
      // Audit logging must never reach the bridge loop. Leave its latch open
      // so a later observation can retry the record.
      return false;
    }
  }

  function breakerState() {
    return { disabled, errorCount };
  }

  function postBreakerNote() {
    if (breakerNoted) return;
    try {
      const parentConvoId = getParentConvoId?.();
      if (!parentConvoId) {
        warn('[codex-watcher] breaker tripped without a parent conversation');
        return;
      }
      if (typeof publisher?.publishText !== 'function') {
        warn('[codex-watcher] breaker tripped without a publisher');
        return;
      }
      const enqueued = publisher.publishText(parentConvoId, {
        body: BREAKER_NOTE,
        from: 'assistant',
      }, { idemKey: `${sessionId ?? parentConvoId}:breaker` });
      if (enqueued !== true) return;
      // This latches local-queue acceptance only. Reconnect re-emission and
      // the stable idem key repair post-enqueue loss.
      breakerNoted = true;
    } catch (error) {
      warn(`[codex-watcher] failed to publish breaker note (${errorKind(error)})`);
    }
  }

  function countFailure(entryPoint, error) {
    errorCount += 1;
    warn(`[codex-watcher] ${entryPoint} failed (${errorKind(error)})`);
    if (!disabled && errorCount >= threshold) {
      disabled = true;
      return true;
    }
    return false;
  }

  function auditStart(meta) {
    const runId = meta?.runId;
    const deadlineTs = meta?.deadlineTs;
    if (disabled || !isValidCodexRunId(runId) || !isAdmittedRun?.(runId) ||
        !Number.isFinite(deadlineTs) || auditedStarts.has(runId)) return;
    const emitted = emitAudit({
      event: 'codex_run_start',
      runId,
      sessionId,
      // Meta is descendant-writable and T-6.2's redactor is not available
      // yet. Preserve the field without placing attacker-controlled labels
      // (which may contain secrets) into logs.
      label: null,
      deadlineTs,
    });
    if (emitted) auditedStarts.add(runId);
  }

  function auditTerminal(runId, details = {}) {
    if (!isValidCodexRunId(runId) || !isAdmittedRun?.(runId) ||
        auditedTerminals.has(runId)) return auditedTerminals.has(runId);
    const emitted = emitAudit({
      event: 'codex_run_terminal',
      runId,
      sessionId,
      outcome: details.outcome ?? null,
      winningSignal: details.winningSignal ?? null,
      livenessEvidence: details.livenessEvidence ?? null,
      durableEventCount: details.durableEventCount ?? 0,
      droppedEventCount: details.droppedEventCount ?? 0,
      redactionDropCount: details.redactionDropCount ?? 0,
      breakerState: breakerState(),
      finalPostLanded: Object.hasOwn(details, 'finalPostLanded')
        ? details.finalPostLanded
        : false,
    });
    if (emitted) auditedTerminals.add(runId);
    return emitted;
  }

  function tryTerminalizeFailedRun(runId, failure, emitTerminalAudit = true) {
    try {
      if (!failure.terminalized) {
        let terminalization = pendingTerminalizations.get(runId);
        if (!terminalization) {
          requestTerminalization(runId, 'interrupted', {
            winningSignal: `${failure.entryPoint}-error`,
            livenessEvidence: null,
            finalPostLanded: false,
          });
          terminalization = pendingTerminalizations.get(runId);
        } else {
          tryPendingTerminalization(runId, terminalization);
        }
        failure.terminalized = terminalization?.terminalized === true;
      }
      if (emitTerminalAudit) tryPendingTerminalization(runId, pendingTerminalizations.get(runId));
      return true;
    } catch (terminalError) {
      warn(`[codex-watcher] terminalize failed (${errorKind(terminalError)})`);
      return false;
    }
  }

  function auditBreakerTerminalizations() {
    try {
      const terminalizations = terminalizeAll?.() ?? [];
      for (const terminalization of terminalizations) {
        const { runId, outcome } = terminalization;
        const failedRun = failedRuns.get(runId);
        if (failedRun) failedRun.terminalized = true;
        let pendingTerminalization = pendingTerminalizations.get(runId);
        if (pendingTerminalization) {
          pendingTerminalization.terminalized = true;
          pendingTerminalization.auditCompleted = auditTerminal(
            runId,
            pendingTerminalization.details,
          );
          continue;
        }
        const details = {
          // A terminal publish that was already pending keeps its first
          // outcome. Do not rewrite that decision as a breaker interrupt.
          outcome,
          winningSignal: failedRun
            ? `${failedRun.entryPoint}-error`
            : outcome === 'interrupted' ? 'breaker' : outcome,
          livenessEvidence: null,
          // The tracker owns the terminal outcome, not stream-drain state.
          // Preserve unknown rather than claiming a pending final did or did
          // not land before the breaker retried its terminal upsert.
          finalPostLanded: outcome === 'interrupted' ? false : null,
        };
        // terminalizeAll can win while a clean-exit drain is still pending.
        // Record that winner in the same authoritative latch so the later
        // clean signal is a no-op instead of becoming a forever retry.
        pendingTerminalization = {
          outcome,
          details,
          terminalized: true,
          auditCompleted: auditTerminal(runId, details),
        };
        pendingTerminalizations.set(runId, pendingTerminalization);
      }
    } catch (terminalError) {
      warn(`[codex-watcher] terminalize-all failed (${errorKind(terminalError)})`);
    }
  }

  function tryPendingTerminalization(runId, terminalization) {
    if (!terminalization) return false;
    try {
      if (!terminalization.terminalized) {
        if (terminalize?.(runId, terminalization.outcome) !== true) return false;
        terminalization.terminalized = true;
      }
      if (!terminalization.auditCompleted) {
        terminalization.auditCompleted = auditTerminal(runId, terminalization.details);
      }
      return terminalization.terminalized && terminalization.auditCompleted;
    } catch (error) {
      warn(`[codex-watcher] terminalize failed (${errorKind(error)})`);
      return false;
    }
  }

  function requestTerminalization(runId, outcome, details = {}) {
    if (!isAdmittedRun?.(runId)) return false;
    const existing = pendingTerminalizations.get(runId);
    if (existing) return false;
    const terminalization = {
      outcome,
      details: { ...details, outcome },
      terminalized: false,
      auditCompleted: false,
    };
    pendingTerminalizations.set(runId, terminalization);
    return tryPendingTerminalization(runId, terminalization);
  }

  function retryPending() {
    for (const [runId, terminalization] of pendingTerminalizations) {
      tryPendingTerminalization(runId, terminalization);
    }
    for (const [runId, failure] of failedRuns) {
      tryTerminalizeFailedRun(runId, failure);
    }
    if (hasPendingCapNote?.()) {
      try {
        retryCapNote?.();
      } catch (error) {
        warn(`[codex-watcher] failed to publish cap note (${errorKind(error)})`);
      }
    }
    if (disabled) {
      auditBreakerTerminalizations();
      postBreakerNote();
    }
  }

  function containFailure(runId, entryPoint, error) {
    // Never leave an already-created child spinning. The tracker's latch
    // makes duplicate or competing terminal signals harmless.
    let failure;
    if (typeof runId === 'string' && isAdmittedRun?.(runId)) {
      failure = { entryPoint, terminalized: false };
      failedRuns.set(runId, failure);
    }
    const breakerTripped = countFailure(entryPoint, error);
    if (breakerTripped) {
      auditBreakerTerminalizations();
      postBreakerNote();
    } else if (failure) {
      tryTerminalizeFailedRun(runId, failure, false);
    }
    if (failure?.terminalized) tryTerminalizeFailedRun(runId, failure);
    return undefined;
  }

  function guard(runId, entryPoint, operation) {
    if (runId !== null && !isAdmittedRun?.(runId)) return undefined;
    const failedRun = failedRuns.get(runId);
    if (failedRun) {
      tryTerminalizeFailedRun(runId, failedRun);
      if (disabled) postBreakerNote();
      return undefined;
    }
    if (disabled) {
      postBreakerNote();
      return undefined;
    }
    try {
      const result = operation();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch(error => containFailure(runId, entryPoint, error));
      }
      return result;
    } catch (error) {
      return containFailure(runId, entryPoint, error);
    }
  }

  return {
    guardRun(runId, entryPoint, operation) {
      return guard(runId, entryPoint, operation);
    },

    guardSession(entryPoint, operation) {
      return guard(null, entryPoint, operation);
    },

    auditStart,
    auditTerminal,
    breakerState,
    requestTerminalization,
    retryPending,

    isDisabled() {
      return disabled;
    },
  };
}

function runIdFromMetaName(name) {
  const match = /^codex-(.+)\.meta\.json$/.exec(name);
  return match?.[1] ?? null;
}

function hasExitCode(meta) {
  return Object.hasOwn(meta, 'exitCode');
}

export class CodexWatcher extends EventEmitter {
  constructor({
    workdir,
    sessionId,
    dir = codexRunsDirFor(workdir, sessionId),
    onDiscover = () => {},
    isWrapperAliveFn = isWrapperAlive,
    pollIntervalMs = DEFAULT_CODEX_POLL_INTERVAL_MS,
    TailClass = TranscriptTail,
    isolation = null,
    maxTranscriptBytes = DEFAULT_CODEX_TRANSCRIPT_MAX_BYTES,
    maxMetaBytes = DEFAULT_CODEX_META_MAX_BYTES,
    maxMetaScanCount = DEFAULT_CODEX_META_SCAN_COUNT,
    drainWindowMs = DEFAULT_CODEX_DRAIN_WINDOW_MS,
    now = Date.now,
  } = {}) {
    super();
    this.dir = dir;
    this.onDiscover = onDiscover;
    this.isWrapperAlive = isWrapperAliveFn;
    this.pollIntervalMs = pollIntervalMs;
    this.TailClass = TailClass;
    this.isolation = isolation;
    this.maxTranscriptBytes = maxTranscriptBytes;
    this.maxMetaBytes = Number.isInteger(maxMetaBytes) && maxMetaBytes > 0
      ? maxMetaBytes
      : DEFAULT_CODEX_META_MAX_BYTES;
    this.maxMetaScanCount = Number.isInteger(maxMetaScanCount) && maxMetaScanCount > 0
      ? maxMetaScanCount
      : DEFAULT_CODEX_META_SCAN_COUNT;
    this.drainWindowMs = Number.isFinite(drainWindowMs) && drainWindowMs >= 0
      ? drainWindowMs
      : DEFAULT_CODEX_DRAIN_WINDOW_MS;
    this.now = now;
    this.seen = new Set();
    this.attached = new Set();
    this.permanentlySkipped = new Set();
    this.pending = new Map();
    this.attachedMeta = new Map();
    this.tails = new Map();
    this.completions = new Map();
    this.streamStates = new Map();
    this.attaching = new Set();
    this.fsWatcher = null;
    this.metaDir = null;
    this.pollTimer = null;
    this.stopped = false;
    this.started = false;
  }

  async start() {
    if (this.started || this.stopped) return false;
    this.started = true;
    await this._guardSession('snapshot', () => this.snapshot());
    if (this.stopped) return false;
    this._guardSession('watch', () => this._ensureFsWatch());
    await this._guardSession('scan', () => this._scan());
    if (this.stopped) return false;
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      this.isolation?.retryPending();
      this._guardSession('poll', async () => {
        if (this.stopped) return;
        this._ensureFsWatch();
        await this._scan();
        return this._watchdogTick();
      });
    }, this.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    return true;
  }

  async snapshot() {
    if (this.stopped) return;
    let dir;
    try {
      dir = fs.opendirSync(this.dir);
    } catch {
      return;
    }

    try {
      let exhausted = false;
      while (!exhausted) {
        const entries = [];
        for (let count = 0; count < this.maxMetaScanCount; count += 1) {
          if (this.stopped) return;
          const entry = dir.readSync();
          if (!entry) {
            exhausted = true;
            break;
          }
          entries.push(entry.name);
        }
        for (const name of entries) {
          if (this.stopped) return;
          if (!name.endsWith('.jsonl')) continue;
          const runId = name.slice('codex-'.length, -'.jsonl'.length);
          if (!name.startsWith('codex-') || !isValidCodexRunId(runId) ||
              this.seen.has(runId) || this.attached.has(runId)) continue;
          const meta = this._readMeta(runId);
          if (!meta) continue;
          if (hasExitCode(meta) || !this.isWrapperAlive(meta)) {
            this.seen.add(runId);
            continue;
          }
          this._discover(meta);
          await this.attach(runId);
        }
      }
    } finally {
      try { dir.closeSync(); } catch { /* snapshot is fail-open */ }
    }
  }

  reconcile(_session) {
    return this._guardSession('reconcile', () => this._reconcile());
  }

  _reconcile() {
    if (this.stopped) return false;
    let dir;
    try {
      dir = fs.opendirSync(this.dir);
    } catch {
      return false;
    }

    try {
      while (true) {
        const entry = dir.readSync();
        if (!entry) break;
        const runId = runIdFromMetaName(entry.name);
        if (runId === null || !isValidCodexRunId(runId) || this.seen.has(runId)) continue;
        this._guardSession('reconcile-run', () => this._reconcileRun(runId));
      }
      return true;
    } finally {
      try { dir.closeSync(); } catch { /* reconciliation is fail-open */ }
    }
  }

  scan() {
    return this._guardSession('scan', () => this._scan());
  }

  watchdogTick() {
    this.isolation?.retryPending();
    return this._guardSession('watchdog', () => this._watchdogTick());
  }

  async attach(runId) {
    if (this.stopped || this.seen.has(runId) || this.attached.has(runId) ||
        this.attaching.has(runId)) return false;
    const meta = this.pending.get(runId);
    if (!meta) return false;
    const filePath = this._jsonlPath(runId);
    if (!this._isSafeSink(filePath)) return false;

    this.attaching.add(runId);
    try {
      const result = await this._guardRun(runId, 'attach', async () => {
        if (this.stopped) return false;
        const tail = new this.TailClass(filePath, {
          readFromStart: true,
          requireRegularFile: true,
          requireInitialFile: true,
          maxFileSizeBytes: this.maxTranscriptBytes,
        });
        tail.on('event', event => {
          this._guardRun(runId, 'tail-event', () => {
            if (this.stopped) return;
            const streamState = this.streamStates.get(runId) ?? {};
            this.streamStates.set(runId, streamState);
            // Consumers pass this state to formatAndRoute. The formatter marks
            // finalPostProduced only after it emits the final-answer publish.
            this.emit('codex-event', { runId, meta, event }, streamState);
          });
        });
        tail.on('parseError', error => {
          this._guardRun(runId, 'tail-parse', () => {
            if (this.stopped) return;
            this.emit('parseError', { runId, meta, error });
          });
        });
        try {
          await tail.start();
        } catch {
          try { await tail.stop(); } catch { /* failed starts remain retryable */ }
          return false;
        }
        if (this.stopped) {
          try { await tail.stop(); } catch { /* visualization teardown is fail-open */ }
          return false;
        }
        this.tails.set(runId, tail);
        this.attachedMeta.set(runId, meta);
        this.pending.delete(runId);
        this.attached.add(runId);
        this.emit('attach', { runId, meta, tail });
        this._startDrainIfAttached(runId);
        return true;
      });
      return result === true;
    } finally {
      this.attaching.delete(runId);
    }
  }

  async stop() {
    if (this.isolation) {
      for (const runId of new Set([...this.pending.keys(), ...this.attached])) {
        const completion = this.completions.get(runId);
        if (completion && !completion.finalized) {
          if (completion.timer) clearTimeout(completion.timer);
          completion.timer = null;
          completion.outcome = 'interrupted';
          completion.winningSignal = 'teardown';
          this._finishDrain(runId);
        } else if (!completion) {
          this._complete(runId, 'interrupted', 'teardown', { pidAlive: null });
        }
      }
      this.isolation.retryPending();
    }
    this.stopped = true;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.metaDir) {
      try { this.metaDir.closeSync(); } catch { /* already closed */ }
      this.metaDir = null;
    }
    for (const tail of this.tails.values()) {
      try { await tail.stop(); } catch { /* visualization teardown is fail-open */ }
    }
    this.tails.clear();
    this.attached.clear();
    this.attaching.clear();
    this.pending.clear();
    this.attachedMeta.clear();
  }

  _watchdogTick() {
    if (this.stopped || !this.isolation) return;
    const runIds = new Set([...this.pending.keys(), ...this.attached]);
    for (const runId of runIds) {
      if (this.completions.has(runId)) continue;
      const previousMeta = this.pending.get(runId) ?? this.attachedMeta.get(runId);
      const readMeta = this._readMeta(runId);
      if (readMeta && this.attached.has(runId)) this.attachedMeta.set(runId, readMeta);
      const meta = readMeta ?? previousMeta;
      if (!meta) continue;
      if (hasExitCode(meta)) {
        this._beginDrain(runId, meta.exitCode === 0 ? 'completed' : 'failed');
        continue;
      }
      const wrapperAlive = this.isWrapperAlive(meta);
      if (pastDeadline(meta, this.now())) {
        this._complete(runId, 'interrupted', 'deadline', {
          pidAlive: wrapperAlive,
          pastDeadline: true,
        });
        continue;
      }
      if (!wrapperAlive) {
        this._complete(runId, 'interrupted', 'liveness', { pidAlive: false, pastDeadline: false });
      }
    }
  }

  _reconcileRun(runId) {
    const meta = this._readMeta(runId);
    if (!meta || hasExitCode(meta)) return;
    try {
      this._discover(meta);
      if (this.pending.has(runId)) {
        this.isolation?.requestTerminalization(runId, 'interrupted', {
          winningSignal: 'restart',
          livenessEvidence: null,
          finalPostLanded: false,
        });
      }
    } finally {
      const tail = this.tails.get(runId);
      if (tail) Promise.resolve(tail.stop()).catch(() => {});
      this.tails.delete(runId);
      this.attached.delete(runId);
      this.attachedMeta.delete(runId);
      this.pending.delete(runId);
      this.seen.add(runId);
    }
  }

  _beginDrain(runId, outcome) {
    if (this.completions.has(runId)) return;
    const completion = {
      outcome,
      winningSignal: 'clean-exit',
      timer: null,
      finalized: false,
      draining: false,
      deadline: this.now() + this.drainWindowMs,
    };
    this.completions.set(runId, completion);
    completion.timer = setTimeout(() => {
      completion.timer = null;
      this._finishDrain(runId, true);
    }, this.drainWindowMs);
    if (typeof completion.timer.unref === 'function') completion.timer.unref();
    this._startDrainIfAttached(runId);
  }

  _startDrainIfAttached(runId) {
    const completion = this.completions.get(runId);
    const tail = this.tails.get(runId);
    if (!completion || completion.finalized || completion.draining || !tail?.drain) return;
    completion.draining = true;
    const remainingMs = Math.max(0, completion.deadline - this.now());
    if (completion.timer) clearTimeout(completion.timer);
    // TranscriptTail installs its final strict read before this fallback timer,
    // allowing an append at the edge of the window to be consumed first.
    let drain;
    try {
      drain = Promise.resolve(tail.drain({ windowMs: remainingMs }));
    } catch (error) {
      drain = Promise.reject(error);
    }
    completion.timer = setTimeout(() => {
      completion.timer = null;
      this._finishDrain(runId, true);
    }, remainingMs);
    if (typeof completion.timer.unref === 'function') completion.timer.unref();
    drain.then(result => {
      if (completion.finalized) return;
      if (result?.ok !== true) throw (result?.error ?? new Error('transcript drain did not report success'));
      if (completion.timer) clearTimeout(completion.timer);
      completion.timer = null;
      this._finishDrain(runId, false);
    }).catch(error => {
      if (completion.finalized) return;
      if (completion.timer) clearTimeout(completion.timer);
      completion.timer = null;
      completion.outcome = 'interrupted';
      completion.winningSignal = 'drain-error';
      this._guardRun(runId, 'drain', () => { throw error; });
      this._finishDrain(runId, false);
    });
  }

  _finishDrain(runId, timedOut = false) {
    const completion = this.completions.get(runId);
    if (!completion || completion.finalized) return;
    if (timedOut) {
      completion.outcome = 'interrupted';
      completion.winningSignal = this.tails.has(runId) ? 'drain-timeout' : 'drain-unattached';
    }
    const previousMeta = this.pending.get(runId) ?? this.attachedMeta.get(runId);
    const readMeta = this._readMeta(runId);
    if (readMeta && this.attached.has(runId)) this.attachedMeta.set(runId, readMeta);
    const meta = readMeta ?? previousMeta;
    let pidAlive = null;
    let isPastDeadline = null;
    if (meta) {
      try { pidAlive = this.isWrapperAlive(meta); } catch { /* evidence remains unknown */ }
      try { isPastDeadline = pastDeadline(meta, this.now()); } catch { /* evidence remains unknown */ }
    }
    this._complete(
      runId,
      completion.outcome,
      completion.winningSignal,
      { pidAlive, pastDeadline: isPastDeadline },
      timedOut,
    );
  }

  _complete(runId, outcome, winningSignal, livenessEvidence, drainTimedOut = false) {
    let completion = this.completions.get(runId);
    if (completion?.finalized) return false;
    if (!completion) {
      completion = { outcome, winningSignal, timer: null };
      this.completions.set(runId, completion);
    }
    completion.finalized = true;
    const streamState = this.streamStates.get(runId) ?? {};
    const accepted = this.isolation?.requestTerminalization(runId, completion.outcome, {
      winningSignal: completion.winningSignal,
      livenessEvidence,
      finalPostLanded: !drainTimedOut && streamState.finalPostProduced === true,
    }) === true;
    const tail = this.tails.get(runId);
    if (tail) Promise.resolve(tail.stop()).catch(() => {});
    this.tails.delete(runId);
    this.attached.delete(runId);
    this.attachedMeta.delete(runId);
    this.pending.delete(runId);
    this.seen.add(runId);
    return accepted;
  }

  _guardSession(entryPoint, operation) {
    if (this.isolation) return this.isolation.guardSession(entryPoint, operation);
    try {
      const result = operation();
      return result && typeof result.then === 'function'
        ? Promise.resolve(result).catch(() => undefined)
        : result;
    } catch { return undefined; }
  }

  _guardRun(runId, entryPoint, operation) {
    if (this.isolation) return this.isolation.guardRun(runId, entryPoint, operation);
    try {
      const result = operation();
      return result && typeof result.then === 'function'
        ? Promise.resolve(result).catch(() => undefined)
        : result;
    } catch { return undefined; }
  }

  _ensureFsWatch() {
    if (this.stopped || this.fsWatcher) return;
    try {
      this.fsWatcher = fs.watch(this.dir, () => {
        if (this.stopped) return;
        this._guardSession('fs-watch', () => this._scan());
      });
      this.fsWatcher.on('error', () => {
        if (this.stopped) return;
        try { this.fsWatcher?.close(); } catch { /* already closed */ }
        this.fsWatcher = null;
      });
      if (typeof this.fsWatcher.unref === 'function') this.fsWatcher.unref();
    } catch {
      // A missing directory or an unavailable native watcher is covered by
      // the persistent readdir poll. A later poll retries fs.watch as well.
      this.fsWatcher = null;
    }
  }

  async _scan() {
    if (this.stopped) return;
    const entries = [];
    try {
      if (!this.metaDir) this.metaDir = fs.opendirSync(this.dir);
      for (let count = 0; count < this.maxMetaScanCount; count += 1) {
        const entry = this.metaDir.readSync();
        if (!entry) {
          this.metaDir.closeSync();
          this.metaDir = null;
          break;
        }
        entries.push(entry.name);
      }
    } catch {
      try { this.metaDir?.closeSync(); } catch { /* fail open */ }
      this.metaDir = null;
      return;
    }

    for (const name of entries) {
      if (this.stopped) return;
      const runId = runIdFromMetaName(name);
      if (this.permanentlySkipped.has(name)) continue;
      if (runId === null) {
        if (name.startsWith('codex-') && name.endsWith('.meta.json')) {
          this.permanentlySkipped.add(name);
        }
        continue;
      }
      if (!isValidCodexRunId(runId)) {
        this.permanentlySkipped.add(name);
        continue;
      }
      if (this.seen.has(runId) || this.attached.has(runId) || this.pending.has(runId)) continue;
      const meta = this._readMeta(runId);
      if (meta) this._discover(meta);
    }
    for (const runId of [...this.pending.keys()]) {
      if (this.stopped) return;
      await this.attach(runId);
    }
  }

  _discover(meta) {
    if (this.stopped) return;
    const { runId } = meta;
    if (this.seen.has(runId) || this.attached.has(runId) || this.pending.has(runId)) return;
    const discovered = this.onDiscover(meta);
    // The child tracker returns null when its fail-open publication could not
    // create the durable child. Leave the run undiscovered so the poll fallback
    // retries the complete meta -> child -> JSONL handshake on its next tick.
    if (discovered === null) return;
    if (discovered === false) {
      this.permanentlySkipped.add(`codex-${runId}.meta.json`);
      return;
    }
    this.pending.set(runId, meta);
    this.isolation?.auditStart(meta);
  }

  _readMeta(runId) {
    let fd;
    try {
      const metaPath = this._metaPath(runId);
      if (fs.lstatSync(metaPath).isSymbolicLink()) {
        this.permanentlySkipped.add(path.basename(metaPath));
        return null;
      }
      fd = fs.openSync(metaPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > this.maxMetaBytes) {
        this.permanentlySkipped.add(path.basename(metaPath));
        return null;
      }
      const buf = Buffer.alloc(stat.size);
      const bytesRead = fs.readSync(fd, buf, 0, stat.size, 0);
      const meta = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
      if (meta?.runId !== runId || !isValidCodexRunId(meta.runId)) {
        this.permanentlySkipped.add(path.basename(metaPath));
        return null;
      }
      return meta;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  _metaPath(runId) {
    return path.join(this.dir, `codex-${runId}.meta.json`);
  }

  _jsonlPath(runId) {
    return path.join(this.dir, `codex-${runId}.jsonl`);
  }

  _isSafeSink(filePath) {
    let fd;
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) return false;
      const noFollow = fs.constants.O_NOFOLLOW ?? 0;
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(fd);
      return stat.isFile();
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
