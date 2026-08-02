// Codex CLI review/execute runs are surfaced as child conversations of the
// Claude session that launched their wrapper. This tracker owns only the
// child-conversation lifecycle; discovery and event decoding live in the
// watcher/formatter modules.

export const CHILD_CONVO_INFIX = ':codex:';
export const CHILD_STATE_RUNNING = 'running';
export const CHILD_STATE_FINISHED = 'done';
export const CHILD_STATE_TERMINAL_PENDING = 'terminal-pending';
export const CODEX_RUN_ID_MAX_LENGTH = 32;
export const DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION = 64;

const CHILD_LIMIT_NOTE = '⚙ codex live-view child limit reached — additional reviews are not shown';

const SESSION_OUTCOMES = new Set(['completed', 'interrupted', 'failed']);

// Wrapper-owned identity: <epoch_ms>-<pid>-<4hex>. Keep this strict because
// runId becomes part of a durable conversation id and the sink directory is
// inherited by every child process.
const CODEX_RUN_ID_RE = /^\d{13}-[1-9]\d{0,9}-[0-9a-f]{4}$/;

export function isValidCodexRunId(runId) {
  return typeof runId === 'string' &&
    runId.length <= CODEX_RUN_ID_MAX_LENGTH &&
    CODEX_RUN_ID_RE.test(runId);
}

export function childConvoId(parentConvoId, runId) {
  return `${parentConvoId}${CHILD_CONVO_INFIX}${runId}`;
}

export function createCodexConvoTracker({
  sessionId,
  publisher,
  getParentConvoId,
  log = console,
  maxChildren = DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION,
} = {}) {
  const children = new Map();
  const childLimit = Number.isInteger(maxChildren) && maxChildren >= 0
    ? maxChildren
    : DEFAULT_MAX_CODEX_CHILDREN_PER_SESSION;
  let childLimitNoted = false;
  let childLimitNotePending = false;

  function warn(message) {
    try { log.warn(message); } catch { /* logging must never throw */ }
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function postChildLimitNote() {
    if (childLimitNoted || !childLimitNotePending) return true;
    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) return false;
    const enqueued = publisher.publishText(parentConvoId, {
      body: CHILD_LIMIT_NOTE,
      from: 'assistant',
    }, { idemKey: `${sessionId ?? parentConvoId}:childcap` });
    if (enqueued !== true) return false;
    // This latch covers acceptance by the local queue. Post-enqueue drops are
    // repaired on reconnect; the stable idem key makes re-emission safe.
    childLimitNoted = true;
    childLimitNotePending = false;
    return true;
  }

  function ensureChild(meta) {
    const runId = meta?.runId;
    if (!isValidCodexRunId(runId)) {
      warn('[codex-convos] invalid runId; skipping child');
      return false;
    }

    const existing = children.get(runId);
    if (existing) return existing;

    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) {
      warn(`[codex-convos] no parent convo id yet; skipping child for ${runId}`);
      return null;
    }

    if (children.size >= childLimit) {
      childLimitNotePending = !childLimitNoted;
      postChildLimitNote();
      return false;
    }

    // The sidecar is forgeable by descendants that inherit its sink. Until
    // T-6.2 provides a fail-closed redactor, never promote its label into
    // durable title metadata; identity validity alone controls creation.
    const child = {
      runId,
      parentConvoId,
      convoId: childConvoId(parentConvoId, runId),
      state: CHILD_STATE_RUNNING,
      terminal: false,
    };
    const opts = {
      sessionState: CHILD_STATE_RUNNING,
      parentConvoId,
    };
    if (publisher.upsertConvo(child.convoId, opts) !== true) return null;
    children.set(runId, child);
    return child;
  }

  function terminalize(runId, outcome) {
    if (!SESSION_OUTCOMES.has(outcome)) {
      warn(`[codex-convos] invalid terminal outcome; skipping child terminalization for ${runId}`);
      return false;
    }
    const child = children.get(runId);
    if (!child || child.terminal) return false;
    const terminalOutcome = child.pendingOutcome ?? outcome;
    child.pendingOutcome = terminalOutcome;
    child.state = CHILD_STATE_TERMINAL_PENDING;
    const enqueued = publisher.upsertConvo(child.convoId, {
      parentConvoId: child.parentConvoId,
      sessionState: CHILD_STATE_FINISHED,
      sessionOutcome: terminalOutcome,
    });
    // A rejected enqueue leaves this child pending for an in-session retry.
    // Once enqueue succeeds there is no
    // server ack, so T-5.4 reconnect terminalChildren() re-emission repairs a
    // post-enqueue drop/rejection; T-3.1 COALESCE makes that retry idempotent.
    if (enqueued !== true) return false;
    child.terminal = true;
    child.state = CHILD_STATE_FINISHED;
    child.outcome = terminalOutcome;
    delete child.pendingOutcome;
    return true;
  }

  function terminalizeByRunId(runId, outcome) {
    if (!isValidCodexRunId(runId) || !SESSION_OUTCOMES.has(outcome)) return false;
    const existing = children.get(runId);
    if (existing) return existing.terminal || terminalize(runId, outcome);

    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) return null;
    const enqueued = publisher.upsertConvo(childConvoId(parentConvoId, runId), {
      parentConvoId,
      sessionState: CHILD_STATE_FINISHED,
      sessionOutcome: outcome,
    });
    // Reconciliation deliberately does not retain this historical run in the
    // live-child Map. The journal's terminal-field COALESCE makes this upsert
    // idempotent and preserves an already-terminal outcome.
    return enqueued === true ? true : null;
  }

  function interruptAll() {
    const terminalized = [];
    for (const [runId, child] of children) {
      const outcome = child.pendingOutcome ?? 'interrupted';
      try {
        if (terminalize(runId, 'interrupted')) terminalized.push({ runId, outcome });
      } catch (error) {
        warn(`[codex-convos] terminalize failed: ${errorMessage(error)}`);
      }
    }
    return terminalized;
  }

  return {
    // null means the handoff may succeed on a later poll (for example, the
    // parent id or publisher is temporarily unavailable); false is a
    // permanent rejection that the filesystem watcher must not retry.
    ensureChild(meta) {
      try { return ensureChild(meta); }
      catch (error) {
        warn(`[codex-convos] ensureChild failed: ${errorMessage(error)}`);
        return null;
      }
    },

    terminalize(runId, outcome) {
      try { return terminalize(runId, outcome); }
      catch (error) {
        warn(`[codex-convos] terminalize failed: ${errorMessage(error)}`);
        return false;
      }
    },

    terminalizeByRunId(runId, outcome) {
      try { return terminalizeByRunId(runId, outcome); }
      catch (error) {
        warn(`[codex-convos] direct terminalize failed: ${errorMessage(error)}`);
        return null;
      }
    },

    interruptAll() {
      return interruptAll();
    },

    hasPendingCapNote() {
      return childLimitNotePending && !childLimitNoted;
    },

    retryPendingCapNote() {
      try { return postChildLimitNote(); }
      catch (error) {
        warn(`[codex-convos] child-limit note failed: ${errorMessage(error)}`);
        return false;
      }
    },

    convoIdFor(runId) {
      return children.get(runId)?.convoId ?? null;
    },

    childFor(runId) {
      const child = children.get(runId);
      return child ? { ...child } : null;
    },

    terminalChildren() {
      const terminal = new Map();
      for (const [runId, child] of children) {
        if (child.terminal) terminal.set(runId, child.outcome);
      }
      return terminal;
    },

    hasChild(runId) {
      return children.has(runId);
    },
  };
}
