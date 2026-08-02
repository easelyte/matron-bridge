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

  function warn(message) {
    try { log.warn(message); } catch { /* logging must never throw */ }
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function ensureChild(meta) {
    const runId = meta?.runId;
    if (!isValidCodexRunId(runId)) {
      warn('[codex-convos] invalid runId; skipping child');
      return null;
    }

    const existing = children.get(runId);
    if (existing) return existing;

    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) {
      warn(`[codex-convos] no parent convo id yet; skipping child for ${runId}`);
      return null;
    }

    if (children.size >= childLimit) {
      if (!childLimitNoted) {
        publisher.publishText(parentConvoId, {
          body: CHILD_LIMIT_NOTE,
          from: 'assistant',
        });
        childLimitNoted = true;
      }
      return null;
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
    publisher.upsertConvo(child.convoId, opts);
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
    publisher.upsertConvo(child.convoId, {
      parentConvoId: child.parentConvoId,
      sessionState: CHILD_STATE_FINISHED,
      sessionOutcome: terminalOutcome,
    });
    child.terminal = true;
    child.state = CHILD_STATE_FINISHED;
    child.outcome = terminalOutcome;
    delete child.pendingOutcome;
    return true;
  }

  function interruptAll() {
    const interrupted = [];
    for (const runId of children.keys()) {
      try {
        if (terminalize(runId, 'interrupted')) interrupted.push(runId);
      } catch (error) {
        warn(`[codex-convos] terminalize failed: ${errorMessage(error)}`);
      }
    }
    return interrupted;
  }

  return {
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

    interruptAll() {
      return interruptAll();
    },

    convoIdFor(runId) {
      return children.get(runId)?.convoId ?? null;
    },

    childFor(runId) {
      const child = children.get(runId);
      return child ? { ...child } : null;
    },
  };
}
