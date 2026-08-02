import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isValidCodexRunId } from './codex-convos.js';
import { isWrapperAlive } from './codex-liveness.js';
import { codexRunsDirFor } from './codex-paths.js';
import { TranscriptTail } from './transcript-tail.js';

export const DEFAULT_CODEX_POLL_INTERVAL_MS = 2000;
export const DEFAULT_CODEX_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

export function createCodexWatcherIfEnabled(options, {
  env = process.env,
  WatcherClass = CodexWatcher,
} = {}) {
  return env.MATRON_CODEX_VIZ === '0' ? null : new WatcherClass(options);
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
      publisher.publishText(parentConvoId, {
        body: BREAKER_NOTE,
        from: 'assistant',
      }, { idemKey: `${sessionId ?? parentConvoId}:breaker` });
      // publishText is intentionally fire-and-forget; its queue reconnect
      // retries retain this idem key. Separately, retryPending runs every
      // watchdog tick and T-5.4 re-emits terminal state on reconnect, while
      // T-3.1's COALESCE makes terminal retries set-once. No sync ack needed.
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
        auditedTerminals.has(runId)) return;
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
  }

  function tryTerminalizeFailedRun(runId, failure, emitTerminalAudit = true) {
    try {
      if (!failure.terminalized) {
        if (terminalize?.(runId, 'interrupted') !== true) return false;
        failure.terminalized = true;
      }
      if (emitTerminalAudit) {
        auditTerminal(runId, {
          outcome: 'interrupted',
          winningSignal: `${failure.entryPoint}-error`,
          livenessEvidence: null,
          finalPostLanded: false,
        });
      }
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
        auditTerminal(runId, {
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
        });
      }
    } catch (terminalError) {
      warn(`[codex-watcher] terminalize-all failed (${errorKind(terminalError)})`);
    }
  }

  function retryPending() {
    for (const [runId, failure] of failedRuns) {
      tryTerminalizeFailedRun(runId, failure);
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
  } = {}) {
    super();
    this.dir = dir;
    this.onDiscover = onDiscover;
    this.isWrapperAlive = isWrapperAliveFn;
    this.pollIntervalMs = pollIntervalMs;
    this.TailClass = TailClass;
    this.isolation = isolation;
    this.maxTranscriptBytes = maxTranscriptBytes;
    this.seen = new Set();
    this.pending = new Map();
    this.tails = new Map();
    this.attaching = new Set();
    this.fsWatcher = null;
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
      this._guardSession('poll', () => {
        if (this.stopped) return;
        this._ensureFsWatch();
        return this._scan();
      });
    }, this.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    return true;
  }

  async snapshot() {
    if (this.stopped) return;
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (this.stopped) return;
      if (!name.endsWith('.jsonl')) continue;
      const runId = name.slice('codex-'.length, -'.jsonl'.length);
      if (!name.startsWith('codex-') || !isValidCodexRunId(runId) || this.seen.has(runId)) continue;
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

  scan() {
    return this._guardSession('scan', () => this._scan());
  }

  async attach(runId) {
    if (this.stopped || this.seen.has(runId) || this.attaching.has(runId)) return false;
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
          maxFileSizeBytes: this.maxTranscriptBytes,
        });
        tail.on('event', event => {
          this._guardRun(runId, 'tail-event', () => {
            if (this.stopped) return;
            this.emit('codex-event', { runId, meta, event });
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
        this.pending.delete(runId);
        this.seen.add(runId);
        this.emit('attach', { runId, meta, tail });
        return true;
      });
      return result === true;
    } finally {
      this.attaching.delete(runId);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const tail of this.tails.values()) {
      try { await tail.stop(); } catch { /* visualization teardown is fail-open */ }
    }
    this.tails.clear();
    this.attaching.clear();
    this.pending.clear();
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
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (this.stopped) return;
      const runId = runIdFromMetaName(name);
      if (!isValidCodexRunId(runId) || this.seen.has(runId) || this.pending.has(runId)) continue;
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
    if (this.seen.has(runId) || this.pending.has(runId)) return;
    const discovered = this.onDiscover(meta);
    // The child tracker returns null when its fail-open publication could not
    // create the durable child. Leave the run undiscovered so the poll fallback
    // retries the complete meta -> child -> JSONL handshake on its next tick.
    if (discovered === null) return;
    this.pending.set(runId, meta);
    this.isolation?.auditStart(meta);
  }

  _readMeta(runId) {
    try {
      const meta = JSON.parse(fs.readFileSync(this._metaPath(runId), 'utf8'));
      return meta?.runId === runId ? meta : null;
    } catch {
      return null;
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
      return stat.isFile() && stat.size <= this.maxTranscriptBytes;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
