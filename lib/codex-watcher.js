import { isValidCodexRunId } from './codex-convos.js';

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
      });
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
      postBreakerNote();
      return true;
    }
    return false;
  }

  function auditStart(meta) {
    const runId = meta?.runId;
    const deadlineTs = meta?.deadlineTs;
    if (disabled || !isValidCodexRunId(runId) ||
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
    if (!isValidCodexRunId(runId) || auditedTerminals.has(runId)) return;
    const emitted = emitAudit({
      event: 'codex_run_terminal',
      runId,
      sessionId,
      winningSignal: details.winningSignal ?? null,
      livenessEvidence: details.livenessEvidence ?? null,
      durableEventCount: details.durableEventCount ?? 0,
      droppedEventCount: details.droppedEventCount ?? 0,
      redactionDropCount: details.redactionDropCount ?? 0,
      breakerState: breakerState(),
      finalPostLanded: details.finalPostLanded ?? false,
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

  function containFailure(runId, entryPoint, error) {
    // Never leave an already-created child spinning. The tracker's latch
    // makes duplicate or competing terminal signals harmless.
    let failure;
    if (typeof runId === 'string') {
      failure = { entryPoint, terminalized: false };
      failedRuns.set(runId, failure);
      tryTerminalizeFailedRun(runId, failure, false);
    }
    const breakerTripped = countFailure(entryPoint, error);
    if (breakerTripped) {
      try {
        const interruptedRunIds = terminalizeAll?.() ?? [];
        for (const interruptedRunId of interruptedRunIds) {
          auditTerminal(interruptedRunId, {
            winningSignal: 'breaker',
            livenessEvidence: null,
            finalPostLanded: false,
          });
        }
      } catch (terminalError) {
        warn(`[codex-watcher] terminalize-all failed (${errorKind(terminalError)})`);
      }
    }
    if (failure?.terminalized) tryTerminalizeFailedRun(runId, failure);
    return undefined;
  }

  function guard(runId, entryPoint, operation) {
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

    isDisabled() {
      return disabled;
    },
  };
}
