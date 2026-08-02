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
