import { createCodexConvoTracker } from './codex-convos.js';
import {
  connectCodexWatcherPublisher,
  createCodexWatcherIsolation,
  registerCodexWatcherForLiveSession,
} from './codex-watcher.js';
import { createPublishRedactor } from './redact.js';

// Side-effect-free production wiring seam. The entrypoint supplies its live
// publisher/session registry; tests can exercise the same setup without
// importing and starting the bridge process.
export function setupCodexWatcherForSession(session, workdir, sessionId, {
  publisher,
  liveSessions,
  redactorOptions = {},
  watcherOptions = {},
  watcherDependencies = {},
  log = console,
} = {}) {
  if (!publisher || !liveSessions) {
    throw new TypeError('setupCodexWatcherForSession requires publisher and liveSessions');
  }
  const getParentConvoId = () => session.journalConvoId || session.claudeSessionId;
  const codexPublishRedact = createPublishRedactor({ ...redactorOptions, log });
  session.codexConvos = createCodexConvoTracker({
    sessionId,
    publisher,
    getParentConvoId,
    log,
    redact: codexPublishRedact,
  });
  session.codexOnDiscover = meta => session.codexConvos?.ensureChild(meta) ?? null;
  session.codexWatcherIsolation = null;
  try {
    const isolation = createCodexWatcherIsolation({
      sessionId,
      publisher,
      getParentConvoId,
      terminalize: (runId, outcome) => session.codexConvos.terminalize(runId, outcome),
      terminalizeAll: () => session.codexConvos.interruptAll(),
      hasPendingCapNote: () => session.codexConvos.hasPendingCapNote(),
      retryCapNote: () => session.codexConvos.retryPendingCapNote(),
      isAdmittedRun: runId => session.codexConvos.hasChild(runId),
      log,
    });
    session.codexWatcherIsolation = isolation;
    const codexWatcher = registerCodexWatcherForLiveSession(liveSessions, session.roomId, {
      workdir,
      sessionId,
      ...watcherOptions,
      onDiscover: session.codexOnDiscover,
      onReconcile: (runId, outcome) => session.codexConvos.terminalizeByRunId(runId, outcome),
      isolation,
    }, {
      ...watcherDependencies,
      onCreate: watcher => connectCodexWatcherPublisher(watcher, {
        publisher,
        convoIdFor: runId => session.codexConvos.convoIdFor(runId),
        retainFinalAnswer: (runId, payload) => session.codexConvos.retainFinalAnswer(runId, payload),
        markFinalAnswerDelivered: runId => session.codexConvos.markFinalAnswerDelivered(runId),
        redact: codexPublishRedact,
        log,
      }),
      onFailure: (_error, failedWatcher) => {
        if (session.codexWatcher === failedWatcher) session.codexWatcher = null;
        Promise.resolve(failedWatcher?.stop?.()).catch(() => {});
      },
    });
    return codexWatcher;
  } catch (error) {
    session.codexWatcher = null;
    try { log.warn(`[codex-watcher] session setup failed (${error instanceof Error ? error.name : typeof error})`); }
    catch { /* visualization setup must never block session initialization */ }
    return null;
  }
}
