// Codex CLI review/execute runs are surfaced as child conversations of the
// Claude session that launched their wrapper. This tracker owns only the
// child-conversation lifecycle; discovery and event decoding live in the
// watcher/formatter modules.

export const CHILD_CONVO_INFIX = ':codex:';
export const CHILD_STATE_RUNNING = 'running';
export const CHILD_STATE_FINISHED = 'done';
export const CODEX_RUN_ID_MAX_LENGTH = 32;
export const CODEX_LABEL_MAX_LENGTH = 120;

// Wrapper-owned identity: <epoch_ms>-<pid>-<4hex>. Keep this strict because
// runId becomes part of a durable conversation id and the sink directory is
// inherited by every child process.
const CODEX_RUN_ID_RE = /^\d{13}-[1-9]\d{0,9}-[0-9a-f]{4}$/;
// Labels are display metadata, not an arbitrary text channel. Permit ordinary
// title punctuation while excluding controls, markup, paths, and key/value
// syntax. Secret-shaped values are rejected by the denylist below.
const CODEX_LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,:;_+()#@&'’!?-]*$/u;
const SECRET_LABEL_PATTERNS = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/i,
  /\bAKIA[0-9A-Z]{12,}\b/,
  /\b(?:authorization|api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._+\-/=]{8,}/i,
];

export function isValidCodexRunId(runId) {
  return typeof runId === 'string' &&
    runId.length <= CODEX_RUN_ID_MAX_LENGTH &&
    CODEX_RUN_ID_RE.test(runId);
}

export function sanitizeCodexLabel(label) {
  if (typeof label !== 'string') return null;
  const normalized = label.trim();
  if (!normalized || normalized.length > CODEX_LABEL_MAX_LENGTH) return null;
  if (!CODEX_LABEL_RE.test(normalized)) return null;
  if (SECRET_LABEL_PATTERNS.some(pattern => pattern.test(normalized))) return null;
  return normalized;
}

export function childConvoId(parentConvoId, runId) {
  return `${parentConvoId}${CHILD_CONVO_INFIX}${runId}`;
}

export function createCodexConvoTracker({ publisher, getParentConvoId, log = console } = {}) {
  const children = new Map();

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

    const title = sanitizeCodexLabel(meta?.label);
    if (title == null) {
      warn(`[codex-convos] invalid label; skipping child for ${runId}`);
      return null;
    }

    const existing = children.get(runId);
    if (existing) return existing;

    const parentConvoId = getParentConvoId?.();
    if (!parentConvoId) {
      warn(`[codex-convos] no parent convo id yet; skipping child for ${runId}`);
      return null;
    }

    const child = {
      runId,
      parentConvoId,
      convoId: childConvoId(parentConvoId, runId),
      title,
      state: CHILD_STATE_RUNNING,
      terminal: false,
    };
    const opts = {
      sessionState: CHILD_STATE_RUNNING,
      parentConvoId,
    };
    if (child.title != null) opts.title = child.title;
    publisher.upsertConvo(child.convoId, opts);
    children.set(runId, child);
    return child;
  }

  function terminalize(runId, outcome) {
    const child = children.get(runId);
    if (!child || child.terminal) return;
    publisher.upsertConvo(child.convoId, {
      parentConvoId: child.parentConvoId,
      title: child.title,
      sessionState: CHILD_STATE_FINISHED,
      sessionOutcome: outcome,
    });
    child.terminal = true;
    child.state = CHILD_STATE_FINISHED;
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
      try { terminalize(runId, outcome); }
      catch (error) { warn(`[codex-convos] terminalize failed: ${errorMessage(error)}`); }
    },

    convoIdFor(runId) {
      return children.get(runId)?.convoId ?? null;
    },
  };
}
